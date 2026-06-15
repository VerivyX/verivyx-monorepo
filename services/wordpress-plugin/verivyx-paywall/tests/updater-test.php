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

echo $failures === 0 ? "\nOK\n" : "\n$failures FAILED\n";
exit($failures === 0 ? 0 : 1);
