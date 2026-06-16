import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isBlockedIp, isValidPublicHost } from '../ssrf.js';

test('isBlockedIp blocks loopback / private / link-local / metadata / unspecified', () => {
  for (const ip of [
    '127.0.0.1', '127.0.0.53', '::1',
    '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '169.254.0.1',
    '0.0.0.0', 'fc00::1', 'fe80::1',
  ]) {
    assert.equal(isBlockedIp(ip), true, `${ip} must be blocked`);
  }
});

test('isBlockedIp allows public addresses', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '103.30.195.75', '2606:4700:4700::1111']) {
    assert.equal(isBlockedIp(ip), false, `${ip} must be allowed`);
  }
});

test('isValidPublicHost rejects non-domains, IP literals, ports, userinfo', () => {
  assert.equal(isValidPublicHost('web-test.verivyx.com'), true);
  assert.equal(isValidPublicHost('localhost'), false);
  assert.equal(isValidPublicHost('127.0.0.1'), false); // IP literal
  assert.equal(isValidPublicHost('169.254.169.254'), false);
  assert.equal(isValidPublicHost('example.com:8080'), false); // port
  assert.equal(isValidPublicHost('user@example.com'), false); // userinfo
  assert.equal(isValidPublicHost(''), false);
  assert.equal(isValidPublicHost('no-dot'), false);
});
