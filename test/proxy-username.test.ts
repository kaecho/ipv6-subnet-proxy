import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

process.env.API_KEY = 'test-key';

import {
  authenticateProxyUser,
  createUser,
} from '../src/core/users';
import { parseProxyUsername } from '../src/core/proxy-username';
import {
  allocateForUser,
  cleanupExpiredStickyBindings,
  configureStickyBindingTtl,
  getCurrentStickyAddress,
  pickSubnetId,
  refreshUserStickyBindings,
  removeAllStickyBindings,
} from '../src/core/ip-allocator';
import { loadConfig } from '../src/config';
import { addSubnet } from '../src/core/subnets';
import { getDb } from '../src/database/connection';
import { runMigrations } from '../src/database/migrations';

const db = getDb(':memory:');
runMigrations(db);

test.beforeEach(() => configureStickyBindingTtl(24));

test('SOCKS5 username suffixes select allocation mode', () => {
  assert.deepEqual(parseProxyUsername('alice'), {
    baseUsername: 'alice',
    mode: 'random',
    stickyKey: null,
  });
  assert.deepEqual(parseProxyUsername('alice-random'), {
    baseUsername: 'alice',
    mode: 'random',
    stickyKey: null,
  });
  assert.deepEqual(parseProxyUsername('alice-sticky'), {
    baseUsername: 'alice',
    mode: 'sticky',
    stickyKey: 'default',
  });
  assert.deepEqual(parseProxyUsername('alice-sticky-8D3F-4A1B'), {
    baseUsername: 'alice',
    mode: 'sticky',
    stickyKey: '8d3f-4a1b',
  });
  assert.deepEqual(parseProxyUsername('my-user-sticky-work'), {
    baseUsername: 'my-user',
    mode: 'sticky',
    stickyKey: 'work',
  });
  // Invalid or empty keys are not suffix forms; the literal account is tried.
  assert.deepEqual(parseProxyUsername('alice-sticky-'), {
    baseUsername: 'alice-sticky-',
    mode: 'random',
    stickyKey: null,
  });
  assert.deepEqual(parseProxyUsername('alice-sticky-has space'), {
    baseUsername: 'alice-sticky-has space',
    mode: 'random',
    stickyKey: null,
  });
});

test('suffix variants authenticate with the base password', async () => {
  const alice = createUser({ username: 'alice', password: 'secret' });

  const random = await authenticateProxyUser('alice', 'secret');
  assert.equal(random?.user.id, alice.id);
  assert.equal(random?.mode, 'random');
  assert.equal(random?.stickyKey, null);

  const explicitRandom = await authenticateProxyUser('alice-random', 'secret');
  assert.equal(explicitRandom?.user.id, alice.id);
  assert.equal(explicitRandom?.mode, 'random');

  const sticky = await authenticateProxyUser('alice-sticky', 'secret');
  assert.equal(sticky?.user.id, alice.id);
  assert.equal(sticky?.mode, 'sticky');
  assert.equal(sticky?.stickyKey, 'default');

  const keyed = await authenticateProxyUser('alice-sticky-UUID-A', 'secret');
  assert.equal(keyed?.user.id, alice.id);
  assert.equal(keyed?.mode, 'sticky');
  assert.equal(keyed?.stickyKey, 'uuid-a');

  assert.equal(await authenticateProxyUser('alice-sticky-UUID-A', 'wrong'), null);
});

test('a literal suffix account is used only until its base account exists', async () => {
  const literal = createUser({ username: 'bob-sticky', password: 'literal-pass' });

  const literalLogin = await authenticateProxyUser('bob-sticky', 'literal-pass');
  assert.equal(literalLogin?.user.id, literal.id);
  assert.equal(literalLogin?.mode, 'random');

  const bob = createUser({ username: 'bob', password: 'base-pass' });

  // The base account now owns the suffix form...
  const sticky = await authenticateProxyUser('bob-sticky', 'base-pass');
  assert.equal(sticky?.user.id, bob.id);
  assert.equal(sticky?.mode, 'sticky');

  // ...and the literal account's password no longer resolves that username.
  assert.equal(await authenticateProxyUser('bob-sticky', 'literal-pass'), null);
});

