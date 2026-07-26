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
  };
}
