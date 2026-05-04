'use strict';

/**
 * scrapers/full-content.js
 * Busca o conteúdo completo de um artigo via scraping da URL original.
 * Retorna { body, image_url } — ambos podem ser null.
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const https   = require('https');
const { normalizeBody }                     = require('./normalizer');
const { fetchWithHeadless, isJsRenderedSite } = require('./headless-content');

const USER_AGENT  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HTTPS_AGENT = new https.Agent({ rejectUnauthorized: false });

// Seletores de conteúdo, do mais específico ao mais amplo
const CONTENT_SELECTORS = [
  '[itemprop="articleBody"]',
  'article .entry-content',
  'article .post-content',
  'article .article-body',
  '.noticia-corpo',
  '.conteudo-noticia',
  '.texto-noticia',
  '.noticia-conteudo',
  '.article-text',
  '.elementor-widget-theme-post-content',
  'article',
  '.entry-content',
  '.post-content',
  '.article-content',
  '.article-body',
  '.content-body',
  'main article',
  'main .content',
  'main',
];

/**
 * Normaliza uma URL de imagem para absoluta.
 * Lida com: http/https, protocol-relative (//), relativa (/).
 */
function normalizarUrlImagem(src, baseUrl) {
  if (!src || typeof src !== 'string') return null;
  src = src.trim();
  if (src.startsWith('http://') || src.startsWith('https://')) return src;
  if (src.startsWith('//')) return 'https:' + src;
  if (src.startsWith('/') && baseUrl) {
    try {
      const u = new URL(baseUrl);
      return u.origin + src;
    } catch { return null; }
  }
  if (src.startsWith('./') || (!src.startsWith('data:') && !src.startsWith('#'))) {
    try {
      return new URL(src, baseUrl).href;
    } catch { return null; }
  }
  return null;
}

/**
 * Extrai a imagem destacada da página do artigo.
 * Prioridade: og:image > twitter:image > primeira <img> grande no conteúdo.
 */
