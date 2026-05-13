'use strict';

/**
 * scrapers/full-content.js
 * Busca o conteúdo completo de um artigo via scraping da URL original.
 * Retorna { body, image_url } — ambos podem ser null.
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const https   = require('https');
const iconv   = require('iconv-lite');
const { Readability }                         = require('@mozilla/readability');
const { JSDOM }                               = require('jsdom');
const { normalizeBody }                       = require('./normalizer');
const { fetchWithHeadless, isJsRenderedSite } = require('./headless-content');

const USER_AGENT  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HTTPS_AGENT = new https.Agent({ rejectUnauthorized: false });

// Seletores de conteúdo, do mais específico ao mais amplo
const CONTENT_SELECTORS = [
  '[itemprop="articleBody"]',
  // Assembleia RS (Drupal) — ww4.al.rs.gov.br
  '.field--type-text-with-summary',
  '.field--name-body',
  '.node__content .clearfix',
  // Portal do Agronegócio
  '.noticeCont',
  // Brasil Paralelo (Next.js/Tailwind)
  '.prose',
  // Elementor WordPress — post content e text editor
  '.elementor-widget-theme-post-content',
  '.elementor-widget-text-editor .elementor-widget-container',
  '.elementor-text-editor',
  // atende.net (prefeituras RS/SC)
  '.descricao',
  // Demais
  'article .entry-content',
  'article .post-content',
  'article .article-body',
  '.noticia-corpo',
  '.conteudo-noticia',
  '.texto-noticia',
  '.noticia-conteudo',
  '.article-text',
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
  let resolved = null;
  if (src.startsWith('http://') || src.startsWith('https://')) {
    resolved = src;
  } else if (src.startsWith('//')) {
    resolved = 'https:' + src;
  } else if (src.startsWith('/') && baseUrl) {
    try {
      const u = new URL(baseUrl);
      resolved = u.origin + src;
    } catch { return null; }
  } else if (src.startsWith('./') || (!src.startsWith('data:') && !src.startsWith('#'))) {
    try {
      resolved = new URL(src, baseUrl).href;
    } catch { return null; }
  }
  if (!resolved) return null;
  // Wix CDN: remove parâmetros de transformação para obter imagem em resolução original.
  // Placeholder borrado: .../media/abc~mv2.jpg/v1/fill/w_25,h_25,blur_30,.../abc~mv2.jpg
  // Após fix:            .../media/abc~mv2.jpg
  const wixMatch = resolved.match(/^(https:\/\/static\.wixstatic\.com\/media\/[^/]+\.[a-z0-9]+)\/.+/i);
  if (wixMatch) return wixMatch[1];
  return resolved;
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
// Domínios conhecidos por serem lentos — usam timeout maior
const SLOW_DOMAINS = ['al.rs.gov.br', 'al.sc.gov.br', 'alesc.sc.gov.br', '.gov.br', 'atende.net', 'sc.gov.br'];

async function fetchFullContent(url, source) {
  try {
    // Timeout maior para domínios governamentais reconhecidamente lentos
    const isSlowDomain = SLOW_DOMAINS.some(d => url.includes(d));
    const timeout = isSlowDomain ? 30000 : 15000;

    const resp = await axios.get(url, {
      timeout,
      responseType: 'arraybuffer', // necessário para decodificar charset corretamente
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        // Envia Referer como sendo o próprio domínio — evita bloqueio de hotlink
        'Referer': (() => { try { return new URL(url).origin + '/'; } catch { return url; } })(),
      },
      httpsAgent: HTTPS_AGENT,
    });

    // Detecta charset a partir do Content-Type e decodifica corretamente
    // Sites de prefeitura (atende.net, etc.) usam iso-8859-1
    const contentType = resp.headers['content-type'] || '';
    const charsetMatch = contentType.match(/charset=([^\s;]+)/i);
    const charset = charsetMatch ? charsetMatch[1].toLowerCase().replace('iso8859', 'iso-8859') : 'utf-8';
    const htmlDecoded = iconv.decode(Buffer.from(resp.data), charset);

    // Usa HTML decodificado com charset correto
    const $ = cheerio.load(htmlDecoded);
    let rawHtml = '';

    // Antes de remover atributos: converte data-src/data-lazy-src → src em <img>
    // (sites com lazy loading usam src vazio ou placeholder data: URI)
    $('img').each((_, el) => {
      const src = $(el).attr('src') || '';
      const isPlaceholder = !src || src.startsWith('data:');
      if (!isPlaceholder) return;
      const real = $(el).attr('data-src') || $(el).attr('data-lazy-src') || $(el).attr('data-original') || $(el).attr('data-img-url') || '';
      if (real) $(el).attr('src', real);
    });

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

    // ── Mozilla Readability — extração automática sem seletor manual ──────────
    // Funciona como o Modo Leitura do Firefox: identifica o artigo principal
    // independente do tema/CMS. Usado quando não há content_selector configurado.
    if (!rawHtml) {
      try {
        const dom    = new JSDOM(htmlDecoded, { url });
        const reader = new Readability(dom.window.document, { charThreshold: 300 });
        const parsed = reader.parse();
        if (parsed?.content) {
          const textLen = parsed.content.replace(/<[^>]*>/g, '').trim().length;
          if (textLen >= 300) {
            rawHtml = parsed.content;
            console.log(`[full-content] Readability OK (${textLen}c): ${url}`);
          }
        }
      } catch (e) {
        console.log(`[full-content] Readability falhou, usando seletores CSS: ${e.message}`);
      }
    }

    // Tenta seletores genéricos (fallback quando Readability não extrai bem)
    if (!rawHtml) {
      for (const sel of CONTENT_SELECTORS) {
        const $el = $(sel);
        if (!$el.length) continue;

        // Quando há múltiplos elementos com o mesmo seletor (ex: .descricao no atende.net),
        // coleta apenas os que têm conteúdo textual real e os concatena.
        if ($el.length > 1) {
          const partes = [];
          $el.each((_, el) => {
            const txt = $(el).text().trim();
            const h   = $(el).html() || '';
            if (txt.length > 80) partes.push(h);
          });
          if (partes.length > 0 && partes.join('').replace(/<[^>]*>/g,'').trim().length > 150) {
            rawHtml = partes.join('\n');
            break;
          }
        } else {
          const txt = $el.text().trim();
          if (txt.length > 150) {
            rawHtml = $el.html() || '';
            break;
          }
        }
      }
    }

    // Normaliza o body extraído
    let body = rawHtml ? (normalizeBody(rawHtml, url) || null) : null;

    // Extrai imagem destacada
    // Prioridade: featured_image_selector > extract_body_image > og:image automático
    let image_url;

    if (source?.featured_image_selector) {
      // Seletor CSS explícito configurado para esta fonte — prioridade máxima.
      // Suporta dois casos:
      //   1. Seletor aponta direto para <img> → usa src do próprio elemento
      //   2. Seletor aponta para container (div, figure, etc.) → procura <img> dentro
      const imgEl = $(source.featured_image_selector);
      imgEl.each((_, el) => {
        const $el = $(el);
        let srcRaw = $el.attr('src') || $el.attr('data-src') || $el.attr('data-lazy-src') || '';
        if (!srcRaw) {
          // Container: busca primeiro <img> dentro do elemento
          const inner = $el.find('img').first();
          srcRaw = inner.attr('src') || inner.attr('data-src') || inner.attr('data-lazy-src') || '';
        }
        const src = normalizarUrlImagem(srcRaw, url);
        if (src && !src.match(/\.svg(\?|$)/i)) { image_url = src; return false; }
      });
      console.log(`[full-content] featured_image_selector (${source.featured_image_selector}): ${image_url || 'não encontrada'}`);
    }

    if (!image_url) {
      if (source?.extract_body_image && body) {
        const extracted = extrairImagemDoCorpo(body, url);
        image_url = extracted.image_url;
        body      = extracted.body;
        console.log(`[full-content] extract_body_image: ${image_url || 'nenhuma imagem encontrada'}`);
      } else {
        image_url = extrairImagemDestacada($, body, url);
        console.log(`[full-content] image_url=${image_url || 'null'}`);
      }
    }

    // ── Fallback headless: aciona Puppeteer quando o scraping estático falhou ──
    //
    // Condições para usar o headless browser:
    //   1. Body ausente ou muito curto (< 200 chars) E site JS-rendered (Wix, React…)
    //   2. OU body completamente vazio (< 50 chars) — independente do tipo do site
    //      (cobre portais como atende.net onde o conteúdo real é carregado via AJAX)
    //
    const bodyTextLen = (body || '').replace(/<[^>]*>/g, '').trim().length;
    const needsHeadless = (bodyTextLen < 200 && isJsRenderedSite(htmlDecoded || ''))
                       || bodyTextLen < 50;

    if (needsHeadless) {
      console.log(`[full-content] Conteúdo insuficiente (${bodyTextLen}c), tentando headless: ${url}`);
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
