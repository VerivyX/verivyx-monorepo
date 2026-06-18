<?php
// Standalone test for Verivyx_Updater pure helpers — runs without WordPress.
// Run: php services/wordpress-plugin/verivyx-paywall/tests/updater-test.php
define('ABSPATH', __DIR__); // satisfy the plugin's ABSPATH guard
require __DIR__ . '/../includes/class-updater.php';

$failures = 0;
function check(bool $cond, string $name): void {
    if ($cond) {
        echo "PASS  $name\n";
    } else {
        echo "FAIL  $name\n";
        $GLOBALS['failures']++;
    }
}

// --- is_newer ---
check(Verivyx_Updater::is_newer('1.1.0', '1.0.1') === true,  'newer minor');
check(Verivyx_Updater::is_newer('1.0.2', '1.0.1') === true,  'newer patch');
check(Verivyx_Updater::is_newer('1.0.1', '1.0.1') === false, 'equal is not newer');
check(Verivyx_Updater::is_newer('1.0.0', '1.0.1') === false, 'older is not newer');
check(Verivyx_Updater::is_newer('2.0.0', '1.9.9') === true,  'major bump');

// --- sanitize_meta: valid ---
$ok = Verivyx_Updater::sanitize_meta([
    'version'      => '1.2.0',
    'download_url' => 'https://verivyx.com/verivyx-paywall.zip',
    'requires'     => '5.8',
    'tested'       => '6.5',
    'requires_php' => '8.0',
    'sections'     => ['changelog' => '<h4>1.2.0</h4>'],
]);
check(is_array($ok) && $ok['version'] === '1.2.0', 'valid meta parsed');
check(is_array($ok) && $ok['changelog'] === '<h4>1.2.0</h4>', 'changelog carried');

// --- sanitize_meta: security rejections (each must be null = "no update") ---
check(Verivyx_Updater::sanitize_meta(['version'=>'1.2.0','download_url'=>'https://evil.example/x.zip']) === null, 'reject foreign host');
check(Verivyx_Updater::sanitize_meta(['version'=>'1.2.0','download_url'=>'http://verivyx.com/x.zip']) === null, 'reject non-https');
check(Verivyx_Updater::sanitize_meta(['version'=>'1.2.0','download_url'=>'https://verivyx.com.evil.com/x.zip']) === null, 'reject host-suffix spoof');
check(Verivyx_Updater::sanitize_meta(['version'=>'1.2.0','download_url'=>'https://verivyx.com@evil.com/x.zip']) === null, 'reject userinfo spoof');
check(Verivyx_Updater::sanitize_meta(['version'=>'1.2.0','download_url'=>'//verivyx.com/x.zip']) === null, 'reject protocol-relative');
check(Verivyx_Updater::sanitize_meta(['version'=>'1.2.0']) === null, 'reject missing download_url');
check(Verivyx_Updater::sanitize_meta(['download_url'=>'https://verivyx.com/x.zip']) === null, 'reject missing version');
check(Verivyx_Updater::sanitize_meta(['version'=>'not-a-version','download_url'=>'https://verivyx.com/x.zip']) === null, 'reject bad version string');
check(Verivyx_Updater::sanitize_meta('nope') === null, 'reject non-array');

// --- status_text (force-check notice; pure) ---
check(strpos(Verivyx_Updater::status_text('1.3.0', '1.2.0'), '1.3.0') !== false, 'status: update available mentions remote version');
check(stripos(Verivyx_Updater::status_text('1.3.0', '1.2.0'), 'update available') !== false, 'status: update available phrasing');
check(stripos(Verivyx_Updater::status_text('1.2.0', '1.2.0'), 'up to date') !== false, 'status: equal version = up to date');
check(stripos(Verivyx_Updater::status_text('1.1.0', '1.2.0'), 'up to date') !== false, 'status: older remote = up to date');
check(stripos(Verivyx_Updater::status_text('', '1.2.0'), 'could not reach') !== false, 'status: empty remote = unreachable');

