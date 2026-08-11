/**
 * Hurricane Electric tunnelbroker.net client.
 *
 * Two calls matter for bringing a tunnel up unattended:
 *
 *   - `tunnelInfo.php` returns the tunnel's endpoints and routed prefixes, so
 *     the operator only has to supply credentials instead of transcribing six
 *     addresses out of the web UI.
 *   - `nic/update` (a dyndns-protocol endpoint) points the tunnel at the IPv4
 *     address the request came from. A 6in4 tunnel only carries traffic when
 *     HE's configured client IPv4 matches the host's actual one, so this is
 *     what makes the tunnel survive a dynamic IP or a move to a new box.
 *
 * Both are reached over IPv4 on purpose: the update endpoint infers the tunnel
 * endpoint from the source address of the request, and a host that needs a
 * tunnel generally has no IPv6 path to reach them over anyway.
 */
import https from 'https';
import { TunnelConfig } from '../config';

const USER_AGENT = 'ipv6-subnet-proxy/1.5 (+https://github.com/kaecho/ipv6-subnet-proxy)';
const MAX_BODY_BYTES = 512 * 1024;

export interface TunnelInfo {
  id: string | null;
  description: string | null;
  serverIpv4: string | null;
  serverIpv6: string | null;
  clientIpv4: string | null;
  clientIpv6: string | null;
  routed64: string | null;
  routed48: string | null;
  mtu: number | null;
}

export interface UpdateResult {
  ok: boolean;
  code: string;
  ip: string | null;
  message: string;
}

interface HttpResult {
  status: number;
  body: string;
}

export function isIPv4(value: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value.trim());
  if (!m) return false;
  return m.slice(1).every((o) => {
    const n = parseInt(o, 10);
    return n >= 0 && n <= 255 && String(n) === String(parseInt(o, 10));
  });
}

function httpsGetText(rawUrl: string, opts: { auth?: string; timeoutMs: number }): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      reject(new Error(`Invalid URL: ${rawUrl}`));
      return;
    }
    if (url.protocol !== 'https:') {
      // These requests carry the tunnel credentials.
      reject(new Error(`Refusing to send tunnel credentials over ${url.protocol}//`));
      return;
    }

    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        auth: opts.auth,
        family: 4,
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
        timeout: opts.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BODY_BYTES) {
            req.destroy(new Error('Response too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () =>
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );

    req.on('timeout', () => req.destroy(new Error(`Request to ${url.hostname} timed out after ${opts.timeoutMs}ms`)));
    req.on('error', reject);
    req.end();
  });
}

// --- tunnelInfo.php ----------------------------------------------------------

/**
 * Field name variants accepted from the XML. HE documents the endpoint but not
 * its schema, so each field is looked up under every spelling that has been
 * seen in the wild rather than one exact tag.
 */
const FIELDS = {
  id: ['id', 'tunnel_id', 'tunnelid'],
  description: ['description', 'desc'],
  serverIpv4: ['serverv4', 'server_v4', 'server_ipv4', 'serverip4'],
  serverIpv6: ['serverv6', 'server_v6', 'server_ipv6', 'serverip6'],
  clientIpv4: ['clientv4', 'client_v4', 'client_ipv4', 'clientip4'],
  clientIpv6: ['clientv6', 'client_v6', 'client_ipv6', 'clientip6'],
  routed64: ['routed64', 'routed_64', 'routed_prefix64', 'routedprefix64'],
  routed48: ['routed48', 'routed_48', 'routed_prefix48', 'routedprefix48'],
  mtu: ['mtu'],
} as const;

function tagValue(xml: string, names: readonly string[]): string | null {
  for (const name of names) {
    const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
    if (!m) continue;
    const value = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
    if (value) return value;
  }
  return null;
}

/** Append the implied prefix length when the API returns a bare address. */
function withPrefix(value: string | null, length: number): string | null {
  if (!value) return null;
  return value.includes('/') ? value : `${value}/${length}`;
}

export function parseTunnelInfoXml(xml: string, tunnelId?: string | null): TunnelInfo {
  const blocks: { id: string | null; body: string }[] = [];
  const re = /<tunnel\b([^>]*)>([\s\S]*?)<\/tunnel>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const idAttr = /\bid\s*=\s*["']?([^"'\s>]+)/i.exec(m[1]);
    blocks.push({ id: idAttr ? idAttr[1] : tagValue(m[2], FIELDS.id), body: m[2] });
  }

  // Tolerate a response that is a single tunnel without a wrapper element.
  if (blocks.length === 0 && tagValue(xml, FIELDS.clientIpv6)) {
    blocks.push({ id: tagValue(xml, FIELDS.id), body: xml });
  }

  if (blocks.length === 0) {
    throw new Error(
      'tunnelInfo returned no tunnel data. Check the credentials, or configure the ' +
        'tunnel manually with HE_TUNNEL_SERVER_IPV4 / HE_TUNNEL_CLIENT_IPV6 / HE_TUNNEL_ROUTED_PREFIXES.'
    );
  }

  let chosen: { id: string | null; body: string };
  if (tunnelId) {
    const match = blocks.find((b) => b.id === tunnelId);
    if (!match) {
      const ids = blocks.map((b) => b.id ?? '?').join(', ');
      throw new Error(`Tunnel ${tunnelId} is not in this account (found: ${ids})`);
    }
    chosen = match;
  } else if (blocks.length === 1) {
    chosen = blocks[0];
  } else {
    const ids = blocks.map((b) => b.id ?? '?').join(', ');
    throw new Error(`Account has ${blocks.length} tunnels (${ids}); set HE_TUNNEL_ID to pick one`);
  }

  const mtuRaw = tagValue(chosen.body, FIELDS.mtu);
  const mtu = mtuRaw ? parseInt(mtuRaw, 10) : NaN;

  return {
    id: chosen.id,
    description: tagValue(chosen.body, FIELDS.description),
    serverIpv4: tagValue(chosen.body, FIELDS.serverIpv4),
    serverIpv6: tagValue(chosen.body, FIELDS.serverIpv6),
    clientIpv4: tagValue(chosen.body, FIELDS.clientIpv4),
    clientIpv6: withPrefix(tagValue(chosen.body, FIELDS.clientIpv6), 64),
    routed64: withPrefix(tagValue(chosen.body, FIELDS.routed64), 64),
    routed48: withPrefix(tagValue(chosen.body, FIELDS.routed48), 48),
    mtu: isNaN(mtu) ? null : mtu,
  };
}

