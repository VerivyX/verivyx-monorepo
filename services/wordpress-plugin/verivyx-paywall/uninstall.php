<?php
/**
 * Plugin uninstall handler — runs when the plugin is deleted via Dashboard → Plugins → Delete.
 * Purges all plugin options and transients so no secrets persist after removal.
 */
defined('WP_UNINSTALL_PLUGIN') || exit;

// --- Options ---
delete_option('verivyx_api_url');
delete_option('verivyx_domain');
delete_option('verivyx_enabled');
delete_option('verivyx_scope');
delete_option('verivyx_post_types');
delete_option('verivyx_public_pages');
delete_option('verivyx_internal_token'); // live secret — must be purged

// --- Named transients ---
// Update cache (Verivyx_Updater::CACHE_KEY = 'verivyx_update_info').
delete_transient('verivyx_update_info');
delete_site_transient('verivyx_update_info');

// One-shot admin notice set by the Connect flow.
delete_transient('vx_connect_notice');

// Connect handshake transients use dynamic keys (vx_connect_<id>, vx_connect_state_<state>).
// They have a 10-minute TTL and expire naturally, but we sweep any that remain via a
// wildcard query so deletion is complete even if the site is deleted immediately after
// initiating a connect flow.
global $wpdb;
$like = $wpdb->esc_like('_transient_vx_connect_') . '%';
// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
$keys = $wpdb->get_col(
    $wpdb->prepare("SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s", $like)
);
foreach ($keys as $key) {
    // Strip the '_transient_' prefix to get the transient name for delete_transient().
    $transient_name = preg_replace('/^_transient_/', '', $key);
    delete_transient($transient_name);
}
