import test from 'node:test';
import assert from 'node:assert/strict';

process.env.API_KEY = 'test-key';

import { hasRouteForPrefix } from '../src/utils/ipv6';

// hasRouteForPrefix asks the kernel whether traffic sourced from a prefix can
// leave the host. On a machine with a default IPv6 route almost nothing is
// unroutable, so these assert only on answers that do not depend on the host's
// connectivity: a degenerate prefix parse must not silently look routable, and
// a prefix that parses must return a boolean rather than throw.

test('a well-formed prefix returns a boolean without throwing', () => {
  for (const cidr of ['2001:db8::/64', '2001:db8::/128', '::1/128']) {
    const result = hasRouteForPrefix(cidr);
    assert.equal(typeof result, 'boolean', `${cidr} should resolve to a boolean`);
  }
});

test('loopback is always routed', () => {
  assert.equal(hasRouteForPrefix('::1/128'), true);
});

test('the all-zero prefix is rejected by the CIDR parser instead of looking routable', () => {
  // parseCIDR refuses /0, so this must not be reported as routable. Silently
  // returning true here would keep an unusable pool entry alive.
  assert.equal(hasRouteForPrefix('::/0'), false);
});
