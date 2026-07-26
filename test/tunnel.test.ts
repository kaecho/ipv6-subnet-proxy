import test from 'node:test';
import assert from 'node:assert/strict';

process.env.API_KEY = 'test-key';

import { TunnelConfig } from '../src/config';
import { parseTunnelInfoXml, parseUpdateResponse, isIPv4 } from '../src/core/tunnelbroker';
import {
  parseClientIpv6,
  chooseLocalIPv4,
  resolveTunnelSpec,
  planTunnelSetup,
  planTunnelTeardown,
} from '../src/core/tunnel';
import { isAddressInCIDR, detectIPv6Subnets } from '../src/utils/ipv6';

// A tunnelbroker.net tunnel as it appears in the web UI, in the XML shape the
// API returns it. Field spellings are matched leniently, so the parser tests
// cover the variants too.
const HE_XML = `<?xml version="1.0" encoding="ISO-8859-1"?>
<tunnels>
  <tunnel id="1033580">
    <description>proxy egress</description>
    <serverv4>216.218.221.42</serverv4>
    <serverv6>2001:470:35:380::1</serverv6>
    <clientv4>146.56.100.15</clientv4>
    <clientv6>2001:470:35:380::2/64</clientv6>
    <routed64>2001:470:36:37f::/64</routed64>
    <routed48>2001:470:ecf2::/48</routed48>
    <mtu>1480</mtu>
  </tunnel>
</tunnels>`;

function baseConfig(overrides: Partial<TunnelConfig> = {}): TunnelConfig {
  return {
    enabled: true,
    device: 'he-ipv6',
    tunnelId: null,
    username: null,
    password: null,
    updateKey: null,
    serverIpv4: null,
    serverIpv6: null,
    clientIpv6: null,
    localIpv4: null,
    routedPrefixes: [],
    mtu: 1480,
    ttl: 255,
    routeTable: 1470,
    defaultRoute: 'auto',
    forwarding: false,
    registerSubnets: true,
    teardownOnExit: true,
    verify: true,
    verifyHost: '2001:470:20::2',
    verifyPort: 53,
    updateEndpoint: false,
    updateIntervalMs: 900_000,
    apiUrl: 'https://tunnelbroker.net/tunnelInfo.php',
    updateUrl: 'https://ipv4.tunnelbroker.net/nic/update',
    publicIpv4Url: 'https://checkip.amazonaws.com',
    requestTimeoutMs: 10_000,
    ...overrides,
  };
}

// --- tunnelInfo parsing ------------------------------------------------------

test('parses a tunnelbroker tunnel description', () => {
  const info = parseTunnelInfoXml(HE_XML, '1033580');
  assert.equal(info.id, '1033580');
  assert.equal(info.serverIpv4, '216.218.221.42');
  assert.equal(info.serverIpv6, '2001:470:35:380::1');
  assert.equal(info.clientIpv4, '146.56.100.15');
  assert.equal(info.clientIpv6, '2001:470:35:380::2/64');
  assert.equal(info.routed64, '2001:470:36:37f::/64');
  assert.equal(info.routed48, '2001:470:ecf2::/48');
  assert.equal(info.mtu, 1480);
});

test('adds the implied prefix length to bare routed addresses', () => {
  const xml = HE_XML.replace('2001:470:ecf2::/48', '2001:470:ecf2::').replace(
    '2001:470:36:37f::/64',
    '2001:470:36:37f::'
  );
  const info = parseTunnelInfoXml(xml);
  assert.equal(info.routed48, '2001:470:ecf2::/48');
  assert.equal(info.routed64, '2001:470:36:37f::/64');
});

test('accepts underscore field spellings', () => {
  const xml = `<tunnels><tunnel id="7">
    <server_v4>216.218.221.42</server_v4>
    <client_v6>2001:470:35:380::2</client_v6>
    <routed_48>2001:470:ecf2::/48</routed_48>
  </tunnel></tunnels>`;
  const info = parseTunnelInfoXml(xml);
  assert.equal(info.serverIpv4, '216.218.221.42');
  assert.equal(info.clientIpv6, '2001:470:35:380::2/64');
  assert.equal(info.routed48, '2001:470:ecf2::/48');
});

test('picks the requested tunnel out of an account with several', () => {
  const xml = `<tunnels>
    <tunnel id="111"><serverv4>1.1.1.1</serverv4><clientv6>2001:470:1::2/64</clientv6></tunnel>
    <tunnel id="222"><serverv4>2.2.2.2</serverv4><clientv6>2001:470:2::2/64</clientv6></tunnel>
  </tunnels>`;
  assert.equal(parseTunnelInfoXml(xml, '222').serverIpv4, '2.2.2.2');
  assert.throws(() => parseTunnelInfoXml(xml), /set HE_TUNNEL_ID/);
  assert.throws(() => parseTunnelInfoXml(xml, '333'), /not in this account/);
});

