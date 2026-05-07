<?php
/**
 * Plugin Name: Portal Publisher
 * Description: Integração com o Sistema de Agregação — recebe artigos via endpoint REST e publica com chapéu editorial e crédito de fonte, sem depender do tema.
 * Version:     1.6.0
 * Author:      Sistema XIXO
 * Text Domain: portal-publisher
 */

if ( ! defined( 'ABSPATH' ) ) exit;

define( 'PORTAL_PUB_VERSION',    '1.6.0' );
define( 'PORTAL_PUB_OPTION_KEY', 'xixo_api_key' );

// ── Ativação: gera chave automática ──────────────────────────────────────────
register_activation_hook( __FILE__, function () {
    if ( ! get_option( PORTAL_PUB_OPTION_KEY ) ) {
        update_option( PORTAL_PUB_OPTION_KEY, bin2hex( random_bytes( 24 ) ) );
    }
} );

// ── Admin: menu de configurações ─────────────────────────────────────────────
add_action( 'admin_menu', function () {
    add_options_page(
        'Portal Publisher',
        'Portal Publisher',
        'manage_options',
        'portal-publisher',
        'portal_pub_settings_page'
    );
} );

function portal_pub_settings_page() {
    if ( ! current_user_can( 'manage_options' ) ) return;

    $msg = '';

    if ( isset( $_POST['portal_pub_action'] ) && check_admin_referer( 'portal_pub_save' ) ) {
        if ( $_POST['portal_pub_action'] === 'save' ) {
            $k = sanitize_text_field( $_POST['portal_pub_api_key'] ?? '' );
            if ( $k ) {
                update_option( PORTAL_PUB_OPTION_KEY, $k );
                $msg = '<div class="notice notice-success inline"><p>✔ Chave salva com sucesso.</p></div>';
            }
        } elseif ( $_POST['portal_pub_action'] === 'regenerate' ) {
            update_option( PORTAL_PUB_OPTION_KEY, bin2hex( random_bytes( 24 ) ) );
            $msg = '<div class="notice notice-success inline"><p>✔ Nova chave gerada.</p></div>';
        }
    }

    $key      = get_option( PORTAL_PUB_OPTION_KEY, '' );
    $endpoint = rest_url( 'xixo/v1/publish' );
    ?>
    <div class="wrap">
        <h1>⚙ Portal Publisher</h1>
        <p style="color:#555;">Integração com o Sistema de Agregação de Notícias. <strong>v<?php echo PORTAL_PUB_VERSION; ?></strong></p>
        <?php echo $msg; ?>

        <table class="form-table" role="presentation">
            <tr>
                <th scope="row">Versão</th>
                <td><code><?php echo PORTAL_PUB_VERSION; ?></code></td>
            </tr>
            <tr>
                <th scope="row">Endpoint de publicação</th>
                <td>
                    <code id="portal-pub-endpoint"><?php echo esc_html( $endpoint ); ?></code>
                    <button type="button" onclick="navigator.clipboard.writeText(document.getElementById('portal-pub-endpoint').innerText)" class="button button-small" style="margin-left:8px;">Copiar</button>
                </td>
            </tr>
            <tr>
                <th scope="row">Chave de API</th>
                <td>
                    <form method="post">
                        <?php wp_nonce_field( 'portal_pub_save' ); ?>
                        <input type="text" name="portal_pub_api_key" id="portal-pub-key" value="<?php echo esc_attr( $key ); ?>"
                               class="regular-text" style="font-family:monospace;" readonly />
                        <button type="button" onclick="navigator.clipboard.writeText(document.getElementById('portal-pub-key').value)" class="button button-small" style="margin-left:8px;">Copiar</button>
                        <br><br>
                        <button type="submit" name="portal_pub_action" value="regenerate" class="button button-secondary"
                                onclick="return confirm('Gerar nova chave vai invalidar a chave atual. Confirmar?')">
                            🔄 Gerar nova chave
                        </button>
                    </form>
                </td>
            </tr>
        </table>

        <hr>
        <h2>Como configurar</h2>
        <ol>
            <li>No Sistema de Agregação, vá em <strong>Configurações → Meus Sites</strong>.</li>
            <li>Edite este portal ou cadastre um novo.</li>
            <li>No campo <strong>"Chave XIXO Plugin"</strong>, cole a chave de API acima.</li>
            <li>Salve. A partir daí, as publicações usarão este plugin automaticamente.</li>
        </ol>
    </div>
    <?php
}

