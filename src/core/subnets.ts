import { v4 as uuidv4 } from 'uuid';
import net from 'net';
import { getDb } from '../database/connection';
import { parseCIDR, generateIPv6, normalizeCIDR } from '../utils/ipv6';
import { getLogger } from '../utils/logger';

export interface Subnet {
  id: string;
  cidr: string;
  gateway: string | null;
  status: 'active' | 'disabled';
  created_at: string;
  /**
   * What put this subnet here: `detected`, `env`, `tunnel`, `warp`, or null for
   * one an operator added through the API. Only proxy-managed sources are
   * reconciled on startup.
   */
  source: string | null;
}

const SUBNET_COLUMNS = 'id, cidr, gateway, status, created_at, source';

function rowToSubnet(row: any): Subnet {
  return {
    id: row.id,
    cidr: row.cidr,
    gateway: row.gateway,
    status: row.status,
    created_at: row.created_at,
    source: row.source ?? null,
  };
}

export function addSubnet(cidr: string, gateway?: string, source?: string): Subnet {
  const db = getDb();
  const log = getLogger();
  const normalized = normalizeCIDR(cidr); // validate + compress

  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(
    'INSERT INTO subnets (id, cidr, gateway, status, created_at, source) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, normalized, gateway || null, 'active', now, source || null);

  log.info({ subnetId: id, cidr: normalized, source: source || null }, 'Subnet added');
  return {
    id,
    cidr: normalized,
    gateway: gateway || null,
    status: 'active',
    created_at: now,
    source: source || null,
  };
}


export function getSubnet(id: string): Subnet | null {
  const db = getDb();
  const row = db.prepare(`SELECT ${SUBNET_COLUMNS} FROM subnets WHERE id = ?`).get(id) as any;
  return row ? rowToSubnet(row) : null;
}

export function getSubnetByCidr(cidr: string): Subnet | null {
  const db = getDb();
  const row = db.prepare(`SELECT ${SUBNET_COLUMNS} FROM subnets WHERE cidr = ?`)
    .get(normalizeCIDR(cidr)) as any;
  return row ? rowToSubnet(row) : null;
}

export function listSubnets(): Subnet[] {
  const db = getDb();
  return (db.prepare(
    `SELECT ${SUBNET_COLUMNS} FROM subnets ORDER BY created_at DESC`
  ).all() as any[]).map(rowToSubnet);
}

/**
 * Bind a subnet to every existing user.
 *
 * New users are auto-bound to all active subnets when they are created, but a
 * subnet that appears afterwards — a WARP link registered on a later boot, a
 * tunnel prefix that only just came up — would otherwise be invisible to
 * everyone who already existed. Returns how many bindings were added.
 */
export function bindSubnetToAllUsers(subnetId: string): number {
  const db = getDb();
  const users = db.prepare('SELECT id FROM users').all() as { id: string }[];
  const insert = db.prepare(
    'INSERT OR IGNORE INTO user_subnet_bindings (id, user_id, subnet_id) VALUES (?, ?, ?)'
  );

  let added = 0;
  db.transaction(() => {
    for (const user of users) {
      added += insert.run(uuidv4(), user.id, subnetId).changes;
    }
  })();

  return added;
}

/**
 * Drop proxy-managed subnets of one source that are no longer live.
 *
 * WARP addresses change when devices are re-registered; leaving the old /128s
 * registered would keep handing users an address that no longer routes.
 * Subnets an operator added by hand (source null) are never touched.
 */
export function pruneSubnetsBySource(source: string, keepCidrs: string[]): string[] {
  const db = getDb();
  const log = getLogger();
  const keep = new Set(keepCidrs.map((c) => normalizeCIDR(c)));

  const stale = (db.prepare('SELECT id, cidr FROM subnets WHERE source = ?').all(source) as any[])
    .filter((row) => !keep.has(row.cidr));

  for (const row of stale) {
    // Bindings and sticky allocations cascade with the subnet.
    db.prepare('DELETE FROM subnets WHERE id = ?').run(row.id);
    log.info({ cidr: row.cidr, source }, 'Removed a stale proxy-managed subnet');
  }

  return stale.map((row) => row.cidr);
}

export function removeSubnet(id: string): void {
  const db = getDb();
  const log = getLogger();
  db.prepare('DELETE FROM subnets WHERE id = ?').run(id);
  log.info({ subnetId: id }, 'Subnet removed');
}

export function checkSubnetHealth(id: string): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    const subnet = getSubnet(id);
    if (!subnet) {
      resolve({ ok: false, message: `Subnet ${id} not found` });
      return;
    }

    try {
      const parsed = parseCIDR(subnet.cidr);
      const testAddr = generateIPv6(parsed.prefix, parsed.prefixLength);

      const timeout = setTimeout(() => {
        socket.destroy();
        resolve({ ok: false, message: 'Health check timed out' });
      }, 5000);

      // Must be an IPv6 target: the socket is bound to an IPv6 source, and a
      // v4 destination cannot be reached from it.
      const socket = net.createConnection({
        host: '2606:4700:4700::1111',
        port: 443,
        localAddress: testAddr,
        family: 6,
        timeout: 5000,
      });

      socket.on('connect', () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve({ ok: true, message: `Successfully bound to ${testAddr}` });
      });

      socket.on('error', (err) => {
        clearTimeout(timeout);
        resolve({ ok: false, message: `Failed: ${err.message}` });
      });
    } catch (err: any) {
      resolve({ ok: false, message: `Error: ${err.message}` });
    }
  });
}
