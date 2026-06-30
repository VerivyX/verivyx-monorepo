import assert from 'node:assert/strict'; import { test } from 'node:test';
import { newSiteId, onchainKey, siteLabel } from './site.js';
test('newSiteId is prefixed + unique', () => { const a=newSiteId(); assert.match(a,/^site_[a-z0-9]+$/i); assert.notEqual(a,newSiteId()); });
test('onchainKey prefers domain', () => { assert.equal(onchainKey({domain:'web-test.verivyx.com',siteId:'site_x'}),'web-test.verivyx.com'); });
test('onchainKey falls back to siteId', () => { assert.equal(onchainKey({domain:null,siteId:'site_x'}),'site_x'); assert.equal(onchainKey({domain:'',siteId:'site_x'}),'site_x'); });
test('onchainKey throws if both empty', () => { assert.throws(()=>onchainKey({domain:null,siteId:null})); });
test('siteLabel prefers domain', () => { assert.equal(siteLabel({domain:'web-test.verivyx.com',siteId:'site_x'}),'web-test.verivyx.com'); });
test('siteLabel falls back to siteId then fallback', () => { assert.equal(siteLabel({domain:null,siteId:'site_x'}),'site_x'); assert.equal(siteLabel({domain:'',siteId:'',fallback:'a@b.com'}),'a@b.com'); });
test('siteLabel never throws when all empty', () => { assert.equal(siteLabel({domain:null,siteId:null}),'unknown'); });
