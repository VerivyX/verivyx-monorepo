<?php
defined('ABSPATH') || exit;

class Verivyx_Settings {

    const OPTION_API_URL    = 'verivyx_api_url';
    const OPTION_DOMAIN     = 'verivyx_domain';
    const OPTION_ENABLED    = 'verivyx_enabled';
    const OPTION_SCOPE      = 'verivyx_scope';       // 'all' | 'posts' | 'pages' | 'custom'
    const OPTION_POST_TYPES = 'verivyx_post_types';  // comma-separated custom post types
    const OPTION_PUBLIC_PAGES = 'verivyx_public_pages'; // comma-separated page slugs never gated

    public static function activate(): void {
        add_option(self::OPTION_API_URL,    'https://api.verivyx.com');
        add_option(self::OPTION_DOMAIN,     self::detect_domain());
        add_option(self::OPTION_ENABLED,    '1');
        add_option(self::OPTION_SCOPE,      'posts');
        add_option(self::OPTION_POST_TYPES, '');
        add_option(self::OPTION_PUBLIC_PAGES, '');
    }

    public static function deactivate(): void {
        // Keep settings on deactivation — only remove on uninstall
    }

    public static function get_api_url(): string {
        return rtrim((string) get_option(self::OPTION_API_URL, 'https://api.verivyx.com'), '/');
    }

    public static function get_domain(): string {
        return (string) get_option(self::OPTION_DOMAIN, self::detect_domain());
    }

    public static function is_enabled(): bool {
        return (bool) get_option(self::OPTION_ENABLED, '1');
    }

    public static function get_scope(): string {
        return (string) get_option(self::OPTION_SCOPE, 'posts');
    }

    public static function get_custom_post_types(): array {
        $raw = (string) get_option(self::OPTION_POST_TYPES, '');
        if ($raw === '') return [];
        return array_filter(array_map('trim', explode(',', $raw)));
    }

    public static function get_public_pages(): array {
        $raw = (string) get_option(self::OPTION_PUBLIC_PAGES, '');
        if ($raw === '') return [];
        return array_filter(array_map('trim', explode(',', $raw)));
    }

    public static function get_internal_token(): string {
        // A wp-config constant (ops-managed secret) takes precedence over the option.
        if (defined('VERIVYX_INTERNAL_TOKEN') && is_string(VERIVYX_INTERNAL_TOKEN)) {
            return trim(VERIVYX_INTERNAL_TOKEN);
        }
        $v = get_option('verivyx_internal_token', '');
        return is_string($v) ? trim($v) : '';
    }

    private static function detect_domain(): string {
        $url = get_site_url();
        $host = wp_parse_url($url, PHP_URL_HOST);
        return $host ?: '';
    }

    public static function register_admin(): void {
        add_options_page(
            'Verivyx Paywall',
            'Verivyx',
            'manage_options',
            'verivyx-paywall',
            ['Verivyx_Settings', 'render_admin_page']
        );
    }

    public static function render_admin_page(): void {
        if (!current_user_can('manage_options')) return;

        $vx_connect_notice = Verivyx_Connect::take_notice();
        if ($vx_connect_notice) {
            echo '<div class="notice ' . esc_attr($vx_connect_notice['class']) . '"><p>'
                . esc_html($vx_connect_notice['text']) . '</p></div>';
        }

        if (isset($_POST['verivyx_save']) && check_admin_referer('verivyx_save_settings')) {
            update_option(self::OPTION_API_URL,    sanitize_url(wp_unslash($_POST['verivyx_api_url'] ?? '')));
            update_option(self::OPTION_DOMAIN,     sanitize_text_field(wp_unslash($_POST['verivyx_domain'] ?? '')));
            update_option(self::OPTION_ENABLED,    isset($_POST['verivyx_enabled']) ? '1' : '0');
            update_option(self::OPTION_SCOPE,      sanitize_text_field(wp_unslash($_POST['verivyx_scope'] ?? 'posts')));
            update_option(self::OPTION_POST_TYPES, sanitize_text_field(wp_unslash($_POST['verivyx_post_types'] ?? '')));
            update_option(self::OPTION_PUBLIC_PAGES, sanitize_text_field(wp_unslash($_POST['verivyx_public_pages'] ?? '')));
            // Only overwrite the stored token when a wp-config constant is NOT managing it.
            if (!defined('VERIVYX_INTERNAL_TOKEN')) {
                update_option('verivyx_internal_token', sanitize_text_field(wp_unslash($_POST['verivyx_internal_token'] ?? '')));
            }
            echo '<div class="notice notice-success"><p>Settings saved.</p></div>';
        }

        if (isset($_POST['verivyx_check_updates']) && check_admin_referer('verivyx_check_updates')) {
            $meta   = Verivyx_Updater::force_check();
            $remote = is_array($meta) ? (string) ($meta['version'] ?? '') : '';
            $class  = 'notice-success';
            if ($remote === '') {
                $class = 'notice-error';
            } elseif (Verivyx_Updater::is_newer($remote, VERIVYX_VERSION)) {
                $class = 'notice-warning';
            }
            echo '<div class="notice ' . esc_attr($class) . '"><p>'
                . esc_html(Verivyx_Updater::status_text($remote, VERIVYX_VERSION)) . '</p></div>';
        }

        require_once VERIVYX_PLUGIN_DIR . 'admin/settings-page.php';
    }
}

add_action('admin_menu', ['Verivyx_Settings', 'register_admin']);
