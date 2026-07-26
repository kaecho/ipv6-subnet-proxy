/**
 * Cloudflare WARP device registration.
 *
 * WARP is a free WireGuard service. Registering a device hands out a
 * WireGuard peer and a single global IPv6 address out of Cloudflare's space —
 * no account, no payment, no email. That address is a real, routable /128, so
 * a host with nothing but IPv4 can still egress over IPv6.
 *
 * One registration is one address. To spread connections across more than one
 * egress IP the proxy registers several devices and brings up one WireGuard
 * link per registration; see `warp.ts`.
 *
 * The API is the one Cloudflare's own 1.1.1.1 clients speak. It is not
 * documented publicly, so the request is shaped like a real client's and every
 * field that Cloudflare could plausibly rotate is configurable.
 *
 * Registration is reached over IPv4 on purpose: a host that needs WARP for
 * IPv6 has no IPv6 path to reach the API over.
 */
import crypto from 'crypto';
import https from 'https';
import { WarpConfig } from '../config';

const MAX_BODY_BYTES = 256 * 1024;

/** The DER preamble of a PKCS#8-wrapped X25519 private key; the 32 raw bytes follow. */
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

export interface WarpKeyPair {
  /** base64, the form WireGuard configs use. */
  privateKey: string;
  publicKey: string;
}

export interface WarpAccount {
  /** Slot this account occupies — also picks its device name and route table. */
  slot: number;
  deviceId: string | null;
  /** Bearer token for later calls against this device (e.g. applying a licence). */
  token: string | null;
  accountId: string | null;
  accountType: string | null;
  license: string | null;
  privateKey: string;
  publicKey: string;
  /** Cloudflare's side of the WireGuard tunnel. */
  peerPublicKey: string;
  /** `host:port` as Cloudflare reports it, e.g. engage.cloudflareclient.com:2408. */
  endpointHost: string;
  clientId: string | null;
  /** The three bytes some WARP clients stuff into the WireGuard reserved field. */
  reserved: number[];
  addressV4: string | null;
  /** The whole point: a routable IPv6 address, without a prefix length. */
  addressV6: string;
}

interface HttpResult {
  status: number;
  body: string;
}

// --- keys --------------------------------------------------------------------

/** A WireGuard keypair. X25519 is exactly the curve WireGuard uses. */
export function generateWarpKeyPair(): WarpKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64'),
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
  };
}

/** Recover the public key of a stored private key, so only the private one has to be persisted. */
export function publicKeyFromPrivate(privateKeyB64: string): string {
  const raw = Buffer.from(privateKeyB64, 'base64');
  if (raw.length !== 32) {
    throw new Error(`A WireGuard private key is 32 bytes; got ${raw.length}`);
  }
  const key = crypto.createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8',
  });
  return crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
}

/**
 * The `reserved` triple is just the client id's bytes. Kernel WireGuard does
 * not use it — it is recorded for diagnostics and for userspace clients that do.
 */
export function reservedFromClientId(clientId: string | null): number[] {
  if (!clientId) return [];
  return Array.from(Buffer.from(clientId, 'base64'));
}

function randomToken(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

/** The registration body a 1.1.1.1 client sends. Only `key` carries real meaning. */
export function buildRegistrationBody(publicKey: string, now: string): Record<string, string> {
  const installId = randomToken(22);
  return {
    key: publicKey,
    install_id: installId,
    fcm_token: `${installId}:APA91b${randomToken(134)}`,
    tos: now,
    model: 'PC',
    serial_number: installId,
    locale: 'en_US',
  };
}

// --- response parsing --------------------------------------------------------

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`WARP registration response is missing ${what}`);
  }
  return value.trim();
}

/**
 * Pull a usable WireGuard peer out of the registration response.
 *
 * The address arrives without a prefix length; it is a /128, which is what
 * makes a WARP account exactly one egress address rather than a pool.
 */
