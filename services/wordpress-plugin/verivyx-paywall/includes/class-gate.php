<?php
defined('ABSPATH') || exit;

class Verivyx_Gate {

    /** True once intercept() has confirmed a valid payment / human session (hydrate 200). */
    public static $verified = false;

    /** True only while rendering the body for the internal REST endpoint. */
    public static $internal_render = false;

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

        if (!Verivyx_Content_Gate::is_protected_post($post)) return;

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
            self::$verified = true;
            // Forward the x402 settlement receipt if hydration returned one.
            $payment_response = wp_remote_retrieve_header($resp, 'payment-response');
            if ($payment_response) {
                header('Payment-Response: ' . $payment_response);
                header('X-Payment-Response: ' . $payment_response);
            }

            // For a paid AGENT request (one that carried an x402 payment) the client
            // must receive BOTH the settlement receipt header and the content in this
            // same response. Letting WordPress render the full themed page can drop the
            // custom Payment-Response header (theme output, full-page caches), which is
            // exactly what makes an x402 client think the payment never happened. So we
            // serve hydration's content directly and exit — mirroring the reliable
            // send_402() path where headers always survive. Human/cookie sessions fall
            // through to a normal themed render below.
            if ($x_payment) {
                $body = json_decode(wp_remote_retrieve_body($resp), true);
                $html = (is_array($body) && isset($body['html'])) ? (string) $body['html'] : '';
                if ($html !== '') {
                    status_header(200);
                    header('Content-Type: text/html; charset=UTF-8');
                    header('Access-Control-Allow-Origin: *');
                    header('Access-Control-Expose-Headers: PAYMENT-REQUIRED, Payment-Response, X-Payment-Response');
                    echo $html;
                    exit;
                }
            }
            // Human session valid — let WordPress serve the themed content normally.
            return;
        }

        // 402 — agent has not paid yet. Return requirements so the agent can pay.
        self::send_402($domain, $slug, $resp);
    }

    /**
     * Emit a 402 response with the x402-standard PAYMENT-REQUIRED header + the
     * PaymentRequired JSON body. The hydration 402 body already contains the full
     * PaymentRequired payload, so we forward it directly when available.
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
        foreach (self::response_headers_402($encoded) as $name => $value) {
            header($name . ': ' . $value);
        }

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
     * Pure: response headers for a 402, given the base64-encoded PaymentRequired.
     *
     * Emits only the x402-standard PAYMENT-REQUIRED header — official @x402 v2
     * clients read it via getHeader("PAYMENT-REQUIRED"), and the same payload is
     * also returned in the JSON body for x402 v1 / body-reading clients. The legacy
     * X-Payment-Required duplicate is intentionally dropped: a multi-asset
     * PAYMENT-REQUIRED header is ~2 KB, and emitting it twice (~4.2 KB) overran the
     * default nginx->php-fpm fastcgi_buffer_size (4 KB), making the 402 path 502.
     *
     * @return array<string,string> header name => value
     */
    public static function response_headers_402(?string $encoded): array {
        $headers = [
            'Content-Type'                  => 'application/json',
            'Cache-Control'                 => 'no-store',
            // CORS so AI agents calling from non-browser contexts can read these.
            'Access-Control-Allow-Origin'   => '*',
            'Access-Control-Expose-Headers' => 'PAYMENT-REQUIRED, Payment-Response, X-Payment-Response',
        ];
        if ($encoded) {
            $headers['PAYMENT-REQUIRED'] = $encoded;
        }
        return $headers;
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
