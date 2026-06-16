<?php
defined('ABSPATH') || exit;

class Verivyx_Content_Gate {

    /**
     * Pure decision: should this article be gated (teaser-only on public surfaces)?
     * No WordPress calls — unit-testable standalone.
     *
     * Exclusions (never gated): front page, blog index, allowlisted public pages.
     * Otherwise mirrors the scope rules used by Verivyx_Gate.
     */
    public static function should_gate_article(
        string $post_type,
        int $post_id,
        int $front_id,
        int $posts_page_id,
        string $scope,
        array $custom_types,
        array $public_page_ids
    ): bool {
        if ($post_id > 0) {
            if ($post_id === $front_id || $post_id === $posts_page_id) {
                return false;
            }
            if (in_array($post_id, $public_page_ids, true)) {
                return false;
            }
        }

        switch ($scope) {
            case 'all':
                return true;
            case 'posts':
                return $post_type === 'post';
            case 'pages':
                return $post_type === 'page';
            case 'posts_pages':
                return in_array($post_type, ['post', 'page'], true);
            case 'custom':
                return in_array($post_type, $custom_types, true);
            default:
                return false;
        }
    }

    /**
     * Pure: should the singular article body be withheld from the HTML source?
     * Withhold only when the request is for a gated singular article AND the caller
     * is NOT verified (no payment, no human session) AND this is NOT the internal
     * body render (which must emit the real body for the hydration-service).
     */
    public static function should_withhold_body(bool $is_gated_singular, bool $is_verified, bool $is_internal_render): bool {
        if ($is_internal_render) {
            return false;
        }
        return $is_gated_singular && !$is_verified;
    }

    /**
     * Pure teaser builder: excerpt paragraph (escaped) + "Read more" permalink.
     * Never receives or emits the full article body.
     */
    public static function build_teaser(string $excerpt, string $permalink): string {
        $excerpt = trim($excerpt);
        $out = '';
        if ($excerpt !== '') {
            $out .= '<p>' . esc_html($excerpt) . '</p>';
        }
        $out .= '<p class="verivyx-read-more"><a href="' . esc_url($permalink) . '">Read more →</a></p>';
        return $out;
    }

    /**
     * Phase 2 stub for a withheld singular article: the teaser followed by an empty
     * paywalled container. The embed injects the real body into #vx-article after
     * PoW/payment. The container class (vx-paywalled) matches the JSON-LD cssSelector.
     */
    public static function build_stub(string $teaser_html): string {
        return $teaser_html
            . '<div id="vx-article" class="vx-paywalled" data-vx-gated="1"></div>';
    }

    /**
     * Google paywalled-content structured data (anti-cloaking signal). Declares the
     * page carries a paywalled part identified by the .vx-paywalled cssSelector, so
     * serving the snippet to every client (including Googlebot) is not cloaking.
     * Ref: https://developers.google.com/search/docs/appearance/structured-data/paywalled-content
     */
    public static function build_paywall_jsonld(string $title, string $description, string $url): string {
        return wp_json_encode([
            '@context'            => 'https://schema.org',
            '@type'               => 'NewsArticle',
            'headline'            => $title,
            'description'         => $description,
            'url'                 => $url,
            'isAccessibleForFree' => false,
            'hasPart'             => [
                '@type'               => 'WebPageElement',
                'isAccessibleForFree' => false,
                'cssSelector'         => '.vx-paywalled',
            ],
        ]);
    }

    /** Reentrancy guard: get_the_excerpt() may re-fire the_content internally. */
    private static $building = false;

    /**
     * WP wrapper around should_gate_article(): gathers front-page / blog-index /
     * scope / custom-types / allowlisted-page IDs and delegates to the pure decision.
     */
    public static function is_protected_post(WP_Post $post): bool {
        $front_id      = (int) get_option('page_on_front');
        $posts_page_id = (int) get_option('page_for_posts');

        $public_page_ids = [];
        foreach (Verivyx_Settings::get_public_pages() as $slug) {
            $page = get_page_by_path($slug);
            if ($page instanceof WP_Post) {
                $public_page_ids[] = (int) $page->ID;
            }
        }

        return self::should_gate_article(
            (string) $post->post_type,
            (int) $post->ID,
            $front_id,
            $posts_page_id,
            Verivyx_Settings::get_scope(),
            Verivyx_Settings::get_custom_post_types(),
            $public_page_ids
        );
    }