test('reports unusable tunnelInfo responses', () => {
  assert.throws(() => parseTunnelInfoXml('<html>login required</html>'), /no tunnel data/);
});

// --- endpoint update ---------------------------------------------------------

test('reads dyndns update responses', () => {
  const good = parseUpdateResponse('good 146.56.100.15');
  assert.equal(good.ok, true);
  assert.equal(good.ip, '146.56.100.15');

  const nochg = parseUpdateResponse('nochg 146.56.100.15');
  assert.equal(nochg.ok, true);
  assert.equal(nochg.code, 'nochg');

  const badauth = parseUpdateResponse('badauth');
  assert.equal(badauth.ok, false);
  assert.match(badauth.message, /Update Key/);

  assert.equal(parseUpdateResponse('abuse').ok, false);
  assert.equal(parseUpdateResponse('').code, 'empty');
  assert.equal(parseUpdateResponse('-ERROR: something broke').ok, false);
});

test('validates IPv4 literals', () => {
  assert.equal(isIPv4('146.56.100.15'), true);
  assert.equal(isIPv4('256.1.1.1'), false);
  assert.equal(isIPv4('2001:470::1'), false);
  assert.equal(isIPv4(''), false);
});

// --- spec resolution ---------------------------------------------------------

test('splits the client address from its prefix length', () => {
  assert.deepEqual(parseClientIpv6('2001:470:35:380::2/64'), {
    address: '2001:470:35:380::2',
    prefixLength: 64,
  });
  assert.deepEqual(parseClientIpv6(' 2001:470:35:380::2 '), {
    address: '2001:470:35:380::2',
    prefixLength: 64,
  });
  assert.throws(() => parseClientIpv6('146.56.100.15'), /Invalid IPv6/);
  assert.throws(() => parseClientIpv6('2001:470::2/999'), /must be 1-128/);
});

test('anchors the tunnel to a local address, flagging NAT', () => {
  // The broker's client IPv4 is on this host: no NAT.
  assert.deepEqual(
    chooseLocalIPv4({ publicIpv4: '146.56.100.15', locals: ['146.56.100.15', '10.0.0.5'] }),
    { address: '146.56.100.15', natted: false }
  );

  // Public address is elsewhere — anchor locally and say so.
  assert.deepEqual(chooseLocalIPv4({ publicIpv4: '203.0.113.9', locals: ['192.168.1.20'] }), {
    address: '192.168.1.20',
    natted: true,
  });

  // An explicit setting is trusted even when it is not a local address.
  assert.deepEqual(chooseLocalIPv4({ configured: '203.0.113.9', locals: ['192.168.1.20'] }), {
    address: '203.0.113.9',
    natted: true,
  });

  assert.throws(() => chooseLocalIPv4({ configured: 'nonsense', locals: [] }), /must be an IPv4/);
  assert.throws(() => chooseLocalIPv4({ locals: [] }), /HE_TUNNEL_LOCAL_IPV4/);
});

test('builds a spec from the API description alone', () => {
  const info = parseTunnelInfoXml(HE_XML, '1033580');
  const spec = resolveTunnelSpec(baseConfig(), info, '146.56.100.15');

  assert.equal(spec.serverIpv4, '216.218.221.42');
  assert.equal(spec.clientIpv6, '2001:470:35:380::2');
  assert.equal(spec.clientPrefixLength, 64);
  assert.equal(spec.linkPrefix, '2001:470:35:380::/64');
  // Broadest first, and the link prefix is not an allocation pool.
  assert.deepEqual(spec.routedPrefixes, ['2001:470:ecf2::/48', '2001:470:36:37f::/64']);
});

test('environment settings override the API description', () => {
  const info = parseTunnelInfoXml(HE_XML, '1033580');
  const spec = resolveTunnelSpec(
    baseConfig({
      serverIpv4: '10.0.0.1',
      clientIpv6: '2001:db8:1::2/64',
      routedPrefixes: ['2001:db8:ffff::/48'],
    }),
    info,
    '192.168.1.20'
  );

  assert.equal(spec.serverIpv4, '10.0.0.1');
  assert.equal(spec.clientIpv6, '2001:db8:1::2');
  assert.deepEqual(spec.routedPrefixes, ['2001:db8:ffff::/48']);
});

test('drops a routed prefix that is only the tunnel link', () => {
  const cfg = baseConfig({
    serverIpv4: '216.218.221.42',
    clientIpv6: '2001:470:35:380::2/64',
    routedPrefixes: ['2001:470:35:380::/64'],
  });
  assert.throws(() => resolveTunnelSpec(cfg, null, '146.56.100.15'), /link prefix/);
});

