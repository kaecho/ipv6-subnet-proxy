import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import dns from 'node:dns';
import tls from 'node:tls';

process.env.API_KEY = 'test-key';

import { parseEdgeOverrides } from '../src/config';
import { matchProvider } from '../src/core/cdn-providers';
import {
  resolveTargetRoute,
  resetTargetResolver,
  invalidateRoute,
  isValidHostname,
  isUsableIPv6,
  synthesizeNat64,
} from '../src/core/target-resolver';

// --- fake DNS zone -----------------------------------------------------------

interface Zone {
  aaaa?: Record<string, string[]>;
  a?: Record<string, string[]>;
  cname?: Record<string, string[]>;
  ptr?: Record<string, string[]>;
}

let zone: Zone = {};
let dnsQueries: string[] = [];

function answer(table: Record<string, string[]> | undefined, name: string): string[] {
  const hit = table?.[name.toLowerCase()];
  if (!hit || hit.length === 0) {
    const err: NodeJS.ErrnoException = new Error(`queryA ENODATA ${name}`);
    err.code = 'ENODATA';
    throw err;
  }
  return hit;
}

const proto = dns.promises.Resolver.prototype as any;
proto.resolve6 = async (name: string) => {
  dnsQueries.push(`AAAA ${name}`);
  return answer(zone.aaaa, name);
};
proto.resolve4 = async (name: string) => {
  dnsQueries.push(`A ${name}`);
  return answer(zone.a, name);
};
proto.resolveCname = async (name: string) => {
  dnsQueries.push(`CNAME ${name}`);
  return answer(zone.cname, name);
};
proto.reverse = async (addr: string) => {
  dnsQueries.push(`PTR ${addr}`);
  return answer(zone.ptr, addr);
};
proto.setServers = () => {};

// --- fake TLS probe ----------------------------------------------------------

/** (sni, address) => whether the edge serves that name. */
let probeAccepts: (sni: string, address: string) => boolean = () => false;
let probeCalls: { sni: string; address: string; port: number }[] = [];

(tls as any).connect = (opts: any) => {
  const socket: any = new EventEmitter();
  socket.authorized = false;
  socket.setTimeout = () => socket;
  socket.destroy = () => socket;
  setImmediate(() => {
    probeCalls.push({ sni: opts.servername, address: opts.host, port: opts.port });
    if (probeAccepts(opts.servername, opts.host)) {
      socket.authorized = true;
      socket.emit('secureConnect');
    } else {
      socket.emit('error', new Error('handshake failed'));
    }
  });
  return socket;
};

function setup(next: Zone, accepts: (sni: string, address: string) => boolean = () => false): void {
  zone = next;
  probeAccepts = accepts;
  dnsQueries = [];
  probeCalls = [];
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('CDN_FALLBACK_') || key === 'NAT64_PREFIX') delete process.env[key];
  }
  resetTargetResolver();
}

// --- pure helpers ------------------------------------------------------------

test('isValidHostname rejects header/query injection and malformed names', () => {
  assert.ok(isValidHostname('build.nvidia.com'));
  assert.ok(isValidHostname('_dmarc.example.com'));
  assert.ok(isValidHostname('a-b.example.co.uk'));

  assert.ok(!isValidHostname('example.com\r\nX-Injected: 1'));
  assert.ok(!isValidHostname('example..com'));
  assert.ok(!isValidHostname(''));
  assert.ok(!isValidHostname('exa mple.com'));
  assert.ok(!isValidHostname(`${'a'.repeat(64)}.com`));
  assert.ok(!isValidHostname(`${'a'.repeat(250)}.example.com`));
});

test('isUsableIPv6 keeps only globally routable unicast', () => {
  assert.ok(isUsableIPv6('2606:4700::6810:85e5'));
  assert.ok(!isUsableIPv6('::1'));
  assert.ok(!isUsableIPv6('::'));
  assert.ok(!isUsableIPv6('fe80::1'));
  assert.ok(!isUsableIPv6('fd00::1'));
  assert.ok(!isUsableIPv6('ff02::1'));
  assert.ok(!isUsableIPv6('::ffff:192.0.2.1'));
  assert.ok(!isUsableIPv6('192.0.2.1'));
});

test('synthesizeNat64 embeds IPv4 per RFC 6052', () => {
  assert.equal(synthesizeNat64('64:ff9b::', '192.0.2.33'), '64:ff9b::c000:221');
  assert.equal(synthesizeNat64('64:ff9b::', '1.2.3.4'), '64:ff9b::102:304');
  assert.throws(() => synthesizeNat64('64:ff9b::', '999.1.1.1'));
});

test('parseEdgeOverrides handles per-provider and bare forms', () => {
  assert.deepEqual(parseEdgeOverrides('cloudfront=2600::1,2600::2;fastly=2a04::9'), {
    cloudfront: ['2600::1', '2600::2'],
    fastly: ['2a04::9'],
  });
  assert.deepEqual(parseEdgeOverrides('2600::1,2600::2'), { default: ['2600::1', '2600::2'] });
  assert.deepEqual(parseEdgeOverrides(''), {});
});

