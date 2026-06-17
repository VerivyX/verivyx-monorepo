import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { newConnectId, newNonce, newCode, isPendingExpired, confirmOwnership } from '../connect.js';

test('id/nonce/code are unique, url-safe, sufficiently long', () => {
  assert.notEqual(newConnectId(), newConnectId());
  assert.match(newNonce(), /^[A-Za-z0-9_-]{32,}$/);
  assert.match(newCode(), /^[A-Za-z0-9_-]{32,}$/);
});

test('isPendingExpired honors the TTL', () => {
  const now = Date.now();
  assert.equal(isPendingExpired(new Date(now - 9 * 60_000), now), false);
  assert.equal(isPendingExpired(new Date(now - 11 * 60_000), now), true);
});

test('confirmOwnership rejects an SSRF-blocked host without making a request', async () => {
  await assert.rejects(() => confirmOwnership('localhost', 'cid'), /invalid_site/);
  await assert.rejects(() => confirmOwnership('169.254.169.254', 'cid'), /invalid_site/);
});

test('confirmOwnership returns the nonce a compliant confirm endpoint reports', async () => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '', 'http://x');
    if (u.pathname === '/wp-json/verivyx/v1/confirm' && u.searchParams.get('connect_id') === 'cid') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ nonce: 'NONCE123' }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    const nonce = await confirmOwnership('web-test.verivyx.com', 'cid', `http://127.0.0.1:${port}`);
    assert.equal(nonce, 'NONCE123');
  } finally {
    server.close();
  }
});
