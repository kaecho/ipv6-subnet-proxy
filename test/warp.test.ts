import test from 'node:test';
import assert from 'node:assert/strict';

process.env.API_KEY = 'test-key';

import { WarpConfig } from '../src/config';
import {
  generateWarpKeyPair,
  publicKeyFromPrivate,
  reservedFromClientId,
  buildRegistrationBody,
  parseRegistration,
} from '../src/core/warp-api';
import {
  PRIVATE_KEY_FILE,
  parseEndpoint,
  parseWarpDevices,
  warpDeviceName,
  buildLink,
  planWarpSetup,
  planWarpTeardown,
} from '../src/core/warp';
import { generateIPv6, parseCIDR } from '../src/utils/ipv6';

/** A registration response in the shape Cloudflare's client API returns it. */
const REG_RESPONSE = JSON.stringify({
  id: 'e5b7c2a0-0000-4d1a-9f3b-2c9d4e5f6a7b',
  type: 'a',
  token: '9f2a4c6e-1111-4b8d-8e7f-3a1b2c3d4e5f',
  account: {
    id: 'a1b2c3d4-2222-4c5d-9e8f-7a6b5c4d3e2f',
    account_type: 'free',
    license: 'K3s9L2mP-xxxxxxxx-yyyyyyyy',
  },
  config: {
    client_id: 'kJq2',
    peers: [
      {
        public_key: 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=',
        endpoint: {
          v4: '162.159.192.1:0',
          v6: '[2606:4700:d0::a29f:c001]:0',
          host: 'engage.cloudflareclient.com:2408',
        },
      },
    ],
    interface: {
      addresses: {
        v4: '172.16.0.2',
        v6: '2606:4700:110:8921:bf06:c4d7:40b7:8afd',
      },
    },
  },
});

function baseConfig(overrides: Partial<WarpConfig> = {}): WarpConfig {
  return {
    enabled: true,
    accounts: 1,
    devicePrefix: 'warp',
    mtu: 1280,
    routeTable: 51820,
    keepalive: 25,
    rulePriority: 1520,
    endpoint: 'engage.cloudflareclient.com:2408',
    apiUrl: 'https://api.cloudflareclient.com/v0a2158/reg',
    clientVersion: 'a-6.10-2158',
    userAgent: 'okhttp/3.12.1',
    license: null,
    registerSubnets: true,
    teardownOnExit: true,
    reset: false,
    verify: true,
    verifyHost: '2606:4700:4700::1111',
    verifyPort: 53,
    requestTimeoutMs: 15_000,
    registerDelayMs: 0,
    ...overrides,
  };
}

// --- WireGuard keys -----------------------------------------------------------

test('generates a WireGuard keypair in the base64 form configs use', () => {
  const { privateKey, publicKey } = generateWarpKeyPair();
  assert.equal(Buffer.from(privateKey, 'base64').length, 32);
  assert.equal(Buffer.from(publicKey, 'base64').length, 32);
  assert.notEqual(privateKey, publicKey);
});

test('re-derives the public key from a stored private key', () => {
  const { privateKey, publicKey } = generateWarpKeyPair();
  assert.equal(publicKeyFromPrivate(privateKey), publicKey);
});

test('rejects a private key that is not 32 bytes', () => {
  assert.throws(() => publicKeyFromPrivate(Buffer.alloc(16).toString('base64')), /32 bytes/);
});

test('derives the reserved triple from the client id', () => {
  // "kJq2" base64-decodes to three bytes.
  assert.deepEqual(reservedFromClientId('kJq2'), [144, 154, 182]);
  assert.deepEqual(reservedFromClientId(null), []);
});

test('the registration body carries the public key and a self-consistent install id', () => {
  const body = buildRegistrationBody('PUBKEY=', '2026-07-26T12:00:00.000Z');
  assert.equal(body.key, 'PUBKEY=');
  assert.equal(body.tos, '2026-07-26T12:00:00.000Z');
  assert.equal(body.install_id.length, 22);
  assert.equal(body.serial_number, body.install_id);
  assert.ok(body.fcm_token.startsWith(`${body.install_id}:APA91b`));
});

// --- registration response ------------------------------------------------------