test('collapses a routed prefix nested inside another', () => {
  const spec = resolveTunnelSpec(
    baseConfig({
      serverIpv4: '216.218.221.42',
      clientIpv6: '2001:470:35:380::2/64',
      routedPrefixes: ['2001:470:ecf2::/48', '2001:470:ecf2:7::/64'],
    }),
    null,
    '146.56.100.15'
  );
  assert.deepEqual(spec.routedPrefixes, ['2001:470:ecf2::/48']);
});

test('says what is missing when the tunnel is underspecified', () => {
  assert.throws(() => resolveTunnelSpec(baseConfig(), null, '1.2.3.4'), /HE_TUNNEL_SERVER_IPV4/);
  assert.throws(
    () => resolveTunnelSpec(baseConfig({ serverIpv4: '1.2.3.4' }), null, '1.2.3.4'),
    /HE_TUNNEL_CLIENT_IPV6/
  );
  assert.throws(
    () => resolveTunnelSpec(baseConfig({ serverIpv4: '1.2.3.4', clientIpv6: '2001:db8::2/64' }), null, '1.2.3.4'),
    /HE_TUNNEL_ROUTED_PREFIXES/
  );
});

// --- command planning --------------------------------------------------------

function specFixture() {
  return resolveTunnelSpec(baseConfig(), parseTunnelInfoXml(HE_XML, '1033580'), '146.56.100.15');
}

test('plans the ip commands that bring a 6in4 tunnel up', () => {
  const plan = planTunnelSetup(specFixture(), { routeTable: 1470, installDefaultRoute: true });
  const setup = plan.setup.map((c) => `ip ${c.args.join(' ')}`);

  assert.deepEqual(setup, [
    'ip tunnel add he-ipv6 mode sit remote 216.218.221.42 local 146.56.100.15 ttl 255',
    'ip link set dev he-ipv6 mtu 1480 up',
    'ip -6 addr replace 2001:470:35:380::2/64 dev he-ipv6',
    'ip -6 route replace default dev he-ipv6 table 1470',
    'ip -6 rule add from 2001:470:35:380::2/128 lookup 1470 pref 1470',
    'ip -6 rule add from 2001:470:ecf2::/48 lookup 1470 pref 1470',
    'ip -6 route replace local 2001:470:ecf2::/48 dev lo',
    'ip -6 rule add from 2001:470:36:37f::/64 lookup 1470 pref 1470',
    'ip -6 route replace local 2001:470:36:37f::/64 dev lo',
    'ip -6 route replace default dev he-ipv6 metric 1024',
  ]);

  // Only the device and its address are load-bearing; policy routing degrades.
  assert.deepEqual(
    plan.setup.filter((c) => !c.optional).map((c) => c.args[0]),
    ['tunnel', 'link', '-6']
  );
});

test('leaves the host default route alone when asked not to install one', () => {
  const plan = planTunnelSetup(specFixture(), { routeTable: 1470, installDefaultRoute: false });
  const mainTableDefaults = plan.setup.filter(
    (c) => c.args.includes('default') && !c.args.includes('table')
  );
  assert.deepEqual(mainTableDefaults, []);
});

test('teardown removes everything setup adds', () => {
  const spec = specFixture();
  const teardown = planTunnelTeardown(spec, 1470).map((c) => `ip ${c.args.join(' ')}`);

  assert.deepEqual(teardown, [
    'ip -6 rule del from 2001:470:ecf2::/48 lookup 1470 pref 1470',
    'ip -6 route del local 2001:470:ecf2::/48 dev lo',
    'ip -6 rule del from 2001:470:36:37f::/64 lookup 1470 pref 1470',
    'ip -6 route del local 2001:470:36:37f::/64 dev lo',
    'ip -6 rule del from 2001:470:35:380::2/128 lookup 1470 pref 1470',
    'ip -6 route flush table 1470',
    'ip link del he-ipv6',
  ]);
  // Nothing in teardown may abort a restart.
  assert.equal(
    planTunnelTeardown(spec, 1470).every((c) => c.optional),
    true
  );
});

// --- address/prefix matching -------------------------------------------------

test('matches allocated addresses to the prefix they belong to', () => {
  assert.equal(isAddressInCIDR('2001:470:ecf2:1234:5678:9abc:def0:1', '2001:470:ecf2::/48'), true);
  assert.equal(isAddressInCIDR('2001:470:ecf3::1', '2001:470:ecf2::/48'), false);
  assert.equal(isAddressInCIDR('2001:470:35:380::2', '2001:470:35:380::/64'), true);
  assert.equal(isAddressInCIDR('not-an-address', '2001:470:ecf2::/48'), false);
});

test('interface scan skips the tunnel link prefix when told to', () => {
  // Whatever this host has, an excluded prefix is never returned.
  const all = detectIPv6Subnets();
  if (all.length === 0) return;
  const filtered = detectIPv6Subnets([all[0]]);
  assert.equal(filtered.includes(all[0]), false);
});