/**
 * HE requires a tunnel's Update Key instead of the account password for calls
 * that operate on a single tunnel.
 */
function apiSecret(cfg: TunnelConfig): string {
  const secret = cfg.tunnelId && cfg.updateKey ? cfg.updateKey : cfg.password || cfg.updateKey;
  if (!cfg.username || !secret) {
    throw new Error('HE_TUNNEL_USERNAME and HE_TUNNEL_PASSWORD (or HE_TUNNEL_UPDATE_KEY) are required');
  }
  return secret;
}

export async function fetchTunnelInfo(cfg: TunnelConfig): Promise<TunnelInfo> {
  const secret = apiSecret(cfg);
  const url = new URL(cfg.apiUrl);
  if (cfg.tunnelId) url.searchParams.set('tid', cfg.tunnelId);

  const res = await httpsGetText(url.toString(), {
    auth: `${cfg.username}:${secret}`,
    timeoutMs: cfg.requestTimeoutMs,
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `tunnelbroker.net rejected the credentials (HTTP ${res.status}). Note that a tunnel ` +
        'with an Update Key set requires that key in HE_TUNNEL_UPDATE_KEY, not the account password.'
    );
  }
  if (res.status !== 200) {
    throw new Error(`tunnelInfo returned HTTP ${res.status}`);
  }
  return parseTunnelInfoXml(res.body, cfg.tunnelId);
}

// --- endpoint update (dyndns protocol) ---------------------------------------

export function parseUpdateResponse(body: string): UpdateResult {
  const text = body.trim();
  const code = (text.split(/\s+/)[0] || '').toLowerCase();
  const ipMatch = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(text);
  const ip = ipMatch ? ipMatch[1] : null;

  switch (code) {
    case 'good':
      return { ok: true, code, ip, message: `Tunnel endpoint set to ${ip ?? 'the detected address'}` };
    case 'nochg':
      return { ok: true, code, ip, message: `Tunnel endpoint already ${ip ?? 'up to date'}` };
    case 'badauth':
      return {
        ok: false,
        code,
        ip,
        message:
          'Credentials rejected. A tunnel with an Update Key set requires that key in ' +
          'HE_TUNNEL_UPDATE_KEY rather than the account password.',
      };
    case 'nohost':
      return { ok: false, code, ip, message: 'HE_TUNNEL_ID is not a tunnel on this account' };
    case 'abuse':
      return { ok: false, code, ip, message: 'HE blocked the update as abuse — raise HE_TUNNEL_UPDATE_INTERVAL_MS' };
    case 'badagent':
      return { ok: false, code, ip, message: 'HE rejected the client user agent' };
    case 'notfqdn':
      return { ok: false, code, ip, message: 'HE rejected the hostname (HE_TUNNEL_ID)' };
    case 'dnserr':
    case '911':
      return { ok: false, code, ip, message: 'HE reported a server-side error; the tunnel endpoint was not updated' };
    default:
      return {
        ok: false,
        code: code || 'empty',
        ip,
        message: text ? `Unexpected response from HE: ${text.slice(0, 200)}` : 'Empty response from HE',
      };
  }
}

/**
 * Point the tunnel at `myip`, or at whatever public IPv4 the request appears to
 * come from when `myip` is omitted.
 */
export async function updateTunnelEndpoint(cfg: TunnelConfig, myip?: string | null): Promise<UpdateResult> {
  if (!cfg.tunnelId) {
    throw new Error('HE_TUNNEL_ID is required to update the tunnel endpoint');
  }
  const secret = apiSecret(cfg);
  const url = new URL(cfg.updateUrl);
  url.searchParams.set('hostname', cfg.tunnelId);
  if (myip) url.searchParams.set('myip', myip);

  const res = await httpsGetText(url.toString(), {
    auth: `${cfg.username}:${secret}`,
    timeoutMs: cfg.requestTimeoutMs,
  });

  if (res.status === 401 || res.status === 403) {
    return parseUpdateResponse('badauth');
  }
  return parseUpdateResponse(res.body);
}

/** This host's public IPv4 as seen from the internet — the address HE must tunnel to. */
export async function detectPublicIPv4(cfg: TunnelConfig): Promise<string> {
  const res = await httpsGetText(cfg.publicIpv4Url, { timeoutMs: cfg.requestTimeoutMs });
  if (res.status !== 200) {
    throw new Error(`Public IPv4 lookup (${cfg.publicIpv4Url}) returned HTTP ${res.status}`);
  }
  const ip = res.body.trim();
  if (!isIPv4(ip)) {
    throw new Error(`Public IPv4 lookup returned something that is not an IPv4 address: ${ip.slice(0, 80)}`);
  }
  return ip;
}
