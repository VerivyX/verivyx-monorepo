// detector.ts references browser globals (window/navigator) only at construction
// time, so we stub them per case. The scoring threshold (>=50 = bot) is the
// security-relevant behavior we lock down here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BotDetector } from "../src/detector.js";

function withBrowser(nav: Record<string, unknown>, fn: () => void): void {
  Object.defineProperty(globalThis, "window", {
    value: { addEventListener() {} },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: nav,
    configurable: true,
    writable: true,
  });
  try {
    fn();
  } finally {
    // @ts-expect-error cleanup test globals
    delete globalThis.window;
    // @ts-expect-error cleanup test globals
    delete globalThis.navigator;
  }
}

const human = {
  webdriver: false,
  languages: ["en-US", "en"],
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120",
};

test("a normal browser scores below the bot threshold", () => {
  withBrowser(human, () => {
    assert.equal(new BotDetector().isBot(), false);
  });
});

test("navigator.webdriver alone reaches the bot threshold (50)", () => {
  withBrowser({ ...human, webdriver: true }, () => {
    assert.equal(new BotDetector().isBot(), true);
  });
});

test("a bot user-agent is flagged decisively", () => {
  withBrowser({ ...human, userAgent: "Mozilla/5.0 (compatible; GPTBot/1.1)" }, () => {
    assert.equal(new BotDetector().isBot(), true);
  });
  withBrowser({ ...human, userAgent: "HeadlessChrome/120" }, () => {
    assert.equal(new BotDetector().isBot(), true);
  });
});

test("missing languages contributes but does not alone trip the threshold", () => {
  withBrowser({ ...human, languages: [] }, () => {
    // +20 only → still human
    assert.equal(new BotDetector().isBot(), false);
  });
});
