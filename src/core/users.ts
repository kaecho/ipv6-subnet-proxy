import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcrypt';
import { getDb } from '../database/connection';
import { loadConfig } from '../config';
import { getLogger } from '../utils/logger';
import { getActiveSessions, forceDisconnect } from './sessions';
import { removeAllStickyBindings } from './ip-allocator';
import {
  parseProxyUsername,
  type ProxyMode,
} from './proxy-username';

export interface User {
  id: string;
  username: string;
  status: 'active' | 'disabled';
  created_at: string;
  updated_at: string;
}

export interface CreateUserInput {
  username: string;
  password: string;
}

export interface UpdateUserInput {
  password?: string;
  status?: 'active' | 'disabled';
}

export type { ParsedProxyUsername, ProxyMode } from './proxy-username';

/**
 * The account a SOCKS5 login resolves to, plus how that connection should be
 * allocated. The base account keeps one password; the suffix on the SOCKS5
 * username selects the allocation behaviour.
 */
export interface ProxyIdentity {
  user: User;
  mode: ProxyMode;
  /** Sticky namespace; `default` for plain `-sticky`, null for random. */
  stickyKey: string | null;
}

/**
 * bcrypt takes 60-100 ms by design, and every SOCKS5 connection performs an
 * authentication. Cache the successful result so a burst of connections from
 * one client costs a single comparison; a password or status change clears
 * the whole cache.
 */
const AUTH_CACHE_TTL_MS = 60_000;
const AUTH_CACHE_MAX_ENTRIES = 1024;

interface AuthCacheEntry {
  identity: ProxyIdentity;
  expiresAt: number;
}

const authCache = new Map<string, AuthCacheEntry>();
/**
 * Bumped whenever the cache is cleared. An async bcrypt comparison that
 * started before an update must not write its now-stale result back in.
 */
let authCacheGeneration = 0;

/** Key by username + password, never the plaintext password itself. */
function authCacheKey(username: string, password: string): string {
  return crypto.createHash('sha256').update(username).update('\0').update(password).digest('hex');
}

function pruneAuthCache(now: number): void {
  for (const [key, entry] of authCache) {
    if (entry.expiresAt <= now) authCache.delete(key);
  }
  while (authCache.size >= AUTH_CACHE_MAX_ENTRIES) {
    const oldest = authCache.keys().next();
    if (oldest.done) return;
    authCache.delete(oldest.value);
  }
}

