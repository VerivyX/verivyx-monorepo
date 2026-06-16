<?php
defined('ABSPATH') || exit;

class Verivyx_Updater {

    const SLUG         = 'verivyx-paywall';
    const META_URL     = 'https://verivyx.com/verivyx-paywall.json';
    const ALLOWED_HOST = 'verivyx.com';
    const CACHE_KEY    = 'verivyx_update_info';
    const CACHE_TTL    = 43200; // 12h, in seconds (literal so the class loads without WP)

    public static function boot(): void {
        add_filter('pre_set_site_transient_update_plugins', [__CLASS__, 'inject_update']);
        add_filter('plugins_api', [__CLASS__, 'plugin_info'], 20, 3);
        add_action('upgrader_process_complete', [__CLASS__, 'flush_cache']);
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

        return [
            'version'      => $version,
            'download_url' => $download,
            'requires'     => $str($data['requires']     ?? ''),
            'tested'       => $str($data['tested']        ?? ''),
            'requires_php' => $str($data['requires_php']  ?? ''),
            'last_updated' => $str($data['last_updated']  ?? ''),
            'homepage'     => $str($data['homepage']      ?? ''),
            'changelog'    => $changelog,
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

    /** Inject an update entry when a newer, validated version exists. */
    public static function inject_update($transient) {
        if (!is_object($transient)) {
            return $transient;
        }
        $meta = self::fetch_meta();
        if ($meta === null || !self::is_newer($meta['version'], VERIVYX_VERSION)) {
            return $transient;
        }
        if (!isset($transient->response) || !is_array($transient->response)) {
            $transient->response = [];
        }
        $transient->response[VERIVYX_PLUGIN_BASENAME] = (object) [
            'slug'         => self::SLUG,
            'plugin'       => VERIVYX_PLUGIN_BASENAME,
            'new_version'  => $meta['version'],
            'package'      => $meta['download_url'],
            'url'          => $meta['homepage'] !== '' ? $meta['homepage'] : 'https://verivyx.com',
            'tested'       => $meta['tested'],
            'requires'     => $meta['requires'],
            'requires_php' => $meta['requires_php'],
        ];
        return $transient;
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
}