test('matchProvider identifies CDNs from CNAME and PTR names', () => {
  assert.equal(matchProvider('d111111abcdef8.cloudfront.net')?.name, 'cloudfront');
  assert.equal(matchProvider('server-13-33-1-2.lhr50.r.cloudfront.net')?.name, 'cloudfront');
  assert.equal(matchProvider('prod.example.map.fastly.net')?.name, 'fastly');
  assert.equal(matchProvider('e1234.dscx.akamaiedge.net')?.name, 'akamai');
  assert.equal(matchProvider('a23-1-2-3.deploy.static.akamaitechnologies.com')?.name, 'akamai');
  assert.equal(matchProvider('example.com.cdn.cloudflare.net')?.name, 'cloudflare');
  assert.equal(matchProvider('www.example.com'), null);
});

// --- resolution ladder -------------------------------------------------------

test('native AAAA is used directly, without probing', async () => {
  setup({ aaaa: { 'example.com': ['2606:4700::1'] } });

  const route = await resolveTargetRoute('example.com', 443);
  assert.equal(route.kind, 'native');
  assert.deepEqual(route.addresses, ['2606:4700::1']);
  assert.equal(probeCalls.length, 0);
});

test('IPv6 literal targets pass through untouched', async () => {
  setup({});
  const route = await resolveTargetRoute('2606:4700::1', 443);
  assert.equal(route.kind, 'literal');
  assert.deepEqual(route.addresses, ['2606:4700::1']);
  assert.equal(dnsQueries.length, 0);
});

test('a name with no AAAA borrows the dual-stack view of its own CDN mapping', async () => {
  setup(
    {
      a: { 'cdn.example.com': ['151.101.1.1'] },
      cname: { 'cdn.example.com': ['prod.example.map.fastly.net'] },
      aaaa: { 'dualstack.prod.example.map.fastly.net': ['2a04:4e42::485'] },
    },
    (sni, address) => sni === 'cdn.example.com' && address === '2a04:4e42::485'
  );

  const route = await resolveTargetRoute('cdn.example.com', 443);
  assert.equal(route.kind, 'dualstack');
  assert.equal(route.provider, 'fastly');
  assert.equal(route.via, 'dualstack.prod.example.map.fastly.net');
  assert.deepEqual(route.addresses, ['2a04:4e42::485']);
  assert.ok(route.verified);
  // SNI must be the original name, which is what makes the borrow work.
  assert.equal(probeCalls[0].sni, 'cdn.example.com');
});

test('a CloudFront name with IPv6 disabled borrows a foreign edge', async () => {
  setup(
    {
      a: { 'app.example.com': ['13.33.1.2'] },
      cname: { 'app.example.com': ['d111111abcdef8.cloudfront.net'] },
      // The target's own distribution publishes no AAAA; another one does.
      aaaa: { 'd2wy8f7a9ursnm.cloudfront.net': ['2600:9000:2015:1600::1'] },
    },
    (sni, address) => sni === 'app.example.com' && address === '2600:9000:2015:1600::1'
  );

  const route = await resolveTargetRoute('app.example.com', 443);
  assert.equal(route.kind, 'cdn-borrow');
  assert.equal(route.provider, 'cloudfront');
  assert.deepEqual(route.addresses, ['2600:9000:2015:1600::1']);
  assert.ok(route.verified);
});

test('the CDN is detected from the PTR record when there is no CNAME', async () => {
  setup(
    {
      a: { 'apex.example.com': ['13.33.1.2'] },
      ptr: { '13.33.1.2': ['server-13-33-1-2.lhr50.r.cloudfront.net'] },
      aaaa: { 'd2wy8f7a9ursnm.cloudfront.net': ['2600:9000:2015:1600::1'] },
    },
    () => true
  );

  const route = await resolveTargetRoute('apex.example.com', 443);
  assert.equal(route.kind, 'cdn-borrow');
  assert.equal(route.provider, 'cloudfront');
});

test('an edge that fails certificate verification is never used', async () => {
  setup(
    {
      a: { 'notcdn.example.com': ['13.33.1.2'] },
      cname: { 'notcdn.example.com': ['d111111abcdef8.cloudfront.net'] },
      aaaa: { 'd2wy8f7a9ursnm.cloudfront.net': ['2600:9000:2015:1600::1'] },
    },
    () => false // every handshake fails the name check
  );

  await assert.rejects(
    () => resolveTargetRoute('notcdn.example.com', 443),
    /no usable IPv6 path/
  );
  assert.ok(probeCalls.length > 0, 'the edge should have been probed');
});

test('borrowing is confined to the configured ports', async () => {
  setup(
    {
      a: { 'app.example.com': ['13.33.1.2'] },
      cname: { 'app.example.com': ['d111111abcdef8.cloudfront.net'] },
      aaaa: { 'd2wy8f7a9ursnm.cloudfront.net': ['2600:9000:2015:1600::1'] },
    },
    () => true
  );

  await assert.rejects(() => resolveTargetRoute('app.example.com', 8080), /port 8080/);
  assert.equal(probeCalls.length, 0);
});

