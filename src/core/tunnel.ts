/**
 * 6in4 tunnel bring-up.
 *
 * A tunnel broker hands out a routed prefix — Hurricane Electric gives a /48,
 * which is 2^80 addresses — and delivers it over an RFC 4213 tunnel that only
 * needs IPv4 to reach. That makes the proxy's egress pool independent of
 * whether the host has any IPv6 of its own.
 *
 * What gets configured:
 *
 *   sit device      encapsulates IPv6 in IPv4 towards the broker's endpoint
 *   client address  our end of the tunnel link (their end is the far side)
 *   policy route    traffic *sourced from* the tunnelled prefixes goes out the
 *                   tunnel, in its own table, so a host that already has native
 *                   IPv6 keeps using it for everything else
 *   local route     the whole routed prefix is delivered locally, which is what
 *                   lets any address in it answer as if it were configured
 *
 * The `ip` invocations are built by pure functions so the exact sequence can be
 * asserted in tests without root or a network.
 */
import os from 'os';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { TunnelConfig } from '../config';
import { getLogger } from '../utils/logger';
import {
  SourceProbe,
  parseCIDR,
  normalizeCIDR,
  generateIPv6,
  collapseNestedSubnets,
  registerInterfaceForPrefix,
  clearPrefixInterfaces,
  registerIPv6Address,
  forceUnregisterIPv6Address,
  resetOutboundInterface,
  probeFromSource,
} from '../utils/ipv6';
import {
  TunnelInfo,
  UpdateResult,
  fetchTunnelInfo,
  updateTunnelEndpoint,
  detectPublicIPv4,
  isIPv4,
} from './tunnelbroker';

export interface TunnelSpec {
  device: string;
  serverIpv4: string;
  serverIpv6: string | null;
  /** Our address on the tunnel link, without a prefix length. */
  clientIpv6: string;
  clientPrefixLength: number;
  /** The tunnel link prefix — routed to us, but not an allocation pool. */
  linkPrefix: string;
  localIpv4: string;
  /** Prefixes routed to this tunnel, normalized and de-nested. */
  routedPrefixes: string[];
  mtu: number;
  ttl: number;
}

export interface IpCommand {
  args: string[];
  /** Failure degrades the setup but does not break it. */
  optional?: boolean;
}

export interface TunnelPlan {
  teardown: IpCommand[];
  setup: IpCommand[];
}

export type TunnelProbe = SourceProbe;

export interface TunnelState {
  enabled: boolean;
  device: string;
  up: boolean;
  spec: TunnelSpec | null;
  info: TunnelInfo | null;
  localIpv4: string | null;
  /** The tunnel's local IPv4 is not this host's public one — NAT in between. */
  natted: boolean;
  publicIpv4: string | null;
  endpointUpdate: (UpdateResult & { at: string }) | null;
  probes: TunnelProbe[];
  startedAt: string | null;
  warnings: string[];
}

let _cfg: TunnelConfig | null = null;
let _state: TunnelState = emptyState('he-ipv6');
let _watcher: NodeJS.Timeout | null = null;
let _watcherBusy = false;

/** HE asks clients not to hammer the endpoint update. */
const MIN_UPDATE_INTERVAL_MS = 60_000;

function emptyState(device: string): TunnelState {
  return {
    enabled: false,
    device,
    up: false,
    spec: null,
    info: null,
    localIpv4: null,
    natted: false,
    publicIpv4: null,
    endpointUpdate: null,
    probes: [],
    startedAt: null,
    warnings: [],
  };
}

// --- pure helpers ------------------------------------------------------------

