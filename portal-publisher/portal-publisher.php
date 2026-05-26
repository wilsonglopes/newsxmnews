<?php
/**
 * Plugin Name: Portal Publisher
 * Description: Integração com o Sistema de Agregação — recebe artigos via endpoint REST e publica com chapéu editorial e crédito de fonte, sem depender do tema.
 * Version:     2.1.0
 * Author:      XMNews Publisher
 * Text Domain: portal-publisher
 */

if ( ! defined( 'ABSPATH' ) ) exit;

// ── Ativação: gera chave automaticamente se ainda não existir ─────────────────
register_activation_hook( __FILE__, 'xmn_activate' );
function xmn_activate() {
    if ( ! get_option( 'xixo_api_key' ) ) {
        update_option( 'xixo_api_key', wp_generate_password( 40, false ) );
    }
}

// ── Garante que sites já com o plugin instalado também tenham chave gerada ────
add_action( 'admin_init', function () {
    if ( ! get_option( 'xixo_api_key' ) ) {
        update_option( 'xixo_api_key', wp_generate_password( 40, false ) );
    }

    // Trata regeneração de chave
    if ( isset( $_POST['xmn_regenerate'] ) && check_admin_referer( 'xmn_regenerate_nonce' ) ) {
        if ( current_user_can( 'manage_options' ) ) {
            update_option( 'xixo_api_key', wp_generate_password( 40, false ) );
            wp_redirect( admin_url( 'admin.php?page=portal-publisher&xmn_regenerated=1' ) );
            exit;
        }
    }
} );

// ── Menu de nível superior na sidebar do WP Admin ────────────────────────────
add_action( 'admin_menu', function () {
    add_menu_page(
        'Portal Publisher',           // título da página
        'Portal Publisher',           // texto no menu
        'manage_options',             // capability
        'portal-publisher',           // slug
        'xmn_settings_page',          // callback
        'dashicons-rss',              // ícone
        3                             // posição: logo abaixo de "Painel"
    );
} );

