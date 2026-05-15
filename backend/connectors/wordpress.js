'use strict';

const axios    = require('axios');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const FormData = require('form-data');
const sharp    = require('sharp');
const { decryptToken } = require('./encrypt');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

const HTTPS_AGENT = new https.Agent({ rejectUnauthorized: false });

const MAX_IMAGE_WIDTH = 1000;
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024; // 1.5 MB

/**
 * Redimensiona a imagem para no máximo MAX_IMAGE_WIDTH de largura.
 * Converte AVIF/WebP/JFIF para JPEG. PNG permanece PNG (suporta transparência).
 * Retorna { buffer, contentType, fileName } ou o original em caso de falha.
 */
async function resizeImageIfNeeded(buffer, contentType, fileName) {
  try {
    const meta = await sharp(buffer).metadata();
    const needsResize = (meta.width || 0) > MAX_IMAGE_WIDTH || buffer.length > MAX_IMAGE_BYTES;
    if (!needsResize) return { buffer, contentType, fileName };

    const isPng = contentType === 'image/png';
    let pipeline = sharp(buffer).resize(MAX_IMAGE_WIDTH, null, { withoutEnlargement: true });
    let newContentType, newFileName;

    if (isPng) {
      pipeline    = pipeline.png({ compressionLevel: 8 });
      newContentType = 'image/png';
      newFileName    = fileName.replace(/\.[^.]+$/, '.png') || 'imagem.png';
    } else {
      pipeline    = pipeline.jpeg({ quality: 85, progressive: true });
      newContentType = 'image/jpeg';
      newFileName    = fileName.replace(/\.[^.]+$/, '.jpg') || 'imagem.jpg';
    }

    const resized = await pipeline.toBuffer();
    console.log(`[img-resize] ${buffer.length} → ${resized.length} bytes (${meta.width}px → ≤${MAX_IMAGE_WIDTH}px)`);
    return { buffer: resized, contentType: newContentType, fileName: newFileName };
  } catch (e) {
    console.warn('[img-resize] falhou, usando original:', e.message);
    return { buffer, contentType, fileName };
  }
}

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

/**
 * Resolve o buffer de imagem a partir de article.image_base64 (postagem manual)
 * ou baixando article.image_url (artigo de scraping). Retorna null se não houver imagem.
 */
async function resolveImageBuffer(article) {
  if (article.image_base64) {
    const buffer      = Buffer.from(article.image_base64, 'base64');
    const contentType = article.image_mime || 'image/jpeg';
    const rawName     = article.image_name || 'imagem.jpg';
    const fileName    = rawName.replace(/\.(jpe?g|jfif|jpg|png|webp|gif|avif|svg).*$/i, (m) => m.split('?')[0]) || 'imagem.jpg';
    return resizeImageIfNeeded(buffer, contentType, fileName);
  }
  if (article.image_url) {
    let buffer, contentType;

    try {
      const imgRes = await axios.get(article.image_url, {
        responseType: 'arraybuffer', timeout: 15000, httpsAgent: HTTPS_AGENT,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          'Referer': (() => { try { return new URL(article.image_url).origin + '/'; } catch { return article.image_url; } })(),
        },
      });
      buffer      = Buffer.from(imgRes.data);
      contentType = imgRes.headers['content-type']?.split(';')[0].trim() || 'image/jpeg';
    } catch (e) {
      // Fallback CF Worker para domínios bloqueados na Oracle Cloud (sc.gov.br etc)
      const cfProxy = require('../utils/cf-proxy');
      if (cfProxy.needsCFProxy(article.image_url) && cfProxy.isAvailable()) {
        console.log(`[img-fetch] axios falhou (${e.message}), tentando CF Worker: ${article.image_url}`);
        const resp = await cfProxy.fetchViaCFProxy(article.image_url, { responseType: 'arraybuffer', timeout: 20000 });
        buffer      = Buffer.from(resp.data);
        contentType = resp.headers['content-type']?.split(';')[0].trim() || 'image/jpeg';
        console.log(`[img-fetch] CF Worker OK: ${buffer.length} bytes (${contentType})`);
      } else {
        throw e;
      }
    }

    const extMap = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
                     'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg' };
    const extFromCt = extMap[contentType] || 'jpg';
    const rawName   = article.image_url.split('/').pop().split('?')[0] || '';
    const fileName  = rawName.replace(/\.(jpe?g|jfif|jpg|png|webp|gif|avif|svg).*$/i, (m) => m)
                      || `imagem.${extFromCt}`;
    return resizeImageIfNeeded(buffer, contentType, fileName);
  }
  return null;
}

