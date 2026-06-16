<?php
// Standalone test for Verivyx_Content_Gate pure helpers — runs without WordPress.
// Run: php services/wordpress-plugin/verivyx-paywall/tests/content-gate-test.php
define('ABSPATH', __DIR__); // satisfy the plugin's ABSPATH guard

// --- WP function shims used by build_teaser ---
if (!function_exists('esc_html')) { function esc_html($s) { return htmlspecialchars((string) $s, ENT_QUOTES); } }
if (!function_exists('esc_url'))  { function esc_url($s)  { return (string) $s; } }

require __DIR__ . '/../includes/class-content-gate.php';

$failures = 0;
function check(bool $cond, string $name): void {
    if ($cond) {
        echo "PASS  $name\n";
    } else {
        echo "FAIL  $name\n";
        $GLOBALS['failures']++;
    }
}

// Signature:
// should_gate_article(post_type, post_id, front_id, posts_page_id, scope, custom_types, public_page_ids)

// --- exclusions: never gate front page / blog index / allowlisted page ---
check(Verivyx_Content_Gate::should_gate_article('page', 10, 10, 0, 'all', [], []) === false, 'front page never gated');
check(Verivyx_Content_Gate::should_gate_article('page', 20, 10, 20, 'all', [], []) === false, 'blog index never gated');
check(Verivyx_Content_Gate::should_gate_article('page', 30, 10, 20, 'all', [], [30, 31]) === false, 'allowlisted page never gated');

// --- scope: posts ---
check(Verivyx_Content_Gate::should_gate_article('post', 5, 10, 20, 'posts', [], []) === true,  'scope=posts gates a post');
check(Verivyx_Content_Gate::should_gate_article('page', 5, 10, 20, 'posts', [], []) === false, 'scope=posts does not gate a page');

// --- scope: pages ---
check(Verivyx_Content_Gate::should_gate_article('page', 5, 10, 20, 'pages', [], []) === true,  'scope=pages gates a page');
check(Verivyx_Content_Gate::should_gate_article('post', 5, 10, 20, 'pages', [], []) === false, 'scope=pages does not gate a post');

// --- scope: posts_pages ---
check(Verivyx_Content_Gate::should_gate_article('post', 5, 10, 20, 'posts_pages', [], []) === true, 'scope=posts_pages gates post');
check(Verivyx_Content_Gate::should_gate_article('page', 5, 10, 20, 'posts_pages', [], []) === true, 'scope=posts_pages gates page');

// --- scope: all gates a normal page but NOT the front page ---
check(Verivyx_Content_Gate::should_gate_article('page', 5, 10, 20, 'all', [], []) === true,  'scope=all gates a normal page');
check(Verivyx_Content_Gate::should_gate_article('page', 10, 10, 20, 'all', [], []) === false, 'scope=all still excludes front page');

// --- scope: custom ---
check(Verivyx_Content_Gate::should_gate_article('book', 5, 10, 20, 'custom', ['book'], []) === true,  'scope=custom gates listed CPT');
check(Verivyx_Content_Gate::should_gate_article('post', 5, 10, 20, 'custom', ['book'], []) === false, 'scope=custom does not gate unlisted type');

// --- unknown scope / front_id=0 guard ---
check(Verivyx_Content_Gate::should_gate_article('post', 5, 10, 20, 'nonsense', [], []) === false, 'unknown scope never gates');
check(Verivyx_Content_Gate::should_gate_article('post', 0, 0, 0, 'all', [], []) === true, 'post_id 0 with front_id 0 is not treated as front page');

// --- build_teaser ---
$teaser = Verivyx_Content_Gate::build_teaser('A short summary.', 'https://example.com/post/');
check(strpos($teaser, 'A short summary.') !== false, 'teaser contains the excerpt');
check(strpos($teaser, 'https://example.com/post/') !== false, 'teaser contains the permalink');
check(strpos($teaser, 'verivyx-read-more') !== false, 'teaser has read-more marker');

$empty = Verivyx_Content_Gate::build_teaser('', 'https://example.com/post/');
check(strpos($empty, 'https://example.com/post/') !== false, 'empty-excerpt teaser still links to article');
check(strpos($empty, '<p></p>') === false, 'empty-excerpt teaser omits empty paragraph');

// excerpt is HTML-escaped (no raw markup passes through)
$xss = Verivyx_Content_Gate::build_teaser('<script>x</script>', 'https://example.com/post/');
check(strpos($xss, '<script>') === false, 'teaser escapes excerpt HTML');

echo $failures === 0 ? "\nOK\n" : "\n$failures FAILED\n";
exit($failures === 0 ? 0 : 1);
