import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';
import { checkPow, leadingZeroBits, normalizeDomain, fingerprintReason, validateSlug } from '../lib.js';

test('leadingZeroBits is correct for known buffers', () => {
  assert.equal(leadingZeroBits(Buffer.from([0xff])), 0);
  assert.equal(leadingZeroBits(Buffer.from([0x80])), 0);
  assert.equal(leadingZeroBits(Buffer.from([0x40])), 1);
  assert.equal(leadingZeroBits(Buffer.from([0x00, 0x80])), 8);
  assert.equal(leadingZeroBits(Buffer.from([0x00, 0x00, 0x10])), 19);
});

test('checkPow accepts a found nonce and rejects a wrong one', () => {
  const challenge = 'demo';
  const salt = 'salt';
  const difficulty = 10;
  let found = '';
  for (let i = 0; i < 1_000_000; i++) {
    const n = i.toString(16);
    const h = crypto.createHash('sha256').update(`${challenge}:${salt}:${n}`).digest();
    if (leadingZeroBits(h) >= difficulty) {
      found = n;
      break;
    }
  }
  assert.notEqual(found, '');
  assert.equal(checkPow(challenge, salt, found, difficulty), true);
  assert.equal(checkPow(challenge, salt, 'definitely-wrong', difficulty), false);
});

test('normalizeDomain strips protocol/www/path and rejects garbage', () => {
  assert.equal(normalizeDomain('https://www.Example.com/foo'), 'example.com');
  assert.equal(normalizeDomain('blog.example.co.uk'), 'blog.example.co.uk');
  assert.equal(normalizeDomain('@1Q2w3'), null);
  assert.equal(normalizeDomain('not_a_domain'), null);
  assert.equal(normalizeDomain(' '), null);
  assert.equal(normalizeDomain(123 as unknown as string), null);
});

test('validateSlug allows safe slugs and rejects dangerous ones', () => {
  assert.equal(validateSlug('hello'), 'hello');
  assert.equal(validateSlug('my-article-2026'), 'my-article-2026');
  assert.equal(validateSlug('A'), 'a');
  assert.equal(validateSlug('-foo'), null);
  assert.equal(validateSlug('foo--bar'), 'foo--bar'); // hyphens are allowed
  assert.equal(validateSlug('with space'), null);
  assert.equal(validateSlug('../etc/passwd'), null);
});

test('fingerprintReason flags obvious bot signals', () => {
  // happy path
  assert.equal(
    fingerprintReason({
      webdriver: false,
      languages: ['en'],
      userAgent: 'Mozilla/5.0',
      hardwareConcurrency: 8,
      screenWidth: 1920,
      screenHeight: 1080,
    }),
    null,
  );
  // webdriver flag
  assert.equal(
    fingerprintReason({
      webdriver: true,
      languages: ['en'],
      userAgent: 'Mozilla/5.0',
      hardwareConcurrency: 8,
      screenWidth: 1920,
      screenHeight: 1080,
    }),
    'webdriver_flag_set',
  );
  // headless UA
  assert.equal(
    fingerprintReason({
      webdriver: false,
      languages: ['en'],
      userAgent: 'HeadlessChrome/120',
      hardwareConcurrency: 8,
      screenWidth: 1920,
      screenHeight: 1080,
    }),
    'headless_user_agent',
  );
  // GPTBot UA
  assert.equal(
    fingerprintReason({
      webdriver: false,
      languages: ['en'],
      userAgent: 'GPTBot/1.0',
      hardwareConcurrency: 8,
      screenWidth: 1920,
      screenHeight: 1080,
    }),
    'bot_user_agent',
  );
  // empty languages
  assert.equal(
    fingerprintReason({
      webdriver: false,
      languages: [],
      userAgent: 'Mozilla/5.0',
      hardwareConcurrency: 8,
      screenWidth: 1920,
      screenHeight: 1080,
    }),
    'no_languages',
  );
});
