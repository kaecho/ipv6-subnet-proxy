export interface CdnFallbackConfig {
  /** Master switch for the whole no-AAAA fallback ladder. */
  enabled: boolean;
  /** Prove a borrowed edge really serves the target before using it. */
  verify: boolean;
  /** Ports on which borrowing a CDN edge is allowed. */
  ports: number[];
  /** DNS servers for fallback lookups. Empty = system resolvers. */
  resolvers: string[];
  /** Probe candidates from every known provider when detection is inconclusive. */
  probeAll: boolean;
  /** Remember edge addresses seen on natively dual-stack hosts of a known CDN. */
  learn: boolean;
  probeTimeoutMs: number;
  dnsTimeoutMs: number;
  /** Upper bound on verification probes per resolution. */
  maxProbes: number;
  positiveTtlMs: number;
  negativeTtlMs: number;
  edgeTtlMs: number;
  cacheMax: number;
  /** Operator-supplied edges, keyed by provider name (`default` = any provider). */
  staticEdges: Record<string, string[]>;
  /** NAT64 /96 prefix for reaching IPv4-only targets, or null when disabled. */
  nat64Prefix: string | null;
}

/**
 * A 6in4 tunnel the proxy brings up itself, so a host with no IPv6 of its own
 * still gets a routed prefix to allocate from.
 *
 * Written against Hurricane Electric's tunnelbroker.net (free, hands out a /48),
 * but the manual settings describe a plain RFC 4213 6in4 tunnel and work with
 * any provider; only the API/endpoint-update fields are HE-specific.
 */
export interface TunnelConfig {
  enabled: boolean;
  /** Name of the sit device the proxy creates. */
  device: string;
  /** HE tunnel id — also the dyndns `hostname` when updating the endpoint. */
  tunnelId: string | null;
  username: string | null;
  /** Account password. HE requires the tunnel's Update Key instead when one is set. */
  password: string | null;
  updateKey: string | null;
  /** Tunnel server (HE side) IPv4 — the sit `remote`. */
  serverIpv4: string | null;
  serverIpv6: string | null;
  /** Our side of the tunnel link, e.g. `2001:470:35:380::2/64`. */
  clientIpv6: string | null;
  /** Local IPv4 for the sit `local`. Auto-detected when unset (NAT-aware). */
  localIpv4: string | null;
  /** Prefixes routed to this tunnel; these become allocation subnets. */
  routedPrefixes: string[];
  mtu: number;
  ttl: number;
  /** Policy-routing table for tunnel-sourced traffic. */
  routeTable: number;
  /** `auto` installs a default route only when the host has none of its own. */
  defaultRoute: 'auto' | 'always' | 'never';
  /** Forward the routed prefix on to other hosts (off: the proxy only sources from it). */
  forwarding: boolean;
  /** Register the routed prefixes as allocation subnets on startup. */
  registerSubnets: boolean;
  teardownOnExit: boolean;
  verify: boolean;
  verifyHost: string;
  verifyPort: number;
  /** Point the tunnel at this host's current public IPv4 before bringing it up. */
  updateEndpoint: boolean;
  /** Re-check the public IPv4 on this interval; 0 disables. */
  updateIntervalMs: number;
  apiUrl: string;
  updateUrl: string;
  publicIpv4Url: string;
  requestTimeoutMs: number;
}

export interface AppConfig {
  socks5Port: number;
  apiPort: number;
  apiHost: string;
  apiKey: string;
  dbPath: string;
  defaultSubnet: string | null;
  defaultSubnetGateway: string | null;
  bcryptRounds: number;
  logLevel: string;
  cdnFallback: CdnFallbackConfig;
  tunnel: TunnelConfig;
}

function envInt(key: string, def: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = parseInt(v, 10);
  if (isNaN(n)) throw new Error(`${key} must be an integer, got: ${v}`);
  return n;
}

function envBool(key: string, def: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const lower = v.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(lower)) return true;
  if (['0', 'false', 'no', 'off'].includes(lower)) return false;
  throw new Error(`${key} must be a boolean (true/false), got: ${v}`);
}

