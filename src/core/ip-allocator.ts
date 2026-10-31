import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database/connection';
import { parseCIDR, generateIPv6, registerIPv6Address, forceUnregisterIPv6Address } from '../utils/ipv6';
import { getLogger } from '../utils/logger';
import { getActiveSessions, forceDisconnect } from './sessions';
import { DEFAULT_STICKY_KEY, type ProxyMode } from './proxy-username';

/**
 * Keyed sticky buckets expire after this much idle time by default. The plain
 * `-sticky` default bucket is exempt and lasts until the API refresh clears it.
 * `STICKY_TTL_HOURS` overrides the duration at startup.
 */
export const DEFAULT_STICKY_BINDING_TTL_MS = 24 * 60 * 60 * 1000;
let stickyBindingTtlMs = DEFAULT_STICKY_BINDING_TTL_MS;

/** Set from `STICKY_TTL_HOURS` during startup. */
export function configureStickyBindingTtl(hours: number): void {
  if (!Number.isFinite(hours) || hours < 1) {
    throw new Error(`Sticky binding TTL must be at least 1 hour, got: ${hours}`);
  }
  stickyBindingTtlMs = Math.round(hours * 60 * 60 * 1000);
}

/** Stale rows are swept in the background so an abandoned key cannot pin an address forever. */
const STICKY_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

interface StickyRow {
  id: string;
  user_id: string;
  subnet_id: string;
  sticky_key: string;
  ipv6_addr: string;
  bound_at: string;
  last_used_at: string;
}

function stickyCutoff(nowMs: number): string {
  return new Date(nowMs - stickyBindingTtlMs).toISOString();
}

/** Pick subnet for this connect. Sticky reuses a live key bucket; random picks among bindings. */
export function pickSubnetId(
  userId: string,
  subnetIds: string[],
  mode: ProxyMode,
  stickyKey: string | null
): string {
  if (subnetIds.length === 0) {
    throw new Error('No active subnet bindings');
  }
  if (mode === 'sticky') {
    if (!stickyKey) throw new Error('Sticky allocation requires a sticky key');
    const db = getDb();
    const placeholders = subnetIds.map(() => '?').join(',');
    const existing = db.prepare(
      `SELECT subnet_id FROM sticky_bindings
       WHERE user_id = ? AND sticky_key = ?
         AND (sticky_key = ? OR last_used_at >= ?)
         AND subnet_id IN (${placeholders})
       ORDER BY last_used_at ASC LIMIT 1`
    ).get(
      userId,
      stickyKey,
      DEFAULT_STICKY_KEY,
      stickyCutoff(Date.now()),
      ...subnetIds
    ) as { subnet_id: string } | undefined;
    if (existing) return existing.subnet_id;
  }
  return subnetIds[crypto.randomInt(subnetIds.length)];
}

/**
 * Drop an address from the host interface unless a live session still sources
 * from it. The session's own close path releases the remaining reference.
 */
function releaseStickyAddress(addr: string): void {
  if (getActiveSessions().some((session) => session.ipv6Addr === addr)) return;
  forceUnregisterIPv6Address(addr);
}

