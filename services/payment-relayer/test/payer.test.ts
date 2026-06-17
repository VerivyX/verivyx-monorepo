import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePayer } from '../src/payer';

test('resolvePayer prefers the client-declared payer', () => {
  assert.equal(resolvePayer('GDECLARED', 'GFROM', 'GSOURCE'), 'GDECLARED');
});

test('resolvePayer falls back to the Soroban transfer from-arg', () => {
  assert.equal(resolvePayer(undefined, 'GFROM', 'GSOURCE'), 'GFROM');
  assert.equal(resolvePayer('', 'GFROM', 'GSOURCE'), 'GFROM');
});

test('resolvePayer falls back to the tx source as last resort', () => {
  assert.equal(resolvePayer('', '', 'GSOURCE'), 'GSOURCE');
});
