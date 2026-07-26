import crypto from 'crypto';
import os from 'os';
import { execFileSync } from 'child_process';

export interface ParsedCIDR {
  prefix: string;
  prefixLength: number;
}

export function parseCIDR(cidr: string): ParsedCIDR {
  const parts = cidr.split('/');
  if (parts.length !== 2) {
    throw new Error(`Invalid CIDR format: "${cidr}". Expected: "2001:db8:1::/64"`);
  }

  const prefixLength = parseInt(parts[1], 10);
  if (isNaN(prefixLength) || prefixLength < 1 || prefixLength > 128) {
    throw new Error(`Invalid prefix length in "${cidr}": must be 1-128`);
  }

  const addrStr = parts[0];
  let hextets: string[];
  if (addrStr.includes('::')) {
    const sides = addrStr.split('::');
    const left = sides[0] ? sides[0].split(':').filter(s => s !== '') : [];
    const right = sides[1] ? sides[1].split(':').filter(s => s !== '') : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0) {
      throw new Error(`Invalid IPv6 address in "${cidr}": too many hextets`);
    }
    hextets = [...left, ...Array(missing).fill('0'), ...right];
  } else {
    hextets = addrStr.split(':');
  }

  if (hextets.length !== 8) {
    throw new Error(`Invalid IPv6 address in "${cidr}": expected 8 hextets, got ${hextets.length}`);
  }

  for (const h of hextets) {
    if (!/^[0-9a-fA-F]{0,4}$/.test(h)) {
      throw new Error(`Invalid hextet "${h}" in "${cidr}"`);
    }
  }

  const padded = hextets.map(h => h.padStart(4, '0').toLowerCase());
  return { prefix: padded.join(':'), prefixLength };
}

/** Compress full 8-hextet IPv6 to canonical form (2001:470:ef3f::). */
export function compressIPv6(addr: string): string {
  const hextets = addr.includes(':') && !addr.includes('::')
    ? addr.split(':').map(h => (parseInt(h || '0', 16) || 0).toString(16))
    : parseCIDR(`${addr}/128`).prefix.split(':').map(h => (parseInt(h, 16) || 0).toString(16));
  // Find longest zero run
  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  for (let i = 0; i <= 8; i++) {
    if (i < 8 && hextets[i] === '0') {
      if (curStart < 0) curStart = i;
      curLen++;
    } else {
      if (curLen > bestLen) { bestStart = curStart; bestLen = curLen; }
      curStart = -1; curLen = 0;
    }
  }
  if (bestLen < 2) return hextets.join(':');
  const left = hextets.slice(0, bestStart).join(':');
  const right = hextets.slice(bestStart + bestLen).join(':');
  return `${left}::${right}`;
}

/** Normalize any CIDR to compressed network/prefix form for stable storage. */
export function normalizeCIDR(cidr: string): string {
  const { prefix, prefixLength } = parseCIDR(cidr);
  const network = networkAddressFromCIDR(prefix, prefixLength);
  return `${compressIPv6(network)}/${prefixLength}`;
}

export function generateIPv6(prefix: string, prefixLength: number): string {
  const hextets = prefix.split(':');
  const prefixBytes = Math.floor(prefixLength / 16);

  const result: string[] = [];
  for (let i = 0; i < 8; i++) {
    if (i < prefixBytes) {
      result.push(hextets[i]);
    } else if (i === prefixBytes && prefixLength % 16 !== 0) {
      const remaining = prefixLength % 16;
      const mask = (0xFFFF << (16 - remaining)) & 0xFFFF;
      const base = parseInt(hextets[i], 16) & mask;
      const randomPart = crypto.randomInt(0, 1 << (16 - remaining));
      result.push((base | randomPart).toString(16).padStart(4, '0'));
    } else {
      const rand = crypto.randomInt(0, 0xFFFF + 1);
      result.push(rand.toString(16).padStart(4, '0'));
    }
  }

  // Avoid all-zeros and all-ones interface ID
  const suffixStart = Math.max(0, prefixBytes);
  const suffix = result.slice(suffixStart).join(':');
  if (suffix === '0000:0000:0000:0000'.slice(0, suffix.length) ||
      suffix === 'ffff:ffff:ffff:ffff'.slice(0, suffix.length)) {
    return generateIPv6(prefix, prefixLength);
  }

  return result.join(':');
}

