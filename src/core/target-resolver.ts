import dns from 'dns';
import net from 'net';
import tls from 'tls';
import { loadConfig, CdnFallbackConfig } from '../config';
import { getLogger } from '../utils/logger';
import { CDN_PROVIDERS, CdnProvider, matchProvider } from './cdn-providers';

/**
 * Decides which IPv6 address a proxied connection should actually be sent to.
 *
 * An IPv6-only egress can normally only reach names that publish an AAAA
 * record. But a large share of the web sits behind anycast CDNs whose edge
 * fleet is dual-stack and dispatches on SNI / Host rather than on destination
 * IP. Those sites are reachable over IPv6 through any edge of their CDN even
 * though their own DNS is IPv4-only — publishing AAAA is a customer-side
 * toggle, not a capability of the edge.
 *
 * Resolution ladder, first rung that works wins:
 *
 *   1. native     — the name has its own AAAA records
 *   2. dualstack  — `dualstack.<cname-hop>` has AAAA. Same CDN, same mapping,
 *                   just the IPv6 view of it (Fastly, Akamai, AWS ELB and
 *                   CloudFront all publish this variant)
 *   3. cdn-borrow — identify the CDN from the CNAME chain or the PTR of its
 *                   IPv4 address, then connect to a borrowed edge of that CDN
 *   4. nat64      — synthesize an address from NAT64_PREFIX (opt-in)
 *
 * Rungs 2 and 3 are verified before use: the resolver completes a TLS
 * handshake against the candidate edge with SNI set to the target name and a
 * full certificate check. An edge that does not serve the name fails the check
 * and is discarded, so a borrow never degrades into a certificate error on the
 * client. Results are cached per host/port.
 */

export type RouteKind = 'literal' | 'native' | 'dualstack' | 'cdn-borrow' | 'nat64';

export interface TargetRoute {
  kind: RouteKind;
  /** Connect candidates, best first. */
  addresses: string[];
  /** CDN the address was borrowed from, when applicable. */
  provider: string | null;
  /** Name the address was harvested from, for diagnostics. */
  via: string | null;
  /** True when a TLS handshake proved this edge serves the target name. */
  verified: boolean;
}

interface Candidate {
  address: string;
  via: string;
  provider: string | null;
  kind: RouteKind;
  verified?: boolean;
}

interface CacheEntry {
  route: TargetRoute | null;
  error: string | null;
  expiresAt: number;
}

interface EdgePoolEntry {
  addresses: string[];
  expiresAt: number;
}

const LEARNED_EDGES_PER_PROVIDER = 8;

const routeCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<TargetRoute>>();
const edgePool = new Map<string, EdgePoolEntry>();
const learnedEdges = new Map<string, { address: string; seenAt: number }[]>();

let _cfg: CdnFallbackConfig | null = null;
let _resolver: dns.promises.Resolver | null = null;

function cfg(): CdnFallbackConfig {
  if (!_cfg) _cfg = loadConfig().cdnFallback;
  return _cfg;
}

function resolver(): dns.promises.Resolver {
  if (_resolver) return _resolver;
  const c = cfg();
  const r = new dns.promises.Resolver({ timeout: c.dnsTimeoutMs, tries: 1 });
  if (c.resolvers.length > 0) r.setServers(c.resolvers);
  _resolver = r;
  return r;
}

/** Drop all cached state (config, DNS results, edge pools). */
export function resetTargetResolver(): void {
  _cfg = null;
  _resolver = null;
  routeCache.clear();
  inflight.clear();
  edgePool.clear();
  learnedEdges.clear();
}

// --- validation helpers ---

/**
 * Target names arrive from untrusted SOCKS clients and are interpolated into
 * DNS queries and into the Host header of the HTTP probe, so anything that is
 * not a plain hostname is rejected outright.
 */
export function isValidHostname(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  const labels = host.replace(/\.$/, '').split('.');
  if (labels.length === 0) return false;
  return labels.every(
    (l) => l.length > 0 && l.length <= 63 && /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?$/i.test(l)
  );
}

