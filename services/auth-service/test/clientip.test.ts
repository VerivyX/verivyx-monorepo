import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientIp } from '../lib.js';

test('spoof defeated: last XFF entry wins (nginx-appended), not first (attacker-injected)', () => {
  assert.equal(clientIp('1.2.3.4, 5.6.7.8', 'fallback', 1), '5.6.7.8');
});

test('single XFF entry: that entry is returned', () => {
  assert.equal(clientIp('9.9.9.9', 'fallback', 1), '9.9.9.9');
});

test('no XFF header: falls back to remoteAddr', () => {
  assert.equal(clientIp(undefined, '10.0.0.1', 1), '10.0.0.1');
});

test('empty XFF string: falls back to remoteAddr', () => {
  assert.equal(clientIp('', '10.0.0.1', 1), '10.0.0.1');
});

test('fewer XFF entries than trustedHops: falls back to remoteAddr', () => {
  assert.equal(clientIp('1.2.3.4', 'peer', 2), 'peer');
});

test('array XFF header: joined, split, last entry returned', () => {
  assert.equal(clientIp(['1.1.1.1, 2.2.2.2'], 'peer', 1), '2.2.2.2');
});

test('whitespace and empty segments tolerated', () => {
  assert.equal(clientIp('  1.2.3.4 ,, 5.6.7.8 ', 'peer', 1), '5.6.7.8');
});

test('default trustedHops=1: last entry used', () => {
  assert.equal(clientIp('1.2.3.4, 5.6.7.8', 'peer'), '5.6.7.8');
});