/**
 * Faz upload de imagem para a biblioteca de mídia do WordPress via multipart/form-data.
 * Retorna o media_id ou null em caso de falha.
 */
async function uploadImageToWP(baseUrl, wpHeaders, img) {
  const form = new FormData();
  form.append('file', img.buffer, { filename: img.fileName, contentType: img.contentType });
  const uploadRes = await axios.post(`${baseUrl}/wp-json/wp/v2/media`, form, {
    timeout: 20000,
    httpsAgent: HTTPS_AGENT,
    maxContentLength: Infinity,
    maxBodyLength:    Infinity,
    headers: { ...wpHeaders, 'Accept': 'application/json', ...form.getHeaders() },
  });
  return { id: uploadRes.data?.id || null, url: uploadRes.data?.source_url || null };
}

// ── Publicação via Plugin XMNews Publisher (modo preferencial) ───────────────
// Usado quando o site tem o plugin XMNews Publisher instalado e a chave configurada.
// O plugin (v2.1.0+) gerencia download de imagem, featured_media e corpo em ambos os modos:
//   'editorial' — imagem injetada no corpo + featured_media
//   'standard'  — apenas featured_media (tema exibe a imagem via featured_media)
async function publishViaPlugin(site, rewritten, article) {
  const baseUrl = (site.site_url || '').replace(/\/$/, '');
  const apiKey  = site.xixo_api_key;

  if (!baseUrl || !apiKey) throw new Error('URL ou chave do plugin XMNews Publisher não configurada.');

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

  // Pré-upload da imagem: o backend baixa a imagem da fonte (VPS tem acesso) e sobe
  // para a biblioteca de mídia do WP antes de chamar o plugin. O plugin recebe a URL
  // já hospedada no próprio WP → download instantâneo, sem timeout por CDNs bloqueadas.
  // Fallback: se não houver wp_app_password, tenta a URL original; se inacessível, publica sem imagem.
  let imageUrlParaPlugin = article.image_url || '';

  if (imageUrlParaPlugin && site.wp_app_password && site.wp_username) {
    try {
      const password  = decryptToken(site.wp_app_password);
      const wpAuth    = Buffer.from(`${site.wp_username}:${password}`).toString('base64');
      const wpHeaders = { Authorization: `Basic ${wpAuth}` };
      const img = await resolveImageBuffer({ image_url: imageUrlParaPlugin });
      if (img) {
        const { id: mediaId, url: mediaUrl } = await uploadImageToWP(baseUrl, wpHeaders, img);
        if (mediaUrl) {
          console.log(`[plugin] pré-upload OK: ${imageUrlParaPlugin} → ${mediaUrl}`);
          imageUrlParaPlugin = mediaUrl;
        }
      }
    } catch (e) {
      console.warn(`[plugin] pré-upload falhou (${e.message}), tentando URL original`);
      // 403 = WAF bloqueia o VPS mas a URL é pública (browsers acessam normalmente)
      // Só limpa a imagem se o erro não foi 403 e a URL também falha no HEAD
      if (e.response?.status !== 403 && !/403/.test(e.message)) {
        try {
          await axios.head(imageUrlParaPlugin, { timeout: 4000, httpsAgent: HTTPS_AGENT,
            headers: { 'User-Agent': 'Mozilla/5.0' } });
        } catch {
          console.warn(`[plugin] URL original inacessível, publicando sem imagem`);
          imageUrlParaPlugin = '';
        }
      }
    }
  } else if (imageUrlParaPlugin || article.image_base64) {
    // Sem credenciais WP: resolve imagem (base64 ou URL) e serve via temp file no backend.
    // O plugin baixa do nosso servidor em vez da CDN original ou de memória do frontend.
    try {
      const imgSource = article.image_base64
        ? { image_base64: article.image_base64, image_mime: article.image_mime, image_name: article.image_name }
        : { image_url: imageUrlParaPlugin };
      const img = await resolveImageBuffer(imgSource);
      if (img) {
        const backendUrl = (process.env.BACKEND_URL || '').replace(/\/$/, '');
        if (backendUrl && !backendUrl.includes('localhost')) {
          if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
          const ext      = img.fileName.split('.').pop() || 'jpg';
          const tmpName  = `tmp_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
          const tmpPath  = path.join(UPLOADS_DIR, tmpName);
          fs.writeFileSync(tmpPath, img.buffer);
          imageUrlParaPlugin = `${backendUrl}/uploads/${tmpName}`;
          // Limpa o arquivo temporário após 15 minutos
          setTimeout(() => { try { fs.unlinkSync(tmpPath); } catch {} }, 15 * 60 * 1000);
          console.log(`[plugin] temp img: ${img.buffer.length} bytes → ${imageUrlParaPlugin}`);
        }
        // Em localhost (dev): usa URL original — plugin não consegue acessar localhost de fora
      }
    } catch (e) {
      console.warn(`[plugin] temp img falhou (${e.message}), tentando URL original`);
    }
    // Verifica se URL final ainda é acessível; se não, publica sem imagem
    if (imageUrlParaPlugin) {
      try {
        await axios.head(imageUrlParaPlugin, { timeout: 5000, httpsAgent: HTTPS_AGENT,
          headers: { 'User-Agent': 'Mozilla/5.0' } });
      } catch {
        console.warn(`[plugin] URL final inacessível, publicando sem imagem`);
        imageUrlParaPlugin = '';
      }
    }
  }

  console.log(`[plugin] publicando post_format=${postFormat} image_url=${imageUrlParaPlugin || '(sem imagem)'} site=${site.name}`);

  const payload = {
    title:       rewritten.title       || '',
    chapeu:      rewritten.chapeu      || '',
    summary:     rewritten.summary     || '',
    body:        rewritten.body        || '',
    slug:        slugify(rewritten.title),
    source_url:  article.external_url  || '',
    source_name: nomefonte,
    image_url:   imageUrlParaPlugin,
    post_format: postFormat,
    tags:        rewritten.tags        || [],
    category_ids: rewritten.category_ids?.length ? rewritten.category_ids : (rewritten.category_id ? [rewritten.category_id] : []),
  };

  const res = await axios.post(`${baseUrl}/wp-json/xmn/v1/publish`, payload, {
    timeout:    60000,
    httpsAgent: HTTPS_AGENT,
    headers: {
      'Content-Type': 'application/json',
      'X-XMNews-Key': apiKey,
    },
  });

  const data = res.data;
  if (!data?.success || !data?.post_id) {
    throw new Error(data?.error || 'Resposta inesperada do plugin XMNews Publisher.');
  }

  const postId  = String(data.post_id);
  const postUrl = data.post_url;

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

  // Plugin XMNews Publisher tem prioridade — não precisa de wp_app_password
  if (site.xixo_api_key) {
    return publishViaPlugin(site, rewritten, article);
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
  let featuredMediaId  = article.image_media_id || null; // pré-carregado pelo frontend
  let featuredMediaUrl = article.image_url || null;

  // Se a imagem não foi pré-carregada, faz download da URL e sobe ao WP media
  if (!featuredMediaId && article.image_url) {
    try {
      const img = await resolveImageBuffer(article);
      if (img) {
        const wpHeaders = { Authorization: authHeader['Authorization'] };
        const { id: mediaId } = await uploadImageToWP(baseUrl, wpHeaders, img);
        if (mediaId) {
          featuredMediaId  = mediaId;
          featuredMediaUrl = article.image_url;
        }
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
  const catIds = rewritten.category_ids?.length ? rewritten.category_ids : (rewritten.category_id ? [rewritten.category_id] : []);
  if (catIds.length) postBody.categories = catIds;
  if (featuredMediaId)        postBody.featured_media = featuredMediaId;

  const postRes = await axiosWP.post('/wp-json/wp/v2/posts', postBody);
  const post = postRes.data;
  if (!post?.id) throw new Error(post?.message || 'Erro ao criar post no WordPress.');

  return { post_id: String(post.id), post_url: post.link };
}

module.exports = { publishToWordPress };