/** Globally routable unicast IPv6 only — no loopback, link-local, ULA or multicast. */
export function isUsableIPv6(addr: string): boolean {
  if (!net.isIPv6(addr)) return false;
  const l = addr.toLowerCase();
  if (l === '::' || l === '::1') return false;
  if (l.startsWith('::ffff:')) return false;
  if (/^fe[89ab]/.test(l)) return false;
  if (/^f[cd]/.test(l)) return false;
  if (l.startsWith('ff')) return false;
  return true;
}

// --- DNS helpers (never throw; an unresolvable name is just an empty answer) ---

async function resolve6(name: string): Promise<string[]> {
  try {
    return (await resolver().resolve6(name)).filter(isUsableIPv6);
  } catch {
    return [];
  }
}

async function resolve4(name: string): Promise<string[]> {
  try {
    return (await resolver().resolve4(name)).filter((a) => net.isIPv4(a));
  } catch {
    return [];
  }
}

async function reverse(addr: string): Promise<string[]> {
  try {
    return await resolver().reverse(addr);
  } catch {
    return [];
  }
}

/** Follow CNAMEs hop by hop. The chain is what identifies the CDN. */
async function cnameChain(host: string, maxHops = 8): Promise<string[]> {
  const chain: string[] = [];
  let cur = host;
  for (let i = 0; i < maxHops; i++) {
    let answers: string[];
    try {
      answers = await resolver().resolveCname(cur);
    } catch {
      break;
    }
    if (!answers || answers.length === 0) break;
    const next = answers[0].replace(/\.$/, '').toLowerCase();
    if (!next || next === cur || chain.includes(next) || !isValidHostname(next)) break;
    chain.push(next);
    cur = next;
  }
  return chain;
}

// --- verification probes ---

/**
 * TLS handshake against `addr` with SNI set to `host` and full certificate
 * verification. Success proves the edge holds a valid certificate for the
 * target name, which is exactly the condition for a borrow to be usable.
 */
function tlsProbe(host: string, addr: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    // `addr` is always an IPv6 literal (every candidate passes isUsableIPv6),
    // so no address family hint is needed — no name resolution happens here.
    const socket = tls.connect({
      host: addr,
      port,
      servername: host,
      rejectUnauthorized: true,
      ALPNProtocols: ['http/1.1'],
    });
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.on('secureConnect', () => finish(socket.authorized));
    socket.on('error', () => finish(false));
  });
}

/**
 * Plaintext HEAD with the target's Host header, for cleartext ports where
 * there is no certificate to check. A CDN edge that does not know the name
 * answers 4xx (CloudFront 400, Cloudflare 403 "direct IP access not allowed"),
 * so only sub-400 responses count as proof.
 */
function httpProbe(host: string, addr: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let buf = '';
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    const socket = net.createConnection({ host: addr, port, family: 6 });
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.on('connect', () => {
      socket.write(
        `HEAD / HTTP/1.1\r\nHost: ${host}\r\n` +
          'User-Agent: ipv6-subnet-proxy/probe\r\nAccept: */*\r\nConnection: close\r\n\r\n'
      );
    });
    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      const eol = buf.indexOf('\r\n');
      if (eol === -1 && buf.length < 256) return;
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(buf.slice(0, eol === -1 ? 256 : eol));
      finish(status !== null && Number(status[1]) < 400);
    });
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false));
  });
}

/**
 * On 443 (and any other TLS port) the certificate is the proof. On 80 the
 * edge is first asked over TLS on 443 — a valid certificate there means the
 * fleet maps this name — and only then falls back to the HTTP check, which
 * covers names served over cleartext alone.
 */
async function probeCandidate(
  host: string,
  addr: string,
  port: number,
  timeoutMs: number
): Promise<boolean> {
  if (await tlsProbe(host, addr, port === 80 ? 443 : port, timeoutMs)) return true;
  if (port === 80) return httpProbe(host, addr, 80, timeoutMs);
  return false;
}

