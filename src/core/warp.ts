/**
 * Cloudflare WARP links.
 *
 * WARP gives away a routable IPv6 address over WireGuard, for free and without
 * an account. That solves the same problem as the 6in4 tunnel in `tunnel.ts` —
 * IPv6 egress on a host that has none — but from the opposite direction:
 *
 *   6in4 broker   one signup, one *routed prefix*, 2^80 addresses behind it
 *   WARP          no signup, one address per registration
 *
 * So where the tunnel gets a prefix and generates addresses inside it, WARP
 * gets breadth by registering several devices. Each registration becomes its
 * own WireGuard interface with its own /128, and each /128 is registered as a
 * one-address subnet. The proxy's existing per-user subnet selection then does
 * the rotation for free: `random` users land on a different WARP address per
 * connection, `sticky` users keep one.
 *
 * What gets configured per link:
 *
 *   wireguard device  the WireGuard tunnel to Cloudflare's anycast endpoint
 *   address           the /128 Cloudflare assigned, which is also the egress IP
 *   policy route      traffic *sourced from* that address leaves through that
 *                     link, in its own table, so the host's own traffic and any
 *                     native IPv6 it has are left alone
 *
 * Nothing is put in the main routing table: WARP here is an egress pool for the
 * proxy, not a VPN for the whole box.
 *
 * As in `tunnel.ts`, the command sequences are built by pure functions so the
 * exact `ip`/`wg` invocations can be asserted in tests without root or a network.
 */
import dns from 'dns';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { execFileSync } from 'child_process';
import { WarpConfig } from '../config';
import { getDb } from '../database/connection';
import { getLogger } from '../utils/logger';
import {
  SourceProbe,
  normalizeCIDR,
  parseCIDR,
  registerInterfaceForPrefix,
  clearPrefixInterfaces,
  pinIPv6Address,
  clearPinnedIPv6Addresses,
  probeFromSource,
} from '../utils/ipv6';
import {
  WarpAccount,
  registerWarpAccount,
  applyWarpLicense,
  publicKeyFromPrivate,
  reservedFromClientId,
} from './warp-api';

/** Placeholder for the private-key file, substituted when the plan is executed. */
export const PRIVATE_KEY_FILE = '%WARP_PRIVATE_KEY_FILE%';

export interface WarpLink {
  slot: number;
  device: string;
  /** The assigned address, without a prefix length. */
  address: string;
  /** The same address as a /128 — this link's entire allocation pool. */
  cidr: string;
  /** Cloudflare's peer, resolved to a literal `ip:port`. */
  endpoint: string;
  peerPublicKey: string;
  privateKey: string;
  table: number;
  /** Rule priority; kept below the main table's 32766 so this rule wins. */
  priority: number;
  mtu: number;
  keepalive: number;
}

export interface WarpCommand {
  bin: 'ip' | 'wg';
  args: string[];
  /** Failure degrades the link but does not break it. */
  optional?: boolean;
}

export interface WarpPlan {
  teardown: WarpCommand[];
  setup: WarpCommand[];
}

export interface WarpLinkState {
  slot: number;
  device: string;
  address: string;
  cidr: string;
  endpoint: string;
  table: number;
  accountType: string | null;
  up: boolean;
  error: string | null;
  probe: SourceProbe | null;
}

export interface WarpState {
  enabled: boolean;
  up: boolean;
  links: WarpLinkState[];
  /** The /128s that are usable as allocation subnets right now. */
  cidrs: string[];
  startedAt: string | null;
  warnings: string[];
}

let _cfg: WarpConfig | null = null;
let _links: WarpLink[] = [];
let _state: WarpState = emptyState();

function emptyState(): WarpState {
  return { enabled: false, up: false, links: [], cidrs: [], startedAt: null, warnings: [] };
}

// --- account persistence ------------------------------------------------------

/**
 * Registrations are kept so a restart reuses the same addresses. Re-registering
 * on every boot would hand every user a new egress IP and pointlessly consume
 * Cloudflare's registration quota.
 */
