/**
 * Known anycast CDNs whose edge nodes are dual-stack and route requests by
 * SNI / Host header rather than by destination IP.
 *
 * That property is what makes "edge borrowing" work: a site fronted by one of
 * these CDNs is reachable over IPv6 through *any* edge address of that CDN,
 * even when the site's own DNS publishes no AAAA record. IPv6 in DNS is a
 * per-customer toggle; the edge fleet itself is dual-stack regardless.
 *
 * `match` is tested against CNAME chain hops and against the PTR name of the
 * target's IPv4 address — CDNs commonly name their edge PTRs after themselves
 * (`server-x-x-x-x.lhr50.r.cloudfront.net`, `cache-fra-1.fastly.net`,
 * `a23-x-x-x.deploy.static.akamaitechnologies.com`).
 *
 * `seeds` are dual-stack hostnames on the same fleet, used only to harvest a
 * live edge address. They are a starting point, not a guarantee: seeds that do
 * not resolve are skipped silently, the pool self-populates from observed
 * traffic (see `recordLearnedEdges`), and operators can pin known-good edges
 * with CDN_FALLBACK_EDGES.
 */
export interface CdnProvider {
  name: string;
  match: RegExp;
  seeds: string[];
}

export const CDN_PROVIDERS: CdnProvider[] = [
  {
    name: 'cloudfront',
    match: /(^|\.)cloudfront\.net$/,
    seeds: [
      'd2wy8f7a9ursnm.cloudfront.net',
      'docs.aws.amazon.com',
      'aws.amazon.com',
    ],
  },
  {
    name: 'fastly',
    match: /(^|\.)(fastly\.net|fastlylb\.net|fastly-edge\.com|fastlyssl\.net)$/,
    seeds: [
      'www.fastly.com',
      'github.githubassets.com',
      'cdn.jsdelivr.net',
    ],
  },
  {
    name: 'akamai',
    match: /(^|\.)(akamaiedge\.net|akamai\.net|akamaized\.net|akamaihd\.net|edgekey\.net|edgesuite\.net|akadns\.net|akamaitechnologies\.com)$/,
    seeds: [
      'www.akamai.com',
      'www.apple.com',
      'www.ibm.com',
    ],
  },
  {
    name: 'cloudflare',
    match: /(^|\.)(cloudflare\.net|cloudflare\.com|cloudflaressl\.com|pages\.dev|workers\.dev|cdn\.cloudflare\.net)$/,
    seeds: [
      'www.cloudflare.com',
      'blog.cloudflare.com',
      'cdnjs.cloudflare.com',
    ],
  },
  {
    name: 'google',
    match: /(^|\.)(googlehosted\.com|ghs\.google\.com|googleusercontent\.com|gvt1\.com|1e100\.net|google\.com)$/,
    seeds: [
      'www.google.com',
      'ghs.googlehosted.com',
      'storage.googleapis.com',
    ],
  },
  {
    name: 'azure',
    match: /(^|\.)(azureedge\.net|azurefd\.net|azureedge-vnext\.net|trafficmanager\.net|msecnd\.net|msedge\.net|azure\.com)$/,
    seeds: [
      'azure.microsoft.com',
      'www.microsoft.com',
    ],
  },
  {
    name: 'aws',
    match: /(^|\.)(elb\.amazonaws\.com|awsglobalaccelerator\.com|amazonaws\.com)$/,
    seeds: [
      'aws.amazon.com',
    ],
  },
  {
    name: 'bunny',
    match: /(^|\.)(b-cdn\.net|bunnycdn\.com|bunny\.net)$/,
    seeds: ['bunny.net'],
  },
  {
    name: 'gcore',
    match: /(^|\.)(gcdn\.co|gcorelabs\.com|gcore\.com)$/,
    seeds: ['gcore.com'],
  },
  {
    name: 'cdn77',
    match: /(^|\.)(cdn77\.org|cdn77\.com)$/,
    seeds: ['www.cdn77.com'],
  },
  {
    name: 'stackpath',
    match: /(^|\.)(stackpathdns\.com|stackpathcdn\.com|netdna-cdn\.com|highwinds-cdn\.com)$/,
    seeds: [],
  },
  {
    name: 'imperva',
    match: /(^|\.)(incapdns\.net|impervadns\.net)$/,
    seeds: [],
  },
];

/** First provider whose pattern matches `name` (a CNAME hop or PTR name). */
export function matchProvider(name: string): CdnProvider | null {
  const clean = name.replace(/\.$/, '').toLowerCase();
  if (!clean) return null;
  return CDN_PROVIDERS.find((p) => p.match.test(clean)) || null;
}

export function getProvider(name: string): CdnProvider | null {
  return CDN_PROVIDERS.find((p) => p.name === name) || null;
}