/** Bounds the total number of probes spent resolving one target. */
class ProbeBudget {
  constructor(public remaining: number) {}
  take(n: number): number {
    const granted = Math.max(0, Math.min(n, this.remaining));
    this.remaining -= granted;
    return granted;
  }
}

/**
 * Probe candidates concurrently and return the most-preferred one that works,
 * preserving list order rather than whichever handshake happens to finish first.
 */
async function firstWorking(
  host: string,
  port: number,
  candidates: Candidate[],
  budget: ProbeBudget
): Promise<Candidate | null> {
  const c = cfg();
  if (candidates.length === 0) return null;

  if (!c.verify) return { ...candidates[0], verified: false };

  const allowed = budget.take(candidates.length);
  if (allowed === 0) return null;
  const batch = candidates.slice(0, allowed);

  const results = await Promise.all(
    batch.map((cand) => probeCandidate(host, cand.address, port, c.probeTimeoutMs))
  );
  const idx = results.findIndex((ok) => ok);
  return idx === -1 ? null : { ...batch[idx], verified: true };
}

// --- edge pools ---

function recordLearnedEdges(provider: string, addrs: string[]): void {
  const list = learnedEdges.get(provider) || [];
  const now = Date.now();
  for (const addr of addrs) {
    if (!isUsableIPv6(addr)) continue;
    const existing = list.find((e) => e.address === addr);
    if (existing) existing.seenAt = now;
    else list.push({ address: addr, seenAt: now });
  }
  list.sort((a, b) => b.seenAt - a.seenAt);
  learnedEdges.set(provider, list.slice(0, LEARNED_EDGES_PER_PROVIDER));
}

function getLearnedEdges(provider: string): string[] {
  const cutoff = Date.now() - cfg().edgeTtlMs;
  return (learnedEdges.get(provider) || [])
    .filter((e) => e.seenAt > cutoff)
    .map((e) => e.address);
}

/**
 * A name that resolves natively to AAAA *and* belongs to a known CDN is itself
 * a live sample of that CDN's edge fleet. Recording those addresses keeps the
 * borrow pool fresh from real traffic, so the feature does not depend on the
 * built-in seed hostnames staying dual-stack forever.
 */
async function learnFromNative(host: string, addrs: string[]): Promise<void> {
  try {
    const chain = await cnameChain(host);
    for (const name of [host, ...chain]) {
      const provider = matchProvider(name);
      if (provider) {
        recordLearnedEdges(provider.name, addrs);
        return;
      }
    }
  } catch {
    // best effort — learning never blocks or fails a connection
  }
}

/** Borrowable edges for one CDN: operator-pinned first, then learned, then seeds. */
async function getProviderEdges(provider: CdnProvider): Promise<string[]> {
  const c = cfg();
  const out: string[] = [];
  const push = (addr: string): void => {
    if (isUsableIPv6(addr) && !out.includes(addr)) out.push(addr);
  };

  for (const addr of c.staticEdges[provider.name] || []) push(addr);
  for (const addr of getLearnedEdges(provider.name)) push(addr);

  const cached = edgePool.get(provider.name);
  if (cached && cached.expiresAt > Date.now()) {
    for (const addr of cached.addresses) push(addr);
    return out;
  }

  const harvested: string[] = [];
  for (const seed of provider.seeds) {
    for (const addr of (await resolve6(seed)).slice(0, 2)) {
      if (!harvested.includes(addr)) harvested.push(addr);
    }
    if (harvested.length >= 4) break;
  }
  // Cached even when empty, so dead seeds are not re-queried on every request.
  edgePool.set(provider.name, { addresses: harvested, expiresAt: Date.now() + c.edgeTtlMs });
  for (const addr of harvested) push(addr);
  return out;
}

