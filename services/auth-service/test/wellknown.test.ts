import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyWellKnown } from '../wellknown.js';

test('verifyWellKnown rejects an SSRF-blocked host without making a request', async () => {
  await assert.rejects(() => verifyWellKnown('localhost', 'NONCE'), /invalid_site/);
  await assert.rejects(() => verifyWellKnown('169.254.169.254', 'NONCE'), /invalid_site/);
  await assert.rejects(() => verifyWellKnown('192.168.1.1', 'NONCE'), /invalid_site/);
});

test('verifyWellKnown returns true when the nonce matches exactly', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('EXPECTED_NONCE\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    const result = await verifyWellKnown('example.com', 'EXPECTED_NONCE', `http://127.0.0.1:${port}`);
    assert.equal(result, true);
  } finally {
    server.close();
  }
});

test('verifyWellKnown returns false when the nonce does not match', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('WRONG_NONCE\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    const result = await verifyWellKnown('example.com', 'EXPECTED_NONCE', `http://127.0.0.1:${port}`);
    assert.equal(result, false);
  } finally {
    server.close();
  }
});

test('verifyWellKnown returns false on non-200 response', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    const result = await verifyWellKnown('example.com', 'EXPECTED_NONCE', `http://127.0.0.1:${port}`);
    assert.equal(result, false);
  } finally {
    server.close();
  }
});

test('verifyWellKnown fetches from the correct .well-known path', async () => {
  let capturedPath = '';
  const server = http.createServer((req, res) => {
    capturedPath = req.url ?? '';
    if (req.url === '/.well-known/verivyx.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('MY_NONCE');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    const result = await verifyWellKnown('example.com', 'MY_NONCE', `http://127.0.0.1:${port}`);
    assert.equal(result, true);
    assert.equal(capturedPath, '/.well-known/verivyx.txt');
  } finally {
    server.close();
  }
});