function rowToAccount(row: any): WarpAccount {
  return {
    slot: row.slot,
    deviceId: row.device_id,
    token: row.token,
    accountId: row.account_id,
    accountType: row.account_type,
    license: row.license,
    privateKey: row.private_key,
    publicKey: row.public_key,
    peerPublicKey: row.peer_public_key,
    endpointHost: row.endpoint_host || '',
    clientId: row.client_id,
    reserved: reservedFromClientId(row.client_id),
    addressV4: row.address_v4,
    addressV6: row.address_v6,
  };
}

export function listStoredAccounts(): WarpAccount[] {
  const db = getDb();
  return (db.prepare('SELECT * FROM warp_accounts ORDER BY slot ASC').all() as any[]).map(rowToAccount);
}

function storeAccount(account: WarpAccount): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO warp_accounts
       (id, slot, device_id, token, account_id, account_type, license, private_key,
        public_key, peer_public_key, client_id, endpoint_host, address_v4, address_v6, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(slot) DO UPDATE SET
       device_id = excluded.device_id, token = excluded.token, account_id = excluded.account_id,
       account_type = excluded.account_type, license = excluded.license,
       private_key = excluded.private_key, public_key = excluded.public_key,
       peer_public_key = excluded.peer_public_key, client_id = excluded.client_id,
       endpoint_host = excluded.endpoint_host, address_v4 = excluded.address_v4,
       address_v6 = excluded.address_v6`
  ).run(
    uuidv4(),
    account.slot,
    account.deviceId,
    account.token,
    account.accountId,
    account.accountType,
    account.license,
    account.privateKey,
    account.publicKey,
    account.peerPublicKey,
    account.clientId,
    account.endpointHost,
    account.addressV4,
    account.addressV6,
    new Date().toISOString()
  );
}

export function clearStoredAccounts(): void {
  getDb().prepare('DELETE FROM warp_accounts').run();
}

// --- pure helpers -------------------------------------------------------------

/** Split `host:port`, `1.2.3.4:2408` or `[2606:4700::1]:2408`. */
export function parseEndpoint(raw: string, defaultPort: number): { host: string; port: number } {
  const value = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
  if (bracketed) {
    return { host: bracketed[1], port: bracketed[2] ? parseInt(bracketed[2], 10) : defaultPort };
  }

  const colon = value.lastIndexOf(':');
  // More than one colon and no brackets: a bare IPv6 literal, no port.
  if (colon === -1 || value.indexOf(':') !== colon) {
    return { host: value, port: defaultPort };
  }

  const port = parseInt(value.slice(colon + 1), 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`WARP endpoint has an invalid port: ${raw}`);
  }
  return { host: value.slice(0, colon), port };
}

export function warpDeviceName(prefix: string, slot: number): string {
  const name = `${prefix}${slot}`;
  // Linux caps interface names at 15 characters.
  if (name.length > 15) {
    throw new Error(`WARP_DEVICE_PREFIX is too long: "${name}" exceeds the 15-character interface name limit`);
  }
  return name;
}

export function planWarpTeardown(link: WarpLink): WarpCommand[] {
  const table = String(link.table);
  const pref = String(link.priority);
  return [
    { bin: 'ip', args: ['-6', 'rule', 'del', 'from', link.cidr, 'lookup', table, 'pref', pref], optional: true },
    { bin: 'ip', args: ['-6', 'route', 'flush', 'table', table], optional: true },
    { bin: 'ip', args: ['link', 'del', link.device], optional: true },
  ];
}

/**
 * `allowed-ips` is IPv6-only on purpose: this link exists to carry the proxy's
 * IPv6 egress, and nothing should be able to pull the host's IPv4 into it.
 */
export function planWarpSetup(link: WarpLink, privateKeyFile: string = PRIVATE_KEY_FILE): WarpPlan {
  const table = String(link.table);
  return {
    teardown: planWarpTeardown(link),
    setup: [
      { bin: 'ip', args: ['link', 'add', 'dev', link.device, 'type', 'wireguard'] },
      {
        bin: 'wg',
        args: [
          'set', link.device,
          'private-key', privateKeyFile,
          'peer', link.peerPublicKey,
          'endpoint', link.endpoint,
          'allowed-ips', '::/0',
          'persistent-keepalive', String(link.keepalive),
        ],
      },
      { bin: 'ip', args: ['link', 'set', 'dev', link.device, 'mtu', String(link.mtu), 'up'] },
      { bin: 'ip', args: ['-6', 'addr', 'replace', link.cidr, 'dev', link.device] },
      // Everything reachable through this link, in a table of its own.
      { bin: 'ip', args: ['-6', 'route', 'replace', 'default', 'dev', link.device, 'table', table] },
      {
        bin: 'ip',
        args: ['-6', 'rule', 'add', 'from', link.cidr, 'lookup', table, 'pref', String(link.priority)],
      },
    ],
  };
}

export function buildLink(cfg: WarpConfig, account: WarpAccount, endpoint: string): WarpLink {
  const cidr = normalizeCIDR(`${account.addressV6}/128`);
  return {
    slot: account.slot,
    device: warpDeviceName(cfg.devicePrefix, account.slot),
    address: parseCIDR(cidr).prefix,
    cidr,
    endpoint,
    peerPublicKey: account.peerPublicKey,
    privateKey: account.privateKey,
    table: cfg.routeTable + account.slot,
    priority: cfg.rulePriority + account.slot,
    mtu: cfg.mtu,
    keepalive: cfg.keepalive,
  };
}

// --- execution ----------------------------------------------------------------

function runCommand(cmd: WarpCommand): { ok: boolean; stderr: string } {
  try {
    execFileSync(cmd.bin, cmd.args, { timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, stderr: '' };
  } catch (err: any) {
    const stderr = (err.stderr?.toString() || err.stdout?.toString() || err.message || '').trim();
    return { ok: false, stderr };
  }
}

/** Turn the terse failures of `ip` and `wg` into something the operator can act on. */
function explainFailure(cmd: WarpCommand, stderr: string): string {
  const lower = stderr.toLowerCase();
  const text = `${cmd.bin} ${cmd.args.join(' ')}`;

  if (lower.includes('operation not permitted') || lower.includes('permission denied')) {
    return `${text}: permission denied. WARP needs NET_ADMIN — run as root, or give the container --cap-add=NET_ADMIN.`;
  }
  if (cmd.args.includes('wireguard') && (lower.includes('not supported') || lower.includes('unknown device type'))) {
    return `${text}: the kernel has no WireGuard support loaded. Run "modprobe wireguard" on the host ` +
      '(persist it in /etc/modules-load.d/wireguard.conf); inside Docker the module must be loaded on the host, not in the container.';
  }
  if (cmd.bin === 'wg' && (lower.includes('not found') || lower.includes('enoent'))) {
    return `${text}: the "wg" tool is not installed. Install wireguard-tools (apk add wireguard-tools / apt install wireguard-tools).`;
  }
  if (lower.includes('invalid argument') && cmd.args.includes('rule')) {
    return `${text}: the kernel lacks IPv6 policy routing (CONFIG_IPV6_MULTIPLE_TABLES).`;
  }
  return `${text}: ${stderr || 'failed'}`;
}

/**
 * `wg` reads the private key from a file rather than argv, which is what we
 * want anyway: an argv key is visible in /proc to every process on the box.
 * The file lives in a 0700 directory for the length of one command.
 */
function withPrivateKeyFile<T>(privateKey: string, fn: (file: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warp-key-'));
  const file = path.join(dir, 'private');
  try {
    fs.writeFileSync(file, `${privateKey}\n`, { mode: 0o600 });
    return fn(file);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort; the directory is 0700 and in the private tmpdir
    }
  }
}

function warnIfNoWireguardTools(): string[] {
  try {
    execFileSync('wg', ['--version'], { encoding: 'utf-8', timeout: 3000 });
    return [];
  } catch {
    return [
      'The "wg" tool is not on PATH. WARP needs wireguard-tools ' +
        '(apk add wireguard-tools / apt install wireguard-tools).',
    ];
  }
}

/** Build one link. Throws if a required command fails; returns non-fatal warnings. */
export function applyLink(link: WarpLink): string[] {
  const log = getLogger();
  const warnings: string[] = [];

  const plan = withPrivateKeyFile(link.privateKey, (file) => planWarpSetup(link, file));

  // Teardown first: this is what makes bring-up idempotent across restarts.
  for (const cmd of plan.teardown) {
    const result = runCommand(cmd);
    log.debug({ cmd: `${cmd.bin} ${cmd.args.join(' ')}`, ok: result.ok }, 'WARP teardown command');
  }

  for (const cmd of plan.setup) {
    const result = runCommand(cmd);
    if (result.ok) {
      log.debug({ cmd: `${cmd.bin} ${cmd.args.join(' ')}` }, 'WARP setup command');
      continue;
    }
    const message = explainFailure(cmd, result.stderr);
    if (cmd.optional) {
      log.warn({ err: result.stderr }, message);
      warnings.push(message);
      continue;
    }
    throw new Error(message);
  }

  // Addresses from this link belong on its own device, and the address is the
  // device's own — sessions must not add or remove it as they come and go.
  registerInterfaceForPrefix(link.cidr, link.device);
  pinIPv6Address(link.address);

  log.info(
    { device: link.device, address: link.address, endpoint: link.endpoint, table: link.table, mtu: link.mtu },
    'WARP link is up'
  );
  return warnings;
}

export function teardownLink(link: WarpLink): void {
  for (const cmd of planWarpTeardown(link)) {
    runCommand(cmd);
  }
  clearPrefixInterfaces(link.device);
}

/** Interface names of the form `<prefix><slot>` that currently exist on the host. */
export function parseWarpDevices(ipLinkOutput: string, devicePrefix: string): { device: string; slot: number }[] {
  const escaped = devicePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}(\\d+)$`);
  const found: { device: string; slot: number }[] = [];

  for (const line of ipLinkOutput.split('\n')) {
    // `ip -o link show` lines look like: `7: warp0: <POINTOPOINT,...> mtu 1280 ...`
    const name = /^\d+:\s+([^:@\s]+)/.exec(line)?.[1];
    if (!name) continue;
    const match = pattern.exec(name);
    if (match) found.push({ device: name, slot: parseInt(match[1], 10) });
  }

  return found;
}