/** Candidates drawn from every pool, for targets whose CDN could not be identified. */
async function anyProviderCandidates(exclude: string | null, limit: number): Promise<Candidate[]> {
  const c = cfg();
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (address: string, provider: string): void => {
    if (out.length >= limit || !isUsableIPv6(address) || seen.has(address)) return;
    seen.add(address);
    out.push({ address, provider, via: `${provider} edge`, kind: 'cdn-borrow' });
  };

  for (const addr of c.staticEdges.default || []) add(addr, 'pinned');
  for (const provider of learnedEdges.keys()) {
    if (provider === exclude) continue;
    for (const addr of getLearnedEdges(provider)) add(addr, provider);
  }
  for (const provider of CDN_PROVIDERS) {
    if (out.length >= limit) break;
    if (provider.name === exclude) continue;
    for (const addr of await getProviderEdges(provider)) add(addr, provider.name);
  }
  return out;
}

// --- NAT64 ---

/** Embed an IPv4 address in the low 32 bits of a NAT64 /96 prefix (RFC 6052). */
export function synthesizeNat64(prefix: string, ipv4: string): string {
  const octets = ipv4.split('.').map((o) => parseInt(o, 10));
  if (octets.length !== 4 || octets.some((o) => isNaN(o) || o < 0 || o > 255)) {
    throw new Error(`Invalid IPv4 address: ${ipv4}`);
  }
  const high = ((octets[0] << 8) | octets[1]).toString(16);
  const low = ((octets[2] << 8) | octets[3]).toString(16);
  const base = prefix.endsWith(':') ? prefix : `${prefix}:`;
  const addr = `${base}${high}:${low}`;
  if (!net.isIPv6(addr)) {
    throw new Error(`NAT64_PREFIX "${prefix}" does not form a valid address`);
  }
  return addr;
}

function nat64Route(ipv4Addrs: string[]): TargetRoute | null {
  const prefix = cfg().nat64Prefix;
  if (!prefix || ipv4Addrs.length === 0) return null;
  const addresses: string[] = [];
  for (const v4 of ipv4Addrs.slice(0, 3)) {
    try {
      addresses.push(synthesizeNat64(prefix, v4));
    } catch {
      // skip malformed answers
    }
  }
  if (addresses.length === 0) return null;
  return { kind: 'nat64', addresses, provider: null, via: prefix, verified: false };
}

// --- resolution ---

async function computeRoute(host: string, port: number): Promise<TargetRoute> {
  const c = cfg();
  const log = getLogger();

  // 1. Native AAAA.
  const native = await resolve6(host);
  if (native.length > 0) {
    if (c.learn) void learnFromNative(host, native);
    return { kind: 'native', addresses: native.slice(0, 3), provider: null, via: host, verified: false };
  }

  if (!c.enabled) {
    const nat = nat64Route(await resolve4(host));
    if (nat) return nat;
    throw new Error(`${host} has no AAAA record`);
  }

  if (!c.ports.includes(port)) {
    const nat = nat64Route(await resolve4(host));
    if (nat) return nat;
    throw new Error(
      `${host} has no AAAA record and CDN edge borrowing is not enabled on port ${port}`
    );
  }

  const chain = await cnameChain(host);
  const names = [host, ...chain];
  const v4 = await resolve4(host);

  // No AAAA, no CNAME and no A record means the name simply does not exist.
  // Fail here rather than spending the probe budget looking for an edge to
  // borrow for a host that nothing serves.
  if (chain.length === 0 && v4.length === 0) {
    throw new Error(`${host} does not resolve to any address`);
  }

  const budget = new ProbeBudget(c.maxProbes);

  // 2. The dual-stack view of the target's own CDN mapping.
  const siblings: Candidate[] = [];
  for (const name of names) {
    if (name.startsWith('dualstack.')) continue;
    for (const addr of (await resolve6(`dualstack.${name}`)).slice(0, 2)) {
      siblings.push({
        address: addr,
        via: `dualstack.${name}`,
        provider: matchProvider(name)?.name ?? null,
        kind: 'dualstack',
      });
    }
  }
  const sibling = await firstWorking(host, port, siblings, budget);
  if (sibling) {
    log.info(
      { host, port, address: sibling.address, via: sibling.via },
      'Reaching IPv4-only name over IPv6 via its dual-stack CDN mapping'
    );
    return toRoute(sibling, siblings);
  }

  // 3. A borrowed edge of the CDN this name is served from.
  const provider = await detectProvider(host, names, v4);
  if (provider) {
    const edges = await getProviderEdges(provider);
    const candidates: Candidate[] = edges.map((address) => ({
      address,
      via: `${provider.name} edge`,
      provider: provider.name,
      kind: 'cdn-borrow',
    }));
    const winner = await firstWorking(host, port, candidates, budget);
    if (winner) {
      log.info(
        { host, port, address: winner.address, provider: provider.name },
        'Reaching IPv4-only name over IPv6 via a borrowed CDN edge'
      );
      return toRoute(winner, candidates);
    }
    log.debug({ host, provider: provider.name, edges: edges.length }, 'CDN edge borrow rejected by probe');
  }

  // 4. CDN unknown or mismatched — try whatever edges are on hand.
  if (c.probeAll && budget.remaining > 0) {
    const candidates = await anyProviderCandidates(provider?.name ?? null, budget.remaining);
    const winner = await firstWorking(host, port, candidates, budget);
    if (winner) {
      log.info(
        { host, port, address: winner.address, provider: winner.provider },
        'Reaching IPv4-only name over IPv6 via a borrowed CDN edge (provider inferred by probe)'
      );
      return toRoute(winner, candidates);
    }
  }

  // 5. NAT64, when the operator has a gateway.
  const nat = nat64Route(v4);
  if (nat) return nat;

  throw new Error(
    `${host} has no AAAA record and no usable IPv6 path was found` +
      (provider ? ` (CDN detected: ${provider.name}, but no edge served the name)` : '')
  );
}

