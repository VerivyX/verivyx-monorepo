<?php
defined('ABSPATH') || exit;

class Verivyx_Detect {

    /**
     * Known AI agents and automated HTTP clients that must always pay, even
     * when they present a navigation-style request (Sec-Fetch-Mode: navigate
     * can be spoofed by any non-browser client). Mirrors the gateway/hydration
     * Go classifier so enforcement is consistent across the stack.
     */
    public static function is_known_agent(string $ua): bool {
        $ua = strtolower($ua);
        if ($ua === '') {
            return false;
        }

        $needles = [
            // AI crawlers / research agents
            'gptbot', 'oai-search', 'openai', 'perplexity', 'anthropic', 'claudebot',
            'google-extended', 'googleother', 'bytespider', 'amazonbot', 'ccbot',
            // headless / automation stacks
            'headless', 'puppeteer', 'playwright', 'selenium', 'phantomjs',
            // raw HTTP clients
            'python-requests', 'python-urllib', 'go-http-client', 'curl/', 'wget/',
            'libwww-perl', 'scrapy', 'httpclient', 'apache-httpclient', 'node-fetch', 'axios',
        ];

        foreach ($needles as $needle) {
            if (strpos($ua, $needle) !== false) {
                return true;
            }
        }
        return false;
    }
}
