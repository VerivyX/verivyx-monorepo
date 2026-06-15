<?php
// Standalone test for Verivyx_Detect::is_known_agent — runs without WordPress.
// Run: php services/wordpress-plugin/verivyx-paywall/tests/detect-test.php
define('ABSPATH', __DIR__); // satisfy the plugin's ABSPATH guard
require __DIR__ . '/../includes/class-detect.php';

$failures = 0;
function check(bool $cond, string $name): void {
    if ($cond) {
        echo "PASS  $name\n";
    } else {
        echo "FAIL  $name\n";
        $GLOBALS['failures']++;
    }
}

check(Verivyx_Detect::is_known_agent('Mozilla/5.0 (compatible; GPTBot/1.1)') === true, 'gptbot is agent');
check(Verivyx_Detect::is_known_agent('ClaudeBot/1.0 (+anthropic.com)') === true, 'claudebot is agent');
check(Verivyx_Detect::is_known_agent('PerplexityBot/1.0') === true, 'perplexity is agent');
check(Verivyx_Detect::is_known_agent('python-requests/2.31') === true, 'python-requests is agent');
check(Verivyx_Detect::is_known_agent('curl/8.4.0') === true, 'curl is agent');
check(Verivyx_Detect::is_known_agent('HeadlessChrome/120') === true, 'headless is agent');
check(Verivyx_Detect::is_known_agent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36') === false, 'real chrome is not agent');
check(Verivyx_Detect::is_known_agent('') === false, 'empty UA is not agent');

echo $failures === 0 ? "\nOK\n" : "\n$failures FAILED\n";
exit($failures === 0 ? 0 : 1);