test('parses a WARP registration into a usable peer', () => {
  const keys = { privateKey: 'PRIV=', publicKey: 'PUB=' };
  const account = parseRegistration(REG_RESPONSE, keys, 3);

  assert.equal(account.slot, 3);
  assert.equal(account.deviceId, 'e5b7c2a0-0000-4d1a-9f3b-2c9d4e5f6a7b');
  assert.equal(account.accountType, 'free');
  assert.equal(account.privateKey, 'PRIV=');
  assert.equal(account.peerPublicKey, 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=');
  assert.equal(account.endpointHost, 'engage.cloudflareclient.com:2408');
  assert.equal(account.addressV6, '2606:4700:110:8921:bf06:c4d7:40b7:8afd');
  assert.equal(account.addressV4, '172.16.0.2');
  assert.deepEqual(account.reserved, [144, 154, 182]);
});

test('reports registration responses that carry no WireGuard config', () => {
  const keys = { privateKey: 'PRIV=', publicKey: 'PUB=' };
  assert.throws(() => parseRegistration('<html>blocked</html>', keys, 0), /not JSON/);
  assert.throws(() => parseRegistration('{"id":"x"}', keys, 0), /no WireGuard config/);
  assert.throws(
    () => parseRegistration('{"success":false,"errors":[{"code":1002}]}', keys, 0),
    /rejected/
  );
});

test('a config without an IPv6 address is useless and says so', () => {
  const stripped = REG_RESPONSE.replace('2606:4700:110:8921:bf06:c4d7:40b7:8afd', '');
  assert.throws(
    () => parseRegistration(stripped, { privateKey: 'P', publicKey: 'K' }, 0),
    /missing an IPv6 address/
  );
});

// --- endpoints -------------------------------------------------------------------

test('parses the endpoint forms Cloudflare reports', () => {
  assert.deepEqual(parseEndpoint('engage.cloudflareclient.com:2408', 2408), {
    host: 'engage.cloudflareclient.com',
    port: 2408,
  });
  assert.deepEqual(parseEndpoint('162.159.192.1:500', 2408), { host: '162.159.192.1', port: 500 });
  assert.deepEqual(parseEndpoint('[2606:4700:d0::a29f:c001]:2408', 2408), {
    host: '2606:4700:d0::a29f:c001',
    port: 2408,
  });
  // A bare name or bare IPv6 literal falls back to the default port.
  assert.deepEqual(parseEndpoint('engage.cloudflareclient.com', 2408), {
    host: 'engage.cloudflareclient.com',
    port: 2408,
  });
  assert.deepEqual(parseEndpoint('2606:4700:d0::a29f:c001', 2408), {
    host: '2606:4700:d0::a29f:c001',
    port: 2408,
  });
  assert.throws(() => parseEndpoint('host:99999', 2408), /invalid port/);
});

test('refuses a device name the kernel would truncate', () => {
  assert.equal(warpDeviceName('warp', 7), 'warp7');
  assert.throws(() => warpDeviceName('a-very-long-prefix', 1), /15-character/);
});

// --- links ------------------------------------------------------------------------

const ACCOUNT = parseRegistration(REG_RESPONSE, { privateKey: 'PRIV=', publicKey: 'PUB=' }, 2);

test('a link takes its device, table and pool from its slot', () => {
  const link = buildLink(baseConfig(), ACCOUNT, '162.159.192.1:2408');

  assert.equal(link.device, 'warp2');
  assert.equal(link.table, 51822);
  assert.equal(link.priority, 1522);
  // The assigned address is the whole allocation pool: one address, one /128.
  assert.equal(link.cidr, '2606:4700:110:8921:bf06:c4d7:40b7:8afd/128');
  assert.equal(link.address, '2606:4700:0110:8921:bf06:c4d7:40b7:8afd');
  assert.equal(link.endpoint, '162.159.192.1:2408');
  assert.equal(link.mtu, 1280);
});

test('builds the ip/wg sequence that brings a link up', () => {
  const link = buildLink(baseConfig(), ACCOUNT, '162.159.192.1:2408');
  const plan = planWarpSetup(link);
  const setup = plan.setup.map((c) => `${c.bin} ${c.args.join(' ')}`);

  assert.deepEqual(setup, [
    'ip link add dev warp2 type wireguard',
    `wg set warp2 private-key ${PRIVATE_KEY_FILE} peer bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo= ` +
      'endpoint 162.159.192.1:2408 allowed-ips ::/0 persistent-keepalive 25',
    'ip link set dev warp2 mtu 1280 up',
    'ip -6 addr replace 2606:4700:110:8921:bf06:c4d7:40b7:8afd/128 dev warp2',
    'ip -6 route replace default dev warp2 table 51822',
    'ip -6 rule add from 2606:4700:110:8921:bf06:c4d7:40b7:8afd/128 lookup 51822 pref 1522',
  ]);
});

test('the rule is consulted before the main table', () => {
  // Rules run in ascending priority and the main table sits at 32766. A WARP
  // rule after it is never reached on a host that has an IPv6 default route of
  // its own: that traffic leaves through the native interface carrying a
  // Cloudflare source address, and gets dropped.
  const cfg = baseConfig({ accounts: 64 });
  for (let slot = 0; slot < cfg.accounts; slot++) {
    const link = buildLink(cfg, { ...ACCOUNT, slot }, '162.159.192.1:2408');
    assert.ok(
      link.priority < 32766,
      `slot ${slot} rule priority ${link.priority} would lose to the main table`
    );
  }
});

test('the private key never appears on a command line', () => {
  const link = buildLink(baseConfig(), { ...ACCOUNT, privateKey: 'SUPERSECRETKEY=' }, '162.159.192.1:2408');
  const rendered = planWarpSetup(link, '/tmp/warp-key/private')
    .setup.map((c) => `${c.bin} ${c.args.join(' ')}`)
    .join('\n');

  assert.ok(!rendered.includes('SUPERSECRETKEY='));
  assert.ok(rendered.includes('private-key /tmp/warp-key/private'));
});

test('nothing in the plan touches the main routing table', () => {
  const link = buildLink(baseConfig(), ACCOUNT, '162.159.192.1:2408');
  for (const cmd of planWarpSetup(link).setup) {
    if (!cmd.args.includes('route')) continue;
    assert.ok(
      cmd.args.includes('table'),
      `route command must name its own table: ip ${cmd.args.join(' ')}`
    );
  }
});

test('teardown removes the rule, the table and the device', () => {
  const link = buildLink(baseConfig(), ACCOUNT, '162.159.192.1:2408');
  const teardown = planWarpTeardown(link).map((c) => `${c.bin} ${c.args.join(' ')}`);

  assert.deepEqual(teardown, [
    'ip -6 rule del from 2606:4700:110:8921:bf06:c4d7:40b7:8afd/128 lookup 51822 pref 1522',
    'ip -6 route flush table 51822',
    'ip link del warp2',
  ]);
  // Teardown runs against a host that may have none of this configured.
  assert.ok(planWarpTeardown(link).every((c) => c.optional));
});

test('bring-up tears its own device down first, so restarts are idempotent', () => {
  const link = buildLink(baseConfig(), ACCOUNT, '162.159.192.1:2408');
  const plan = planWarpSetup(link);
  assert.deepEqual(
    plan.teardown.map((c) => c.args.join(' ')),
    planWarpTeardown(link).map((c) => c.args.join(' '))
  );
});

test('each slot gets its own device and its own route table', () => {
  const cfg = baseConfig({ accounts: 3 });
  const links = [0, 1, 2].map((slot) => buildLink(cfg, { ...ACCOUNT, slot }, '162.159.192.1:2408'));

  assert.deepEqual(links.map((l) => l.device), ['warp0', 'warp1', 'warp2']);
  assert.deepEqual(links.map((l) => l.table), [51820, 51821, 51822]);
  assert.deepEqual(links.map((l) => l.priority), [1520, 1521, 1522]);
});

// --- orphaned links ----------------------------------------------------------------

test('finds our own devices in ip link output and leaves others alone', () => {
  const output = [
    '1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT',
    '2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP mode DEFAULT',
    '3: he-ipv6@NONE: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1480 qdisc noqueue state UNKNOWN',
    '4: warp0: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1280 qdisc noqueue state UNKNOWN',
    '5: warp11: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1280 qdisc noqueue state UNKNOWN',
    '6: warpother: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1280 qdisc noqueue state UNKNOWN',
    '7: wg0: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1420 qdisc noqueue state UNKNOWN',
  ].join('\n');

  // `warpother` has no slot number and `wg0` is somebody else's tunnel.
  assert.deepEqual(parseWarpDevices(output, 'warp'), [
    { device: 'warp0', slot: 0 },
    { device: 'warp11', slot: 11 },
  ]);
});

test('a device prefix with regex characters is matched literally', () => {
  const output = '4: w.p0: <POINTOPOINT> mtu 1280\n5: wxp0: <POINTOPOINT> mtu 1280';
  assert.deepEqual(parseWarpDevices(output, 'w.p'), [{ device: 'w.p0', slot: 0 }]);
});

// --- allocation out of a single-address subnet -------------------------------------

test('a /128 subnet yields its one address instead of recursing forever', () => {
  const parsed = parseCIDR('2606:4700:110:8921:bf06:c4d7:40b7:8afd/128');
  const addr = generateIPv6(parsed.prefix, parsed.prefixLength);
  assert.equal(addr, '2606:4700:0110:8921:bf06:c4d7:40b7:8afd');
  // Deterministic: the same address every time, which is what makes a WARP
  // link's egress IP stable for the sessions that use it.
  assert.equal(generateIPv6(parsed.prefix, parsed.prefixLength), addr);
});