// --- build_update: WP-shaped update entry, only when a newer version exists ---
$meta = [
    'version'      => '1.4.0',
    'download_url' => 'https://verivyx.com/verivyx-paywall.zip',
    'homepage'     => 'https://verivyx.com',
    'tested'       => '6.5',
    'requires'     => '5.8',
    'requires_php' => '8.0',
    'changelog'    => '',
];
$uri = 'https://verivyx.com/verivyx-paywall.json';
$up  = Verivyx_Updater::build_update($meta, '1.3.1', 'verivyx-paywall/verivyx-paywall.php', $uri);
check(is_array($up) && $up['new_version'] === '1.4.0', 'build_update: new_version set when newer (classic transient contract)');
check(is_array($up) && $up['version'] === '1.4.0', 'build_update: version mirrors new_version (update_plugins_{host} contract)');
check(is_array($up) && $up['package'] === 'https://verivyx.com/verivyx-paywall.zip', 'build_update: package = download_url');
check(is_array($up) && $up['plugin'] === 'verivyx-paywall/verivyx-paywall.php', 'build_update: plugin basename carried');
check(is_array($up) && $up['slug'] === 'verivyx-paywall', 'build_update: slug set');
check(is_array($up) && $up['id'] === $uri, 'build_update: id = Update URI');
check(Verivyx_Updater::build_update($meta, '1.4.0', 'x/x.php', $uri) === null, 'build_update: null when equal (not newer)');
check(Verivyx_Updater::build_update($meta, '1.5.0', 'x/x.php', $uri) === null, 'build_update: null when installed is newer');
check(Verivyx_Updater::build_update(null, '1.3.1', 'x/x.php', $uri) === null, 'build_update: null when meta unavailable');

// --- verify_sha256 (package integrity helper) ---
// Create a temp file with known content to test hash verification.
$tmp = sys_get_temp_dir() . '/vx-test-' . getmypid() . '.bin';
file_put_contents($tmp, 'hello verivyx');
$good_hex = hash('sha256', 'hello verivyx');
$bad_hex  = str_repeat('0', 64); // wrong but valid-length hex

check(Verivyx_Updater::verify_sha256($tmp, $good_hex) === true,  'verify_sha256: matching hash returns true');
check(Verivyx_Updater::verify_sha256($tmp, $bad_hex)  === false, 'verify_sha256: wrong hash returns false');
check(Verivyx_Updater::verify_sha256('/no/such/file/xyz.zip', $good_hex) === false, 'verify_sha256: missing file returns false');
check(Verivyx_Updater::verify_sha256($tmp, 'not-hex') === false, 'verify_sha256: malformed hex returns false');
check(Verivyx_Updater::verify_sha256($tmp, strtoupper($good_hex)) === true, 'verify_sha256: uppercase hex accepted');
@unlink($tmp);

// --- sanitize_meta: sha256 field carried when valid 64-char hex ---
$with_sha = Verivyx_Updater::sanitize_meta([
    'version'      => '1.3.0',
    'download_url' => 'https://verivyx.com/verivyx-paywall.zip',
    'sha256'       => $good_hex,
]);
check(is_array($with_sha) && ($with_sha['sha256'] ?? '') === $good_hex, 'sanitize_meta: valid sha256 carried through');

$no_sha = Verivyx_Updater::sanitize_meta([
    'version'      => '1.3.0',
    'download_url' => 'https://verivyx.com/verivyx-paywall.zip',
]);
check(is_array($no_sha) && ($no_sha['sha256'] ?? '') === '', 'sanitize_meta: missing sha256 results in empty string (backward-compat)');

$bad_sha = Verivyx_Updater::sanitize_meta([
    'version'      => '1.3.0',
    'download_url' => 'https://verivyx.com/verivyx-paywall.zip',
    'sha256'       => 'too-short',
]);
check(is_array($bad_sha) && ($bad_sha['sha256'] ?? '') === '', 'sanitize_meta: invalid sha256 is stripped to empty (not rejected)');

echo $failures === 0 ? "\nOK\n" : "\n$failures FAILED\n";
exit($failures === 0 ? 0 : 1);
