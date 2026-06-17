import type { BotSignal } from './types';

// Score-based, synchronous bot detection (runs < 5ms). score >= 50 → BOT path.
export function calcBotScore(): { score: number; signals: BotSignal[] } {
  const signals: BotSignal[] = [];
  let score = 0;

  function add(name: string, points: number): void {
    signals.push({ name, score: points });
    score += points;
  }

  try {
    const nav = navigator as Navigator & { webdriver?: boolean; plugins?: PluginArray };
    const ua = navigator.userAgent.toLowerCase();
    const win = window as Window & {
      chrome?: unknown;
      _phantom?: unknown;
      __nightmare?: unknown;
      callPhantom?: unknown;
    };

    // Hard signals (100 pts = immediate BOT)
    if (nav.webdriver === true) add('webdriver', 100);

    const botUAs = [
      'googlebot', 'bingbot', 'slurp', 'crawl', 'spider',
      'bot/', 'headless', 'python-requests', 'python-urllib',
      'go-http-client', 'libwww-perl', 'curl/', 'wget/',
      'scrapy', 'httpclient', 'apache-httpclient',
    ];
    if (botUAs.some((b) => ua.includes(b))) add('bot_ua', 100);

    if (typeof win._phantom !== 'undefined' || typeof win.callPhantom !== 'undefined') add('phantom', 100);
    if (typeof win.__nightmare !== 'undefined') add('nightmare', 100);

    // Strong signals (30-50 pts)
    if (!navigator.languages || navigator.languages.length === 0) add('no_languages', 40);
    if (ua.includes('chrome') && !ua.includes('edge') && !ua.includes('opr') && !win.chrome) add('chrome_no_runtime', 45);
    if (navigator.plugins && navigator.plugins.length === 0 && !ua.includes('firefox')) add('no_plugins', 30);
    if (navigator.hardwareConcurrency === 0) add('no_cpu_cores', 30);

    // Medium signals (10-25 pts)
    if (
      (screen.width === 800 && screen.height === 600) ||
      (screen.width === 1280 && screen.height === 720 && window.devicePixelRatio === 1)
    ) add('headless_screen', 25);

    if (
      window.outerWidth > 0 && window.outerHeight > 0 &&
      window.outerWidth === window.innerWidth && window.outerHeight === window.innerHeight
    ) add('no_browser_chrome', 20);

    try {
      if (typeof navigator.permissions === 'undefined') add('no_permissions_api', 15);
    } catch { /* noop */ }

    if (!(navigator as Navigator & { connection?: unknown }).connection) add('no_network_info', 10);
  } catch {
    /* browser may restrict — not fatal */
  }

  return { score, signals };
}
