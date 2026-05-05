'use strict';

const axios   = require('axios');
const https   = require('https');
const { decryptToken } = require('./encrypt');

const HTTPS_AGENT = new https.Agent({ rejectUnauthorized: false });

/**
 * Garante que todas as <img> do body HTML tenham width:100% responsivo.
 * Substitui ou adiciona o atributo style nas imagens.
 */
function ensureImgFullWidth(html) {
  if (!html) return html;
  // Adiciona/substitui style nas tags <img>
  return html.replace(/<img(\s[^>]*)?>/gi, (match, attrs) => {
    if (!attrs) return `<img style="max-width:100%;width:100%;height:auto;display:block;margin:1rem auto;">`;
    // Remove style existente e adiciona o novo
    const cleaned = attrs.replace(/\s*style\s*=\s*["'][^"']*["']/gi, '');
    return `<img${cleaned} style="max-width:100%;width:100%;height:auto;display:block;margin:1rem auto;">`;
  });
}

// ── Publicação via Plugin XIXO (modo preferencial) ───────────────────────────
// Usado quando o site tem o plugin XIXO Publisher instalado e a chave configurada.
//
// COMPORTAMENTO POR post_format:
//   'editorial' — Plugin v1.2.0+: envia image_url, o plugin injeta a imagem no
//                 corpo E usa JS para ocultá-la quando o tema exibe featured_media.
//                 (ex: vozesdooraculo — plugin v1.2.0)
//
//   'standard'  — Plugin v1.1.0: NÃO envia image_url para o plugin (evita injeção
//                 no corpo). Após criar o post, faz upload da imagem via WP REST API
//                 nativa e define featured_media separadamente.
//                 (ex: rb24horas — plugin v1.1.0 sem JS de ocultação)
//
async function publishViaXixoPlugin(site, rewritten, article) {
  const baseUrl = (site.site_url || '').replace(/\/$/, '');
  const apiKey  = site.xixo_api_key;

  if (!baseUrl || !apiKey) throw new Error('URL ou chave do plugin XIXO não configurada.');

  const slugify = (str) => (str || '').toLowerCase()
    .replace(/[áàãâä]/g,'a').replace(/[éêë]/g,'e').replace(/[íîï]/g,'i')
    .replace(/[óõôö]/g,'o').replace(/[úûü]/g,'u').replace(/[ç]/g,'c').replace(/[ñ]/g,'n')
    .normalize('NFD').replace(/[̀-ͯ]/g,'')
    .replace(/[^a-z0-9\s-]/g,'').trim().replace(/\s+/g,'-').replace(/-+/g,'-').slice(0,100);

  let nomefonte = article.source_name || '';
  if (!nomefonte && article.external_url) {
    try { nomefonte = new URL(article.external_url).hostname.replace('www.',''); } catch { nomefonte = ''; }
  }

  // post_format controla como a imagem é exibida no plugin:
  //   'editorial' → imagem injetada no corpo do post (para temas que não exibem featured_media)
  //   'standard'  → imagem apenas como featured_media (para temas que já a exibem, ex: Hello Elementor)
  const postFormat = site.post_format || 'editorial';

  const payload = {
    title:       rewritten.title       || '',
    chapeu:      rewritten.chapeu      || '',
    summary:     rewritten.summary     || '',
    body:        rewritten.body        || '',
    slug:        slugify(rewritten.title),
    source_url:  article.external_url  || '',
    source_name: nomefonte,
    image_url:   article.image_url     || '',
    post_format: postFormat,
    tags:        rewritten.tags        || [],
    category_id: rewritten.category_id || null,
  };

  const res = await axios.post(`${baseUrl}/wp-json/xixo/v1/publish`, payload, {
    timeout:    30000,
    httpsAgent: HTTPS_AGENT,
    headers: {
      'Content-Type': 'application/json',
      'X-XIXO-Key':   apiKey,
    },
  });

  const data = res.data;
  if (!data?.success || !data?.post_id) {
    throw new Error(data?.error || 'Resposta inesperada do plugin XIXO.');
  }

  const postId  = String(data.post_id);
  const postUrl = data.post_url;

  // ── Modo standard: sobe imagem via WP REST API e define featured_media ────────
  // O plugin não inseriu a imagem no corpo. Aqui fazemos o upload e vinculamos
  // ao post como imagem destacada (aparece 1x via tema, sem duplicata).
  if (postFormat !== 'editorial' && article.image_url && site.wp_app_password && site.wp_username) {
    try {
      const password   = decryptToken(site.wp_app_password);
      const wpAuth     = Buffer.from(`${site.wp_username}:${password}`).toString('base64');
      const wpHeaders  = { Authorization: `Basic ${wpAuth}` };

      // Baixa a imagem
      const imgRes = await axios.get(article.image_url, {
        responseType: 'arraybuffer', timeout: 15000, httpsAgent: HTTPS_AGENT,
        headers: { 'User-Agent': 'Mozilla/5.0',
          'Referer': (() => { try { return new URL(article.image_url).origin + '/'; } catch { return article.image_url; } })() },
      });

      const imgBuffer   = Buffer.from(imgRes.data);
      const contentType = imgRes.headers['content-type'] || 'image/jpeg';
      const rawName     = article.image_url.split('/').pop().split('?')[0] || 'imagem.jpg';
      const imgName     = rawName.replace(/\.(jpeg|jpg|png|webp|gif).*$/i, '.$1') || 'imagem.jpg';

      // Upload para a biblioteca de mídia
      const uploadRes = await axios.post(`${baseUrl}/wp-json/wp/v2/media`, imgBuffer, {
        timeout: 20000, httpsAgent: HTTPS_AGENT,
        headers: {
          ...wpHeaders,
          'Content-Disposition': `attachment; filename="${imgName}"`,
          'Content-Type': contentType,
        },
      });

      const mediaId = uploadRes.data?.id;
      if (mediaId) {
        // Define como featured_media no post
        await axios.post(`${baseUrl}/wp-json/wp/v2/posts/${postId}`, { featured_media: mediaId }, {
          timeout: 10000, httpsAgent: HTTPS_AGENT,
          headers: { ...wpHeaders, 'Content-Type': 'application/json' },
        });
        console.log(`[xixo] featured_media ${mediaId} definida no post ${postId} (${site.name})`);
      }
    } catch (imgErr) {
      // Falha no upload da imagem não impede a publicação
      console.warn('[xixo] Falha ao definir featured_media:', imgErr.message);
    }
  }

  return { post_id: postId, post_url: postUrl };
}

