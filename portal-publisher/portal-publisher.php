<?php
/**
 * Plugin Name: Portal Publisher
 * Description: Integração com o Sistema de Agregação — recebe artigos via endpoint REST e publica com chapéu editorial e crédito de fonte, sem depender do tema.
 * Version:     1.6.1
 * Author:      Sistema XIXO
 * Text Domain: portal-publisher
 */

if ( ! defined( 'ABSPATH' ) ) exit;

// ── Admin: página de configuração da chave API ────────────────────────────────
add_action( 'admin_menu', function () {
    add_options_page(
        'Portal Publisher',
        'Portal Publisher',
        'manage_options',
        'portal-publisher',
        'xixo_settings_page'
    );
} );

add_action( 'admin_init', function () {
    register_setting( 'xixo_settings_group', 'xixo_api_key', [
        'sanitize_callback' => 'sanitize_text_field',
    ] );
} );

function xixo_settings_page() {
    ?>
    <div class="wrap">
        <h1>Portal Publisher — Configurações</h1>
        <form method="post" action="options.php">
            <?php settings_fields( 'xixo_settings_group' ); ?>
            <table class="form-table">
                <tr>
                    <th scope="row"><label for="xixo_api_key">Chave API (X-XIXO-Key)</label></th>
                    <td>
                        <input type="text" id="xixo_api_key" name="xixo_api_key"
                               value="<?php echo esc_attr( get_option( 'xixo_api_key', '' ) ); ?>"
                               class="regular-text" />
                        <p class="description">Deve coincidir com a chave configurada no sistema de agregação.</p>
                    </td>
                </tr>
            </table>
            <?php submit_button(); ?>
        </form>
    </div>
    <?php
}

// ── Registra os endpoints REST ────────────────────────────────────────────────
add_action( 'rest_api_init', function () {
    register_rest_route( 'xixo/v1', '/publish', [
        'methods'             => 'POST',
        'callback'            => 'xixo_handle_publish',
        'permission_callback' => '__return_true',
    ] );
    register_rest_route( 'xixo/v1', '/categories', [
        'methods'             => 'GET',
        'callback'            => 'xixo_handle_categories',
        'permission_callback' => '__return_true',
    ] );
} );

// ── GET /wp-json/xixo/v1/categories — retorna categorias autenticado por chave ─
function xixo_handle_categories( WP_REST_Request $request ) {
    $api_key  = get_option( 'xixo_api_key', '' );
    $sent_key = $request->get_header( 'X-XIXO-Key' );
    if ( ! $api_key || ! hash_equals( $api_key, (string) $sent_key ) ) {
        return new WP_REST_Response( [ 'error' => 'Chave API inválida.' ], 401 );
    }
    $terms = get_terms( [ 'taxonomy' => 'category', 'hide_empty' => false, 'number' => 200 ] );
    if ( is_wp_error( $terms ) ) {
        return new WP_REST_Response( [ 'error' => $terms->get_error_message() ], 500 );
    }
    $cats = array_map( function( $t ) {
        return [ 'id' => $t->term_id, 'name' => $t->name, 'parent' => $t->parent ?: null ];
    }, $terms );
    return new WP_REST_Response( $cats, 200 );
}