function xmn_settings_page() {
    $api_key     = get_option( 'xixo_api_key', '' );
    $regenerated = isset( $_GET['xmn_regenerated'] );
    ?>
    <div class="wrap">
        <h1 style="display:flex;align-items:center;gap:10px;">
            <span class="dashicons dashicons-rss" style="font-size:1.6rem;color:#d63638;margin-top:3px;"></span>
            Portal Publisher
        </h1>

        <?php if ( $regenerated ) : ?>
            <div class="notice notice-warning is-dismissible">
                <p><strong>Chave regenerada.</strong> Copie a nova chave e atualize no painel do sistema XMNews.</p>
            </div>
        <?php endif; ?>

        <!-- ── Chave de integração ── -->
        <div style="background:#fff;border:1px solid #c3c4c7;border-radius:6px;padding:24px 28px;max-width:640px;margin-top:20px;box-shadow:0 1px 3px rgba(0,0,0,.08);">
            <h2 style="margin-top:0;font-size:1.05rem;color:#1d2327;">🔑 Sua chave de integração</h2>
            <p style="color:#555;margin:0 0 14px;font-size:.92rem;">
                Esta chave identifica o seu site no sistema XMNews. Copie-a e cole no painel do sistema para ativar a conexão.
            </p>

            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                <input type="text" id="xmn-api-key-display" readonly
                       value="<?php echo esc_attr( $api_key ); ?>"
                       style="flex:1;font-family:monospace;font-size:.9rem;padding:9px 12px;border:2px solid #d63638;border-radius:5px;background:#fff8f8;color:#1d2327;letter-spacing:.04em;" />
                <button type="button" id="xmn-copy-btn" onclick="xmnCopyKey()"
                        style="padding:9px 18px;background:#d63638;color:#fff;border:none;border-radius:5px;cursor:pointer;font-size:.88rem;font-weight:600;white-space:nowrap;transition:background .15s;">
                    📋 Copiar chave
                </button>
            </div>
            <p id="xmn-copy-msg" style="display:none;color:#00a32a;font-size:.82rem;font-weight:600;margin:0 0 16px;">
                ✅ Chave copiada! Agora cole no painel do sistema XMNews.
            </p>

            <form method="post" style="margin-top:16px;padding-top:14px;border-top:1px solid #f0f0f1;"
                  onsubmit="return confirm('Atenção: regenerar a chave vai desconectar o sistema XMNews até você colar a nova chave lá. Confirmar?');">
                <?php wp_nonce_field( 'xmn_regenerate_nonce' ); ?>
                <input type="submit" name="xmn_regenerate" class="button button-secondary"
                       value="🔄 Regenerar chave" />
                <span style="color:#888;font-size:.8rem;margin-left:8px;">Use apenas se a chave atual foi comprometida.</span>
            </form>
        </div>

        <!-- ── Passo a passo ── -->
        <div style="background:#fff;border:1px solid #c3c4c7;border-radius:6px;padding:24px 28px;max-width:640px;margin-top:20px;box-shadow:0 1px 3px rgba(0,0,0,.08);">
            <h2 style="margin-top:0;font-size:1.05rem;color:#1d2327;">📋 Como ativar a conexão com o sistema XMNews</h2>

            <ol style="margin:0;padding-left:20px;color:#444;font-size:.92rem;line-height:1.9;">
                <li>
                    <strong>Instale este plugin</strong> no seu WordPress
                    (Plugins → Adicionar novo → envie o arquivo <code>portal-publisher.zip</code>).
                </li>
                <li>
                    <strong>Ative o plugin</strong> — a chave de integração é gerada automaticamente.
                </li>
                <li>
                    <strong>Copie a chave</strong> clicando em <em>📋 Copiar chave</em> acima.
                </li>
                <li>
                    Acesse o <strong>painel do sistema XMNews</strong> e faça login com seu usuário.
                </li>
                <li>
                    Clique na aba <strong>Meus Portais</strong> no menu superior.
                </li>
                <li>
                    Localize o seu site na lista — ele estará com o status
                    <em style="background:#fef9c3;color:#854d0e;padding:1px 7px;border-radius:20px;font-size:.82rem;font-style:normal;">Aguardando ativação</em>.
                </li>
                <li>
                    Cole a chave no campo indicado e clique em <strong>Ativar</strong>.
                </li>
                <li>
                    Pronto! O status muda para
                    <em style="background:#dcfce7;color:#166534;padding:1px 7px;border-radius:20px;font-size:.82rem;font-style:normal;">Ativo ✓</em>
                    e o sistema já pode publicar artigos automaticamente no seu site.
                </li>
            </ol>

            <div style="margin-top:18px;background:#f0f6fc;border-left:4px solid #2271b1;padding:10px 14px;border-radius:0 4px 4px 0;font-size:.85rem;color:#1d2327;">
                <strong>Dúvidas?</strong> Entre em contato com o administrador do sistema XMNews.
            </div>
        </div>
    </div>

    <script>
    function xmnCopyKey() {
        var input = document.getElementById('xmn-api-key-display');
        var msg   = document.getElementById('xmn-copy-msg');
        var btn   = document.getElementById('xmn-copy-btn');
        input.select();
        input.setSelectionRange(0, 99999);
        var ok = false;
        try { ok = document.execCommand('copy'); } catch(e) {}
        if (!ok && navigator.clipboard) {
            navigator.clipboard.writeText(input.value).then(function() {
                xmnShowCopied(btn, msg);
            });
            return;
        }
        if (ok) xmnShowCopied(btn, msg);
    }
    function xmnShowCopied(btn, msg) {
        btn.textContent = '✅ Copiado!';
        btn.style.background = '#00a32a';
        msg.style.display = 'block';
        setTimeout(function() {
            btn.innerHTML = '📋 Copiar chave';
            btn.style.background = '#d63638';
            msg.style.display = 'none';
        }, 3000);
    }
    </script>
    <?php
}

// ── Registra os endpoints REST ────────────────────────────────────────────────
add_action( 'rest_api_init', function () {
    register_rest_route( 'xmn/v1', '/publish', [
        'methods'             => 'POST',
        'callback'            => 'xmn_handle_publish',
        'permission_callback' => '__return_true',
    ] );
    register_rest_route( 'xmn/v1', '/categories', [
        'methods'             => 'GET',
        'callback'            => 'xmn_handle_categories',
        'permission_callback' => '__return_true',
    ] );
} );

