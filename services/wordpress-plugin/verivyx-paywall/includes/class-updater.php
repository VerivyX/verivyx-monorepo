<?php
defined('ABSPATH') || exit;

class Verivyx_Updater {

    const SLUG         = 'verivyx-paywall';
    const META_URL     = 'https://verivyx.com/verivyx-paywall.json';
    const ALLOWED_HOST = 'verivyx.com';
    const CACHE_KEY    = 'verivyx_update_info';
    const CACHE_TTL    = 43200; // 12h, in seconds (literal so the class loads without WP)

    public static function boot(): void {
        // Classic path (WP < 5.8, and a resilient fallback): inject into the transient.
        add_filter('pre_set_site_transient_update_plugins', [__CLASS__, 'inject_update']);
        // Modern path (WP 5.8+): the Update URI header routes checks to this
        // hostname-scoped filter so wordpress.org cannot claim the "verivyx-paywall"
        // slug. Both paths reuse build_update(), so they always agree.
        add_filter('update_plugins_' . self::ALLOWED_HOST, [__CLASS__, 'check_update_uri'], 10, 4);
        add_filter('plugins_api', [__CLASS__, 'plugin_info'], 20, 3);
        add_action('upgrader_process_complete', [__CLASS__, 'flush_cache']);
        // Package integrity: verify SHA-256 of the downloaded zip before WP installs it.
        // upgrader_pre_download fires before the download begins; we download + verify
        // ourselves and return the verified local path (or WP_Error on mismatch).
        // Gated to this plugin's package URL only — other plugins are unaffected.
        add_filter('upgrader_pre_download', [__CLASS__, 'verify_package_download'], 10, 4);
    }

    /** version_compare wrapper — pure, unit-testable. */
    public static function is_newer(string $remote, string $local): bool {
        return version_compare($remote, $local, '>');
    }

    /**
     * Human-readable result of a force update check. Pure (no WP I/O) so it is
     * unit-testable. $remote is the version reported by verivyx.com ('' on failure).
     */
    public static function status_text(string $remote, string $local): string {
        if ($remote === '') {
            return 'Could not reach the Verivyx update server. Please try again in a moment.';
        }
        if (self::is_newer($remote, $local)) {
            return sprintf(
                'Update available: version %s (you have %s). Open Dashboard → Updates or Plugins to install it.',
                $remote,
                $local
            );
        }
        return sprintf('You are up to date (version %s).', $local);
    }

    /**
     * Force an immediate re-check: drops our cached metadata AND WordPress's own
     * plugin-update transient, then refetches. Bypasses the 12h cache so the admin
     * "Check for updates now" button reflects verivyx.com right away.
     */
    public static function force_check(): ?array {
        delete_transient(self::CACHE_KEY);
        delete_site_transient('update_plugins'); // make core re-evaluate on next page load
        return self::fetch_meta(true);
    }

    /**
     * Validate + normalize untrusted metadata. Pure (no WP I/O) so it is
     * unit-testable. Requires a well-formed version and an https download_url on
     * the exact allowed host. Anything else returns null = "no update" (fail-safe).
     */
    public static function sanitize_meta($data): ?array {
        if (!is_array($data)) {
            return null;
        }
        $version  = (isset($data['version'])      && is_string($data['version']))      ? trim($data['version'])      : '';
        $download = (isset($data['download_url']) && is_string($data['download_url'])) ? trim($data['download_url']) : '';
        if ($version === '' || $download === '') {
            return null;
        }
        if (!preg_match('/^\d+\.\d+(\.\d+)?([.-][0-9A-Za-z.-]+)?$/', $version)) {
            return null;
        }

        $parts = parse_url($download);
        if (!is_array($parts)) {
            return null;
        }
        if (empty($parts['scheme']) || strtolower($parts['scheme']) !== 'https') {
            return null;
        }
        if (empty($parts['host']) || strtolower($parts['host']) !== self::ALLOWED_HOST) {
            return null;
        }
        if (!empty($parts['user']) || !empty($parts['pass'])) {
            return null; // reject userinfo (e.g. https://verivyx.com@evil.com)
        }

        $str = static function ($v): string { return is_string($v) ? $v : ''; };
        $changelog = '';
        if (isset($data['sections']) && is_array($data['sections']) && isset($data['sections']['changelog'])
            && is_string($data['sections']['changelog'])) {
            $changelog = $data['sections']['changelog'];
        }

        // sha256: optional 64-char lowercase hex string. Strip (to '') if malformed so
        // existing metadata without a hash is backward-compatible (install proceeds).
        $sha256_raw = isset($data['sha256']) && is_string($data['sha256']) ? trim($data['sha256']) : '';
        $sha256     = preg_match('/^[0-9a-fA-F]{64}$/', $sha256_raw) ? strtolower($sha256_raw) : '';

        return [
            'version'      => $version,
            'download_url' => $download,
            'requires'     => $str($data['requires']     ?? ''),
            'tested'       => $str($data['tested']        ?? ''),
            'requires_php' => $str($data['requires_php']  ?? ''),
            'last_updated' => $str($data['last_updated']  ?? ''),
            'homepage'     => $str($data['homepage']      ?? ''),
            'changelog'    => $changelog,
            'sha256'       => $sha256,
        ];
    }