    /** Build the teaser for a post via WP (excerpt + permalink). */
    public static function excerpt_for(WP_Post $post): string {
        $excerpt   = (string) get_the_excerpt($post);
        $permalink = (string) get_permalink($post);
        return self::build_teaser($excerpt, $permalink);
    }

    /**
     * the_content on listings/archives/home: gated articles become teasers.
     * The singular article view is left untouched (Verivyx_Gate owns it; the
     * embed/human reveal flow must keep working).
     */
    public static function filter_the_content($content) {
        if (self::$building) return $content;
        if (is_admin() || is_feed()) return $content;

        // SINGULAR (Phase 2 withholding): replace the body with teaser + empty
        // paywalled container, unless the caller is verified or this is the internal
        // body render. The embed injects the real body after PoW/payment.
        if (is_singular()) {
            if (Verivyx_Gate::$internal_render) return $content; // internal endpoint → real body
            $post = get_post();
            if (!($post instanceof WP_Post) || !self::is_protected_post($post)) return $content;
            if (Verivyx_Gate::$verified) return $content; // intercept confirmed payment/session → real body in source
            self::$building = true;
            $stub = self::build_stub(self::excerpt_for($post));
            self::$building = false;
            return $stub;
        }

        // LISTINGS / ARCHIVE / HOME (Phase 1 teaser): unchanged.
        if (!in_the_loop() || !is_main_query()) return $content;
        $post = get_post();
        if (!($post instanceof WP_Post) || !self::is_protected_post($post)) return $content;
        self::$building = true;
        $teaser = self::excerpt_for($post);
        self::$building = false;
        return $teaser;
    }

    /** the_content_feed + the_excerpt_rss: gated articles become teasers. */
    public static function filter_feed_content($content) {
        if (self::$building) return $content;

        $post = get_post();
        if (!($post instanceof WP_Post) || !self::is_protected_post($post)) return $content;

        self::$building = true;
        $teaser = self::excerpt_for($post);
        self::$building = false;
        return $teaser;
    }

    /**
     * REST: trim content.rendered/raw to the teaser for anonymous/public callers.
     * Editors (edit_post) keep full content so editing is unaffected.
     */
    public static function filter_rest($response, $post, $request) {
        if (!($response instanceof WP_REST_Response) || !($post instanceof WP_Post)) {
            return $response;
        }
        if (!self::is_protected_post($post)) return $response;
        if (current_user_can('edit_post', $post->ID)) return $response;

        $data = $response->get_data();
        if (isset($data['content']) && is_array($data['content'])) {
            $teaser = self::excerpt_for($post);
            if (array_key_exists('rendered', $data['content'])) {
                $data['content']['rendered'] = $teaser;
            }
            if (array_key_exists('raw', $data['content'])) {
                $data['content']['raw'] = '';
            }
            $data['content']['protected'] = true;
            $response->set_data($data);
        }
        return $response;
    }

    /** oEmbed: drop the rich html body for gated articles (keep discovery metadata). */
    public static function filter_oembed($data, $post) {
        if (!($post instanceof WP_Post) || !self::is_protected_post($post)) return $data;
        if (is_array($data)) {
            unset($data['html']);
        }
        return $data;
    }

    public static function boot(): void {
        if (!Verivyx_Settings::is_enabled()) return;

        add_filter('the_content',      [__CLASS__, 'filter_the_content'], 9);
        add_filter('the_content_feed', [__CLASS__, 'filter_feed_content'], 9);
        add_filter('the_excerpt_rss',  [__CLASS__, 'filter_feed_content'], 9);
        add_filter('oembed_response_data', [__CLASS__, 'filter_oembed'], 10, 2);

        // REST: attach to post, page, and any configured custom types.
        $rest_types = array_unique(array_merge(['post', 'page'], Verivyx_Settings::get_custom_post_types()));
        foreach ($rest_types as $type) {
            add_filter("rest_prepare_{$type}", [__CLASS__, 'filter_rest'], 10, 3);
        }
    }
}
