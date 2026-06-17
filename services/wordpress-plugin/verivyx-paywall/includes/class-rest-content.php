<?php
defined('ABSPATH') || exit;

class Verivyx_Rest_Content {

    public static function boot(): void {
        add_action('rest_api_init', [__CLASS__, 'register']);
    }

    public static function register(): void {
        register_rest_route('verivyx/v1', '/content', [
            'methods'             => 'GET',
            'callback'            => [__CLASS__, 'handle'],
            'permission_callback' => [__CLASS__, 'authorized'],
            'args'                => [
                'slug' => ['required' => true, 'sanitize_callback' => 'sanitize_title'],
            ],
        ]);
    }

    /** Only the hydration-service (holding the shared internal token) may call this. */
    public static function authorized(WP_REST_Request $req): bool {
        $expected = Verivyx_Settings::get_internal_token();
        if ($expected === '') {
            return false; // not configured → closed
        }
        $given = (string) $req->get_header('x_verivyx_internal'); // WP maps X-Verivyx-Internal
        return hash_equals($expected, $given);
    }

    public static function handle(WP_REST_Request $req) {
        $slug = (string) $req->get_param('slug');
        $page = get_page_by_path($slug, OBJECT, ['post', 'page']);
        if (!($page instanceof WP_Post)) {
            // try by post_name across any public type
            $q = get_posts(['name' => $slug, 'post_type' => 'any', 'numberposts' => 1]);
            $page = $q ? $q[0] : null;
        }
        if (!($page instanceof WP_Post)) {
            return new WP_REST_Response(['error' => 'not_found'], 404);
        }
        // Render the REAL body: bypass the withholding filter.
        Verivyx_Gate::$internal_render = true;
        try {
            $html = apply_filters('the_content', $page->post_content);
        } finally {
            Verivyx_Gate::$internal_render = false;
        }
        return new WP_REST_Response(['html' => $html], 200);
    }
}
