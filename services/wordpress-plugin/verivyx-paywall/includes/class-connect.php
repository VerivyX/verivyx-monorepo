<?php
defined('ABSPATH') || exit;

/**
 * Zero-config "Connect to Verivyx" handshake (plugin side).
 *
 * OAuth-authorization-code style:
 *   1. admin clicks Connect → POST {site} to auth-service /domains/connect/init
 *      → {connect_id, nonce}; store both (+ a CSRF state) in transients; redirect
 *      the browser to verivyx.com/connect?connect_id&state&redirect_uri.
 *   2. auth-service calls back GET /wp-json/verivyx/v1/confirm?connect_id → we return
 *      the stored nonce (proves this WP initiated the handshake + controls the domain).
 *   3. browser returns with ?code&state → we POST {connect_id, code} to
 *      /domains/connect/token → {token}; store as the internal token. The secret token
 *      only ever arrives over this server-to-server exchange — never via the browser.
 */
class Verivyx_Connect {

    const TTL = 600; // 10 minutes

    public static function boot(): void {
        add_action('rest_api_init', [__CLASS__, 'register_confirm']);
        add_action('admin_post_verivyx_connect_start', [__CLASS__, 'handle_start']);
        add_action('admin_init', [__CLASS__, 'maybe_handle_return']);
    }

    /** Dashboard base (verivyx.com) derived from the API base (api.verivyx.com). */
    public static function dashboard_base(string $api_url): string {
        $base = preg_replace('#//api\.#', '//', rtrim($api_url, '/'));
        return is_string($base) && $base !== '' ? $base : 'https://verivyx.com';
    }

    public static function is_connected(): bool {
        return Verivyx_Settings::get_internal_token() !== '';
    }

    // --- Step 2: ownership confirm (called server-to-server by auth-service) ---
    public static function register_confirm(): void {
        register_rest_route('verivyx/v1', '/confirm', [
            'methods'             => 'GET',
            'callback'            => [__CLASS__, 'confirm'],
            'permission_callback' => '__return_true',
            'args'                => [
                'connect_id' => ['required' => true, 'sanitize_callback' => 'sanitize_text_field'],
            ],
        ]);
    }

    public static function confirm(WP_REST_Request $req) {
        $connect_id = (string) $req->get_param('connect_id');
        $pending = get_transient('vx_connect_' . $connect_id);
        if (!is_array($pending) || empty($pending['nonce'])) {
            return new WP_REST_Response(['error' => 'unknown'], 404);
        }
        // Return the one-time ownership nonce (NOT the secret token).
        return new WP_REST_Response(['nonce' => (string) $pending['nonce']], 200);
    }

    // --- Step 1: start (admin clicked Connect) ---
    public static function handle_start(): void {
        if (!current_user_can('manage_options') || !check_admin_referer('verivyx_connect_start')) {
            wp_die('Forbidden');
        }
        $site = (string) wp_parse_url(get_site_url(), PHP_URL_HOST);
        $api  = Verivyx_Settings::get_api_url();

        $resp = wp_remote_post($api . '/api/v1/domains/connect/init', [
            'timeout' => 10,
            'headers' => ['Content-Type' => 'application/json'],
            'body'    => wp_json_encode(['site' => $site]),
        ]);
        $rc   = is_wp_error($resp) ? 0 : (int) wp_remote_retrieve_response_code($resp);
        $body = $rc === 200 ? json_decode(wp_remote_retrieve_body($resp), true) : null;
        if (!is_array($body) || empty($body['connect_id']) || empty($body['nonce'])) {
            self::finish('error', 'init_failed');
        }

        $connect_id = (string) $body['connect_id'];
        $state      = wp_generate_password(24, false);
        set_transient('vx_connect_' . $connect_id, ['nonce' => (string) $body['nonce'], 'state' => $state], self::TTL);
        set_transient('vx_connect_state_' . $state, $connect_id, self::TTL);

        $return = admin_url('options-general.php?page=verivyx-paywall&vx_connect_return=1');
        $url = self::dashboard_base($api) . '/connect?' . http_build_query([
            'connect_id'   => $connect_id,
            'state'        => $state,
            'redirect_uri' => $return,
            'site'         => $site,
        ]);
        // External host (dashboard) → wp_redirect, not wp_safe_redirect.
        wp_redirect($url);
        exit;
    }

    // --- Step 3: return from dashboard with ?code&state ---
    public static function maybe_handle_return(): void {
        if (!is_admin() || empty($_GET['vx_connect_return']) || !current_user_can('manage_options')) {
            return;
        }
        $state = isset($_GET['state']) ? sanitize_text_field(wp_unslash($_GET['state'])) : '';
        $code  = isset($_GET['code']) ? sanitize_text_field(wp_unslash($_GET['code'])) : '';
        if ($state === '' || $code === '') {
            return;
        }
        $connect_id = get_transient('vx_connect_state_' . $state);
        $pending    = $connect_id ? get_transient('vx_connect_' . $connect_id) : false;
        if (!$connect_id || !is_array($pending) || ($pending['state'] ?? '') !== $state) {
            self::finish('error', 'state_mismatch');
        }

        $api  = Verivyx_Settings::get_api_url();
        $resp = wp_remote_post($api . '/api/v1/domains/connect/token', [
            'timeout' => 10,
            'headers' => ['Content-Type' => 'application/json'],
            'body'    => wp_json_encode(['connect_id' => $connect_id, 'code' => $code]),
        ]);
        $rc   = is_wp_error($resp) ? 0 : (int) wp_remote_retrieve_response_code($resp);
        $body = $rc === 200 ? json_decode(wp_remote_retrieve_body($resp), true) : null;

        delete_transient('vx_connect_' . $connect_id);
        delete_transient('vx_connect_state_' . $state);

        if (!is_array($body) || empty($body['token'])) {
            self::finish('error', 'token_failed');
        }
        update_option('verivyx_internal_token', (string) $body['token']);
        self::finish('success', 'connected');
    }

    /** Store a one-shot admin notice and redirect to the clean settings URL, then exit. */
    private static function finish(string $type, string $codeKey): void {
        set_transient('vx_connect_notice', ['type' => $type, 'code' => $codeKey], 60);
        wp_safe_redirect(admin_url('options-general.php?page=verivyx-paywall'));
        exit;
    }

    /** Human-readable notice for the settings page (consumed once). */
    public static function take_notice(): ?array {
        $n = get_transient('vx_connect_notice');
        if (!is_array($n)) {
            return null;
        }
        delete_transient('vx_connect_notice');
        $messages = [
            'connected'      => ['success', 'Connected to Verivyx. Full withholding is now active.'],
            'init_failed'    => ['error', 'Could not start the connection. Please try again.'],
            'state_mismatch' => ['error', 'Connection could not be verified (state mismatch). Please retry.'],
            'token_failed'   => ['error', 'Authorization did not complete. Please retry the connection.'],
        ];
        $key = (string) ($n['code'] ?? '');
        $m   = $messages[$key] ?? [(string) ($n['type'] ?? 'info'), 'Connection update.'];
        return ['class' => $m[0] === 'success' ? 'notice-success' : 'notice-error', 'text' => $m[1]];
    }
}
