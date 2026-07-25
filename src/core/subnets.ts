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
}

function rowToSubnet(row: any): Subnet {
  return {
    id: row.id,
    cidr: row.cidr,
    gateway: row.gateway,
    status: row.status,
    created_at: row.created_at,
  };
}

export function addSubnet(cidr: string, gateway?: string): Subnet {
  const db = getDb();
  const log = getLogger();
  const normalized = normalizeCIDR(cidr); // validate + compress

  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(
    'INSERT INTO subnets (id, cidr, gateway, status, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, normalized, gateway || null, 'active', now);

  log.info({ subnetId: id, cidr: normalized }, 'Subnet added');
  return { id, cidr: normalized, gateway: gateway || null, status: 'active', created_at: now };
}


export function getSubnet(id: string): Subnet | null {
  const db = getDb();
  const row = db.prepare('SELECT id, cidr, gateway, status, created_at FROM subnets WHERE id = ?')
    .get(id) as any;
  return row ? rowToSubnet(row) : null;
}

export function listSubnets(): Subnet[] {
  const db = getDb();
  return (db.prepare(
    'SELECT id, cidr, gateway, status, created_at FROM subnets ORDER BY created_at DESC'
  ).all() as any[]).map(rowToSubnet);
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

      const socket = net.createConnection({
        host: '1.1.1.1',
        port: 80,
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