// ── REST API ──────────────────────────────────────────────────────────────────
add_action( 'rest_api_init', function () {

    // GET /wp-json/xixo/v1/status — detecta se o plugin está instalado
    register_rest_route( 'xixo/v1', '/status', [
        'methods'             => 'GET',
        'callback'            => fn () => new WP_REST_Response( [
            'xixo'    => true,
            'version' => PORTAL_PUB_VERSION,
            'site'    => get_bloginfo( 'name' ),
        ], 200 ),
        'permission_callback' => '__return_true',
    ] );

    // POST /wp-json/xixo/v1/publish — recebe e publica o artigo
    register_rest_route( 'xixo/v1', '/publish', [
        'methods'             => 'POST',
        'callback'            => 'portal_pub_handle_publish',
        'permission_callback' => 'portal_pub_auth',
    ] );

} );

// Autenticação por chave no header X-XIXO-Key
function portal_pub_auth( WP_REST_Request $req ): bool {
    $stored = get_option( PORTAL_PUB_OPTION_KEY, '' );
    if ( ! $stored ) return false;
    $sent = $req->get_header( 'x-xixo-key' ) ?: ( $req->get_param( 'api_key' ) ?? '' );
    return hash_equals( $stored, (string) $sent );
}

// Handler principal de publicação
function portal_pub_handle_publish( WP_REST_Request $req ): WP_REST_Response {
    $d = $req->get_json_params();

    $title       = sanitize_text_field( $d['title']       ?? '' );
    $chapeu      = sanitize_text_field( $d['chapeu']      ?? '' );
    $summary     = sanitize_textarea_field( $d['summary'] ?? '' );
    $body        = wp_kses_post( $d['body']               ?? '' );
    $source_url  = esc_url_raw( $d['source_url']          ?? '' );
    $source_name = sanitize_text_field( $d['source_name'] ?? '' );
    $image_url   = esc_url_raw( $d['image_url']           ?? '' );
    $post_format = sanitize_text_field( $d['post_format'] ?? 'editorial' );
    $tags        = array_map( 'sanitize_text_field', (array) ( $d['tags'] ?? [] ) );
    $category_ids = array_filter( array_map( 'intval', (array) ( $d['category_ids'] ?? [] ) ) );
    if ( empty( $category_ids ) && ! empty( $d['category_id'] ) ) {
        $category_ids = [ intval( $d['category_id'] ) ];
    }
    $slug        = sanitize_title( $d['slug'] ?? $title );

    if ( ! $title ) {
        return new WP_REST_Response( [ 'error' => 'O campo title é obrigatório.' ], 400 );
    }

    // ── 1. Tags ───────────────────────────────────────────────────────────────
    $tag_ids = [];
    foreach ( $tags as $tag_name ) {
        if ( ! $tag_name ) continue;
        $existing = get_term_by( 'name', $tag_name, 'post_tag' );
        if ( $existing ) {
            $tag_ids[] = $existing->term_id;
        } else {
            $new = wp_insert_term( $tag_name, 'post_tag' );
            if ( ! is_wp_error( $new ) ) $tag_ids[] = $new['term_id'];
        }
    }

    // ── 2. Upload da imagem ───────────────────────────────────────────────────
    $featured_id  = 0;
    $embedded_img = $image_url;

    if ( $image_url ) {
        require_once ABSPATH . 'wp-admin/includes/media.php';
        require_once ABSPATH . 'wp-admin/includes/file.php';
        require_once ABSPATH . 'wp-admin/includes/image.php';

        $tmp = download_url( $image_url );
        if ( ! is_wp_error( $tmp ) ) {
            $ext      = strtolower( pathinfo( parse_url( $image_url, PHP_URL_PATH ), PATHINFO_EXTENSION ) );
            $ext      = preg_replace( '/[^a-z0-9]/i', '', $ext ) ?: 'jpg';
            $filename = sanitize_file_name( $title . '.' . $ext );
            $file_arr = [ 'name' => $filename, 'tmp_name' => $tmp ];
            $media_id = media_handle_sideload( $file_arr, 0, $title );
            @unlink( $tmp );
            if ( ! is_wp_error( $media_id ) ) {
                $featured_id  = $media_id;
                $embedded_img = wp_get_attachment_url( $media_id ) ?: $image_url;
            }
        }
    }

    // ── 3. Monta o conteúdo ───────────────────────────────────────────────────
    //
    // Estrutura do post:
    //   • Chapéu: exibido via the_title filter (acima do título, cinza)
    //   • Imagem: <figure class="xixo-figura"> no corpo + featured_media para SEO/OG
    //             CSS injetado via wp_head garante full-width independente do tema
    //   • Corpo: artigo reescrito pela IA
    //   • Fonte: crédito ao final
    //
    $alt           = esc_attr( $title );
    $content_parts = '';

    // Modo 'editorial': resumo + imagem no corpo (temas que não exibem featured_media)
    // Modo 'standard': só featured_media, sem nada extra no corpo (tema já exibe)
    if ( $post_format === 'editorial' ) {
        if ( $summary ) {
            $content_parts .= '<p class="xixo-resumo" style="font-size:1.05em;color:#444;margin:0 0 1.5rem;line-height:1.6;font-style:italic;">'
                . esc_html( $summary )
                . '</p>' . "\n";
        }
        if ( $embedded_img ) {
            $content_parts .= '<figure class="xixo-figura" style="margin:0 0 1.5rem;padding:0;">'
                . '<img src="' . esc_url( $embedded_img ) . '" alt="' . $alt . '" style="width:100%;max-width:100%;height:auto;display:block;border-radius:4px;" />'
                . '</figure>' . "\n";
        }
    }

    // Corpo do artigo
    $content_parts .= $body;

    // Crédito de fonte no final
    if ( $source_url || $source_name ) {
        $display_name = $source_name ?: parse_url( $source_url, PHP_URL_HOST );
        $content_parts .= '<p class="xixo-fonte" style="font-size:.82em;color:#888;margin:1.8rem 0 0;border-top:1px solid #eee;padding-top:.75rem;">'
            . 'Fonte: <a href="' . esc_url( $source_url ) . '" target="_blank" rel="noopener noreferrer" style="color:#888;">'
            . esc_html( $display_name )
            . '</a></p>' . "\n";
    }

    // ── 4. Criar o post ───────────────────────────────────────────────────────
    $post_data = [
        'post_title'   => $title,
        'post_name'    => $slug,
        'post_excerpt' => $summary,
        'post_content' => $content_parts,
        'post_status'  => 'publish',
        'post_type'    => 'post',
        'tags_input'   => $tag_ids,
    ];
    if ( ! empty( $category_ids ) ) $post_data['post_category'] = $category_ids;

    $post_id = wp_insert_post( $post_data, true );
    if ( is_wp_error( $post_id ) ) {
        return new WP_REST_Response( [ 'error' => $post_id->get_error_message() ], 500 );
    }

    // ── 5. Salva meta ─────────────────────────────────────────────────────────
    if ( $chapeu )       update_post_meta( $post_id, '_xixo_chapeu',      $chapeu );
    if ( $source_url )   update_post_meta( $post_id, '_xixo_source_url',  $source_url );
    if ( $source_name )  update_post_meta( $post_id, '_xixo_source_name', $source_name );
    if ( $embedded_img ) update_post_meta( $post_id, '_xixo_image_url',   $embedded_img );

    // ── 6. Define imagem destacada (SEO / Open Graph) ─────────────────────────
    if ( $featured_id ) set_post_thumbnail( $post_id, $featured_id );

    return new WP_REST_Response( [
        'success'  => true,
        'post_id'  => $post_id,
        'post_url' => get_permalink( $post_id ),
    ], 201 );
}

