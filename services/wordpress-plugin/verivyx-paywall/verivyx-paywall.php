<?php
/**
 * Plugin Name: Verivyx Paywall
 * Plugin URI:  https://verivyx.com
 * Description: X402 paywall — humans read free, AI agents pay USDC via Stellar.
 * Version:     1.1.0
 * Author:      Verivyx
 * License:     MIT
 * Text Domain: verivyx-paywall
 */

defined('ABSPATH') || exit;

define('VERIVYX_VERSION', '1.1.0');
define('VERIVYX_PLUGIN_DIR', plugin_dir_path(__FILE__));
define('VERIVYX_PLUGIN_FILE', __FILE__);
define('VERIVYX_PLUGIN_BASENAME', plugin_basename(__FILE__));

require_once VERIVYX_PLUGIN_DIR . 'includes/class-settings.php';
require_once VERIVYX_PLUGIN_DIR . 'includes/class-api.php';
require_once VERIVYX_PLUGIN_DIR . 'includes/class-detect.php';
require_once VERIVYX_PLUGIN_DIR . 'includes/class-updater.php';
require_once VERIVYX_PLUGIN_DIR . 'includes/class-gate.php';

// Boot on init — before template_redirect fires
add_action('init', ['Verivyx_Gate', 'boot'], 1);
add_action('init', ['Verivyx_Updater', 'boot'], 1);

register_activation_hook(__FILE__,   ['Verivyx_Settings', 'activate']);
register_deactivation_hook(__FILE__, ['Verivyx_Settings', 'deactivate']);
