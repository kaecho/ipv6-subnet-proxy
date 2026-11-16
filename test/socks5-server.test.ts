import test from 'node:test';
import assert from 'node:assert/strict';

process.env.API_KEY = 'test-key';

import { mapErrorToReplyCode, connectTimeoutError } from '../src/socks5/server';

// SOCKS5 reply codes (RFC 1928 §6).
const REP_HOST_UNREACHABLE = 0x04;
const REP_CONNECTION_REFUSED = 0x05;
const REP_TTL_EXPIRED = 0x06;
const REP_CONNECTION_NOT_ALLOWED = 0x02;
const REP_GENERAL_FAILURE = 0x01;

test('the connect timeout error carries an errno code', () => {
  // A bare `new Error()` has no `code`, which made every timeout report as
  // REP_GENERAL_FAILURE ("general SOCKS server failure"). The code is what
  // makes the reply accurate and the client-facing error meaningful.
  const err = connectTimeoutError();
  assert.equal(err.code, 'ETIMEDOUT');
  assert.match(err.message, /timed out/i);
});

test('a connect timeout maps to REP_TTL_EXPIRED, not a general failure', () => {
  assert.equal(mapErrorToReplyCode(connectTimeoutError()), REP_TTL_EXPIRED);
});

test('errno codes map to their RFC 1928 reply codes', () => {
  const withCode = (code: string): NodeJS.ErrnoException =>
    Object.assign(new Error(code), { code });

  assert.equal(mapErrorToReplyCode(withCode('ENETUNREACH')), REP_HOST_UNREACHABLE);
  assert.equal(mapErrorToReplyCode(withCode('EHOSTUNREACH')), REP_HOST_UNREACHABLE);
  assert.equal(mapErrorToReplyCode(withCode('ECONNREFUSED')), REP_CONNECTION_REFUSED);
  assert.equal(mapErrorToReplyCode(withCode('ETIMEDOUT')), REP_TTL_EXPIRED);
  assert.equal(mapErrorToReplyCode(withCode('EACCES')), REP_CONNECTION_NOT_ALLOWED);
  assert.equal(mapErrorToReplyCode(withCode('EPERM')), REP_CONNECTION_NOT_ALLOWED);
});

test('an error without a code still falls back to a general failure', () => {
  assert.equal(mapErrorToReplyCode(new Error('unknown')), REP_GENERAL_FAILURE);
});