/**
 * Remove WARP devices that no live slot claims.
 *
 * A hard kill leaves the devices behind, and lowering WARP_ACCOUNTS orphans the
 * slots that were dropped. Neither is cleaned up by the per-link teardown,
 * which only knows about the links this run is building. The orphan's address
 * is unknown by then, so its rule is deleted by priority instead.
 */
function reapOrphanedLinks(cfg: WarpConfig, activeSlots: Set<number>): void {
  const log = getLogger();

  let output: string;
  try {
    output = execFileSync('ip', ['-o', 'link', 'show'], { encoding: 'utf-8', timeout: 5000 });
  } catch {
    return;
  }

  for (const { device, slot } of parseWarpDevices(output, cfg.devicePrefix)) {
    if (activeSlots.has(slot)) continue;

    runCommand({ bin: 'ip', args: ['-6', 'rule', 'del', 'pref', String(cfg.rulePriority + slot)] });
    runCommand({ bin: 'ip', args: ['-6', 'route', 'flush', 'table', String(cfg.routeTable + slot)] });
    runCommand({ bin: 'ip', args: ['link', 'del', device] });
    clearPrefixInterfaces(device);
    log.info({ device, slot }, 'Removed an orphaned WARP link');
  }
}

// --- endpoint resolution -------------------------------------------------------

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/**
 * Resolve Cloudflare's endpoint to a literal IPv4 address.
 *
 * `wg` would resolve the name itself, but it only does so once and reports
 * nothing useful when it fails. Doing it here also forces IPv4, which is the
 * only family a host that needs WARP for IPv6 can use to reach it.
 */