export function parseRegistration(body: string, keys: WarpKeyPair, slot: number): WarpAccount {
  let json: any;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`WARP registration returned something that is not JSON: ${body.slice(0, 200)}`);
  }

  if (json?.success === false || json?.errors?.length) {
    const detail = JSON.stringify(json.errors ?? json).slice(0, 200);
    throw new Error(`WARP registration was rejected: ${detail}`);
  }

  const config = json?.config;
  const peer = config?.peers?.[0];
  if (!config || !peer) {
    throw new Error(`WARP registration response has no WireGuard config: ${body.slice(0, 200)}`);
  }

  const clientId = typeof config.client_id === 'string' ? config.client_id : null;
  const endpoint = peer.endpoint ?? {};

  return {
    slot,
    deviceId: typeof json.id === 'string' ? json.id : null,
    token: typeof json.token === 'string' ? json.token : null,
    accountId: typeof json.account?.id === 'string' ? json.account.id : null,
    accountType: typeof json.account?.account_type === 'string' ? json.account.account_type : null,
    license: typeof json.account?.license === 'string' ? json.account.license : null,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    peerPublicKey: requireString(peer.public_key, "Cloudflare's peer public key"),
    endpointHost: typeof endpoint.host === 'string' && endpoint.host.trim() ? endpoint.host.trim() : '',
    clientId,
    reserved: reservedFromClientId(clientId),
    addressV4: typeof config.interface?.addresses?.v4 === 'string' ? config.interface.addresses.v4 : null,
    addressV6: requireString(config.interface?.addresses?.v6, 'an IPv6 address'),
  };
}

// --- transport ---------------------------------------------------------------

function httpsJson(
  rawUrl: string,
  opts: {
    method: 'POST' | 'PUT' | 'GET';
    body?: unknown;
    headers: Record<string, string>;
    timeoutMs: number;
  }
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      reject(new Error(`Invalid WARP API URL: ${rawUrl}`));
      return;
    }
    if (url.protocol !== 'https:') {
      // The response carries the WireGuard private key's counterpart and a bearer token.
      reject(new Error(`Refusing to register a WARP device over ${url.protocol}//`));
      return;
    }

    const payload = opts.body === undefined ? null : Buffer.from(JSON.stringify(opts.body), 'utf8');
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: opts.method,
        // A host that needs WARP for IPv6 cannot reach the API over IPv6.
        family: 4,
        headers: {
          ...opts.headers,
          ...(payload ? { 'Content-Length': String(payload.length) } : {}),
        },
        timeout: opts.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BODY_BYTES) {
            req.destroy(new Error('WARP API response too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () =>
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );

    req.on('timeout', () =>
      req.destroy(new Error(`WARP API request to ${url.hostname} timed out after ${opts.timeoutMs}ms`))
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function clientHeaders(cfg: WarpConfig): Record<string, string> {
  return {
    'CF-Client-Version': cfg.clientVersion,
    'User-Agent': cfg.userAgent,
    'Content-Type': 'application/json; charset=UTF-8',
    Accept: 'application/json',
  };
}

/** Register one device and return the WireGuard peer it was given. */
export async function registerWarpAccount(cfg: WarpConfig, slot: number): Promise<WarpAccount> {
  const keys = generateWarpKeyPair();
  const res = await httpsJson(cfg.apiUrl, {
    method: 'POST',
    body: buildRegistrationBody(keys.publicKey, new Date().toISOString()),
    headers: clientHeaders(cfg),
    timeoutMs: cfg.requestTimeoutMs,
  });

  if (res.status === 429) {
    throw new Error(
      'Cloudflare rate-limited the WARP registration. Lower WARP_ACCOUNTS or retry later; ' +
        'accounts already registered are stored and reused, so a restart will not re-register them.'
    );
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`WARP registration returned HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }

  const account = parseRegistration(res.body, keys, slot);
  if (!account.endpointHost) account.endpointHost = cfg.endpoint;
  return account;
}

/**
 * Attach a WARP+ licence to a registered device. Optional: the free tier
 * already provides the IPv6 address, a licence only changes the quota.
 */
export async function applyWarpLicense(
  cfg: WarpConfig,
  account: WarpAccount,
  license: string
): Promise<{ accountType: string | null; license: string | null }> {
  if (!account.deviceId || !account.token) {
    throw new Error('Applying a WARP licence needs the device id and token from registration');
  }

  const base = cfg.apiUrl.replace(/\/reg\/?$/, '');
  const res = await httpsJson(`${base}/reg/${encodeURIComponent(account.deviceId)}/account`, {
    method: 'PUT',
    body: { license: license.trim() },
    headers: { ...clientHeaders(cfg), Authorization: `Bearer ${account.token}` },
    timeoutMs: cfg.requestTimeoutMs,
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`WARP licence was rejected (HTTP ${res.status}): ${res.body.slice(0, 200)}`);
  }

  const json = JSON.parse(res.body);
  return {
    accountType: typeof json?.account_type === 'string' ? json.account_type : null,
    license: typeof json?.license === 'string' ? json.license : null,
  };
}
