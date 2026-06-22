<?php
// Standalone test for Verivyx_Api::hydrate_timeout — runs without WordPress.
// Run: php services/wordpress-plugin/verivyx-paywall/tests/api-timeout-test.php
define('ABSPATH', __DIR__); // satisfy the plugin's ABSPATH guard

require __DIR__ . '/../includes/class-api.php';

$failures = 0;
function check(bool $cond, string $name): void {
    if ($cond) {
        echo "PASS  $name\n";
    } else {
        echo "FAIL  $name\n";
        $GLOBALS['failures']++;
    }
}

// A no-payment hydrate (402 / passthrough / human) resolves fast — keep the short timeout.
check(Verivyx_Api::hydrate_timeout(false) === 5, 'no-payment path uses the fast 5s timeout');

// A paid agent request triggers a synchronous on-chain Soroban settle that takes
// ~9-12s. WP must wait LONGER than hydration's own 30s gateway timeout so hydration
// is the component that decides the outcome — otherwise WP times out at 5s, fails
// open to a themed page (dropping the Payment-Response receipt header) while the
// settle still completes on-chain: money is deducted but the client is told it failed.
check(Verivyx_Api::hydrate_timeout(true) > 30, 'payment path waits longer than hydration 30s gateway timeout');

echo $failures === 0 ? "\nOK\n" : "\n$failures FAILED\n";
exit($failures === 0 ? 0 : 1);
