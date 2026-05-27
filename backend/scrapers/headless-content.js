'use strict';

/**
 * scrapers/headless-content.js
 *
 * Fallback de scraping usando Puppeteer (Chromium headless).
 * Só é acionado quando o scraping estático (axios + cheerio) retorna
 * conteúdo insuficiente E o HTML indica um site JS-rendered (ex: Wix).
 *
 * NÃO é chamado para portais que já funcionam com scraping estático.
 */

const cheerio       = require('cheerio');
const { normalizeBody } = require('./normalizer');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Tipos de recurso que podem ser bloqueados para acelerar o carregamento.
// Imagens são bloqueadas — o og:image vem do <meta>, não do download da imagem.
const BLOCK_TYPES = new Set(['image', 'stylesheet', 'font', 'media', 'ping', 'tracking']);

// Seletores tentados em ordem para extrair o corpo do artigo após renderização JS.
// Inclui seletores específicos de Wix, Elementor + genéricos.
const HEADLESS_SELECTORS = [
  // Wix Blog (público, sem autenticação)
  '[data-hook="post-description"]',
  '[class*="blog-post-page-font"]',
  // Elementor WordPress page builder (ex: Prefeitura de Torres/RS)
  '.elementor-widget-theme-post-content',
  '.elementor-widget-text-editor .elementor-widget-container',
  '.elementor-text-editor',
  // Genéricos — funcionam também em outros sites JS-rendered
  '[itemprop="articleBody"]',
  'article .entry-content',
  'article .post-content',
  '.entry-content',
  '.post-content',
  'article',
  'main',
];

/**
 * Detecta se o HTML estático de uma URL indica renderização via JavaScript.
 * Usado para decidir se vale a pena acionar o Puppeteer.
 *
 * @param {string} html - HTML bruto retornado pelo axios
 * @returns {boolean}
 */
function isJsRenderedSite(html) {
  // Wix — fingerprint confiável
  if (html.includes('static.wixstatic.com'))       return true;
  if (html.includes('"wixConfig"'))                 return true;
  if (html.includes('window.__WIX'))                return true;
  // React/Next.js — hydration markers
  if (html.includes('data-reactroot'))              return true;
  if (html.includes('__NEXT_DATA__'))               return true;
  // Sites que dependem de JS para carregar conteúdo (Angular, Vue, etc.)
  if (html.includes('ng-version='))                 return true;
  if (html.includes('data-server-rendered="true"')) return true;
  // Elementor WordPress page builder — conteúdo renderizado via JS
  if (html.includes('elementor-widget-container'))  return true;
  return false;
}

/**
 * Carrega a URL no Chromium headless, aguarda a renderização JS e extrai
 * o corpo do artigo + og:image.
 *
 * @param {string} url
 * @returns {Promise<{ body: string|null, image_url: string|null }>}
 */
async function fetchWithHeadless(url) {
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    console.warn('[headless] puppeteer não encontrado. Execute: npm install puppeteer');
    return { body: null, image_url: null, published_at: null };
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
      ],
      timeout: 30000,
    });

    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);

    // Bloqueia recursos que não contribuem para o conteúdo textual
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (BLOCK_TYPES.has(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Navega até a página e aguarda o JS renderizar o conteúdo
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });

    // Aguarda o seletor de artigo aparecer no DOM (máx 8s) — Wix demora um pouco
    try {
      await page.waitForFunction(
        selectors => selectors.some(s => {
          const el = document.querySelector(s);
          return el && el.innerText.trim().length > 100;
        }),
        { timeout: 8000 },
        HEADLESS_SELECTORS
      );
    } catch {
      // Se o wait timeout, tenta mesmo assim com o que foi renderizado
    }

    // Extrai og:image e data de publicação do <head>
    const { image_url, published_at: rawDate } = await page.evaluate(() => {
      const og = document.querySelector('meta[property="og:image"], meta[name="og:image"]');
      // Tenta article:published_time (Open Graph) primeiro, depois <time datetime>
      const metaDate = document.querySelector('meta[property="article:published_time"]');
      let dateStr = metaDate ? metaDate.getAttribute('content') : null;
      if (!dateStr) {
        const timeEl = document.querySelector('time[datetime]');
        if (timeEl) dateStr = timeEl.getAttribute('datetime');
      }
      return {
        image_url:    og ? og.getAttribute('content') : null,
        published_at: dateStr || null,
      };
    });
    // Valida antes de retornar — datetime não-ISO (ex: "22 de maio de 2026") causaria RangeError no pg
    const tryParseDate = s => { if (!s) return null; const d = new Date(s); return isNaN(d.getTime()) ? null : d.toISOString(); };
    const published_at = tryParseDate(rawDate);

    // Extrai corpo do artigo — tenta os seletores em ordem
    const rawHtml = await page.evaluate(selectors => {
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          if (el && el.innerText.trim().length > 150) {
            // Clona para não modificar o DOM ao limpar elementos indesejados
            const clone = el.cloneNode(true);
            // Remove elementos que não são conteúdo editorial
            const lixo = clone.querySelectorAll(
              'script, style, nav, footer, aside, .related, .comments, ' +
              '.social, .share, .tags, .ad, [class*="sidebar"], [class*="menu"], ' +
              '[class*="newsletter"], [class*="subscribe"], [class*="banner"]'
            );
            lixo.forEach(n => n.remove());
            return clone.innerHTML || '';
          }
        } catch { /* seletor inválido, continua */ }
      }

      // Último recurso: coleta todos os <p> com conteúdo relevante
      const ps = Array.from(document.querySelectorAll('p'))
        .filter(p => {
          const txt = p.innerText.trim();
          return txt.length > 60 && txt.length < 3000 &&
                 !txt.match(/^(cookie|copyright|©|publicidade|leia também|veja mais)/i);
        });
      return ps.length >= 2
        ? ps.map(p => `<p>${p.innerText.trim()}</p>`).join('\n')
        : '';
    }, HEADLESS_SELECTORS);

    if (!rawHtml || rawHtml.trim().length < 100) {
      return { body: null, image_url: image_url || null, published_at: published_at || null };
    }

    // Normaliza o HTML extraído (remove tags indevidas, links internos, etc.)
    const body = normalizeBody(rawHtml, url) || null;

    console.log(`[headless] ${url} → ${body ? body.replace(/<[^>]*>/g, '').trim().length + ' chars' : 'sem conteúdo'}`);
    return { body, image_url: image_url || null, published_at: published_at || null };

  } catch (err) {
    console.error('[headless] Erro ao carregar', url, ':', err.message);
    return { body: null, image_url: null, published_at: null };
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

module.exports = { fetchWithHeadless, isJsRenderedSite };
