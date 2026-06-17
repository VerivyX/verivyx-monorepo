<?php
// Standalone test for Verivyx_Gate::response_headers_402 — runs without WordPress.
// Run: php services/wordpress-plugin/verivyx-paywall/tests/gate-test.php
define('ABSPATH', __DIR__); // satisfy the plugin's ABSPATH guard

require __DIR__ . '/../includes/class-gate.php';

$failures = 0;
function check(bool $cond, string $name): void {
    if ($cond) {
        echo "PASS  $name\n";
    } else {
        echo "FAIL  $name\n";
        $GLOBALS['failures']++;
    }
}

// response_headers_402(encoded) returns the header name => value map for a 402.
$h = Verivyx_Gate::response_headers_402('QUJD'); // base64 of "ABC"

// --- The x402-standard PAYMENT-REQUIRED header MUST be present (official @x402
//     v2 clients read getHeader("PAYMENT-REQUIRED")). ---
check(($h['PAYMENT-REQUIRED'] ?? null) === 'QUJD', 'emits standard PAYMENT-REQUIRED header');

// --- The legacy non-standard X-Payment-Required duplicate MUST be dropped so the
//     response header set stays under default nginx/php-fpm fastcgi buffers. ---
$has_legacy = false;
foreach (array_keys($h) as $k) {
    if (strcasecmp($k, 'X-Payment-Required') === 0) { $has_legacy = true; }
}
check($has_legacy === false, 'does NOT emit legacy X-Payment-Required duplicate');

// --- Exactly one requirements header (the size regression guard). ---
$req_headers = 0;
foreach (array_keys($h) as $k) {
    if (stripos($k, 'payment-required') !== false) { $req_headers++; }
}
check($req_headers === 1, 'exactly one payment-required header (no duplicate bloat)');

// --- Standard envelope headers. ---
check(($h['Content-Type'] ?? null) === 'application/json', 'Content-Type application/json');
check(($h['Cache-Control'] ?? null) === 'no-store', 'Cache-Control no-store');
check(($h['Access-Control-Allow-Origin'] ?? null) === '*', 'CORS allow-origin *');

// --- Expose-Headers advertises PAYMENT-REQUIRED but not the dropped duplicate. ---
$expose = $h['Access-Control-Expose-Headers'] ?? '';
check(stripos($expose, 'PAYMENT-REQUIRED') !== false, 'Expose-Headers includes PAYMENT-REQUIRED');
check(stripos($expose, 'X-Payment-Required') === false, 'Expose-Headers omits X-Payment-Required');

// --- No requirements header when there is nothing to encode. ---
$h2 = Verivyx_Gate::response_headers_402(null);
check(!array_key_exists('PAYMENT-REQUIRED', $h2), 'no PAYMENT-REQUIRED header when encoded is null');
check(($h2['Content-Type'] ?? null) === 'application/json', 'envelope headers still present when encoded null');

echo "\n";
if ($failures > 0) {
    echo "$failures FAILURE(S)\n";
    exit(1);
}
echo "All gate header-policy checks passed.\n";
