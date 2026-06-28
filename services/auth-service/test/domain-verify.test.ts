import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyDomainTxt } from '../domain-verify.js';

const fakeResolver = (records: string[][]) => async (_host: string) => records;

test('invalid / non-public host throws invalid_site', async () => {
  await assert.rejects(() => verifyDomainTxt('localhost', 'N', fakeResolver([])), /invalid_site/);
  await assert.rejects(() => verifyDomainTxt('192.168.1.1', 'N', fakeResolver([])), /invalid_site/);
});
test('true when a prefixed TXT record matches exactly', async () => {
  assert.equal(
    await verifyDomainTxt('example.com', 'NONCE1', fakeResolver([['verivyx-site-verification=NONCE1']])),
    true,
  );
});
test('matches among multiple TXT records (SPF etc.)', async () => {
  assert.equal(
    await verifyDomainTxt('example.com', 'NONCE1', fakeResolver([['v=spf1 -all'], ['verivyx-site-verification=NONCE1']])),
    true,
  );
});
test('joins multi-chunk TXT records before matching', async () => {
  assert.equal(
    await verifyDomainTxt('example.com', 'NONCE1', fakeResolver([['verivyx-site-', 'verification=NONCE1']])),
    true,
  );
});
test('raw nonce without the prefix does NOT match', async () => {
  assert.equal(await verifyDomainTxt('example.com', 'NONCE1', fakeResolver([['NONCE1']])), false);
});
test('no TXT / resolve error returns false (not thrown)', async () => {
  assert.equal(
    await verifyDomainTxt('example.com', 'NONCE1', async () => { throw new Error('ENOTFOUND'); }),
    false,
  );
});
test('trailing garbage after the nonce does NOT match', async () => {
  assert.equal(
    await verifyDomainTxt('example.com', 'NONCE1', fakeResolver([['verivyx-site-verification=NONCE1extra']])),
    false,
  );
});
test('a different prefix does NOT match', async () => {
  assert.equal(
    await verifyDomainTxt('example.com', 'NONCE1', fakeResolver([['xverivyx-site-verification=NONCE1']])),
    false,
  );
});