test('sticky keys keep independent addresses and expire after 24 hours', () => {
  const subnet = addSubnet('2001:db8:1234::/64');
  const user = createUser({ username: 'sticky-user', password: 'secret' });

  const first = allocateForUser(user.id, subnet.id, 'sticky', 'one');
  const again = allocateForUser(user.id, subnet.id, 'sticky', 'one');
  const second = allocateForUser(user.id, subnet.id, 'sticky', 'two');

  assert.equal(again, first);
  assert.notEqual(second, first);
  assert.equal(pickSubnetId(user.id, [subnet.id], 'sticky', 'one'), subnet.id);

  const addresses = getCurrentStickyAddress(user.id);
  assert.deepEqual(
    addresses.map((entry) => entry.stickyKey),
    ['one', 'two']
  );
  assert.equal(addresses.find((entry) => entry.stickyKey === 'one')?.ipv6Addr, first);

  const expiredAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  db.prepare(
    'UPDATE sticky_bindings SET last_used_at = ? WHERE user_id = ? AND sticky_key = ?'
  ).run(expiredAt, user.id, 'one');

  const afterExpiry = allocateForUser(user.id, subnet.id, 'sticky', 'one');
  assert.notEqual(afterExpiry, first);

  db.prepare('UPDATE sticky_bindings SET last_used_at = ? WHERE user_id = ?')
    .run(expiredAt, user.id);
  assert.equal(cleanupExpiredStickyBindings(), 2);
  assert.equal(getCurrentStickyAddress(user.id).length, 0);
});

test('DETECT_HOST_SUBNETS defaults off and parses booleans', () => {
  const previous = process.env.DETECT_HOST_SUBNETS;
  try {
    delete process.env.DETECT_HOST_SUBNETS;
    assert.equal(loadConfig().detectHostSubnets, false);

    process.env.DETECT_HOST_SUBNETS = 'true';
    assert.equal(loadConfig().detectHostSubnets, true);

    process.env.DETECT_HOST_SUBNETS = 'off';
    assert.equal(loadConfig().detectHostSubnets, false);
  } finally {
    if (previous === undefined) delete process.env.DETECT_HOST_SUBNETS;
    else process.env.DETECT_HOST_SUBNETS = previous;
  }
});

test('STICKY_TTL_HOURS configures the keyed bucket idle window', () => {
  const previous = process.env.STICKY_TTL_HOURS;
  try {
    delete process.env.STICKY_TTL_HOURS;
    assert.equal(loadConfig().stickyTtlHours, 24);

    process.env.STICKY_TTL_HOURS = '240';
    assert.equal(loadConfig().stickyTtlHours, 240);
  } finally {
    if (previous === undefined) delete process.env.STICKY_TTL_HOURS;
    else process.env.STICKY_TTL_HOURS = previous;
  }
});

test('a 240-hour TTL keeps a 25-hour-old bucket and drops it after 241 hours', () => {
  configureStickyBindingTtl(240);
  const subnet = addSubnet('2001:db8:2468::/64');
  const user = createUser({ username: 'long-ttl-user', password: 'secret' });
  const address = allocateForUser(user.id, subnet.id, 'sticky', 'uuid-long');

  const stale25h = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  db.prepare(
    'UPDATE sticky_bindings SET last_used_at = ? WHERE user_id = ? AND sticky_key = ?'
  ).run(stale25h, user.id, 'uuid-long');

  assert.equal(cleanupExpiredStickyBindings(), 0);
  assert.equal(allocateForUser(user.id, subnet.id, 'sticky', 'uuid-long'), address);

  const stale241h = new Date(Date.now() - 241 * 60 * 60 * 1000).toISOString();
  db.prepare(
    'UPDATE sticky_bindings SET last_used_at = ? WHERE user_id = ? AND sticky_key = ?'
  ).run(stale241h, user.id, 'uuid-long');

  assert.equal(cleanupExpiredStickyBindings(), 1);
  assert.equal(getCurrentStickyAddress(user.id).length, 0);
});

