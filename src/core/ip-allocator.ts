import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database/connection';
import { parseCIDR, generateIPv6, registerIPv6Address, forceUnregisterIPv6Address } from '../utils/ipv6';
import { getLogger } from '../utils/logger';
import { getActiveSessions, forceDisconnect } from './sessions';

/** Pick subnet for this connect. Sticky reuses existing sticky subnet; random picks among bindings. */
export function pickSubnetId(
  userId: string,
  subnetIds: string[],
  mode: 'sticky' | 'random'
): string {
  if (subnetIds.length === 0) {
    throw new Error('No active subnet bindings');
  }
  if (mode === 'sticky') {
    const db = getDb();
    const placeholders = subnetIds.map(() => '?').join(',');
    const existing = db.prepare(
      `SELECT subnet_id FROM sticky_bindings
       WHERE user_id = ? AND subnet_id IN (${placeholders})
       ORDER BY bound_at ASC LIMIT 1`
    ).get(userId, ...subnetIds) as { subnet_id: string } | undefined;
    if (existing) return existing.subnet_id;
  }
  return subnetIds[crypto.randomInt(subnetIds.length)];
}

export function allocateForUser(
  userId: string,
  subnetId: string,
  mode: 'sticky' | 'random'
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
    // Use IMMEDIATE transaction to prevent TOCTOU race:
    // two concurrent allocations for the same user+subnet could both
    // see no existing binding and try to INSERT simultaneously.
    const insertSticky = db.transaction(() => {
      const existing = db.prepare(
        'SELECT ipv6_addr FROM sticky_bindings WHERE user_id = ? AND subnet_id = ?'
      ).get(userId, subnetId) as { ipv6_addr: string } | undefined;

      if (existing) {
        log.debug({ userId, subnetId, ipv6Addr: existing.ipv6_addr }, 'Reusing sticky IPv6 address');
        // Re-register so refcount / NDP stays correct across sessions & restarts
        registerIPv6Address(existing.ipv6_addr);
        return existing.ipv6_addr;
      }

      const existingAddrs = db.prepare(
        'SELECT ipv6_addr FROM sticky_bindings WHERE subnet_id = ?'
      ).all(subnetId).map((r: any) => r.ipv6_addr);

      let addr: string;
      let attempts = 0;
      do {
        addr = generateIPv6(parsed.prefix, parsed.prefixLength);
        attempts++;
        if (attempts >= 100) {
          throw new Error('Failed to find a unique IPv6 address after 100 attempts');
        }
      } while (existingAddrs.includes(addr));

      const id = uuidv4();
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO sticky_bindings (id, user_id, subnet_id, ipv6_addr, bound_at) VALUES (?, ?, ?, ?, ?)'
      ).run(id, userId, subnetId, addr, now);

      log.info({ userId, subnetId, ipv6Addr: addr }, 'Allocated new sticky IPv6 address');
      // Register on host interface so upstream NDP can route return traffic
      registerIPv6Address(addr);
      return addr;
    });

    return insertSticky();
  }

  // Random mode
  const addr = generateIPv6(parsed.prefix, parsed.prefixLength);
  registerIPv6Address(addr);
  log.debug({ userId, subnetId, ipv6Addr: addr }, 'Allocated random IPv6 address');
  return addr;
}

export function refreshStickyBinding(userId: string, subnetId: string): void {
  const db = getDb();
  const log = getLogger();

  // Unregister old address from interface before deleting
  const existing = db.prepare(
    'SELECT ipv6_addr FROM sticky_bindings WHERE user_id = ? AND subnet_id = ?'
  ).get(userId, subnetId) as { ipv6_addr: string } | undefined;
  if (existing) {
    // Live sessions still source from the old sticky IP — drop them so
    // the next connect allocates a fresh address.
    for (const s of getActiveSessions()) {
      if (s.userId === userId && s.ipv6Addr === existing.ipv6_addr) {
        forceDisconnect(s.id);
      }
    }
    forceUnregisterIPv6Address(existing.ipv6_addr);
  }

  const result = db.prepare(
    'DELETE FROM sticky_bindings WHERE user_id = ? AND subnet_id = ?'
  ).run(userId, subnetId);
  log.info({ userId, subnetId, deleted: result.changes > 0 }, 'Sticky binding refreshed');
}

export function getCurrentStickyAddress(userId: string): { subnetId: string; ipv6Addr: string }[] {
  const db = getDb();
  return (db.prepare(
    'SELECT subnet_id, ipv6_addr FROM sticky_bindings WHERE user_id = ?'
  ).all(userId) as any[]).map(r => ({ subnetId: r.subnet_id, ipv6Addr: r.ipv6_addr }));
}

export function removeAllStickyBindings(userId: string): void {
  const db = getDb();
  // Unregister all addresses for this user before deleting
  const addrs = db.prepare(
    'SELECT ipv6_addr FROM sticky_bindings WHERE user_id = ?'
  ).all(userId) as { ipv6_addr: string }[];
  for (const a of addrs) {
    forceUnregisterIPv6Address(a.ipv6_addr);
  }
  db.prepare('DELETE FROM sticky_bindings WHERE user_id = ?').run(userId);
}