function rowToUser(row: User): User {
  return {
    id: row.id,
    username: row.username,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createUser(input: CreateUserInput): User {
  const db = getDb();
  const config = loadConfig();
  const log = getLogger();

  const id = uuidv4();
  const now = new Date().toISOString();
  const hashedPassword = bcrypt.hashSync(input.password, config.bcryptRounds);

  db.prepare(`
    INSERT INTO users (id, username, password, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)
  `).run(id, input.username, hashedPassword, now, now);

  // Auto-bind all active subnets to the new user
  const subnets = db.prepare(
    "SELECT id FROM subnets WHERE status = 'active'"
  ).all() as { id: string }[];
  for (const subnet of subnets) {
    db.prepare(
      'INSERT OR IGNORE INTO user_subnet_bindings (id, user_id, subnet_id) VALUES (?, ?, ?)'
    ).run(uuidv4(), id, subnet.id);
  }

  log.info({ userId: id, username: input.username, autoBoundSubnets: subnets.length }, 'User created');

  // A new base account can change how an existing literal `name-sticky` login
  // resolves, so cached identities must not outlive the insert.
  authCache.clear();
  authCacheGeneration++;

  return { id, username: input.username, status: 'active', created_at: now, updated_at: now };
}

interface AuthRow extends User {
  password: string;
}

/**
 * Resolve a SOCKS5 username to its base account and allocation behaviour.
 * A suffix form wins when the base account exists; otherwise the literal
 * username is used as its own base account.
 */
function resolveLogin(username: string): {
  row: AuthRow;
  mode: ProxyMode;
  stickyKey: string | null;
} | null {
  const db = getDb();
  const parsed = parseProxyUsername(username);
  const findByUsername = db.prepare(
    'SELECT id, username, password, status, created_at, updated_at FROM users WHERE username = ?'
  );

  if (parsed.baseUsername !== username) {
    const base = findByUsername.get(parsed.baseUsername) as AuthRow | undefined;
    if (base) {
      return { row: base, mode: parsed.mode, stickyKey: parsed.stickyKey };
    }
  }

  const literal = findByUsername.get(username) as AuthRow | undefined;
  if (!literal) return null;
  return { row: literal, mode: 'random', stickyKey: null };
}

export async function authenticateProxyUser(
  username: string,
  password: string
): Promise<ProxyIdentity | null> {
  const key = authCacheKey(username, password);
  const now = Date.now();
  const generation = authCacheGeneration;
  const cached = authCache.get(key);
  if (cached) {
    if (cached.expiresAt > now) return cached.identity;
    authCache.delete(key);
  }

  const login = resolveLogin(username);
  if (!login || login.row.status === 'disabled') return null;
  // Async compare keeps the event loop free while bcrypt works in libuv.
  if (!(await bcrypt.compare(password, login.row.password))) return null;
  // A password/status change landed while bcrypt was running. The row we
  // read is no longer authoritative; reject rather than caching it.
  if (generation !== authCacheGeneration) return null;

  const identity: ProxyIdentity = {
    user: rowToUser(login.row),
    mode: login.mode,
    stickyKey: login.stickyKey,
  };
  pruneAuthCache(now);
  authCache.set(key, { identity, expiresAt: now + AUTH_CACHE_TTL_MS });
  return identity;
}

export function getUser(id: string): User | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT id, username, status, created_at, updated_at FROM users WHERE id = ?'
  ).get(id) as User | undefined;
  return row ? rowToUser(row) : null;
}

export function listUsers(): User[] {
  const db = getDb();
  return (db.prepare(
    'SELECT id, username, status, created_at, updated_at FROM users ORDER BY created_at DESC'
  ).all() as User[]).map(rowToUser);
}

export function updateUser(id: string, input: UpdateUserInput): User {
  const db = getDb();
  const log = getLogger();
  const now = new Date().toISOString();

  const user = getUser(id);
  if (!user) throw new Error(`User ${id} not found`);

  if (input.password !== undefined) {
    const config = loadConfig();
    const hashedPassword = bcrypt.hashSync(input.password, config.bcryptRounds);
    db.prepare('UPDATE users SET password = ?, updated_at = ? WHERE id = ?')
      .run(hashedPassword, now, id);
    log.info({ userId: id }, 'Password updated');
  }
  if (input.status !== undefined) {
    db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?')
      .run(input.status, now, id);
    log.info({ userId: id, status: input.status }, 'User status updated');
  }

  // Invalidate only after the writes land: a verification that read the old
  // row either finishes before this clear or sees a generation mismatch.
  authCache.clear();
  authCacheGeneration++;

  return getUser(id)!;
}

export function enableUser(id: string): User {
  return updateUser(id, { status: 'active' });
}

export function disableUser(id: string): User {
  return updateUser(id, { status: 'disabled' });
}

export function deleteUser(id: string): void {
  const db = getDb();
  const log = getLogger();

  // Disconnect all active sessions for this user
  const sessions = getActiveSessions().filter(s => s.userId === id);
  for (const s of sessions) {
    forceDisconnect(s.id);
  }
  log.info({ userId: id, disconnectedSessions: sessions.length }, 'Disconnected active sessions for deleted user');

  removeAllStickyBindings(id);

  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  authCache.clear();
  authCacheGeneration++;
  log.info({ userId: id }, 'User deleted');
}
