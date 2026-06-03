'use strict';

const axios    = require('axios');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const FormData = require('form-data');
const sharp    = require('sharp');
const { decryptToken } = require('./encrypt');

const UPLOADS_DIR     = path.join(__dirname, '..', 'uploads');
// Diretório público (servido pelo nginx via /api/uploads/) — usado para temp files de imagem
const PUBLIC_UPLOADS_DIR = path.join(__dirname, '..', 'public', 'uploads');

const HTTPS_AGENT = new https.Agent({ rejectUnauthorized: false });

const MAX_IMAGE_WIDTH = 1000;
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024; // 1.5 MB

// Extensões que o WordPress NÃO aceita por padrão na biblioteca de mídia.
// Imagens com essas extensões (ex: .jfif da Pref. de Tubarão) são convertidas para JPEG.
const WP_UNSUPPORTED_EXT = /\.(jfif|avif|heic|heif|bmp|tiff?|jp2|jpe|pjpeg|pjp)(\?.*)?$/i;
// Formatos (detectados pelo sharp) que o WP aceita — os demais viram JPEG.
const WP_OK_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif']);

// True se a URL aponta para um formato que o WP rejeita no upload.
function precisaConverterParaWP(url) {
  return WP_UNSUPPORTED_EXT.test(url || '');
}