// ── GET /wp-json/xmn/v1/categories — retorna categorias autenticado por chave ─
function xmn_handle_categories( WP_REST_Request $request ) {
    $api_key  = get_option( 'xixo_api_key', '' );
    $sent_key = $request->get_header( 'X-XMNews-Key' );
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
function xmn_handle_publish( WP_REST_Request $request ) {

    // Valida API key
    $api_key  = get_option( 'xixo_api_key', '' );
    if ( ! $api_key ) {
        return new WP_REST_Response( [ 'error' => 'Chave API não configurada no servidor.' ], 500 );
    }
    $sent_key = $request->get_header( 'X-XMNews-Key' );
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
    $image_url      = esc_url_raw( $d['image_url']      ?? '' );
    $image_media_id = intval(      $d['image_media_id'] ?? 0  );
    $post_format    = sanitize_text_field( $d['post_format'] ?? 'editorial' );
    $tags           = array_map( 'sanitize_text_field', (array) ( $d['tags']         ?? [] ) );
    $cat_ids        = array_map( 'intval',               (array) ( $d['category_ids'] ?? [] ) );

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

    // ── 2. Imagem destacada ───────────────────────────────────────────────────
    $featured_id  = 0;
    $embedded_img = $image_url;

    if ( $image_media_id > 0 ) {
        // Caminho rápido: imagem já está na biblioteca de mídia do WP (pré-carregada
        // pelo backend via /upload-image). Usar o media_id diretamente — sem download.
        $featured_id  = $image_media_id;
        $embedded_img = wp_get_attachment_url( $image_media_id ) ?: $image_url;
    } elseif ( $image_url ) {
        // Caminho padrão: backend envia URL externa; plugin baixa e faz sideload.
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
            $content_parts .= '<p class="xmn-resumo" style="font-size:1.05em;color:#444;margin:0 0 1.5rem;line-height:1.6;font-style:italic;">'
                . esc_html( $summary )
                . '</p>' . "\n";
        }
        if ( $embedded_img ) {
            $content_parts .= '<figure class="xmn-figura" style="margin:0 0 1.5rem;padding:0;">'
                . '<img src="' . esc_url( $embedded_img ) . '" alt="' . $alt . '" style="width:100%;max-width:100%;height:auto;display:block;border-radius:4px;" />'
                . '</figure>' . "\n";
        }
    }

    // Corpo do artigo
    $content_parts .= $body;

    // Crédito de fonte no final
    if ( $source_url || $source_name ) {
        $display_name  = $source_name ?: parse_url( $source_url, PHP_URL_HOST );
        $content_parts .= '<p class="xmn-fonte" style="font-size:.82em;color:#888;margin:1.8rem 0 0;border-top:1px solid #eee;padding-top:.75rem;">'
            . 'Fonte: <a href="' . esc_url( $source_url ) . '" target="_blank" rel="noopener noreferrer" style="color:#888;">'
            . esc_html( $display_name )
            . '</a></p>' . "\n";
    }

    // ── 4. Criar o post ───────────────────────────────────────────────────────
    // post_author: wp_insert_post sem autor usa get_current_user_id() = 0 quando
    // a autenticação é por X-XMNews-Key (sem sessão WP). Busca o primeiro admin.
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
    if ( strpos( $title, 'xmn-chapeu-label' ) !== false )  return $title;

    $chapeu = get_post_meta( $pid, '_xixo_chapeu', true );
    if ( ! $chapeu ) return $title;

    return '<span class="xmn-chapeu-label" style="display:block;font-size:1.5rem;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#6b7280;margin:0 0 .5rem;line-height:1.3;font-family:inherit;">'
        . esc_html( $chapeu )
        . '</span>'
        . $title;
}, 10, 2 );

// ── the_content filter: limpa elementos legados ───────────────────────────────
add_filter( 'the_content', function ( $content ) {
    if ( ! is_singular( 'post' ) ) return $content;
    $content = preg_replace(
        '/<p[^>]+class=["\'][^"\']*(?:xixo|xmn)-chapeu[^"\']*["\'][^>]*>[\s\S]*?<\/p>\s*/i',
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
        .xmn-figura {
            display: block !important;
            clear: both !important;
            width: 100% !important;
            margin: 0 0 1.5rem 0 !important;
            padding: 0 !important;
            float: none !important;
        }
        .xmn-figura img {
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
        .xmn-chapeu-label {
            color: #6b7280 !important;
        }
    </style>' . "\n";
}, 99 );