function toRoute(winner: Candidate, pool: Candidate[]): TargetRoute {
  // Only the probed address is known to serve this name. Falling back to an
  // unverified sibling on connect failure would hand the client the very
  // certificate mismatch verification exists to prevent — so a verified borrow
  // carries no backups. `invalidateRoute` re-runs the ladder instead.
  const backups = winner.verified
    ? []
    : pool
        .filter((cand) => cand.address !== winner.address && cand.provider === winner.provider)
        .map((cand) => cand.address);

  return {
    kind: winner.kind,
    addresses: [winner.address, ...backups].slice(0, 3),
    provider: winner.provider,
    via: winner.via,
    verified: winner.verified === true,
  };
}

async function detectProvider(
  host: string,
  names: string[],
  v4: string[]
): Promise<CdnProvider | null> {
  for (const name of names) {
    const provider = matchProvider(name);
    if (provider) return provider;
  }
  // No telling CNAME: CDN edge PTRs are the other reliable fingerprint.
  if (v4.length > 0) {
    for (const ptr of await reverse(v4[0])) {
      const provider = matchProvider(ptr);
      if (provider) return provider;
    }
  }
  return null;
}

function cacheRoute(key: string, route: TargetRoute | null, error: string | null): void {
  const c = cfg();
  routeCache.set(key, {
    route,
    error,
    expiresAt: Date.now() + (route ? c.positiveTtlMs : c.negativeTtlMs),
  });

  if (routeCache.size <= c.cacheMax) return;
  const now = Date.now();
  for (const [k, entry] of routeCache) {
    if (entry.expiresAt <= now) routeCache.delete(k);
  }
  while (routeCache.size > c.cacheMax) {
    const oldest = routeCache.keys().next();
    if (oldest.done) break;
    routeCache.delete(oldest.value);
  }
}

/**
 * Resolve a SOCKS5 target to the IPv6 address the connection should be made
 * to. Throws when no IPv6 path exists.
 */