// ── Publicação via WP REST API nativa (modo legado/fallback) ─────────────────
// Usado quando o site não tem o plugin instalado.
// Comportamento controlado por site.post_format:
//   'editorial' — injeta chapéu, título, resumo e imagem no corpo do post
//   'standard'  — envia apenas chapéu + fonte + corpo; título/imagem via campos nativos
async function publishToWordPress(site, rewritten, article) {
  const baseUrl = (site.site_url || '').replace(/\/$/, '');
  if (!baseUrl) throw new Error('URL do site não configurada.');

  // Plugin XIXO tem prioridade — não precisa de wp_app_password
  if (site.xixo_api_key) {
    return publishViaXixoPlugin(site, rewritten, article);
  }

  const password = decryptToken(site.wp_app_password);
  if (!password) throw new Error('Senha de aplicação não configurada para este site.');

  const authHeader = {
    'Authorization': `Basic ${Buffer.from(`${site.wp_username}:${password}`).toString('base64')}`,
    'Content-Type':  'application/json',
  };

  const axiosWP = axios.create({
    baseURL:    baseUrl,
    timeout:    20000,
    httpsAgent: HTTPS_AGENT,
    headers:    authHeader,
  });

  // ── Testa conectividade ────────────────────────────────────────────────────
  try {
    await axiosWP.get('/wp-json/wp/v2/posts?per_page=1');
  } catch (err) {
    if (err.code === 'ENOTFOUND')                throw new Error(`Domínio não encontrado: ${baseUrl}.`);
    if (['ECONNREFUSED','ECONNRESET'].includes(err.code)) throw new Error(`Não foi possível conectar: ${baseUrl}.`);
    if (err.response?.status === 401)            throw new Error('Credenciais inválidas. Verifique usuário e senha de aplicação.');
    if (err.response?.status === 403)            throw new Error('Acesso negado. Verifique as permissões do usuário.');
    if (!err.response)                           throw new Error(`Erro de rede: ${err.message}`);
  }

  // ── 1. Tags ────────────────────────────────────────────────────────────────
  const tagIds = [];
  for (const tag of (rewritten.tags || [])) {
    try {
      const s = await axiosWP.get(`/wp-json/wp/v2/tags?search=${encodeURIComponent(tag)}`);
      if (Array.isArray(s.data) && s.data.length > 0) {
        tagIds.push(s.data[0].id);
      } else {
        const c = await axiosWP.post('/wp-json/wp/v2/tags', { name: tag });
        if (c.data?.id) tagIds.push(c.data.id);
      }
    } catch { /* ignora tag individual */ }
  }

  // ── 2. Upload da imagem ────────────────────────────────────────────────────
  let featuredMediaId  = null;
  let featuredMediaUrl = article.image_url || null;

  if (article.image_url) {
    try {
      const imgRes = await axios.get(article.image_url, {
        responseType: 'arraybuffer', timeout: 15000, httpsAgent: HTTPS_AGENT,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Referer': (() => { try { return new URL(article.image_url).origin + '/'; } catch { return article.image_url; } })(),
        },
      });
      const imgBuffer   = Buffer.from(imgRes.data);
      const contentType = imgRes.headers['content-type'] || 'image/jpeg';
      const rawName     = article.image_url.split('/').pop().split('?')[0] || 'imagem.jpg';
      const imgName     = rawName.replace(/\.(jpeg|jpg|png|webp|gif).*$/i, '.$1') || 'imagem.jpg';

      const uploadRes = await axiosWP.post('/wp-json/wp/v2/media', imgBuffer, {
        headers: {
          'Authorization':       authHeader['Authorization'],
          'Content-Disposition': `attachment; filename="${imgName}"`,
          'Content-Type':        contentType,
        },
      });
      if (uploadRes.data?.id) {
        featuredMediaId  = uploadRes.data.id;
        featuredMediaUrl = uploadRes.data.source_url || uploadRes.data.guid?.rendered || featuredMediaUrl;
      }
    } catch (e) { console.warn('[wordpress] Upload de imagem falhou:', e.message); }
  }

  // ── 3. Monta conteúdo conforme post_format ─────────────────────────────────
  const slugify = (str) => (str || '').toLowerCase()
    .replace(/[áàãâä]/g,'a').replace(/[éêë]/g,'e').replace(/[íîï]/g,'i')
    .replace(/[óõôö]/g,'o').replace(/[úûü]/g,'u').replace(/[ç]/g,'c').replace(/[ñ]/g,'n')
    .normalize('NFD').replace(/[̀-ͯ]/g,'')
    .replace(/[^a-z0-9\s-]/g,'').trim().replace(/\s+/g,'-').replace(/-+/g,'-').slice(0,100);

  const postFormat = site.post_format || 'editorial';

  let nomefonte = article.source_name || '';
  if (!nomefonte && article.external_url) {
    try { nomefonte = new URL(article.external_url).hostname.replace('www.',''); } catch { nomefonte = 'fonte original'; }
  }

  let conteudoFinal = '';

  // Nota: blocos <style> são removidos pelo wp_kses do WordPress.
  // Usamos apenas estilos inline. Título e imagem são gerenciados pelo tema (featured_media).
  // Modo 'editorial' e 'standard' usam a mesma estrutura: chapéu + resumo + fonte + corpo.
  // A imagem NÃO é injetada no corpo — o tema já exibe via featured_media (evita duplicação).

  // Chapéu no topo do corpo (o tema não exibe chapéu nativamente).
  // Resumo NÃO vai no corpo — o tema Hello Elementor já exibe via campo 'excerpt' (texto cinza abaixo do título).
  // Imagem NÃO vai no corpo — o tema já exibe a featured_media (evita imagem dupla).
  if (rewritten.chapeu) {
    conteudoFinal += `<p style="font-size:.75em;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#b91c1c;margin:0 0 1.2rem;line-height:1.3;">${rewritten.chapeu}</p>\n`;
  }
  if (article.external_url) {
    conteudoFinal += `<p style="font-size:.82em;color:#888;margin:0 0 1.4rem;">Fonte: <a href="${article.external_url}" target="_blank" rel="noopener noreferrer" style="color:#888;">${nomefonte}</a></p>\n`;
  }

  // Remove qualquer <img> ou <figure> do corpo — a imagem principal vai SOMENTE via featured_media.
  // Isso evita imagem duplicada independente do que a IA ou o usuário coloque no corpo.
  const bodyLimpo = (rewritten.body || '')
    .replace(/<figure\b[^>]*>[\s\S]*?<\/figure>/gi, '')
    .replace(/<img\b[^>]*\/?>/gi, '');
  conteudoFinal += bodyLimpo;

  // postFormat mantido para compatibilidade futura.
  void postFormat;

  // ── 4. Cria o post ─────────────────────────────────────────────────────────
  const postBody = {
    title:   rewritten.title,
    slug:    slugify(rewritten.title),
    content: conteudoFinal,
    excerpt: rewritten.summary || '',
    status:  'publish',
    tags:    tagIds,
    meta: { chapeu: rewritten.chapeu || '', fonte_original: article.external_url || '' },
  };
  if (rewritten.category_id) postBody.categories     = [rewritten.category_id];
  if (featuredMediaId)        postBody.featured_media = featuredMediaId;

  const postRes = await axiosWP.post('/wp-json/wp/v2/posts', postBody);
  const post = postRes.data;
  if (!post?.id) throw new Error(post?.message || 'Erro ao criar post no WordPress.');

  return { post_id: String(post.id), post_url: post.link };
}

module.exports = { publishToWordPress };