    /** Fetch + cache metadata. Returns sanitized array or null on any failure. */
    public static function fetch_meta(bool $force = false): ?array {
        if (!$force) {
            $cached = get_transient(self::CACHE_KEY);
            if (is_array($cached)) {
                return $cached;
            }
        }
        $resp = wp_remote_get(self::META_URL, [
            'timeout' => 5,
            'headers' => ['Accept' => 'application/json'],
        ]);
        if (is_wp_error($resp) || (int) wp_remote_retrieve_response_code($resp) !== 200) {
            return null;
        }
        $meta = self::sanitize_meta(json_decode(wp_remote_retrieve_body($resp), true));
        if ($meta !== null) {
            set_transient(self::CACHE_KEY, $meta, self::CACHE_TTL);
        }
        return $meta;
    }

    /**
     * Pure: build the WP update entry from sanitized $meta, or null when there is
     * no newer version. Shaped for BOTH update channels — the classic transient
     * (reads new_version + package) and the modern update_plugins_{$hostname}
     * filter (WP core reads version + id). Unit-testable — no WP I/O.
     *
     * @return array<string,mixed>|null
     */
    public static function build_update(?array $meta, string $current, string $basename, string $update_uri): ?array {
        if ($meta === null || !self::is_newer($meta['version'], $current)) {
            return null;
        }
        return [
            'id'           => $update_uri,
            'slug'         => self::SLUG,
            'plugin'       => $basename,
            'new_version'  => $meta['version'],
            'version'      => $meta['version'],
            'url'          => $meta['homepage'] !== '' ? $meta['homepage'] : 'https://verivyx.com',
            'package'      => $meta['download_url'],
            'tested'       => $meta['tested'],
            'requires'     => $meta['requires'],
            'requires_php' => $meta['requires_php'],
            'sha256'       => $meta['sha256'] ?? '',
        ];
    }

    /** Classic path: inject an update entry when a newer, validated version exists. */
    public static function inject_update($transient) {
        if (!is_object($transient)) {
            return $transient;
        }
        $update = self::build_update(self::fetch_meta(), VERIVYX_VERSION, VERIVYX_PLUGIN_BASENAME, self::META_URL);
        if ($update === null) {
            return $transient;
        }
        if (!isset($transient->response) || !is_array($transient->response)) {
            $transient->response = [];
        }
        $transient->response[VERIVYX_PLUGIN_BASENAME] = (object) $update;
        return $transient;
    }

    /**
     * Modern path (WP 5.8+): callback for update_plugins_{$hostname}, reached via the
     * plugin's Update URI header. Returns the update entry when a newer version
     * exists, otherwise the unchanged $update (false) so WP records "no update".
     */
    public static function check_update_uri($update, $plugin_data, $plugin_file, $locales) {
        $built = self::build_update(self::fetch_meta(), VERIVYX_VERSION, (string) $plugin_file, self::META_URL);
        return $built !== null ? $built : $update;
    }