test('operator-pinned edges take precedence over discovery', async () => {
  setup(
    {
      a: { 'app.example.com': ['13.33.1.2'] },
      cname: { 'app.example.com': ['d111111abcdef8.cloudfront.net'] },
      aaaa: { 'd2wy8f7a9ursnm.cloudfront.net': ['2600:9000:2015:1600::1'] },
    },
    () => true
  );
  process.env.CDN_FALLBACK_EDGES = 'cloudfront=2600:9000:dead::1';
  resetTargetResolver();

  const route = await resolveTargetRoute('app.example.com', 443);
  assert.equal(route.addresses[0], '2600:9000:dead::1');
});

test('NAT64 is the last resort and only when configured', async () => {
  setup({ a: { 'v4only.example.com': ['192.0.2.33'] } });

  await assert.rejects(() => resolveTargetRoute('v4only.example.com', 443));

  process.env.NAT64_PREFIX = '64:ff9b::/96';
  resetTargetResolver();

  const route = await resolveTargetRoute('v4only.example.com', 443);
  assert.equal(route.kind, 'nat64');
  assert.deepEqual(route.addresses, ['64:ff9b::c000:221']);
});

test('results are cached, and concurrent lookups share one resolution', async () => {
  setup({ aaaa: { 'example.com': ['2606:4700::1'] } });

  const [a, b] = await Promise.all([
    resolveTargetRoute('example.com', 443),
    resolveTargetRoute('example.com', 443),
  ]);
  assert.equal(a.addresses[0], b.addresses[0]);

  const afterFirst = dnsQueries.length;
  await resolveTargetRoute('example.com', 443);
  assert.equal(dnsQueries.length, afterFirst, 'a cached hit must not re-query DNS');
});

test('failures are cached too, so unreachable names fail fast', async () => {
  setup({ a: { 'dead.example.com': ['192.0.2.1'] } });

  await assert.rejects(() => resolveTargetRoute('dead.example.com', 443));
  const afterFirst = dnsQueries.length;
  await assert.rejects(() => resolveTargetRoute('dead.example.com', 443));
  assert.equal(dnsQueries.length, afterFirst);
});

test('a name that does not resolve at all fails without spending probes', async () => {
  setup({}, () => true);

  await assert.rejects(() => resolveTargetRoute('nope.example.com', 443), /does not resolve/);
  assert.equal(probeCalls.length, 0);
});

test('hostnames that could inject into DNS or the probe are rejected', async () => {
  setup({});
  await assert.rejects(
    () => resolveTargetRoute('example.com\r\nHost: evil.com', 443),
    /Invalid target hostname/
  );
  assert.equal(dnsQueries.length, 0);
});

test('verification can be turned off for latency-sensitive deployments', async () => {
  setup({
    a: { 'app.example.com': ['13.33.1.2'] },
    cname: { 'app.example.com': ['d111111abcdef8.cloudfront.net'] },
    aaaa: { 'd2wy8f7a9ursnm.cloudfront.net': ['2600:9000:2015:1600::1'] },
  });
  process.env.CDN_FALLBACK_VERIFY = 'false';
  resetTargetResolver();

  const route = await resolveTargetRoute('app.example.com', 443);
  assert.equal(route.kind, 'cdn-borrow');
  assert.equal(route.verified, false);
  assert.equal(probeCalls.length, 0);
});

test('a verified borrow carries no unverified backup addresses', async () => {
  setup(
    {
      a: { 'app.example.com': ['13.33.1.2'] },
      cname: { 'app.example.com': ['d111111abcdef8.cloudfront.net'] },
      aaaa: {
        'd2wy8f7a9ursnm.cloudfront.net': ['2600:9000:aaaa::1'],
        'docs.aws.amazon.com': ['2600:9000:bbbb::2'],
      },
    },
    // Only the second edge actually serves this name.
    (_sni, address) => address === '2600:9000:bbbb::2'
  );

  const route = await resolveTargetRoute('app.example.com', 443);
  // Falling back to the rejected edge would hand the client a cert mismatch.
  assert.deepEqual(route.addresses, ['2600:9000:bbbb::2']);
});

test('invalidateRoute forces the ladder to run again', async () => {
  setup({ aaaa: { 'example.com': ['2606:4700::1'] } });

  await resolveTargetRoute('example.com', 443);
  const afterFirst = dnsQueries.length;

  invalidateRoute('example.com', 443);
  await resolveTargetRoute('example.com', 443);
  assert.ok(dnsQueries.length > afterFirst, 'the cache entry should have been dropped');
});

test('the fallback ladder can be disabled entirely', async () => {
  setup({
    a: { 'app.example.com': ['13.33.1.2'] },
    cname: { 'app.example.com': ['d111111abcdef8.cloudfront.net'] },
    aaaa: { 'd2wy8f7a9ursnm.cloudfront.net': ['2600:9000:2015:1600::1'] },
  });
  process.env.CDN_FALLBACK_ENABLED = 'false';
  resetTargetResolver();

  await assert.rejects(() => resolveTargetRoute('app.example.com', 443), /no AAAA record/);
  assert.equal(probeCalls.length, 0);
});