function envList(key: string, def: string[]): string[] {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  return v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

function envEnum<T extends string>(key: string, allowed: readonly T[], def: T): T {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const lower = v.trim().toLowerCase();
  if (!allowed.includes(lower as T)) {
    throw new Error(`${key} must be one of ${allowed.join('|')}, got: ${v}`);
  }
  return lower as T;
}

function envStr(key: string): string | null {
  const v = process.env[key];
  if (v === undefined) return null;
  const trimmed = v.trim();
  return trimmed === '' ? null : trimmed;
}

function envPorts(key: string, def: number[]): number[] {
  const raw = envList(key, []);
  if (raw.length === 0) return def;
  return raw.map((s) => {
    const n = parseInt(s, 10);
    if (isNaN(n) || n < 1 || n > 65535) {
      throw new Error(`${key} must be a comma-separated list of ports, got: ${s}`);
    }
    return n;
  });
}

/**
 * Parse operator-pinned CDN edges.
 *
 * Format: `provider=addr[,addr...];provider2=addr`, or a bare comma-separated
 * address list which is filed under `default` and tried for any provider.
 * Example: `cloudfront=2600:9000:2015::1;default=2a04:4e42::1`
 */
export function parseEdgeOverrides(raw: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw.trim()) return out;

  for (const group of raw.split(';')) {
    if (!group.trim()) continue;
    const eq = group.indexOf('=');
    const provider = eq === -1 ? 'default' : group.slice(0, eq).trim().toLowerCase();
    const addrs = (eq === -1 ? group : group.slice(eq + 1))
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (addrs.length === 0) continue;
    out[provider] = [...(out[provider] || []), ...addrs];
  }
  return out;
}

function loadNat64Prefix(): string | null {
  const raw = process.env.NAT64_PREFIX;
  if (!raw || !raw.trim()) return null;
  const value = raw.trim();
  const [addr, len] = value.split('/');
  if (len !== undefined && len !== '96') {
    throw new Error(`NAT64_PREFIX must be a /96 prefix (RFC 6052 well-known form), got: ${value}`);
  }
  if (!addr || !addr.includes(':')) {
    throw new Error(`NAT64_PREFIX must be an IPv6 prefix, got: ${value}`);
  }
  return addr;
}

function loadCdnFallbackConfig(): CdnFallbackConfig {
  return {
    enabled: envBool('CDN_FALLBACK_ENABLED', true),
    verify: envBool('CDN_FALLBACK_VERIFY', true),
    ports: envPorts('CDN_FALLBACK_PORTS', [80, 443]),
    resolvers: envList('CDN_FALLBACK_RESOLVERS', []),
    probeAll: envBool('CDN_FALLBACK_PROBE_ALL', true),
    learn: envBool('CDN_FALLBACK_LEARN', true),
    probeTimeoutMs: envInt('CDN_FALLBACK_PROBE_TIMEOUT_MS', 5000),
    dnsTimeoutMs: envInt('CDN_FALLBACK_DNS_TIMEOUT_MS', 3000),
    maxProbes: envInt('CDN_FALLBACK_MAX_PROBES', 6),
    positiveTtlMs: envInt('CDN_FALLBACK_TTL_MS', 600_000),
    negativeTtlMs: envInt('CDN_FALLBACK_NEGATIVE_TTL_MS', 60_000),
    edgeTtlMs: envInt('CDN_FALLBACK_EDGE_TTL_MS', 1_800_000),
    cacheMax: envInt('CDN_FALLBACK_CACHE_MAX', 4096),
    staticEdges: parseEdgeOverrides(process.env.CDN_FALLBACK_EDGES || ''),
    nat64Prefix: loadNat64Prefix(),
  };
}