export function allocateForUser(
  userId: string,
  subnetId: string,
  mode: ProxyMode,
  stickyKey: string | null
): string {
  const db = getDb();
  const log = getLogger();

  const subnet = db.prepare('SELECT cidr FROM subnets WHERE id = ? AND status = ?')
    .get(subnetId, 'active') as { cidr: string } | undefined;

  if (!subnet) {
    throw new Error(`Active subnet ${subnetId} not found`);
  }

  const parsed = parseCIDR(subnet.cidr);

  if (mode === 'sticky') {
    if (!stickyKey) throw new Error('Sticky allocation requires a sticky key');

    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const cutoff = stickyCutoff(nowMs);

    // IMMEDIATE transaction prevents two concurrent connections for the same
    // key from both seeing no binding and inserting different addresses.
    const upsertSticky = db.transaction(() => {
      const existing = db.prepare(
        'SELECT * FROM sticky_bindings WHERE user_id = ? AND subnet_id = ? AND sticky_key = ?'
      ).get(userId, subnetId, stickyKey) as StickyRow | undefined;

      if (
        existing &&
        (stickyKey === DEFAULT_STICKY_KEY || existing.last_used_at >= cutoff)
      ) {
        db.prepare('UPDATE sticky_bindings SET last_used_at = ? WHERE id = ?')
          .run(now, existing.id);
        log.debug(
          { userId, subnetId, stickyKey, ipv6Addr: existing.ipv6_addr },
          'Reusing sticky IPv6 address'
        );
        // Re-register so refcount / NDP stays correct across sessions & restarts
        registerIPv6Address(existing.ipv6_addr);
        return existing.ipv6_addr;
      }

      if (existing) {
        db.prepare('DELETE FROM sticky_bindings WHERE id = ?').run(existing.id);
        releaseStickyAddress(existing.ipv6_addr);
        log.debug(
          { userId, subnetId, stickyKey, ipv6Addr: existing.ipv6_addr },
          'Expired sticky IPv6 address'
        );
      }

      // A /128 subnet has no spare host bits: every key on it necessarily
      // shares the one address (WARP registers each device as a /128).
      const existingAddrs = parsed.prefixLength >= 128
        ? []
        : (db.prepare('SELECT ipv6_addr FROM sticky_bindings WHERE subnet_id = ?')
          .all(subnetId) as { ipv6_addr: string }[]).map((row) => row.ipv6_addr);

      let addr: string;
      let attempts = 0;
      do {
        addr = generateIPv6(parsed.prefix, parsed.prefixLength);
        attempts++;
        if (attempts >= 100) {
          throw new Error('Failed to find a unique IPv6 address after 100 attempts');
        }
      } while (existingAddrs.includes(addr));

      db.prepare(
        `INSERT INTO sticky_bindings
           (id, user_id, subnet_id, sticky_key, ipv6_addr, bound_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(uuidv4(), userId, subnetId, stickyKey, addr, now, now);

      log.info(
        { userId, subnetId, stickyKey, ipv6Addr: addr },
        'Allocated new sticky IPv6 address'
      );
      // Register on host interface so upstream NDP can route return traffic
      registerIPv6Address(addr);
      return addr;
    });

    return upsertSticky();
  }

  // Random mode
  const addr = generateIPv6(parsed.prefix, parsed.prefixLength);
  registerIPv6Address(addr);
  log.debug({ userId, subnetId, ipv6Addr: addr }, 'Allocated random IPv6 address');
  return addr;
}

/** Delete every key bucket for one user+subnet (used when a binding is removed). */
export function refreshStickyBinding(userId: string, subnetId: string): void {
  const db = getDb();
  const log = getLogger();

  const rows = db.prepare(
    'SELECT * FROM sticky_bindings WHERE user_id = ? AND subnet_id = ?'
  ).all(userId, subnetId) as StickyRow[];

  discardStickyRows(userId, rows);
  db.prepare('DELETE FROM sticky_bindings WHERE user_id = ? AND subnet_id = ?')
    .run(userId, subnetId);
  log.info({ userId, subnetId, deleted: rows.length }, 'Sticky bindings refreshed');
}

/** Delete every sticky key bucket for a user (the API's switch-IP action). */
export function refreshUserStickyBindings(userId: string): number {
  const db = getDb();
  const log = getLogger();

  const rows = db.prepare(
    'SELECT * FROM sticky_bindings WHERE user_id = ?'
  ).all(userId) as StickyRow[];

  discardStickyRows(userId, rows);
  db.prepare('DELETE FROM sticky_bindings WHERE user_id = ?').run(userId);
  log.info({ userId, deleted: rows.length }, 'All sticky bindings refreshed for user');
  return rows.length;
}

export interface CurrentStickyAddress {
  subnetId: string;
  stickyKey: string;
  ipv6Addr: string;
  lastUsedAt: string;
}

export function getCurrentStickyAddress(userId: string): CurrentStickyAddress[] {
  const db = getDb();
  return (db.prepare(
    'SELECT subnet_id, sticky_key, ipv6_addr, last_used_at FROM sticky_bindings WHERE user_id = ? ORDER BY sticky_key'
  ).all(userId) as {
    subnet_id: string;
    sticky_key: string;
    ipv6_addr: string;
    last_used_at: string;
  }[]).map((row) => ({
    subnetId: row.subnet_id,
    stickyKey: row.sticky_key,
    ipv6Addr: row.ipv6_addr,
    lastUsedAt: row.last_used_at,
  }));
}

export function removeAllStickyBindings(userId: string): void {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM sticky_bindings WHERE user_id = ?'
  ).all(userId) as StickyRow[];

  for (const row of rows) {
    forceUnregisterIPv6Address(row.ipv6_addr);
  }
  db.prepare('DELETE FROM sticky_bindings WHERE user_id = ?').run(userId);
}

function discardStickyRows(userId: string, rows: StickyRow[]): void {
  if (rows.length === 0) return;
  const addresses = new Set(rows.map((row) => row.ipv6_addr));
  for (const session of getActiveSessions()) {
    if (session.userId === userId && addresses.has(session.ipv6Addr)) {
      forceDisconnect(session.id);
    }
  }
  for (const addr of addresses) {
    forceUnregisterIPv6Address(addr);
  }
}

/**
 * Delete key buckets idle past the TTL. Rows with a live session are kept
 * until that session ends; otherwise the binding would outlive its own use.
 */
export function cleanupExpiredStickyBindings(nowMs = Date.now()): number {
  const db = getDb();
  const log = getLogger();
  const rows = db.prepare(
    'SELECT * FROM sticky_bindings WHERE last_used_at < ? AND sticky_key <> ?'
  ).all(stickyCutoff(nowMs), DEFAULT_STICKY_KEY) as StickyRow[];

  const inUse = new Set(getActiveSessions().map((session) => session.ipv6Addr));
  const expired = rows.filter((row) => !inUse.has(row.ipv6_addr));
  if (expired.length === 0) return 0;

  const remove = db.prepare('DELETE FROM sticky_bindings WHERE id = ?');
  db.transaction(() => {
    for (const row of expired) remove.run(row.id);
  })();

  for (const row of expired) {
    forceUnregisterIPv6Address(row.ipv6_addr);
  }
  log.info({ removed: expired.length }, 'Cleaned up expired sticky bindings');
  return expired.length;
}

/** Start the background sweep; the timer is unref'd so it never holds the process open. */
export function startStickyBindingCleanup(
  intervalMs = STICKY_CLEANUP_INTERVAL_MS
): NodeJS.Timeout {
  const log = getLogger();
  const sweep = (): void => {
    try {
      cleanupExpiredStickyBindings();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err: message }, 'Failed to clean up expired sticky bindings');
    }
  };

  sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref();
  return timer;
}
