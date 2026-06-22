<?php
defined('ABSPATH') || exit;

class Verivyx_Api {

    /**
     * Call Verivyx hydration service.
     * Returns the WP_Remote response array or WP_Error.
     *
     * @param string      $domain
     * @param string      $slug
     * @param string|null $x_payment   Raw value of X-Payment header from the incoming request
     * @param string|null $bearer      Raw value of Authorization header from the incoming request
     * @return array|WP_Error
     */
    public static function hydrate(string $domain, string $slug, ?string $x_payment, ?string $bearer) {
        $api_url = Verivyx_Settings::get_api_url();
        $endpoint = $api_url . '/api/v1/content/hydrate';

        $headers = ['Content-Type' => 'application/json'];
        if ($x_payment) {
            $headers['PAYMENT-SIGNATURE'] = $x_payment; // x402 v2 spec header
            $headers['X-Payment']         = $x_payment; // backward compat
        }
        if ($bearer)     $headers['Authorization']    = $bearer;
        // New idempotency key per forward
        $headers['Idempotency-Key'] = wp_generate_uuid4();

        return wp_remote_post($endpoint, [
            'timeout' => self::hydrate_timeout($x_payment !== null && $x_payment !== ''),
            'headers' => $headers,
            'body'    => wp_json_encode(['domain' => $domain, 'slug' => $slug]),
        ]);
    }

    /**
     * HTTP timeout (seconds) for the hydrate call.
     *
     * No-payment requests (402 / passthrough / human session) resolve in
     * milliseconds, so the short timeout keeps page rendering snappy and fails
     * open quickly if hydration is unreachable.
     *
     * A paid agent request, however, triggers a SYNCHRONOUS on-chain Soroban
     * settlement (verify + distribute) that routinely takes 9-12s. Hydration's own
     * client gives the gateway 30s. WP must wait LONGER than that so hydration is
     * the component that decides success/failure. If WP times out first it fails
     * open to a themed page — dropping the x402 Payment-Response receipt header —
     * while the settle still completes on-chain, so the buyer is charged but the
     * agent is told the payment failed.
     *
     * @param bool $is_payment Whether this hydrate carries an x402 payment header.
     * @return int Timeout in seconds.
     */
    public static function hydrate_timeout(bool $is_payment): int {
        return $is_payment ? 35 : 5;
    }

    /**
     * Fetch PaymentRequired JSON and base64-encoded header from gateway.
     * Returns ['body' => array, 'encoded' => string] or null on failure.
     *
     * @param string $domain
     * @param string $slug
     * @return array{body:array,encoded:string}|null
     */
    public static function fetch_requirements(string $domain, string $slug): ?array {
        $api_url  = Verivyx_Settings::get_api_url();
        $endpoint = $api_url . '/api/v1/payment/requirements?' . http_build_query([
            'domain' => $domain,
            'slug'   => $slug,
        ]);

        $resp = wp_remote_get($endpoint, ['timeout' => 5]);
        if (is_wp_error($resp)) return null;

        $code = wp_remote_retrieve_response_code($resp);
        if ($code !== 402 && $code !== 200) return null;

        $body = json_decode(wp_remote_retrieve_body($resp), true);
        if (!is_array($body)) return null;

        // Prefer the X-Payment-Required header from gateway (already base64-encoded)
        $encoded = wp_remote_retrieve_header($resp, 'x-payment-required');
        if (!$encoded) {
            // Fallback: encode the body ourselves
            $encoded = base64_encode(wp_json_encode($body));
        }

        return ['body' => $body, 'encoded' => $encoded];
    }
}