function loadTunnelConfig(): TunnelConfig {
  const tunnelId = envStr('HE_TUNNEL_ID');
  const username = envStr('HE_TUNNEL_USERNAME');
  const password = envStr('HE_TUNNEL_PASSWORD');
  const updateKey = envStr('HE_TUNNEL_UPDATE_KEY');
  const serverIpv4 = envStr('HE_TUNNEL_SERVER_IPV4');
  const clientIpv6 = envStr('HE_TUNNEL_CLIENT_IPV6');

  // Two ways in: paste the tunnel details, or hand over credentials and let
  // the proxy read them from the tunnelbroker API.
  const hasManual = Boolean(serverIpv4 && clientIpv6);
  const hasApi = Boolean(tunnelId && username && (password || updateKey));

  const mtu = envInt('HE_TUNNEL_MTU', 1480);
  if (mtu < 1280 || mtu > 1500) {
    throw new Error(`HE_TUNNEL_MTU must be 1280-1500 (IPv6 minimum MTU is 1280), got: ${mtu}`);
  }
  const ttl = envInt('HE_TUNNEL_TTL', 255);
  if (ttl < 1 || ttl > 255) {
    throw new Error(`HE_TUNNEL_TTL must be 1-255, got: ${ttl}`);
  }
  const routeTable = envInt('HE_TUNNEL_ROUTE_TABLE', 1470);
  if (routeTable < 1 || routeTable > 0xffffffff || (routeTable >= 253 && routeTable <= 255)) {
    // 253/254/255 are the reserved default/main/local tables.
    throw new Error(`HE_TUNNEL_ROUTE_TABLE must be 1-4294967295 and not 253-255, got: ${routeTable}`);
  }

  return {
    enabled: envBool('HE_TUNNEL_ENABLED', hasManual || hasApi),
    device: process.env.HE_TUNNEL_DEVICE?.trim() || 'he-ipv6',
    tunnelId,
    username,
    password,
    updateKey,
    serverIpv4,
    serverIpv6: envStr('HE_TUNNEL_SERVER_IPV6'),
    clientIpv6,
    localIpv4: envStr('HE_TUNNEL_LOCAL_IPV4'),
    routedPrefixes: envList('HE_TUNNEL_ROUTED_PREFIXES', []),
    mtu,
    ttl,
    routeTable,
    defaultRoute: envEnum('HE_TUNNEL_DEFAULT_ROUTE', ['auto', 'always', 'never'] as const, 'auto'),
    forwarding: envBool('HE_TUNNEL_FORWARDING', false),
    registerSubnets: envBool('HE_TUNNEL_REGISTER_SUBNETS', true),
    teardownOnExit: envBool('HE_TUNNEL_TEARDOWN_ON_EXIT', true),
    verify: envBool('HE_TUNNEL_VERIFY', true),
    // HE's anycast resolver: reachable from every tunnel and answers on TCP/53.
    verifyHost: process.env.HE_TUNNEL_VERIFY_HOST?.trim() || '2001:470:20::2',
    verifyPort: envInt('HE_TUNNEL_VERIFY_PORT', 53),
    updateEndpoint: envBool('HE_TUNNEL_UPDATE_ENDPOINT', hasApi),
    updateIntervalMs: envInt('HE_TUNNEL_UPDATE_INTERVAL_MS', 900_000),
    apiUrl: process.env.HE_TUNNEL_API_URL?.trim() || 'https://tunnelbroker.net/tunnelInfo.php',
    updateUrl: process.env.HE_TUNNEL_UPDATE_URL?.trim() || 'https://ipv4.tunnelbroker.net/nic/update',
    publicIpv4Url: process.env.HE_TUNNEL_PUBLIC_IPV4_URL?.trim() || 'https://checkip.amazonaws.com',
    requestTimeoutMs: envInt('HE_TUNNEL_REQUEST_TIMEOUT_MS', 10_000),
  };
}

export function loadConfig(): AppConfig {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error('API_KEY environment variable is required');
  }

  return {
    socks5Port: envInt('SOCKS5_PORT', 1080),
    apiPort: envInt('API_PORT', 3000),
    apiHost: process.env.API_HOST || '0.0.0.0',
    apiKey,
    dbPath: process.env.DB_PATH || '/data/proxy.db',
    defaultSubnet: process.env.DEFAULT_SUBNET || null,
    defaultSubnetGateway: process.env.DEFAULT_SUBNET_GATEWAY || null,
    bcryptRounds: envInt('BCRYPT_ROUNDS', 10),
    logLevel: process.env.LOG_LEVEL || 'info',
    cdnFallback: loadCdnFallbackConfig(),
    tunnel: loadTunnelConfig(),
  };
}
