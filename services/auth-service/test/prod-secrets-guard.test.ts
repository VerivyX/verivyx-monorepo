import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireProductionSecrets } from '../lib.js';

test('requireProductionSecrets throws in production when Turnstile/Resend secrets are missing', () => {
  // Both missing.
  assert.throws(
    () => requireProductionSecrets({ isProduction: true, TURNSTILE_SECRET_KEY: '', RESEND_API_KEY: '' }),
    /TURNSTILE_SECRET_KEY.*RESEND_API_KEY.*required in production/,
  );
  // Only Turnstile missing.
  assert.throws(
    () => requireProductionSecrets({ isProduction: true, TURNSTILE_SECRET_KEY: '  ', RESEND_API_KEY: 're_x' }),
    /TURNSTILE_SECRET_KEY required in production/,
  );
  // Only Resend missing.
  assert.throws(
    () => requireProductionSecrets({ isProduction: true, TURNSTILE_SECRET_KEY: 'ts_x', RESEND_API_KEY: undefined }),
    /RESEND_API_KEY required in production/,
  );
});

test('requireProductionSecrets passes in production when both secrets are set', () => {
  assert.doesNotThrow(() =>
    requireProductionSecrets({ isProduction: true, TURNSTILE_SECRET_KEY: 'ts_x', RESEND_API_KEY: 're_x' }),
  );
});

test('requireProductionSecrets is a no-op outside production (dev bypass preserved)', () => {
  assert.doesNotThrow(() =>
    requireProductionSecrets({ isProduction: false, TURNSTILE_SECRET_KEY: '', RESEND_API_KEY: '' }),
  );
});