export async function resolveEndpoint(cfg: WarpConfig, hostPort: string): Promise<string> {
  const { host, port } = parseEndpoint(hostPort || cfg.endpoint, 2408);
  if (isIpLiteral(host)) {
    return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
  }

  const lookup = dns.promises.lookup(host, { family: 4 });
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`DNS lookup for ${host} timed out`)), cfg.requestTimeoutMs)
  );

  try {
    const { address } = await Promise.race([lookup, timeout]);
    return `${address}:${port}`;
  } catch (err: any) {
    throw new Error(
      `Could not resolve the WARP endpoint ${host} over IPv4: ${err.message}. ` +
        'Set WARP_ENDPOINT to a literal address (e.g. 162.159.192.1:2408).'
    );
  }
}

// --- orchestration --------------------------------------------------------------

/** Reuse a stored registration for each slot, registering only the ones missing. */
async function ensureAccounts(cfg: WarpConfig, state: WarpState): Promise<WarpAccount[]> {
  const log = getLogger();
  const stored = new Map(listStoredAccounts().map((a) => [a.slot, a]));
  const accounts: WarpAccount[] = [];
  // Paced against API calls rather than successes: a rejected registration is
  // the case that most needs backing off before the next one.
  let calledApi = false;

  for (let slot = 0; slot < cfg.accounts; slot++) {
    const existing = stored.get(slot);
    if (existing) {
      // The public key is derived rather than trusted, so a stored row that
      // predates a key change cannot silently produce a dead link.
      try {
        existing.publicKey = publicKeyFromPrivate(existing.privateKey);
        accounts.push(existing);
        continue;
      } catch (err: any) {
        log.warn({ slot, err: err.message }, 'Stored WARP account is unusable; registering a new one');
      }
    }

    try {
      if (calledApi && cfg.registerDelayMs > 0) {
        // Cloudflare rate-limits bursts of registrations.
        await new Promise((resolve) => setTimeout(resolve, cfg.registerDelayMs));
      }
      calledApi = true;

      const account = await registerWarpAccount(cfg, slot);

      if (cfg.license) {
        try {
          const upgraded = await applyWarpLicense(cfg, account, cfg.license);
          account.accountType = upgraded.accountType ?? account.accountType;
          account.license = upgraded.license ?? cfg.license;
          log.info({ slot, accountType: account.accountType }, 'Applied the WARP+ licence');
        } catch (err: any) {
          log.warn({ slot, err: err.message }, 'WARP+ licence could not be applied; continuing on the free tier');
          state.warnings.push(`WARP licence not applied: ${err.message}`);
        }
      }

      storeAccount(account);
      accounts.push(account);
      log.info(
        { slot, address: account.addressV6, accountType: account.accountType },
        'Registered a Cloudflare WARP device'
      );
    } catch (err: any) {
      log.error({ slot, err: err.message }, 'WARP registration failed');
      state.warnings.push(`Slot ${slot}: ${err.message}`);
    }
  }

  return accounts;
}