/** Split `2001:470:35:380::2/64` (or a bare address) into address + length. */
export function parseClientIpv6(raw: string): { address: string; prefixLength: number } {
  const value = raw.trim();
  const slash = value.indexOf('/');
  const address = (slash === -1 ? value : value.slice(0, slash)).trim();
  const prefixLength = slash === -1 ? 64 : parseInt(value.slice(slash + 1), 10);

  if (isNaN(prefixLength) || prefixLength < 1 || prefixLength > 128) {
    throw new Error(`Invalid prefix length in client IPv6 "${raw}": must be 1-128`);
  }
  // Throws on anything that is not an IPv6 address.
  parseCIDR(`${address}/128`);
  return { address, prefixLength };
}

export function listLocalIPv4(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

/**
 * Pick the address for the tunnel's IPv4 endpoint.
 *
 * The broker tunnels to our *public* address, but the sit device has to be
 * anchored to an address that actually exists on this host. Those differ behind
 * NAT, where the tunnel still works as long as the router forwards protocol 41.
 */
export function chooseLocalIPv4(opts: {
  configured?: string | null;
  publicIpv4?: string | null;
  locals: string[];
}): { address: string; natted: boolean } {
  const { configured, publicIpv4, locals } = opts;

  if (configured) {
    if (!isIPv4(configured)) {
      throw new Error(`HE_TUNNEL_LOCAL_IPV4 must be an IPv4 address, got: ${configured}`);
    }
    return { address: configured, natted: locals.length > 0 && !locals.includes(configured) };
  }

  if (publicIpv4 && locals.includes(publicIpv4)) {
    return { address: publicIpv4, natted: false };
  }

  if (locals.length === 0) {
    throw new Error(
      'No non-loopback IPv4 address found for the tunnel endpoint. Set HE_TUNNEL_LOCAL_IPV4 explicitly.'
    );
  }

  return { address: locals[0], natted: Boolean(publicIpv4) && publicIpv4 !== locals[0] };
}

/** Merge what the broker reported with the environment; the environment wins. */
export function resolveTunnelSpec(cfg: TunnelConfig, info: TunnelInfo | null, localIpv4: string): TunnelSpec {
  const serverIpv4 = cfg.serverIpv4 || info?.serverIpv4 || null;
  const clientIpv6Raw = cfg.clientIpv6 || info?.clientIpv6 || null;

  if (!serverIpv4) {
    throw new Error('Tunnel server IPv4 is unknown — set HE_TUNNEL_SERVER_IPV4 or supply API credentials');
  }
  if (!isIPv4(serverIpv4)) {
    throw new Error(`Tunnel server IPv4 is not an IPv4 address: ${serverIpv4}`);
  }
  if (!clientIpv6Raw) {
    throw new Error('Tunnel client IPv6 is unknown — set HE_TUNNEL_CLIENT_IPV6 or supply API credentials');
  }

  const { address, prefixLength } = parseClientIpv6(clientIpv6Raw);

  const rawPrefixes =
    cfg.routedPrefixes.length > 0
      ? cfg.routedPrefixes
      : [info?.routed48, info?.routed64].filter((p): p is string => Boolean(p));

  if (rawPrefixes.length === 0) {
    throw new Error(
      'No routed prefix for the tunnel — set HE_TUNNEL_ROUTED_PREFIXES to the ' +
        'prefixes the broker routes to it (e.g. 2001:470:ecf2::/48)'
    );
  }

  const linkPrefix = normalizeCIDR(`${address}/${prefixLength}`);
  const routedPrefixes = collapseNestedSubnets(
    Array.from(new Set(rawPrefixes.map((p) => normalizeCIDR(p))))
    // The link prefix carries the two endpoint addresses; it is not a pool.
  ).filter((p) => p !== linkPrefix);

  if (routedPrefixes.length === 0) {
    throw new Error('The only prefix configured for the tunnel is its link prefix; a routed prefix is required');
  }

  return {
    device: cfg.device,
    serverIpv4,
    serverIpv6: cfg.serverIpv6 || info?.serverIpv6 || null,
    clientIpv6: address,
    clientPrefixLength: prefixLength,
    linkPrefix,
    localIpv4,
    routedPrefixes,
    mtu: cfg.mtu,
    ttl: cfg.ttl,
  };
}

export function planTunnelTeardown(spec: TunnelSpec, routeTable: number): IpCommand[] {
  const table = String(routeTable);
  const cmds: IpCommand[] = [];

  for (const prefix of spec.routedPrefixes) {
    cmds.push({ args: ['-6', 'rule', 'del', 'from', prefix, 'lookup', table, 'pref', table], optional: true });
    cmds.push({ args: ['-6', 'route', 'del', 'local', prefix, 'dev', 'lo'], optional: true });
  }
  cmds.push({
    args: ['-6', 'rule', 'del', 'from', `${spec.clientIpv6}/128`, 'lookup', table, 'pref', table],
    optional: true,
  });
  cmds.push({ args: ['-6', 'route', 'flush', 'table', table], optional: true });
  cmds.push({ args: ['link', 'del', spec.device], optional: true });

  return cmds;
}

/**
 * `installDefaultRoute` puts a default route in the main table. With it the
 * whole host egresses through the tunnel; without it only traffic sourced from
 * the tunnelled prefixes does, which is all the proxy needs.
 */
export function planTunnelSetup(
  spec: TunnelSpec,
  opts: { routeTable: number; installDefaultRoute: boolean }
): TunnelPlan {
  const table = String(opts.routeTable);
  const setup: IpCommand[] = [
    {
      args: [
        'tunnel', 'add', spec.device,
        'mode', 'sit',
        'remote', spec.serverIpv4,
        'local', spec.localIpv4,
        'ttl', String(spec.ttl),
      ],
    },
    { args: ['link', 'set', 'dev', spec.device, 'mtu', String(spec.mtu), 'up'] },
    { args: ['-6', 'addr', 'replace', `${spec.clientIpv6}/${spec.clientPrefixLength}`, 'dev', spec.device] },
    // Everything reachable through the tunnel, in a table of our own.
    { args: ['-6', 'route', 'replace', 'default', 'dev', spec.device, 'table', table], optional: true },
    {
      args: ['-6', 'rule', 'add', 'from', `${spec.clientIpv6}/128`, 'lookup', table, 'pref', table],
      optional: true,
    },
  ];

  for (const prefix of spec.routedPrefixes) {
    setup.push({ args: ['-6', 'rule', 'add', 'from', prefix, 'lookup', table, 'pref', table], optional: true });
    // Accept the entire routed prefix locally, so a session can source from any
    // address in it without that address being configured up front.
    setup.push({ args: ['-6', 'route', 'replace', 'local', prefix, 'dev', 'lo'], optional: true });
  }

  if (opts.installDefaultRoute) {
    setup.push({ args: ['-6', 'route', 'replace', 'default', 'dev', spec.device, 'metric', '1024'], optional: true });
  }

  return { teardown: planTunnelTeardown(spec, opts.routeTable), setup };
}

// --- execution ---------------------------------------------------------------

interface RunResult {
  ok: boolean;
  stderr: string;
}

function runIp(args: string[]): RunResult {
  try {
    execFileSync('ip', args, { timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, stderr: '' };
  } catch (err: any) {
    const stderr = (err.stderr?.toString() || err.stdout?.toString() || err.message || '').trim();
    return { ok: false, stderr };
  }
}

/** Turn iproute2's terse failures into something the operator can act on. */
function explainIpFailure(args: string[], stderr: string): string {
  const lower = stderr.toLowerCase();
  const cmd = `ip ${args.join(' ')}`;

  if (lower.includes('operation not permitted') || lower.includes('permission denied')) {
    return `${cmd}: permission denied. The proxy needs NET_ADMIN — run as root, or give the container --cap-add=NET_ADMIN.`;
  }
  if (args[0] === 'tunnel' && (lower.includes('not supported') || lower.includes('no such device'))) {
    return `${cmd}: the kernel has no 6in4 support loaded. Run "modprobe sit" on the host (persist it in /etc/modules-load.d/sit.conf); inside Docker the module must be loaded on the host, not in the container.`;
  }
  if (lower.includes('file exists')) {
    return `${cmd}: already configured and could not be replaced — something else on this host may own it.`;
  }
  if (lower.includes('invalid argument') && args.includes('rule')) {
    return `${cmd}: the kernel lacks IPv6 policy routing (CONFIG_IPV6_MULTIPLE_TABLES).`;
  }
  return `${cmd}: ${stderr || 'failed'}`;
}

function runPlanPhase(cmds: IpCommand[], phase: 'teardown' | 'setup'): string[] {
  const log = getLogger();
  const warnings: string[] = [];

  for (const cmd of cmds) {
    // `rule del` removes one match at a time; a crashed run can leave several.
    const repeat = phase === 'teardown' && cmd.args.includes('rule') && cmd.args.includes('del');
    let attempts = 0;
    let result = runIp(cmd.args);
    while (repeat && result.ok && ++attempts < 8) {
      result = runIp(cmd.args);
    }

    if (result.ok || phase === 'teardown') {
      log.debug({ cmd: `ip ${cmd.args.join(' ')}`, ok: result.ok }, 'Tunnel command');
      continue;
    }

    const message = explainIpFailure(cmd.args, result.stderr);
    if (cmd.optional) {
      log.warn({ err: result.stderr }, message);
      warnings.push(message);
      continue;
    }
    throw new Error(message);
  }

  return warnings;
}

function writeSysctl(path: string, value: string, onlyIfNot?: string): boolean {
  try {
    if (onlyIfNot !== undefined && fs.readFileSync(path, 'utf-8').trim() !== onlyIfNot) return false;
    fs.writeFileSync(path, value);
    return true;
  } catch {
    return false;
  }
}

/** Kernel switches the tunnel depends on. All best-effort: a read-only /proc is not fatal. */
function applySysctls(cfg: TunnelConfig): string[] {
  const warnings: string[] = [];

  // A host that had no use for IPv6 may have it switched off entirely.
  writeSysctl('/proc/sys/net/ipv6/conf/all/disable_ipv6', '0', '1');
  writeSysctl('/proc/sys/net/ipv6/conf/default/disable_ipv6', '0', '1');

  // Sessions bind to addresses out of the routed prefix that are not configured
  // on any interface; without this the bind fails with EADDRNOTAVAIL.
  if (!writeSysctl('/proc/sys/net/ipv6/ip_nonlocal_bind', '1', '0')) {
    try {
      if (fs.readFileSync('/proc/sys/net/ipv6/ip_nonlocal_bind', 'utf-8').trim() !== '1') {
        warnings.push(
          'Could not set net.ipv6.ip_nonlocal_bind=1. Set it on the host ' +
            '(sysctl -w net.ipv6.ip_nonlocal_bind=1) or connections will fail to bind their source address.'
        );
      }
    } catch {
      // /proc unreadable — nothing useful to report.
    }
  }

  if (cfg.forwarding && !writeSysctl('/proc/sys/net/ipv6/conf/all/forwarding', '1', '0')) {
    warnings.push('HE_TUNNEL_FORWARDING is on but net.ipv6.conf.all.forwarding could not be set');
  }

  return warnings;
}

/** True when the host already has an IPv6 default route that is not ours. */
function hasForeignDefaultRoute(device: string): boolean {
  try {
    const out = execFileSync('ip', ['-6', 'route', 'show', 'default'], {
      encoding: 'utf-8',
      timeout: 3000,
    });
    return out
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .some((line) => !line.includes(`dev ${device}`));
  } catch {
    return false;
  }
}

function warnIfNotIproute2(): string[] {
  try {
    const out = execFileSync('ip', ['-V'], { encoding: 'utf-8', timeout: 3000 });
    if (/iproute2/i.test(out)) return [];
  } catch {
    // BusyBox's `ip` exits non-zero on -V.
  }
  return [
    'The `ip` on PATH does not look like iproute2 (BusyBox?). 6in4 setup needs real iproute2 — ' +
      'install it (apk add iproute2 / apt install iproute2).',
  ];
}

export function applyTunnel(spec: TunnelSpec, cfg: TunnelConfig): string[] {
  const log = getLogger();
  const warnings = [...warnIfNotIproute2(), ...applySysctls(cfg)];

  const installDefaultRoute =
    cfg.defaultRoute === 'always' ||
    (cfg.defaultRoute === 'auto' && !hasForeignDefaultRoute(spec.device));

  if (cfg.defaultRoute === 'auto' && !installDefaultRoute) {
    log.info(
      'Host already has an IPv6 default route; leaving it alone and routing only tunnel-sourced traffic'
    );
  }

  const plan = planTunnelSetup(spec, { routeTable: cfg.routeTable, installDefaultRoute });

  // Teardown first: this is what makes bring-up idempotent across restarts.
  runPlanPhase(plan.teardown, 'teardown');
  warnings.push(...runPlanPhase(plan.setup, 'setup'));

  // Addresses from these prefixes belong on the tunnel, not on whatever
  // interface happens to hold the host's default route. Scoped to this device
  // so a reconnect does not disown prefixes that belong to a WARP link.
  clearPrefixInterfaces(spec.device);
  for (const prefix of spec.routedPrefixes) {
    registerInterfaceForPrefix(prefix, spec.device);
  }
  registerInterfaceForPrefix(spec.linkPrefix, spec.device);
  resetOutboundInterface();

  log.info(
    {
      device: spec.device,
      remote: spec.serverIpv4,
      local: spec.localIpv4,
      clientIpv6: spec.clientIpv6,
      routed: spec.routedPrefixes,
      mtu: spec.mtu,
      defaultRoute: installDefaultRoute,
    },
    '6in4 tunnel is up'
  );

  return warnings;
}

// --- verification ------------------------------------------------------------

/**
 * Prove the tunnel carries traffic: once from the tunnel address itself, and
 * once from a random address in the routed prefix — the path a session takes.
 */
export async function verifyTunnel(spec: TunnelSpec, cfg: TunnelConfig): Promise<TunnelProbe[]> {
  const probes: TunnelProbe[] = [];
  const timeoutMs = 5000;

  probes.push(await probeFromSource(spec.clientIpv6, cfg.verifyHost, cfg.verifyPort, timeoutMs));

  const prefix = spec.routedPrefixes[0];
  if (prefix) {
    const parsed = parseCIDR(prefix);
    const addr = generateIPv6(parsed.prefix, parsed.prefixLength);
    registerIPv6Address(addr);
    try {
      probes.push(await probeFromSource(addr, cfg.verifyHost, cfg.verifyPort, timeoutMs));
    } finally {
      forceUnregisterIPv6Address(addr);
    }
  }

  return probes;
}

// --- orchestration -----------------------------------------------------------

async function pushEndpointUpdate(cfg: TunnelConfig, info: TunnelInfo | null, state: TunnelState): Promise<void> {
  const log = getLogger();

  try {
    state.publicIpv4 = await detectPublicIPv4(cfg).catch((err) => {
      log.debug({ err: err.message }, 'Public IPv4 lookup failed; letting HE infer it from the request');
      return null;
    });

    // HE asks that the endpoint only be updated when it actually changes.
    if (state.publicIpv4 && info?.clientIpv4 && state.publicIpv4 === info.clientIpv4) {
      log.info({ ip: state.publicIpv4 }, 'Tunnel endpoint already points at this host');
      return;
    }

    const result = await updateTunnelEndpoint(cfg, state.publicIpv4);
    state.endpointUpdate = { ...result, at: new Date().toISOString() };
    if (result.ok) {
      if (result.ip) state.publicIpv4 = result.ip;
      log.info({ code: result.code, ip: result.ip }, result.message);
    } else {
      log.warn({ code: result.code }, `Tunnel endpoint update failed: ${result.message}`);
      state.warnings.push(result.message);
    }
  } catch (err: any) {
    log.warn({ err: err.message }, 'Could not update the tunnel endpoint');
    state.warnings.push(`Endpoint update failed: ${err.message}`);
  }
}

/**
 * Bring the tunnel up. Returns the resulting state; never throws, so a broken
 * tunnel degrades the proxy to whatever IPv6 the host already had rather than
 * stopping it from starting.
 */
export async function startTunnel(cfg: TunnelConfig): Promise<TunnelState> {
  const log = getLogger();
  _cfg = cfg;
  const state = emptyState(cfg.device);
  state.enabled = cfg.enabled;

  if (!cfg.enabled) {
    // Half-configured is easy to do and silent otherwise: the tunnel only
    // switches itself on with credentials, or with the endpoint settings.
    const partial = cfg.tunnelId || cfg.username || cfg.serverIpv4 || cfg.clientIpv6;
    if (partial) {
      log.warn(
        'Tunnel settings are present but incomplete, so no tunnel was set up. Supply either ' +
          'HE_TUNNEL_ID + HE_TUNNEL_USERNAME + HE_TUNNEL_PASSWORD (or HE_TUNNEL_UPDATE_KEY), ' +
          'or HE_TUNNEL_SERVER_IPV4 + HE_TUNNEL_CLIENT_IPV6 + HE_TUNNEL_ROUTED_PREFIXES.'
      );
    }
    _state = state;
    return state;
  }

  log.info({ device: cfg.device }, 'Setting up 6in4 tunnel...');

  try {
    if (cfg.tunnelId && cfg.username && (cfg.password || cfg.updateKey)) {
      try {
        state.info = await fetchTunnelInfo(cfg);
        log.info(
          {
            tunnelId: state.info.id,
            serverIpv4: state.info.serverIpv4,
            routed64: state.info.routed64,
            routed48: state.info.routed48,
          },
          'Fetched tunnel details from tunnelbroker.net'
        );
      } catch (err: any) {
        // Usable anyway when the tunnel was also described in the environment.
        if (!cfg.serverIpv4 || !cfg.clientIpv6 || cfg.routedPrefixes.length === 0) throw err;
        log.warn({ err: err.message }, 'tunnelbroker API unavailable; using the configured tunnel details');
        state.warnings.push(`tunnelbroker API unavailable: ${err.message}`);
      }
    }

    if (cfg.updateEndpoint && cfg.tunnelId && cfg.username && (cfg.password || cfg.updateKey)) {
      await pushEndpointUpdate(cfg, state.info, state);
    }

    const local = chooseLocalIPv4({
      configured: cfg.localIpv4,
      publicIpv4: state.publicIpv4 || state.info?.clientIpv4 || null,
      locals: listLocalIPv4(),
    });
    state.localIpv4 = local.address;
    state.natted = local.natted;

    if (local.natted) {
      log.warn(
        { local: local.address, public: state.publicIpv4 },
        'Tunnel anchored to a private address — the router must forward IP protocol 41 to this host'
      );
    }

    const spec = resolveTunnelSpec(cfg, state.info, local.address);
    state.spec = spec;
    state.warnings.push(...applyTunnel(spec, cfg));
    state.up = true;
    state.startedAt = new Date().toISOString();

    if (cfg.verify) {
      state.probes = await verifyTunnel(spec, cfg);
      for (const probe of state.probes) {
        if (probe.ok) {
          log.info({ source: probe.source }, `Tunnel verified: ${probe.detail}`);
        } else {
          log.warn({ source: probe.source }, `Tunnel verification failed: ${probe.detail}`);
        }
      }
      if (state.probes.length > 0 && state.probes.every((p) => !p.ok)) {
        state.warnings.push(
          `No traffic passed over the tunnel. Check that the broker's client IPv4 matches ` +
            `${state.publicIpv4 ?? 'this host'} and that IP protocol 41 reaches it.`
        );
      }
    }
  } catch (err: any) {
    log.error({ err: err.message }, 'Tunnel setup failed');
    state.warnings.push(err.message);
    state.up = false;
  }

  _state = state;
  return state;
}

/** Re-run bring-up with the config the process started with (API-triggered). */
export async function reconnectTunnel(): Promise<TunnelState> {
  if (!_cfg) throw new Error('Tunnel support is not configured');
  return startTunnel(_cfg);
}

export function stopTunnel(): void {
  const log = getLogger();
  stopEndpointWatcher();

  if (!_cfg || !_state.spec || !_state.up) return;
  if (!_cfg.teardownOnExit) {
    log.info('Leaving the tunnel up (HE_TUNNEL_TEARDOWN_ON_EXIT=false)');
    return;
  }

  runPlanPhase(planTunnelTeardown(_state.spec, _cfg.routeTable), 'teardown');
  clearPrefixInterfaces(_state.device);
  _state.up = false;
  log.info({ device: _state.device }, '6in4 tunnel torn down');
}

export function getTunnelState(): TunnelState {
  return _state;
}

export function getTunnelConfig(): TunnelConfig | null {
  return _cfg;
}

/** Re-point the tunnel when this host's public IPv4 changes under it. */
export function startEndpointWatcher(cfg: TunnelConfig): void {
  const log = getLogger();
  stopEndpointWatcher();

  if (!cfg.enabled || !cfg.updateEndpoint || !cfg.tunnelId || cfg.updateIntervalMs <= 0) return;

  const interval = Math.max(cfg.updateIntervalMs, MIN_UPDATE_INTERVAL_MS);
  if (interval !== cfg.updateIntervalMs) {
    log.warn({ requested: cfg.updateIntervalMs, using: interval }, 'Endpoint update interval raised to avoid HE abuse limits');
  }

  _watcher = setInterval(() => {
    if (_watcherBusy) return;
    _watcherBusy = true;

    (async () => {
      const current = await detectPublicIPv4(cfg).catch((err) => {
        log.debug({ err: err.message }, 'Public IPv4 re-check failed');
        return null;
      });
      if (!current || current === _state.publicIpv4) return;

      log.info({ from: _state.publicIpv4, to: current }, 'Public IPv4 changed; re-pointing the tunnel');
      const result = await updateTunnelEndpoint(cfg, current);
      _state.endpointUpdate = { ...result, at: new Date().toISOString() };
      _state.publicIpv4 = current;

      if (!result.ok) {
        log.warn({ code: result.code }, `Tunnel endpoint update failed: ${result.message}`);
        return;
      }

      // The sit device is anchored to the old address; rebuild it.
      if (_state.spec) {
        const local = chooseLocalIPv4({
          configured: cfg.localIpv4,
          publicIpv4: current,
          locals: listLocalIPv4(),
        });
        _state.spec = { ..._state.spec, localIpv4: local.address };
        _state.localIpv4 = local.address;
        _state.natted = local.natted;
        try {
          applyTunnel(_state.spec, cfg);
        } catch (err: any) {
          log.error({ err: err.message }, 'Failed to rebuild the tunnel after the IPv4 change');
          _state.up = false;
        }
      }
    })()
      .catch((err) => log.warn({ err: err.message }, 'Endpoint watcher error'))
      .finally(() => {
        _watcherBusy = false;
      });
  }, interval);

  _watcher.unref();
  log.info({ intervalMs: interval }, 'Watching for public IPv4 changes');
}

export function stopEndpointWatcher(): void {
  if (_watcher) {
    clearInterval(_watcher);
    _watcher = null;
  }
}
