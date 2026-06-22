<?php defined('ABSPATH') || exit; ?>
<div class="wrap">
    <h1>Verivyx Paywall Settings</h1>
    <p>Humans read free. AI agents pay USDC via <a href="https://verivyx.com" target="_blank">Verivyx</a>.</p>

    <?php $vx_connected = Verivyx_Connect::is_connected(); ?>
    <h2>Connection</h2>
    <p>Status:
        <?php if ($vx_connected): ?>
            <strong style="color:#1a7f37;">&#9679; Connected to Verivyx</strong>
        <?php else: ?>
            <strong style="color:#b32d2e;">&#9679; Not connected</strong>
        <?php endif; ?>
    </p>
    <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
        <?php wp_nonce_field('verivyx_connect_start'); ?>
        <input type="hidden" name="action" value="verivyx_connect_start">
        <p>
            <input type="submit" class="button button-primary" value="<?php echo $vx_connected ? 'Reconnect' : 'Connect to Verivyx'; ?>">
            <span class="description">One click &mdash; your site is verified automatically (no DNS, files, or tokens to copy).</span>
        </p>
    </form>
    <hr>

    <form method="post">
        <?php wp_nonce_field('verivyx_save_settings'); ?>

        <table class="form-table" role="presentation">
            <tr>
                <th scope="row"><label for="verivyx_enabled">Paywall Enabled</label></th>
                <td>
                    <input type="checkbox" id="verivyx_enabled" name="verivyx_enabled" value="1"
                        <?php checked('1', Verivyx_Settings::is_enabled() ? '1' : '0'); ?>>
                    <p class="description">Uncheck to disable gating globally (content serves to everyone).</p>
                </td>
            </tr>
            <tr>
                <th scope="row"><label for="verivyx_api_url">Verivyx API URL</label></th>
                <td>
                    <input type="url" id="verivyx_api_url" name="verivyx_api_url" class="regular-text"
                        value="<?php echo esc_attr(Verivyx_Settings::get_api_url()); ?>">
                    <p class="description">Default: <code>https://api.verivyx.com</code></p>
                </td>
            </tr>
            <tr>
                <th scope="row"><label for="verivyx_domain">Domain</label></th>
                <td>
                    <input type="text" id="verivyx_domain" name="verivyx_domain" class="regular-text"
                        value="<?php echo esc_attr(Verivyx_Settings::get_domain()); ?>">
                    <p class="description">Must match the domain registered in your Verivyx dashboard.</p>
                </td>
            </tr>
            <tr>
                <th scope="row"><label for="verivyx_scope">Protect</label></th>
                <td>
                    <select id="verivyx_scope" name="verivyx_scope">
                        <?php
                        $scope = Verivyx_Settings::get_scope();
                        $options = [
                            'posts'       => 'Posts only',
                            'pages'       => 'Pages only',
                            'posts_pages' => 'Posts + Pages',
                            'all'         => 'All singular content',
                            'custom'      => 'Custom post types (specify below)',
                        ];
                        foreach ($options as $val => $label) {
                            printf(
                                '<option value="%s"%s>%s</option>',
                                esc_attr($val),
                                selected($scope, $val, false),
                                esc_html($label)
                            );
                        }
                        ?>
                    </select>
                </td>
            </tr>
            <tr>
                <th scope="row"><label for="verivyx_post_types">Custom Post Types</label></th>
                <td>
                    <input type="text" id="verivyx_post_types" name="verivyx_post_types" class="regular-text"
                        value="<?php echo esc_attr(implode(', ', Verivyx_Settings::get_custom_post_types())); ?>">
                    <p class="description">Comma-separated post type slugs (only used when scope is "Custom").</p>
                </td>
            </tr>
            <tr>
                <th scope="row"><label for="verivyx_public_pages">Always-public pages</label></th>
                <td>
                    <input type="text" id="verivyx_public_pages" name="verivyx_public_pages" class="regular-text"
                        value="<?php echo esc_attr(implode(', ', Verivyx_Settings::get_public_pages())); ?>">
                    <p class="description">Comma-separated page slugs that are never gated (e.g. <code>about, pricing, contact</code>). The homepage and blog index are always public automatically.</p>
                </td>
            </tr>
            <tr>
                <th scope="row"><label for="verivyx_internal_token">Internal content token</label></th>
                <td>
                    <?php
                    $token_locked = defined('VERIVYX_INTERNAL_TOKEN');
                    $token_set    = Verivyx_Settings::get_internal_token() !== '';
                    ?>
                    <input type="password" id="verivyx_internal_token" name="verivyx_internal_token" class="regular-text"
                        value=""
                        placeholder="<?php echo $token_set ? esc_attr('••••••••(saved)') : ''; ?>"
                        autocomplete="new-password" <?php echo $token_locked ? 'disabled' : ''; ?>>
                    <p class="description">
                        Shared secret that lets the Verivyx hydration service fetch the full article body for
                        verified readers (full-withholding mode). Must exactly match <code>WP_INTERNAL_TOKEN</code>
                        on the hydration service. Leave blank to keep withholding disabled (the body endpoint stays closed).
                        <?php if ($token_locked): ?>
                            <br><strong>Managed by the <code>VERIVYX_INTERNAL_TOKEN</code> constant in wp-config.php (field disabled).</strong>
                        <?php endif; ?>
                    </p>
                </td>
            </tr>
        </table>

        <p class="submit">
            <input type="submit" name="verivyx_save" class="button-primary" value="Save Settings">
        </p>
    </form>

    <hr>
    <h2>Updates</h2>
    <p>Installed version: <code><?php echo esc_html(VERIVYX_VERSION); ?></code></p>
    <form method="post">
        <?php wp_nonce_field('verivyx_check_updates'); ?>
        <p>
            <input type="submit" name="verivyx_check_updates" class="button" value="Check for updates now">
            <span class="description">Bypasses the 12-hour cache and re-checks verivyx.com immediately.</span>
        </p>
    </form>

    <hr>
    <h2>Embed Script (optional, for browser users)</h2>
    <p>Add this to your theme's <code>&lt;head&gt;</code> for seamless human access with PoW verification:</p>
    <textarea class="large-text code" rows="4" readonly><?php
        printf(
            '<script src="%s/gate.min.js" data-domain="%s" data-api="%s" async></script>',
            esc_attr(Verivyx_Settings::get_api_url()),
            esc_attr(Verivyx_Settings::get_domain()),
            esc_attr(Verivyx_Settings::get_api_url())
        );
    ?></textarea>
</div>
