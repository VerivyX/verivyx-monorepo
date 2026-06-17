<?php
// Standalone test for Verivyx_Content_Gate Phase-2 pure helpers — runs without WordPress.
// Run: php services/wordpress-plugin/verivyx-paywall/tests/withhold-test.php
define('ABSPATH', __DIR__);
if (!function_exists('esc_html')) { function esc_html($s){ return htmlspecialchars((string)$s, ENT_QUOTES); } }
if (!function_exists('esc_url'))  { function esc_url($s){ return (string)$s; } }
if (!function_exists('esc_attr')) { function esc_attr($s){ return htmlspecialchars((string)$s, ENT_QUOTES); } }
if (!function_exists('wp_json_encode')) { function wp_json_encode($d){ return json_encode($d); } }

require __DIR__ . '/../includes/class-content-gate.php';

$failures = 0;
function check(bool $cond, string $name): void {
    echo ($cond ? "PASS  " : "FAIL  ") . $name . "\n";
    if (!$cond) { $GLOBALS['failures']++; }
}

// should_withhold_body(is_gated_singular, is_verified, is_internal_render)
check(Verivyx_Content_Gate::should_withhold_body(true,  false, false) === true,  'gated singular + unverified → withhold');
check(Verivyx_Content_Gate::should_withhold_body(true,  true,  false) === false, 'gated singular + verified (payment/session) → serve');
check(Verivyx_Content_Gate::should_withhold_body(true,  false, true ) === false, 'internal render bypass → serve real body');
check(Verivyx_Content_Gate::should_withhold_body(false, false, false) === false, 'not gated → serve');

// build_stub(teaser_html) → teaser + empty paywalled container, NO body.
$stub = Verivyx_Content_Gate::build_stub('<p>Teaser text.</p>');
check(strpos($stub, 'Teaser text.') !== false, 'stub contains teaser');
check(strpos($stub, 'id="vx-article"') !== false, 'stub has #vx-article container');
check(strpos($stub, 'class="vx-paywalled"') !== false, 'stub container has vx-paywalled class (matches cssSelector)');
check(strpos($stub, '<p>This is your first post') === false, 'stub contains NO article body');

// build_paywall_jsonld(title, description, url) → valid Google paywalled-content JSON-LD.
$ld = Verivyx_Content_Gate::build_paywall_jsonld('My Title', 'My excerpt', 'https://demo.com/a');
$data = json_decode($ld, true);
check(is_array($data), 'json-ld is valid JSON');
check(($data['@type'] ?? '') === 'NewsArticle', 'type NewsArticle');
check(($data['isAccessibleForFree'] ?? null) === false, 'isAccessibleForFree false');
check(($data['hasPart']['@type'] ?? '') === 'WebPageElement', 'hasPart WebPageElement');
check(($data['hasPart']['cssSelector'] ?? '') === '.vx-paywalled', 'cssSelector matches container class');
check(($data['hasPart']['isAccessibleForFree'] ?? null) === false, 'hasPart isAccessibleForFree false');
check(($data['headline'] ?? '') === 'My Title', 'headline carried');

echo $failures === 0 ? "\nOK\n" : "\n$failures FAILED\n";
exit($failures === 0 ? 0 : 1);