// ── the_title filter: chapéu acima do título ──────────────────────────────────
add_filter( 'the_title', function ( $title, $post_id = null ) {
    if ( ! is_singular( 'post' ) )                                 return $title;
    if ( is_admin() || wp_doing_ajax() || wp_doing_cron() )        return $title;
    if ( ! in_the_loop() )                                         return $title;

    $pid = absint( $post_id ?: get_the_ID() );
    if ( ! $pid || $pid !== (int) get_queried_object_id() )        return $title;
    if ( strpos( $title, 'xixo-chapeu-label' ) !== false )         return $title;

    $chapeu = get_post_meta( $pid, '_xixo_chapeu', true );
    if ( ! $chapeu ) return $title;

    return '<span class="xixo-chapeu-label" style="display:block;font-size:1.5rem;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#6b7280;margin:0 0 .5rem;line-height:1.3;font-family:inherit;">'
        . esc_html( $chapeu )
        . '</span>'
        . $title;
}, 10, 2 );

// ── the_content filter: limpa elementos legados ───────────────────────────────
add_filter( 'the_content', function ( $content ) {
    if ( ! is_singular( 'post' ) ) return $content;
    // Remove chapéu antigo do corpo (versões < 1.5)
    $content = preg_replace(
        '/<p[^>]+class=["\'][^"\']*xixo-chapeu[^"\']*["\'][^>]*>[\s\S]*?<\/p>\s*/i',
        '',
        $content
    );
    return $content;
} );

// ── wp_head: CSS full-width para a imagem (sobrescreve tema com !important) ───
add_action( 'wp_head', function () {
    if ( ! is_singular( 'post' ) ) return;
    $pid = get_the_ID();
    if ( ! $pid ) return;
    if ( ! get_post_meta( $pid, '_xixo_image_url', true ) ) return;

    echo '<style id="portal-pub-img-style">
        .xixo-figura {
            display: block !important;
            clear: both !important;
            width: 100% !important;
            margin: 0 0 1.5rem 0 !important;
            padding: 0 !important;
            float: none !important;
        }
        .xixo-figura img {
            width: 100% !important;
            max-width: 100% !important;
            height: auto !important;
            display: block !important;
            float: none !important;
            margin: 0 !important;
            border-radius: 4px;
        }
        .xixo-chapeu-label {
            color: #6b7280 !important;
        }
    </style>' . "\n";
}, 99 );