// ── Handler principal ─────────────────────────────────────────────────────────
function xixo_handle_publish( WP_REST_Request $request ) {

    // Valida API key
    $api_key  = get_option( 'xixo_api_key', '' );
    if ( ! $api_key ) {
        return new WP_REST_Response( [ 'error' => 'Chave API não configurada no servidor.' ], 500 );
    }
    $sent_key = $request->get_header( 'X-XIXO-Key' );
    if ( ! hash_equals( $api_key, (string) $sent_key ) ) {
        return new WP_REST_Response( [ 'error' => 'Chave API inválida.' ], 401 );
    }

    $d = $request->get_json_params();
    if ( ! $d ) {
        return new WP_REST_Response( [ 'error' => 'Payload JSON inválido.' ], 400 );
    }

    $title       = sanitize_text_field( $d['title']       ?? '' );
    $chapeu      = sanitize_text_field( $d['chapeu']      ?? '' );
    $summary     = sanitize_text_field( $d['summary']     ?? '' );
    $body        = wp_kses_post(        $d['body']        ?? '' );
    $slug        = sanitize_title(      $d['slug']        ?? '' );
    $source_url  = esc_url_raw(         $d['source_url']  ?? '' );
    $source_name = sanitize_text_field( $d['source_name'] ?? '' );
    $image_url   = esc_url_raw(         $d['image_url']   ?? '' );
    $post_format = sanitize_text_field( $d['post_format'] ?? 'editorial' );
    $tags        = array_map( 'sanitize_text_field', (array) ( $d['tags']         ?? [] ) );
    $cat_ids     = array_map( 'intval',               (array) ( $d['category_ids'] ?? [] ) );

    if ( ! $title ) {
        return new WP_REST_Response( [ 'error' => 'Título obrigatório.' ], 400 );
    }

    // ── 1. Tags ───────────────────────────────────────────────────────────────
    $tag_ids = [];
    foreach ( $tags as $tag_name ) {
        if ( ! $tag_name ) continue;
        $term = get_term_by( 'name', $tag_name, 'post_tag' );
        if ( $term ) {
            $tag_ids[] = $term->term_id;
        } else {
            $new_term = wp_insert_term( $tag_name, 'post_tag' );
            if ( ! is_wp_error( $new_term ) ) $tag_ids[] = $new_term['term_id'];
        }
    }

    // ── 2. Upload da imagem ───────────────────────────────────────────────────
    $featured_id  = 0;
    $embedded_img = $image_url;

    if ( $image_url ) {
        require_once ABSPATH . 'wp-admin/includes/image.php';
        require_once ABSPATH . 'wp-admin/includes/file.php';
        require_once ABSPATH . 'wp-admin/includes/media.php';

        $tmp = download_url( $image_url );
        if ( ! is_wp_error( $tmp ) ) {
            $ext = strtolower( pathinfo( parse_url( $image_url, PHP_URL_PATH ), PATHINFO_EXTENSION ) );
            if ( $ext === 'jfif' ) $ext = 'jpg'; // jfif é JPEG com extensão diferente
            $ext = in_array( $ext, [ 'jpg', 'jpeg', 'png', 'webp', 'gif' ] ) ? $ext : 'jpg';
            $file = [
                'name'     => sanitize_file_name( $slug ?: 'imagem' ) . '.' . $ext,
                'type'     => 'image/' . ( $ext === 'jpg' ? 'jpeg' : $ext ),
                'tmp_name' => $tmp,
                'error'    => 0,
                'size'     => filesize( $tmp ),
            ];
            $media_id = media_handle_sideload( $file, 0, $title );
            @unlink( $tmp );
            if ( ! is_wp_error( $media_id ) ) {
                $featured_id  = $media_id;
                $embedded_img = wp_get_attachment_url( $media_id ) ?: $image_url;
            }
        }
    }

    // ── 3. Monta conteúdo ─────────────────────────────────────────────────────
    //
    // Modo 'editorial': resumo + imagem no corpo (temas que não exibem featured_media)
    // Modo 'standard' e demais: só featured_media — tema já exibe a imagem
    //
    $alt           = esc_attr( $title );
    $content_parts = '';

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
        $display_name  = $source_name ?: parse_url( $source_url, PHP_URL_HOST );
        $content_parts .= '<p class="xixo-fonte" style="font-size:.82em;color:#888;margin:1.8rem 0 0;border-top:1px solid #eee;padding-top:.75rem;">'
            . 'Fonte: <a href="' . esc_url( $source_url ) . '" target="_blank" rel="noopener noreferrer" style="color:#888;">'
            . esc_html( $display_name )
            . '</a></p>' . "\n";
    }

    // ── 4. Criar o post ───────────────────────────────────────────────────────
    // post_author: wp_insert_post sem autor usa get_current_user_id() = 0 quando
    // a autenticação é por X-XIXO-Key (sem sessão WP). Busca o primeiro admin.
    $admins    = get_users( [ 'role' => 'administrator', 'number' => 1, 'orderby' => 'ID', 'order' => 'ASC' ] );
    $author_id = ! empty( $admins ) ? $admins[0]->ID : 1;

    $post_data = [
        'post_title'   => $title,
        'post_name'    => $slug,
        'post_excerpt' => $summary,
        'post_content' => $content_parts,
        'post_status'  => 'publish',
        'post_type'    => 'post',
        'post_author'  => $author_id,
        'tags_input'   => $tag_ids,
    ];
    if ( ! empty( $cat_ids ) ) $post_data['post_category'] = $cat_ids;

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
    if ( ! is_singular( 'post' ) )                          return $title;
    if ( is_admin() || wp_doing_ajax() || wp_doing_cron() ) return $title;
    if ( ! in_the_loop() )                                  return $title;

    $pid = absint( $post_id ?: get_the_ID() );
    if ( ! $pid || $pid !== (int) get_queried_object_id() ) return $title;
    if ( strpos( $title, 'xixo-chapeu-label' ) !== false )  return $title;

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
        /* Modo editorial: figura injetada no corpo */
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
        /* Modos simple/standard: featured image renderizada pelo tema */
        .wp-post-image,
        .post-thumbnail img,
        .post-thumbnail > a > img,
        .entry-thumbnail img,
        .featured-image img,
        .post-featured-image img,
        figure.wp-block-post-featured-image img,
        .wp-block-post-featured-image img {
            width: 100% !important;
            max-width: 100% !important;
            height: auto !important;
            display: block !important;
        }
        .post-thumbnail,
        .entry-thumbnail,
        .featured-image,
        figure.wp-block-post-featured-image,
        .wp-block-post-featured-image {
            width: 100% !important;
            max-width: 100% !important;
        }
        .xixo-chapeu-label {
            color: #6b7280 !important;
        }
    </style>' . "\n";
}, 99 );