export function isReservedIPv6(addr: string): boolean {
  const lower = addr.toLowerCase();
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;
  if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return true;
  if (lower.startsWith('fe8') || lower.startsWith('fe9') ||
      lower.startsWith('fea') || lower.startsWith('feb')) return true;
  if (lower.startsWith('ff')) return true;
  return false;
}

/**
 * Auto-detect IPv6 subnets from the host's network interfaces.
 *
 * Reads all network interfaces via os.networkInterfaces(), extracts
 * IPv6 addresses with their prefix lengths, computes the network address
 * for each, and returns unique subnet CIDRs suitable for proxy address
 * allocation.
 *
 * Two strategies (in order):
 * 1. Use the `cidr` field directly (available on Node.js >= 18).
 * 2. Fall back to computing the prefix length from the `netmask` field
 *    when `cidr` is null/missing (Node.js docs note `cidr` can be null
 *    when the netmask is invalid; some kernels report IPv6 addresses
 *    differently).
 *
 * Skip candidates: loopback, link-local (fe80::/10), unspecified,
 * multicast (ff00::/8), and addresses with a /128 prefix (single-host).
 */
export function detectIPv6Subnets(exclude: string[] = []): string[] {
  const ifaces = os.networkInterfaces();
  const subnets = new Set<string>();
  const excluded = new Set(
    exclude.map((c) => {
      try {
        return normalizeCIDR(c);
      } catch {
        return c;
      }
    })
  );

  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;

    for (const addr of addrs) {
      // Only IPv6, only external (non-internal)
      if (addr.family !== 'IPv6' || addr.internal) continue;

      let ipStr: string;
      let prefixLen: number;

      // Strategy 1: use the cidr field
      const cidr = (addr as any).cidr as string | undefined | null;
      if (cidr) {
        const slashIdx = cidr.indexOf('/');
        if (slashIdx === -1) continue;
        prefixLen = parseInt(cidr.slice(slashIdx + 1), 10);
        ipStr = cidr.slice(0, slashIdx);
      } else {
        // Strategy 2: construct from address + netmask
        const netmask = (addr as any).netmask as string | undefined;
        if (!netmask) continue;
        prefixLen = prefixLengthFromNetmask(netmask);
        if (prefixLen < 1) continue;
        ipStr = (addr as any).address as string;
        if (!ipStr) continue;
      }

      // Skip /128 (single-host, not a usable subnet) and invalid lengths
      if (isNaN(prefixLen) || prefixLen < 1 || prefixLen > 127) continue;

      // Skip reserved address ranges
      if (isReservedIPv6(ipStr)) continue;
      if (ipStr.startsWith('fd') || ipStr.startsWith('fc')) continue; // ULA

      // Compute the network / prefix address
      try {
        const network = networkAddressFromCIDR(ipStr, prefixLen);
        const subnetCidr = normalizeCIDR(`${network}/${prefixLen}`);
        // The 6in4 link prefix is one of these, but only our single tunnel
        // address inside it is ours to allocate from.
        if (excluded.has(subnetCidr)) continue;
        subnets.add(subnetCidr);
      } catch {
        // silently skip malformed addresses
      }
    }
  }

  // Drop nested subnets: keep the broadest covering prefixes only.
  // e.g. 2001:db8::/48 swallows 2001:db8:0:1::/64.
  return collapseNestedSubnets(Array.from(subnets));
}

/** True if `outer` fully contains `inner` (strict: shorter prefix, same network bits). */
export function cidrContains(outer: string, inner: string): boolean {
  const o = parseCIDR(outer);
  const i = parseCIDR(inner);
  if (o.prefixLength >= i.prefixLength) return false;
  const oNet = networkAddressFromCIDR(o.prefix, o.prefixLength);
  const iAsOuter = networkAddressFromCIDR(i.prefix, o.prefixLength);
  return oNet === iAsOuter;
}

/** Keep broadest CIDRs; drop any that sit inside another kept prefix. */
export function collapseNestedSubnets(cidrs: string[]): string[] {
  const sorted = [...cidrs].sort(
    (a, b) => parseCIDR(a).prefixLength - parseCIDR(b).prefixLength
  );
  const kept: string[] = [];
  for (const c of sorted) {
    if (kept.some((k) => cidrContains(k, c))) continue;
    kept.push(c);
  }
  return kept;
}

