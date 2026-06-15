<?php
defined('ABSPATH') || exit;

class Verivyx_Gate {

    public static function boot(): void {
        if (!Verivyx_Settings::is_enabled()) return;
        // Priority 1 — fires before any theme/plugin template output
        add_action('template_redirect', [__CLASS__, 'intercept'], 1);
    }

    public static function intercept(): void {
        // Only gate singular content (posts, pages, custom post types)
        if (!is_singular()) return;

        $post = get_queried_object();
        if (!($post instanceof WP_Post)) return;

        if (!self::is_protected($post)) return;

        $domain     = Verivyx_Settings::get_domain();
        $slug       = $post->post_name;
        // Accept both PAYMENT-SIGNATURE (x402 v2 spec) and X-PAYMENT (legacy)
        $x_payment  = self::get_header('HTTP_PAYMENT_SIGNATURE') ?? self::get_header('HTTP_X_PAYMENT');
        $bearer     = self::get_header('HTTP_AUTHORIZATION');

        // Cookie fallback: embed script may set vx_session cookie after PoW so
        // the plugin can verify returning human sessions server-side.
        if (!$bearer) {
            $cookie_token = isset($_COOKIE['vx_session'])
                ? sanitize_text_field(wp_unslash($_COOKIE['vx_session']))
                : '';
            if ($cookie_token !== '') {
                $bearer = 'Bearer ' . $cookie_token;
            }
        }

        // Browser first-load pass-through: Sec-Fetch-Mode: navigate is sent by all
        // modern browsers for page navigation but is absent from curl/wget/HTTP
        // clients and AI agents making raw HTTP requests.
        // Let the browser load the page so the embed script can run PoW and issue
        // a human session. The embed script handles detection + overlay for bots.
        if (!$x_payment && !$bearer) {
            $ua = self::get_header('HTTP_USER_AGENT') ?? '';
            // Browsers cannot forge Sec-Fetch-Mode from JS, but raw HTTP clients
            // can. Only let genuine navigation pass through; identifiable agents
            // must still pay regardless of the header.
            if (self::get_header('HTTP_SEC_FETCH_MODE') === 'navigate'
                && !Verivyx_Detect::is_known_agent($ua)) {
                return;
            }
        }

        // Forward request to Verivyx hydration service
        $resp = Verivyx_Api::hydrate($domain, $slug, $x_payment, $bearer);

        if (is_wp_error($resp)) {
            // Cannot reach Verivyx — fail open (serve content) to avoid breaking the site
            return;
        }

        $status = (int) wp_remote_retrieve_response_code($resp);

        // Domain not registered on Verivyx — fail open so the site works normally.
        if ($status === 404) {
            return;
        }

        if ($status === 200) {
            // Payment verified or human session valid — forward PAYMENT-RESPONSE header if present
            $payment_response = wp_remote_retrieve_header($resp, 'payment-response');
            if ($payment_response) {
                header('Payment-Response: ' . $payment_response);
                header('X-Payment-Response: ' . $payment_response);
            }
            // Let WordPress serve the content normally
            return;
        }

        // 402 — agent has not paid yet. Return requirements so the agent can pay.
        self::send_402($domain, $slug, $resp);
    }

    /**
     * Determine if this post should be gated.
     */
    private static function is_protected(WP_Post $post): bool {
        $scope = Verivyx_Settings::get_scope();

        switch ($scope) {
            case 'all':
                return true;
            case 'posts':
                return $post->post_type === 'post';
            case 'pages':
                return $post->post_type === 'page';
            case 'posts_pages':
                return in_array($post->post_type, ['post', 'page'], true);
            case 'custom':
                $types = Verivyx_Settings::get_custom_post_types();
                return in_array($post->post_type, $types, true);
            default:
                return false;
        }
    }

    /**
     * Emit a 402 response with X-Payment-Required header + PaymentRequired JSON body.
     * The hydration 402 body already contains the full PaymentRequired payload,
     * so we forward it directly when available.
     */
    private static function send_402(string $domain, string $slug, $hydration_resp): void {
        // Try to use the body from hydration's 402 (already has requirements inline)
        $body_raw = wp_remote_retrieve_body($hydration_resp);
        $body     = json_decode($body_raw, true);

        $encoded = null;

        if (is_array($body) && isset($body['accepts'])) {
            // hydration returned full PaymentRequired — encode it for the header
            $encoded = base64_encode($body_raw);
        } else {
            // Fallback: fetch requirements directly from gateway
            $req = Verivyx_Api::fetch_requirements($domain, $slug);
            if ($req) {
                $body    = $req['body'];
                $encoded = $req['encoded'];
            }
        }

        // Use WordPress's status_header() — http_response_code() does not reliably
        // override the 200 already set by WP::send_headers() before template_redirect.
        status_header(402);
        header('Content-Type: application/json');
        header('Cache-Control: no-store');

        // Standard X402 header (both names for compatibility)
        if ($encoded) {
            header('X-Payment-Required: ' . $encoded);
            header('Payment-Required: ' . $encoded);
        }

        // CORS headers so AI agents calling from non-browser contexts can read these
        header('Access-Control-Allow-Origin: *');
        header('Access-Control-Expose-Headers: X-Payment-Required, Payment-Required, X-Payment-Response, Payment-Response');

        if (is_array($body)) {
            echo wp_json_encode($body);
        } else {
            echo wp_json_encode([
                'x402Version' => 2,
                'error'       => 'payment_required',
                'resource'    => ['url' => get_permalink(), 'mimeType' => 'text/html'],
            ]);
        }

        exit;
    }

    /**
     * Safe server variable accessor.
     */
    private static function get_header(string $server_key): ?string {
        if (!isset($_SERVER[$server_key])) {
            return null;
        }
        $val = sanitize_text_field(wp_unslash($_SERVER[$server_key]));
        return ($val !== '') ? $val : null;
    }
}