function extrairImagemDestacada($, bodyHtml, baseUrl) {
  // 1. og:image — a mais confiável
  const ogRaw = $('meta[property="og:image"]').attr('content') ||
                $('meta[name="og:image"]').attr('content');
  const og = normalizarUrlImagem(ogRaw, baseUrl);
  if (og) return og;

  // 2. twitter:image
  const twRaw = $('meta[name="twitter:image"]').attr('content') ||
                $('meta[property="twitter:image"]').attr('content');
  const tw = normalizarUrlImagem(twRaw, baseUrl);
  if (tw) return tw;

  // 3. JSON-LD image
  try {
    $('script[type="application/ld+json"]').each((_, el) => {
      const json = JSON.parse($(el).html() || '{}');
      const entries = Array.isArray(json['@graph']) ? json['@graph'] : [json];
      for (const entry of entries) {
        const img = entry.image?.url || entry.image || entry.thumbnailUrl;
        if (img && typeof img === 'string') {
          const u = normalizarUrlImagem(img, baseUrl);
          if (u) throw { found: u }; // break via throw
        }
      }
    });
  } catch (e) {
    if (e.found) return e.found;
  }

  // 4. Primeira <img> grande dentro do conteúdo do artigo
  if (bodyHtml) {
    const $b = cheerio.load(bodyHtml);
    let found = null;
    $b('img').each((_, el) => {
      const srcRaw = $b(el).attr('src') || $b(el).attr('data-src') || $b(el).attr('data-lazy-src') || '';
      const src    = normalizarUrlImagem(srcRaw, baseUrl);
      const width  = parseInt($b(el).attr('width')  || '0', 10);
      const height = parseInt($b(el).attr('height') || '0', 10);
      if (width  > 0 && width  < 200) return;
      if (height > 0 && height < 150) return;
      if (src) { found = src; return false; }
    });
    if (found) return found;
  }

  // 5. Qualquer <img> relevante no corpo da página
  const candidatos = [];
  $('img').each((_, el) => {
    const srcRaw = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src') || '';
    const src    = normalizarUrlImagem(srcRaw, baseUrl);
    if (!src) return;
    // Filtra SVGs (geralmente ícones/logos)
    if (src.match(/\.svg(\?|$)/i)) return;
    // Filtra imagens de tema/template (WordPress, Drupal, etc.)
    if (src.match(/\/themes\/|\/wp-content\/themes\/|\/assets\/img\/|\/static\/img\//i)) return;
    // Filtra ícones, logos, banners, trackers
    if (src.match(/\/logo[s-]|[_-]logo\.|\/icon[s_-]|account\.|avatar|sprite|pixel|tracking|\/banner|\/ads?\/|adserver|doubleclick|favicon|search\.svg|account\.svg/i)) return;
    const w = parseInt($(el).attr('width')  || '0', 10);
    const h = parseInt($(el).attr('height') || '0', 10);
    if (w > 0 && w < 200) return;
    if (h > 0 && h < 150) return;
    const cls   = ($(el).attr('class') || '').toLowerCase();
    const type  = ($(el).attr('typeof') || '').toLowerCase(); // Drupal usa typeof="foaf:Image"
    // Prioridade: imagens de conteúdo do CMS (uploads do usuário)
    let score = 1;
    if (src.match(/\/sites\/default\/files\/|\/uploads\/|\/wp-content\/uploads\//i)) score += 20;
    if (cls.match(/featured|thumbnail|thumb|destaque|principal|hero|post-image|wp-post|image-style/i)) score += 10;
    if (type.includes('foaf:image')) score += 15; // Drupal article image
    candidatos.push({ src, score });
  });

  if (candidatos.length > 0) {
    candidatos.sort((a, b) => b.score - a.score);
    return candidatos[0].src;
  }

  return null;
}

/**
 * Quando a fonte tem extract_body_image=true:
 * Extrai a primeira imagem válida do corpo como imagem destacada.
 * Remove essa imagem do corpo para evitar duplicação no WordPress.
 * Demais imagens permanecem no corpo normalmente.
 *
 * @param {string} bodyHtml - HTML do corpo já normalizado
 * @param {string} baseUrl  - URL base para resolver caminhos relativos
 * @returns {{ image_url: string|null, body: string }}
 */
function extrairImagemDoCorpo(bodyHtml, baseUrl) {
  if (!bodyHtml) return { image_url: null, body: bodyHtml };

  const $b = cheerio.load(bodyHtml);
  let primeiraImagem = null;

  $b('img').each((_, el) => {
    if (primeiraImagem) return false; // já achou, para
    const srcRaw = $b(el).attr('src') || $b(el).attr('data-src') || $b(el).attr('data-lazy-src') || '';
    const src    = normalizarUrlImagem(srcRaw, baseUrl);
    if (!src) return;
    // Ignora SVGs, ícones, logos
    if (src.match(/\.svg(\?|$)/i)) return;
    if (src.match(/logo|icon|favicon|sprite|pixel|tracking/i)) return;
    // Ignora imagens muito pequenas
    const w = parseInt($b(el).attr('width')  || '0', 10);
    const h = parseInt($b(el).attr('height') || '0', 10);
    if (w > 0 && w < 100) return;
    if (h > 0 && h < 80)  return;
    primeiraImagem = src;
    // Remove essa imagem do corpo (e o container <p> vazio que sobra, se houver)
    const parent = $b(el).parent();
    $b(el).remove();
    if (parent.is('p, figure, div') && parent.children().length === 0 && !parent.text().trim()) {
      parent.remove();
    }
  });

  return {
    image_url: primeiraImagem,
    body: $b('body').html() || bodyHtml,
  };
}

/**
 * Busca, normaliza e retorna o conteúdo completo de um artigo.
 *
 * @param {string} url        - URL do artigo
 * @param {object} [source]   - Config da fonte (content_selector, url, category, extract_body_image)
 * @returns {{ body: string|null, image_url: string|null }}
 */
async function fetchFullContent(url, source) {
  try {
    const resp = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        // Envia Referer como sendo o próprio domínio — evita bloqueio de hotlink
        'Referer': (() => { try { return new URL(url).origin + '/'; } catch { return url; } })(),
      },
      httpsAgent: HTTPS_AGENT,
    });

    const $ = cheerio.load(resp.data);
    let rawHtml = '';

    // Tenta seletor configurado na fonte
    const cfgSel = source?.scraping?.contentSelector || source?.content_selector;
    if (cfgSel) {
      const $el = $(cfgSel);
      if ($el.length && $el.text().trim().length > 100) {
        rawHtml = $el.html() || '';
      }
    }

    // Remove lixo do DOM (meta tags no <head> NÃO são afetadas)
    $('script, style, nav, footer, .ad, .ads, aside, .comments, .related, iframe, noscript, .sidebar, .menu, .share, .social, .tags-list, .breadcrumb').remove();

    // Tenta seletores genéricos
    if (!rawHtml) {
      for (const sel of CONTENT_SELECTORS) {
        const $el = $(sel);
        if ($el.length && $el.text().trim().length > 150) {
          rawHtml = $el.html() || '';
          break;
        }
      }
    }

    // Normaliza o body extraído
    let body = rawHtml ? (normalizeBody(rawHtml, url) || null) : null;

    // Extrai imagem destacada
    // Se extract_body_image=true: pega da 1ª img do corpo (remove ela do corpo)
    // Caso contrário: usa og:image / twitter:image / JSON-LD como antes
    let image_url;
    if (source?.extract_body_image && body) {
      const extracted = extrairImagemDoCorpo(body, url);
      image_url = extracted.image_url;
      body      = extracted.body;
      console.log(`[full-content] extract_body_image: ${image_url || 'nenhuma imagem encontrada'}`);
    } else {
      image_url = extrairImagemDestacada($, body, url);
    }

    // ── Fallback headless: aciona Puppeteer quando o scraping estático falhou ──
    //
    // Condições para usar o headless browser:
    //   1. Body estático ausente ou muito curto (< 200 chars de texto)
    //   2. HTML da página indica renderização por JavaScript (Wix, React SPA, etc.)
    //
    // Portais que já funcionam estaticamente (WordPress, etc.) nunca entram aqui.
    //
    const bodyTextLen = (body || '').replace(/<[^>]*>/g, '').trim().length;
    if (bodyTextLen < 200 && isJsRenderedSite(resp.data || '')) {
      console.log(`[full-content] Site JS-rendered detectado, usando headless: ${url}`);
      const headless = await fetchWithHeadless(url);
      const headlessLen = (headless.body || '').replace(/<[^>]*>/g, '').trim().length;
      if (headlessLen > bodyTextLen) {
        body = headless.body;
      }
      if (!image_url && headless.image_url) {
        image_url = headless.image_url;
      }
    }

    return { body, image_url };

  } catch {
    return { body: null, image_url: null };
  }
}

module.exports = { fetchFullContent };