/**
 * Compute the prefix length from an IPv6 netmask string.
 * E.g., "ffff:ffff:ffff:ffff:0000:0000:0000:0000" → 64
 */
function prefixLengthFromNetmask(netmask: string): number {
  // Expand :: notation in the netmask
  let hextets: string[];
  if (netmask.includes('::')) {
    const sides = netmask.split('::');
    const left = sides[0] ? sides[0].split(':').filter(s => s !== '') : [];
    const right = sides[1] ? sides[1].split(':').filter(s => s !== '') : [];
    const missing = 8 - left.length - right.length;
    hextets = [...left, ...Array(missing).fill('0'), ...right];
  } else {
    hextets = netmask.split(':');
  }

  if (hextets.length !== 8) return 0;

  let bits = 0;
  for (const h of hextets) {
    const val = parseInt(h || '0', 16);
    if (val === 0xFFFF) {
      bits += 16;
    } else {
      // Count leading 1 bits in this hextet
      let mask = 0x8000;
      while (mask && (val & mask)) {
        bits++;
        mask >>= 1;
      }
      break;
    }
  }
  return bits;
}

/** True if `addr` falls inside `cidr`. */
export function isAddressInCIDR(addr: string, cidr: string): boolean {
  try {
    const { prefix, prefixLength } = parseCIDR(cidr);
    const network = networkAddressFromCIDR(prefix, prefixLength);
    const expanded = parseCIDR(`${addr}/128`).prefix;
    return networkAddressFromCIDR(expanded, prefixLength) === network;
  } catch {
    return false;
  }
}

/**
 * Given an IPv6 address and a prefix length, compute the network address
 * (all host bits zeroed). E.g., "2001:db8:1::1" / 64 => "2001:db8:1::"
 */
function networkAddressFromCIDR(address: string, prefixLen: number): string {
  const parts = address.split(':');
  // Expand :: notation
  let hextets: string[];
  if (address.includes('::')) {
    const sides = address.split('::');
    const left = sides[0] ? sides[0].split(':').filter(s => s !== '') : [];
    const right = sides[1] ? sides[1].split(':').filter(s => s !== '') : [];
    const missing = 8 - left.length - right.length;
    hextets = [...left, ...Array(missing).fill('0'), ...right];
  } else {
    hextets = address.split(':');
  }

  // Zero out bits beyond the prefix
  for (let i = 0; i < 8; i++) {
    const hextetVal = parseInt(hextets[i] || '0', 16);
    const bitsBefore = i * 16;
    if (bitsBefore >= prefixLen) {
      hextets[i] = '0';
    } else if (bitsBefore + 16 > prefixLen) {
      const keepBits = prefixLen - bitsBefore;
      const mask = 0xFFFF << (16 - keepBits);
      hextets[i] = (hextetVal & mask).toString(16).padStart(4, '0');
    } else {
      hextets[i] = hextetVal.toString(16).padStart(4, '0');
    }
  }

  return hextets.join(':').toLowerCase();
}

// --- Interface address binding for LXC / non-Docker deployments ---

let _outboundInterface: string | null = null;
const _registeredAddrs = new Map<string, { refs: number; iface: string }>();
/** Prefixes that live on a specific device — currently the 6in4 tunnel's. */
const _prefixInterfaces: { cidr: string; iface: string }[] = [];

/**
 * Pin a prefix to a device, so addresses from it are added there instead of on
 * the host's own outbound interface. A tunnelled prefix reaches the internet
 * through the tunnel device and nowhere else.
 */
export function registerInterfaceForPrefix(cidr: string, iface: string): void {
  const normalized = normalizeCIDR(cidr);
  const existing = _prefixInterfaces.find((p) => p.cidr === normalized);
  if (existing) {
    existing.iface = iface;
    return;
  }
  _prefixInterfaces.push({ cidr: normalized, iface });
}

export function clearPrefixInterfaces(iface?: string): void {
  const keep = iface ? _prefixInterfaces.filter((p) => p.iface !== iface) : [];
  _prefixInterfaces.length = 0;
  _prefixInterfaces.push(...keep);
}