export async function resolveTargetRoute(host: string, port: number): Promise<TargetRoute> {
  if (net.isIPv6(host)) {
    return { kind: 'literal', addresses: [host], provider: null, via: null, verified: false };
  }

  if (net.isIPv4(host)) {
    const nat = nat64Route([host]);
    if (nat) return nat;
    throw new Error(
      `IPv4 literal ${host} is not reachable from an IPv6-only source (set NAT64_PREFIX to enable NAT64)`
    );
  }

  const name = host.replace(/\.$/, '').toLowerCase();
  if (!isValidHostname(name)) {
    throw new Error(`Invalid target hostname: ${host}`);
  }

  const key = `${name}|${port}`;
  const cached = routeCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.route) return cached.route;
    throw new Error(cached.error || `No IPv6 route to ${name}`);
  }

  // Browsers open several connections at once; one resolution serves them all.
  const pending = inflight.get(key);
  if (pending) return pending;

  const task = computeRoute(name, port)
    .then((route) => {
      cacheRoute(key, route, null);
      inflight.delete(key);
      return route;
    })
    .catch((err: Error) => {
      cacheRoute(key, null, err.message);
      inflight.delete(key);
      throw err;
    });

  inflight.set(key, task);
  return task;
}

/**
 * Forget a cached route after every one of its addresses failed to connect.
 * An anycast edge can go away between the verification probe and the next
 * connection; dropping the entry makes the following attempt re-run the
 * ladder and pick a live edge instead of retrying a dead one for the whole TTL.
 */
export function invalidateRoute(host: string, port: number): void {
  routeCache.delete(`${host.replace(/\.$/, '').toLowerCase()}|${port}`);
}

// --- diagnostics ---

export interface HostInspection {
  host: string;
  port: number;
  cnameChain: string[];
  aaaa: string[];
  a: string[];
  provider: string | null;
  route: TargetRoute | null;
  error: string | null;
}

/** Run the full ladder for one host and report every step (API diagnostics). */
export async function inspectHost(host: string, port: number): Promise<HostInspection> {
  const name = host.replace(/\.$/, '').toLowerCase();
  if (!isValidHostname(name) && !net.isIP(name)) {
    throw new Error(`Invalid hostname: ${host}`);
  }

  const isLiteral = net.isIP(name) !== 0;
  const chain = isLiteral ? [] : await cnameChain(name);
  const [aaaa, a] = isLiteral ? [[], []] : await Promise.all([resolve6(name), resolve4(name)]);
  const provider = isLiteral ? null : await detectProvider(name, [name, ...chain], a);

  let route: TargetRoute | null = null;
  let error: string | null = null;
  try {
    route = await resolveTargetRoute(name, port);
  } catch (err: any) {
    error = err.message;
  }

  return {
    host: name,
    port,
    cnameChain: chain,
    aaaa,
    a,
    provider: provider?.name ?? null,
    route,
    error,
  };
}

export interface ResolverStats {
  cache: { size: number; max: number; entries: { key: string; kind: RouteKind | null; provider: string | null; address: string | null; verified: boolean; error: string | null; expiresInMs: number }[] };
  edgePools: { provider: string; addresses: string[]; expiresInMs: number }[];
  learnedEdges: { provider: string; addresses: string[] }[];
}

export function getResolverStats(): ResolverStats {
  const now = Date.now();
  return {
    cache: {
      size: routeCache.size,
      max: cfg().cacheMax,
      entries: Array.from(routeCache.entries()).map(([key, entry]) => ({
        key,
        kind: entry.route?.kind ?? null,
        provider: entry.route?.provider ?? null,
        address: entry.route?.addresses[0] ?? null,
        verified: entry.route?.verified ?? false,
        error: entry.error,
        expiresInMs: Math.max(0, entry.expiresAt - now),
      })),
    },
    edgePools: Array.from(edgePool.entries()).map(([provider, entry]) => ({
      provider,
      addresses: entry.addresses,
      expiresInMs: Math.max(0, entry.expiresAt - now),
    })),
    learnedEdges: Array.from(learnedEdges.keys()).map((provider) => ({
      provider,
      addresses: getLearnedEdges(provider),
    })),
  };
}

export function clearRouteCache(): number {
  const size = routeCache.size;
  routeCache.clear();
  return size;
}