test('default sticky bucket persists until an API refresh', () => {
  const subnet = addSubnet('2001:db8:9abc::/64');
  const user = createUser({ username: 'default-user', password: 'secret' });

  const address = allocateForUser(user.id, subnet.id, 'sticky', 'default');
  const expiredAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE sticky_bindings SET last_used_at = ? WHERE user_id = ?')
    .run(expiredAt, user.id);

  assert.equal(cleanupExpiredStickyBindings(), 0);
  assert.equal(allocateForUser(user.id, subnet.id, 'sticky', 'default'), address);
  assert.equal(refreshUserStickyBindings(user.id), 1);
});

test('/128 subnets share their only address across sticky keys', () => {
  const subnet = addSubnet('2001:db8:ffff::1/128');
  const user = createUser({ username: 'warp-user', password: 'secret' });

  const first = allocateForUser(user.id, subnet.id, 'sticky', 'one');
  const second = allocateForUser(user.id, subnet.id, 'sticky', 'two');
  assert.equal(second, first);
});

test('refresh clears every bucket for a user', () => {
  const subnet = addSubnet('2001:db8:5678::/64');
  const user = createUser({ username: 'refresh-user', password: 'secret' });

  allocateForUser(user.id, subnet.id, 'sticky', 'default');
  allocateForUser(user.id, subnet.id, 'sticky', 'uuid-a');

  assert.equal(refreshUserStickyBindings(user.id), 2);
  assert.equal(getCurrentStickyAddress(user.id).length, 0);
  removeAllStickyBindings(user.id);
});

test('migrations upgrade mode-based users and one-address sticky rows', () => {
  const legacy = new Database(':memory:');
  legacy.pragma('foreign_keys = ON');
  legacy.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'random',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE subnets (
      id TEXT PRIMARY KEY,
      cidr TEXT NOT NULL UNIQUE,
      gateway TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE TABLE sticky_bindings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      subnet_id TEXT NOT NULL,
      ipv6_addr TEXT NOT NULL,
      bound_at TEXT NOT NULL,
      UNIQUE(user_id, subnet_id)
    );
    INSERT INTO users VALUES
      ('u1', 'legacy', 'hash', 'sticky', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO subnets VALUES
      ('s1', '2001:db8:1::/64', NULL, 'active', '2026-01-01T00:00:00.000Z');
    INSERT INTO sticky_bindings VALUES
      ('b1', 'u1', 's1', '2001:db8:1::1234', '2026-01-01T00:00:00.000Z');
  `);

  runMigrations(legacy);

  const userColumns = (legacy.prepare('PRAGMA table_info(users)').all() as { name: string }[])
    .map((column) => column.name);
  assert.equal(userColumns.includes('mode'), false);

  const migrated = legacy.prepare(
    'SELECT sticky_key, last_used_at FROM sticky_bindings WHERE id = ?'
  ).get('b1') as { sticky_key: string; last_used_at: string };
  assert.equal(migrated.sticky_key, 'default');
  assert.equal(migrated.last_used_at, '2026-01-01T00:00:00.000Z');

  legacy.prepare(`
    INSERT INTO sticky_bindings
      (id, user_id, subnet_id, sticky_key, ipv6_addr, bound_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'b2', 'u1', 's1', 'uuid-a', '2001:db8:1::5678',
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
  );
  assert.equal(
    (legacy.prepare('SELECT COUNT(*) AS count FROM sticky_bindings').get() as { count: number }).count,
    2
  );

  legacy.close();
});