/** The device an address should be configured on: its pinned prefix, else the default one. */
export function interfaceForAddress(addr: string): string {
  let best: { cidr: string; iface: string } | null = null;
  for (const entry of _prefixInterfaces) {
    if (!isAddressInCIDR(addr, entry.cidr)) continue;
    if (!best || parseCIDR(entry.cidr).prefixLength > parseCIDR(best.cidr).prefixLength) {
      best = entry;
    }
  }
  return best ? best.iface : getOutboundInterface();
}

/** Drop the cached outbound interface — call after the routing table changes. */
export function resetOutboundInterface(): void {
  _outboundInterface = null;
}

/**
 * Detect or return the cached outbound network interface (the one
 * with the default IPv6 route). Respects IPV6_INTERFACE env var.
 */
export function getOutboundInterface(): string {
  if (_outboundInterface) return _outboundInterface;

  // Allow explicit override via env
  const envIface = process.env.IPV6_INTERFACE;
  if (envIface) {
    _outboundInterface = envIface;
    return envIface;
  }

  // Auto-detect: find the interface that has the default IPv6 route
  try {
    const out = execFileSync('ip', ['-6', 'route', 'show', 'default'], {
      encoding: 'utf-8', timeout: 3000,
    });
    // Output: "default via FE80::1 dev eth0 metric 1024 pref medium"
    const m = out.match(/dev (\S+)/);
    if (m) {
      _outboundInterface = m[1];
      return _outboundInterface;
    }
  } catch {}

  // Fallback: use the first non-loopback interface with a global IPv6 address
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (name === 'lo' || !addrs) continue;
    for (const a of addrs) {
      if (a.family === 'IPv6' && !a.internal) {
        _outboundInterface = name;
        return name;
      }
    }
  }

  return 'eth0'; // last-resort fallback
}

/**
 * Register an IPv6 address on the outbound interface so the upstream
 * router responds to NDP (Neighbor Discovery) queries for this address.
 *
 * In LXC containers and some VPS configurations, only addresses
 * explicitly added to the network interface receive return traffic
 * because the upstream switch/router uses NDP to map IPv6 → MAC.
 * Adding the address to the interface makes the kernel answer NDP
 * solicitations, so return packets reach the container.
 */
export function registerIPv6Address(addr: string): void {
  const entry = _registeredAddrs.get(addr);
  if (entry) {
    entry.refs++;
    return;
  }

  const iface = interfaceForAddress(addr);
  try {
    execFileSync('ip', ['-6', 'addr', 'add', `${addr}/128`, 'dev', iface], {
      timeout: 3000,
    });
  } catch {
    // Address may already exist on the interface (e.g., from a previous
    // run) — still track it for refcounted cleanup.
  }
  // Remember where it was put: the tunnel may be torn down and re-detected
  // before this address is released.
  _registeredAddrs.set(addr, { refs: 1, iface });
}

/**
 * Drop one reference to a registered IPv6 address. When the last session
 * releases it, remove the address from the outbound interface.
 * Safe to call on addresses that were never registered.
 */
export function unregisterIPv6Address(addr: string): void {
  const entry = _registeredAddrs.get(addr);
  if (entry === undefined) return;

  if (entry.refs > 1) {
    entry.refs--;
    return;
  }

  removeAddressFromInterface(addr, entry.iface);
  _registeredAddrs.delete(addr);
}

/**
 * Force-remove an address regardless of refcount (sticky refresh / user delete).
 */
export function forceUnregisterIPv6Address(addr: string): void {
  const entry = _registeredAddrs.get(addr);
  removeAddressFromInterface(addr, entry ? entry.iface : interfaceForAddress(addr));
  _registeredAddrs.delete(addr);
}

/**
 * Remove all registered addresses (called on graceful shutdown).
 */
export function unregisterAllIPv6Addresses(): void {
  for (const [addr, entry] of _registeredAddrs) {
    removeAddressFromInterface(addr, entry.iface);
  }
  _registeredAddrs.clear();
}

function removeAddressFromInterface(addr: string, iface: string): void {
  try {
    execFileSync('ip', ['-6', 'addr', 'del', `${addr}/128`, 'dev', iface], {
      timeout: 3000,
    });
  } catch {
    // best-effort — may not be on the interface in this process
  }
}
