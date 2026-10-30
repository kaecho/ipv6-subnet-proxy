import Database from 'better-sqlite3';
import { getLogger } from '../utils/logger';

export function runMigrations(db: Database.Database): void {
  const log = getLogger();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      username   TEXT NOT NULL UNIQUE,
      password   TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subnets (
      id         TEXT PRIMARY KEY,
      cidr       TEXT NOT NULL UNIQUE,
      gateway    TEXT,
      status     TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_subnet_bindings (
      id        TEXT PRIMARY KEY,
      user_id   TEXT NOT NULL,
      subnet_id TEXT NOT NULL,
      UNIQUE(user_id, subnet_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (subnet_id) REFERENCES subnets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sticky_bindings (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      subnet_id    TEXT NOT NULL,
      sticky_key   TEXT NOT NULL DEFAULT 'default',
      ipv6_addr    TEXT NOT NULL,
      bound_at     TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      UNIQUE(user_id, subnet_id, sticky_key),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (subnet_id) REFERENCES subnets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS traffic_stats (
      id        TEXT PRIMARY KEY,
      user_id   TEXT NOT NULL,
      date      TEXT NOT NULL,
      bytes_in  INTEGER NOT NULL DEFAULT 0,
      bytes_out INTEGER NOT NULL DEFAULT 0,
      UNIQUE(user_id, date),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id         TEXT PRIMARY KEY,
      user_id    TEXT,
      actor      TEXT,
      action     TEXT NOT NULL,
      detail     TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rate_limits (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL UNIQUE,
      max_connections INTEGER,
      max_bandwidth   INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Cloudflare WARP registrations. Kept so a restart reuses the same egress
    -- addresses instead of handing every user a new IP and burning through
    -- Cloudflare's registration quota. One row per WireGuard link.
    CREATE TABLE IF NOT EXISTS warp_accounts (
      id              TEXT PRIMARY KEY,
      slot            INTEGER NOT NULL UNIQUE,
      device_id       TEXT,
      token           TEXT,
      account_id      TEXT,
      account_type    TEXT,
      license         TEXT,
      private_key     TEXT NOT NULL,
      public_key      TEXT NOT NULL,
      peer_public_key TEXT NOT NULL,
      client_id       TEXT,
      endpoint_host   TEXT,
      address_v4      TEXT,
      address_v6      TEXT NOT NULL,
      created_at      TEXT NOT NULL
    );
  `);

  // Which mechanism put a subnet in the table, so the ones the proxy manages
  // itself can be reconciled without touching operator-added subnets.
  const subnetColumns = (db.prepare('PRAGMA table_info(subnets)').all() as { name: string }[])
    .map((c) => c.name);
  if (!subnetColumns.includes('source')) {
    db.exec('ALTER TABLE subnets ADD COLUMN source TEXT');
  }

  // Address behaviour now comes from the SOCKS5 username suffix. The old
  // per-account switch is gone; drop its storage on upgrade.
  const userColumns = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[])
    .map((c) => c.name);
  if (userColumns.includes('mode')) {
    db.exec('ALTER TABLE users DROP COLUMN mode');
  }

  // Older databases had one sticky address per user+subnet. Rebuild the table
  // so it can hold one bucket per (user, subnet, sticky key) and track expiry.
  const stickyColumns = (db.prepare('PRAGMA table_info(sticky_bindings)').all() as { name: string }[])
    .map((c) => c.name);
  if (!stickyColumns.includes('sticky_key')) {
    db.exec(`
      ALTER TABLE sticky_bindings RENAME TO sticky_bindings_legacy;

      CREATE TABLE sticky_bindings (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL,
        subnet_id    TEXT NOT NULL,
        sticky_key   TEXT NOT NULL DEFAULT 'default',
        ipv6_addr    TEXT NOT NULL,
        bound_at     TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        UNIQUE(user_id, subnet_id, sticky_key),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (subnet_id) REFERENCES subnets(id) ON DELETE CASCADE
      );

      INSERT INTO sticky_bindings
        (id, user_id, subnet_id, sticky_key, ipv6_addr, bound_at, last_used_at)
      SELECT id, user_id, subnet_id, 'default', ipv6_addr, bound_at, bound_at
      FROM sticky_bindings_legacy;

      DROP TABLE sticky_bindings_legacy;
    `);
  } else if (!stickyColumns.includes('last_used_at')) {
    db.exec('ALTER TABLE sticky_bindings ADD COLUMN last_used_at TEXT');
    db.exec('UPDATE sticky_bindings SET last_used_at = bound_at WHERE last_used_at IS NULL');
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_traffic_stats_date ON traffic_stats(date);
    CREATE INDEX IF NOT EXISTS idx_sticky_bindings_user ON sticky_bindings(user_id);
    CREATE INDEX IF NOT EXISTS idx_sticky_bindings_user_key ON sticky_bindings(user_id, sticky_key, last_used_at);
    CREATE INDEX IF NOT EXISTS idx_user_subnet_bindings_user ON user_subnet_bindings(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_subnet_bindings_subnet ON user_subnet_bindings(subnet_id);
    CREATE INDEX IF NOT EXISTS idx_subnets_source ON subnets(source);
  `);

  log.info('Database migrations completed successfully');
}