/**
 * Bring up every WARP link. Returns the resulting state; never throws, so a
 * failed link degrades the proxy to whatever other IPv6 it has rather than
 * stopping it from starting.
 */
export async function startWarp(cfg: WarpConfig): Promise<WarpState> {
  const log = getLogger();
  _cfg = cfg;
  const state = emptyState();
  state.enabled = cfg.enabled;

  if (!cfg.enabled) {
    _state = state;
    _links = [];
    return state;
  }

  log.info({ accounts: cfg.accounts }, 'Setting up Cloudflare WARP...');
  state.warnings.push(...warnIfNoWireguardTools());

  // Only WARP links pin addresses, so a rebuild can start from a clean slate.
  clearPinnedIPv6Addresses();
  for (const link of _links) clearPrefixInterfaces(link.device);
  _links = [];

  try {
    if (cfg.reset) {
      log.warn('WARP_RESET is set: discarding stored registrations and registering new devices');
      clearStoredAccounts();
    }

    const accounts = await ensureAccounts(cfg, state);
    reapOrphanedLinks(cfg, new Set(accounts.map((a) => a.slot)));

    if (accounts.length === 0) {
      state.warnings.push('No WARP account could be registered; no WARP addresses are available');
      _state = state;
      return state;
    }

    for (const account of accounts) {
      const linkState: WarpLinkState = {
        slot: account.slot,
        device: warpDeviceName(cfg.devicePrefix, account.slot),
        address: account.addressV6,
        cidr: normalizeCIDR(`${account.addressV6}/128`),
        endpoint: account.endpointHost || cfg.endpoint,
        table: cfg.routeTable + account.slot,
        accountType: account.accountType,
        up: false,
        error: null,
        probe: null,
      };
      state.links.push(linkState);

      try {
        const endpoint = await resolveEndpoint(cfg, account.endpointHost || cfg.endpoint);
        const link = buildLink(cfg, account, endpoint);
        linkState.endpoint = endpoint;
        state.warnings.push(...applyLink(link));
        _links.push(link);
        linkState.up = true;
        state.cidrs.push(link.cidr);
      } catch (err: any) {
        // One dead link should not cost us the others.
        log.error({ slot: account.slot, err: err.message }, 'WARP link setup failed');
        linkState.error = err.message;
        state.warnings.push(`Slot ${account.slot}: ${err.message}`);
      }
    }

    state.up = state.cidrs.length > 0;
    state.startedAt = state.up ? new Date().toISOString() : null;

    if (state.up && cfg.verify) {
      await verifyWarp(cfg, state);
    }
  } catch (err: any) {
    log.error({ err: err.message }, 'WARP setup failed');
    state.warnings.push(err.message);
    state.up = false;
  }

  _state = state;
  return state;
}

