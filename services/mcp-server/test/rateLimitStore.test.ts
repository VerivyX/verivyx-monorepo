import assert from "node:assert/strict";
import { test } from "node:test";

import RedisMock from "ioredis-mock";

import {
  InMemoryStore,
  RedisStore,
  initRateLimitStore,
  redisUrlFromEnv,
  selectStoreMode,
  type RedisLike,
} from "../src/rateLimit.js";

test("InMemoryStore.allow mirrors the in-memory engine (limit then block)", async () => {
  const store = new InMemoryStore();
  const key = `mem:${Math.random()}`;
  assert.equal(await store.allow(key, 2, 60_000), true);
  assert.equal(await store.allow(key, 2, 60_000), true);
  assert.equal(await store.allow(key, 2, 60_000), false, "3rd over max=2 blocked");
});

test("RedisStore allows up to max within the window, then blocks", async () => {
  const store = new RedisStore(new RedisMock() as unknown as RedisLike);
  const key = `red:${Math.random()}`;
  assert.equal(await store.allow(key, 3, 60_000), true);
  assert.equal(await store.allow(key, 3, 60_000), true);
  assert.equal(await store.allow(key, 3, 60_000), true);
  assert.equal(await store.allow(key, 3, 60_000), false, "4th over max=3 blocked");
});

test("RedisStore resets after the window expires", async () => {
  const store = new RedisStore(new RedisMock() as unknown as RedisLike);
  const key = `red:${Math.random()}`;
  assert.equal(await store.allow(key, 1, 30), true);
  assert.equal(await store.allow(key, 1, 30), false, "2nd within window blocked");
  await new Promise(r => setTimeout(r, 60));
  assert.equal(await store.allow(key, 1, 30), true, "allowed again after window reset");
});

test("RedisStore keys are independent", async () => {
  const client = new RedisMock() as unknown as RedisLike;
  const store = new RedisStore(client);
  const a = `a:${Math.random()}`;
  const b = `b:${Math.random()}`;
  assert.equal(await store.allow(a, 1, 60_000), true);
  assert.equal(await store.allow(a, 1, 60_000), false);
  assert.equal(await store.allow(b, 1, 60_000), true, "different key has its own bucket");
});

test("RedisStore fails OPEN when the client errors (allow, not block)", async () => {
  const broken: RedisLike = {
    incr: () => Promise.reject(new Error("redis down")),
    pexpire: () => Promise.resolve(1),
  };
  const store = new RedisStore(broken);
  // Even far over any limit, a Redis error must allow the request through.
  assert.equal(await store.allow("k", 1, 60_000), true);
  assert.equal(await store.allow("k", 1, 60_000), true);
});

test("selectStoreMode: unset env → memory, set env → redis", () => {
  assert.equal(selectStoreMode({}), "memory");
  assert.equal(selectStoreMode({ MCP_REDIS_URL: "" }), "memory", "empty string is not configured");
  assert.equal(selectStoreMode({ MCP_REDIS_URL: "redis://localhost:6379" }), "redis");
  assert.equal(selectStoreMode({ REDIS_URL: "redis://localhost:6379" }), "redis", "REDIS_URL fallback");
});

test("redisUrlFromEnv prefers MCP_REDIS_URL over REDIS_URL", () => {
  assert.equal(redisUrlFromEnv({}), undefined);
  assert.equal(
    redisUrlFromEnv({ MCP_REDIS_URL: "redis://a", REDIS_URL: "redis://b" }),
    "redis://a",
  );
  assert.equal(redisUrlFromEnv({ REDIS_URL: "redis://b" }), "redis://b");
});

test("initRateLimitStore: unset env selects the in-memory store (default)", async () => {
  const store = await initRateLimitStore({});
  assert.ok(store instanceof InMemoryStore, "default store must be in-memory");
});