    /** Provide the "View details" modal data. */
    public static function plugin_info($result, $action, $args) {
        if ($action !== 'plugin_information' || !isset($args->slug) || $args->slug !== self::SLUG) {
            return $result;
        }
        $meta = self::fetch_meta();
        if ($meta === null) {
            return $result;
        }
        return (object) [
            'name'          => 'Verivyx Paywall',
            'slug'          => self::SLUG,
            'version'       => $meta['version'],
            'requires'      => $meta['requires'],
            'tested'        => $meta['tested'],
            'requires_php'  => $meta['requires_php'],
            'last_updated'  => $meta['last_updated'],
            'homepage'      => $meta['homepage'] !== '' ? $meta['homepage'] : 'https://verivyx.com',
            'download_link' => $meta['download_url'],
            'sections'      => [
                'changelog' => wp_kses_post($meta['changelog']),
            ],
        ];
    }

    public static function flush_cache(): void {
        delete_transient(self::CACHE_KEY);
    }

    /**
     * Verify a local file's SHA-256 hash against the expected hex string.
     * Pure (no WP I/O) — unit-testable.
     *
     * @param string $file_path   Absolute path to the file to hash.
     * @param string $expected_hex Expected SHA-256 in hex (case-insensitive, must be 64 chars).
     * @return bool true on match, false on mismatch, missing file, or malformed hex.
     */
    public static function verify_sha256(string $file_path, string $expected_hex): bool {
        if (!preg_match('/^[0-9a-fA-F]{64}$/', $expected_hex)) {
            return false;
        }
        if (!is_file($file_path) || !is_readable($file_path)) {
            return false;
        }
        $actual = hash_file('sha256', $file_path);
        if ($actual === false) {
            return false;
        }
        return hash_equals(strtolower($expected_hex), $actual);
    }

    /**
     * Hook: upgrader_pre_download.
     *
     * Fires before WordPress downloads an upgrade package. We intercept ONLY our own
     * plugin's package (identified by the download URL being on ALLOWED_HOST with our
     * zip filename). For other plugins $reply is returned unchanged (false = proceed).
     *
     * When the update metadata includes a sha256 field:
     *   - We download the zip ourselves into a temp file.
     *   - Verify the hash. On mismatch → WP_Error (install aborted).
     *   - On match → return the local temp path so WP installs from it.
     *
     * When no sha256 is present (older metadata) → allow but log a warning.
     *
     * @param false|string|WP_Error $reply    Current reply (false = "not handled yet").
     * @param string                $package  Package URL or local path.
     * @param WP_Upgrader           $upgrader The upgrader instance.
     * @param array                 $hook_extra Contextual data (plugin slug, etc.).
     * @return false|string|WP_Error
     */
    public static function verify_package_download($reply, $package, $upgrader, $hook_extra) {
        // Only intercept if this is already being handled elsewhere.
        if ($reply !== false) {
            return $reply;
        }

        // Gate to our plugin's package URL only.
        if (!is_string($package)) {
            return $reply;
        }
        $parts = parse_url($package);
        if (!is_array($parts) || (strtolower($parts['host'] ?? '')) !== self::ALLOWED_HOST) {
            return $reply; // not our package — leave untouched
        }
        // Confirm it is the plugin basename being upgraded (not a theme or core update
        // that somehow ends up on the same host).
        $plugin_file = $hook_extra['plugin'] ?? '';
        if ($plugin_file !== '' && strpos((string) $plugin_file, self::SLUG) === false) {
            return $reply;
        }

        // Look up the sha256 from the cached metadata (avoid a second HTTP round-trip).
        $meta   = self::fetch_meta();
        $sha256 = ($meta !== null && isset($meta['sha256']) && $meta['sha256'] !== '') ? $meta['sha256'] : '';

        if ($sha256 === '') {
            // Backward-compatible: no hash in the update JSON → allow install but warn.
            // error_log() is the standard WP way to leave a trace without a UI dependency.
            error_log('[Verivyx Updater] No sha256 in update metadata — skipping integrity check (backward-compatible).');
            return $reply; // let WP download normally
        }

        // Download the package ourselves.
        $tmp = download_url($package, 300);
        if (is_wp_error($tmp)) {
            return $tmp; // propagate download error as-is
        }

        // Verify integrity.
        if (!self::verify_sha256($tmp, $sha256)) {
            @unlink($tmp);
            return new WP_Error(
                'verivyx_hash_mismatch',
                'Verivyx Paywall update aborted: package SHA-256 does not match the expected value. ' .
                'The download may have been tampered with. Please try again or contact support.'
            );
        }

        // Hash verified — return the local path for WP to install from.
        return $tmp;
    }
}