/** Prove each link carries traffic by connecting out from its own address. */
export async function verifyWarp(cfg: WarpConfig, state: WarpState = _state): Promise<SourceProbe[]> {
  const log = getLogger();
  const probes: SourceProbe[] = [];

  for (const linkState of state.links) {
    if (!linkState.up) continue;
    const probe = await probeFromSource(linkState.address, cfg.verifyHost, cfg.verifyPort, 8000);
    linkState.probe = probe;
    probes.push(probe);

    if (probe.ok) {
      log.info({ device: linkState.device }, `WARP verified: ${probe.detail}`);
    } else {
      log.warn({ device: linkState.device }, `WARP verification failed: ${probe.detail}`);
    }
  }

  if (probes.length > 0 && probes.every((p) => !p.ok)) {
    state.warnings.push(
      'No traffic passed over any WARP link. Check that UDP to Cloudflare on port ' +
        '2408 is not blocked, and that the wireguard kernel module is loaded.'
    );
  }

  return probes;
}

/** Re-run bring-up with the config the process started with (API-triggered). */
export async function reconnectWarp(): Promise<WarpState> {
  if (!_cfg) throw new Error('WARP support is not configured');
  return startWarp(_cfg);
}

export function stopWarp(): void {
  const log = getLogger();
  if (!_cfg || _links.length === 0) return;

  if (!_cfg.teardownOnExit) {
    log.info('Leaving the WARP links up (WARP_TEARDOWN_ON_EXIT=false)');
    return;
  }

  for (const link of _links) {
    teardownLink(link);
  }
  log.info({ links: _links.length }, 'WARP links torn down');
  _links = [];
  _state.up = false;
}

export function getWarpState(): WarpState {
  return _state;
}

export function getWarpConfig(): WarpConfig | null {
  return _cfg;
}