// Salva um buffer de imagem como arquivo temporário público (servido via /api/uploads/),
// para o plugin baixar. Auto-deletado após 15 min. Retorna a URL pública ou null.
function criarTempImagemPublica(img) {
  const backendUrl = (process.env.BACKEND_URL || '').replace(/\/$/, '');
  if (!backendUrl || backendUrl.includes('localhost')) return null;
  if (!fs.existsSync(PUBLIC_UPLOADS_DIR)) fs.mkdirSync(PUBLIC_UPLOADS_DIR, { recursive: true });
  const ext     = (img.fileName.split('.').pop() || 'jpg').toLowerCase();
  const tmpName = `tmp_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
  const tmpPath = path.join(PUBLIC_UPLOADS_DIR, tmpName);
  fs.writeFileSync(tmpPath, img.buffer);
  setTimeout(() => { try { fs.unlinkSync(tmpPath); } catch {} }, 15 * 60 * 1000);
  return `${backendUrl}/api/uploads/${tmpName}`;
}

/**
 * Redimensiona a imagem para no máximo MAX_IMAGE_WIDTH de largura.
 * Converte AVIF/WebP/JFIF para JPEG. PNG permanece PNG (suporta transparência).
 * Retorna { buffer, contentType, fileName } ou o original em caso de falha.
 */
async function resizeImageIfNeeded(buffer, contentType, fileName) {
  const trocarExt = (nome, ext) => ((nome || 'imagem').replace(/\.[^.]+$/, '') || 'imagem') + '.' + ext;
  const extSegura = (nome) => /\.(jpe?g|png|webp|gif)$/i.test(nome || '');
  try {
    const meta = await sharp(buffer).metadata();
    const fmt  = meta.format; // sharp lê .jfif como 'jpeg'; .avif/.heic como 'avif'/'heif'
    const formatoOk   = WP_OK_FORMATS.has(fmt);
    const needsResize = (meta.width || 0) > MAX_IMAGE_WIDTH || buffer.length > MAX_IMAGE_BYTES;

    // Caso ideal: formato suportado e sem resize. Só normaliza a extensão se vier suja (.jfif etc).
    if (formatoOk && !needsResize) {
      if (extSegura(fileName)) return { buffer, contentType, fileName };
      const ext = fmt === 'jpeg' ? 'jpg' : fmt;
      return { buffer, contentType: `image/${fmt}`, fileName: trocarExt(fileName, ext) };
    }

    // Precisa reencodar (resize e/ou formato não suportado).
    // PNG/WebP/GIF mantêm formato; tudo o mais (incl. jfif/avif/heic) vira JPEG.
    const outFmt = formatoOk ? fmt : 'jpeg';
    let pipeline = sharp(buffer);
    if (needsResize) pipeline = pipeline.resize(MAX_IMAGE_WIDTH, null, { withoutEnlargement: true });

    let outBuffer, newContentType, ext;
    if (outFmt === 'png')       { outBuffer = await pipeline.png({ compressionLevel: 8 }).toBuffer();            newContentType = 'image/png';  ext = 'png'; }
    else if (outFmt === 'webp') { outBuffer = await pipeline.webp({ quality: 85 }).toBuffer();                   newContentType = 'image/webp'; ext = 'webp'; }
    else if (outFmt === 'gif')  { outBuffer = await pipeline.gif().toBuffer();                                   newContentType = 'image/gif';  ext = 'gif'; }
    else                        { outBuffer = await pipeline.jpeg({ quality: 85, progressive: true }).toBuffer(); newContentType = 'image/jpeg'; ext = 'jpg'; }

    const newFileName = trocarExt(fileName, ext);
    const motivo = !formatoOk ? `formato ${fmt}→${ext}` : `resize ${meta.width}px`;
    console.log(`[img-resize] ${buffer.length} → ${outBuffer.length} bytes (${motivo})`);
    return { buffer: outBuffer, contentType: newContentType, fileName: newFileName };
  } catch (e) {
    console.warn('[img-resize] falhou, normalizando extensão:', e.message);
    // Nunca devolve extensão que o WP rejeita — assume jpeg no pior caso
    if (extSegura(fileName)) return { buffer, contentType, fileName };
    return { buffer, contentType: 'image/jpeg', fileName: trocarExt(fileName, 'jpg') };
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

  // Imagem para o plugin:
  // - Criar Post (pré-upload OK): image_media_id já existe no WP → plugin usa diretamente sem download
  // - Criar Post (pré-upload falhou, image_base64 presente): cria temp file acessível via /api/uploads/
  // - Autopub com formato não suportado (.jfif etc): baixa, converte p/ JPEG e serve via temp file
  // - Autopub com formato OK: passa image_url direta → plugin faz download_url() internamente
  let imageUrlParaPlugin = article.image_url || '';

  if (imageUrlParaPlugin && article.image_media_id) {
    // Imagem já na biblioteca do WP — plugin usa image_media_id direto, sem download
    console.log(`[plugin] imagem pré-carregada (media_id=${article.image_media_id}): ${imageUrlParaPlugin}`);
  } else if (!imageUrlParaPlugin && article.image_base64) {
    // Criar Post sem URL (upload-image falhou): serve a imagem via temp file no backend
    try {
      const img = await resolveImageBuffer({
        image_base64: article.image_base64,
        image_mime:   article.image_mime,
        image_name:   article.image_name,
      });
      const tempUrl = img && criarTempImagemPublica(img);
      if (tempUrl) {
        imageUrlParaPlugin = tempUrl;
        console.log(`[plugin] temp img base64: ${img.buffer.length}b → ${imageUrlParaPlugin}`);
      }
    } catch (e) {
      console.warn(`[plugin] temp img falhou (${e.message}), publicando sem imagem`);
    }
  } else if (imageUrlParaPlugin && precisaConverterParaWP(imageUrlParaPlugin)) {
    // Formato que o WP rejeita (.jfif da Pref. de Tubarão etc): baixa, converte p/ JPEG e serve via temp file
    try {
      const img = await resolveImageBuffer({ image_url: imageUrlParaPlugin });
      const tempUrl = img && criarTempImagemPublica(img);
      if (tempUrl) {
        console.log(`[plugin] imagem convertida p/ WP: ${imageUrlParaPlugin} → ${tempUrl}`);
        imageUrlParaPlugin = tempUrl;
      } else {
        console.warn(`[plugin] não foi possível converter ${imageUrlParaPlugin} — passando URL original`);
      }
    } catch (e) {
      console.warn(`[plugin] conversão de imagem falhou (${e.message}), passando URL original`);
    }
  }
  // Demais casos (autopub com formato suportado): plugin recebe a URL original e chama download_url() internamente

  console.log(`[plugin] publicando post_format=${postFormat} image_url=${imageUrlParaPlugin || '(sem imagem)'} site=${site.name}`);

  // Remove <img> e <figure> do corpo — a imagem principal vai SOMENTE via image_url/featured_media.
  // Sem essa limpeza, imagens embutidas no HTML raspado (ex: "Leia Mais" de portais como CNN Brasil)
  // ficam visíveis no corpo do post como thumbnails pequenos de outros artigos.
  // Mesmo comportamento já adotado em publishToWordPress() para o caminho sem plugin.
  const bodyLimpo = (rewritten.body || '')
    .replace(/<figure\b[^>]*>[\s\S]*?<\/figure>/gi, '')
    .replace(/<img\b[^>]*\/?>/gi, '');

  const payload = {
    title:          rewritten.title       || '',
    chapeu:         rewritten.chapeu      || '',
    summary:        rewritten.summary     || '',
    body:           bodyLimpo,
    slug:           slugify(rewritten.title),
    source_url:     article.external_url  || '',
    source_name:    nomefonte,
    image_url:      imageUrlParaPlugin,
    // Quando a imagem foi pré-carregada pelo backend (Criar Post), o media_id
    // já existe na biblioteca do WP. O plugin usa diretamente sem novo download.
    image_media_id: (imageUrlParaPlugin && article.image_media_id) ? article.image_media_id : 0,
    post_format:    postFormat,
    tags:           rewritten.tags        || [],
    category_ids:   rewritten.category_ids?.length ? rewritten.category_ids : (rewritten.category_id ? [rewritten.category_id] : []),
  };

  const res = await axios.post(`${baseUrl}/wp-json/xmn/v1/publish`, payload, {
    timeout:    120000,   // 2 min — plugin precisa de tempo para download_url() + sideload de imagens grandes
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

module.exports = { publishToWordPress, resizeImageIfNeeded, precisaConverterParaWP, resolveImageBuffer, criarTempImagemPublica };
