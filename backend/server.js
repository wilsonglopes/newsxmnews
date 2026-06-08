'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express   = require('express');
const cors      = require('cors');
const RSSParser = require('rss-parser');
const cheerio   = require('cheerio');
const cron      = require('node-cron');
const axios     = require('axios');
const crypto    = require('crypto');
const path      = require('path');
const fs        = require('fs');
const https     = require('https');

// ─── Banco de dados (opcional — só conecta se DATABASE_URL estiver configurado) ─
let pool = null;
if (process.env.DATABASE_URL && process.env.DATABASE_URL !== 'postgresql://user:password@localhost:5432/noticias') {
  pool = require('./db/connection');
  console.log('[DB] Conexão com PostgreSQL configurada.');
}

// ─── Normalização (Fase 3) ────────────────────────────────────────────────────
const { normalizeArticle } = require('./scrapers/normalizer');

// ─── Auth middleware (protege rotas inline do server.js) ──────────────────────
const authMiddleware = require('./middleware/auth');

// ─── Allowed hosts (SSRF protection) ─────────────────────────────────────────
const { isAllowed } = require('./utils/allowed-hosts');

// IPs privados/internos bloqueados no /api/article (anti-SSRF)
const PRIVATE_IP_RE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1|0\.0\.0\.0)/i;

// Agente HTTPS que ignora erros de certificado (usado apenas para scraping de prefeituras)
const agenteSemSSL = new https.Agent({ rejectUnauthorized: false });

const app     = express();
const rss     = new RSSParser({
  timeout: 12000,
  headers: { 'User-Agent': 'Mozilla/5.0 RB24Horas-Aggregator/1.0' },
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: false }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: false }],
      ['enclosure', 'enclosure', { keepArray: false }]
    ]
  }
});

// ─── Configuração ──────────────────────────────────────────────────────────────
const PORT    = process.env.PORT || 3000;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutos

app.use(cors());
app.use(express.json({ limit: '20mb' }));

// ─── Landing page pública (raiz do domínio) ───────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/subscriber/landing.html'));
});

// ─── Prévia da matéria (Telegram) — pública, efêmera, só leitura ──────────────
app.get('/api/preview/:token', (req, res) => {
  const previewStore = require('./utils/preview-store');
  const a = previewStore.obter(req.params.token);
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (!a) {
    return res.status(404).type('html').send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Prévia expirada</title><style>body{font-family:system-ui,sans-serif;background:#0d1424;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px}</style></head><body><div><h1>⏳ Prévia expirada</h1><p>Este link de pré-visualização não está mais disponível. Gere a prévia novamente no Telegram.</p></div></body></html>`);
  }
  const img = a.image_url ? `<img src="/api/proxy-image?url=${encodeURIComponent(a.image_url)}" alt="" style="width:100%;border-radius:12px;margin-bottom:20px" onerror="this.style.display='none'"/>` : '';
  res.type('html').send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(a.title)} — Prévia</title>
<style>
  *{box-sizing:border-box} body{font-family:'Segoe UI',system-ui,sans-serif;background:#f6f9fb;color:#1c2b3a;margin:0;line-height:1.7}
  .aviso{background:#fef3c7;color:#92400e;text-align:center;padding:10px;font-size:.85rem;font-weight:600}
  .wrap{max-width:680px;margin:0 auto;padding:28px 20px 60px}
  .chapeu{display:inline-block;background:#0a64ff;color:#fff;font-size:.72rem;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:5px 12px;border-radius:6px;margin-bottom:16px}
  h1{font-size:1.9rem;line-height:1.2;margin:0 0 12px;color:#07111f}
  .resumo{font-size:1.1rem;color:#475569;margin:0 0 24px;font-weight:500}
  .corpo p{margin:0 0 1.1rem;font-size:1.05rem}
</style></head><body>
  <div class="aviso">👁️ Pré-visualização — ainda não publicada</div>
  <div class="wrap">
    ${a.chapeu ? `<span class="chapeu">${esc(a.chapeu)}</span><br>` : ''}
    <h1>${esc(a.title)}</h1>
    ${a.summary ? `<p class="resumo">${esc(a.summary)}</p>` : ''}
    ${img}
    <div class="corpo">${a.body || ''}</div>
  </div>
</body></html>`);
});

// ─── Frontend estático ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../frontend/subscriber')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
// Uploads sob /api/* (nginx só encaminha /api/*) — cards gerados pra Instagram
app.use('/api/uploads', express.static(path.join(__dirname, 'public/uploads')));

// ─── Fontes ────────────────────────────────────────────────────────────────────
const sources = require('./sources.json');

// ─── Cache em memória ─────────────────────────────────────────────────────────
// Estrutura: { [slug]: { data: [], lastUpdated: Date|null, error: string|null } }
const cache = {};
sources.forEach(s => {
  cache[s.slug] = { data: [], lastUpdated: null, error: null };
});

// ─── Utilitários ──────────────────────────────────────────────────────────────

function md5(str) {
  return crypto.createHash('md5').update(String(str)).digest('hex').slice(0, 12);
}

// Similaridade de título por tokens Jaccard (para detecção de duplicatas)
function titleSimilarity(a, b) {
  const tokenize = s => new Set(
    s.toLowerCase().replace(/[^\wÀ-ú\s]/g, '').split(/\s+/).filter(t => t.length > 2)
  );
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  const intersection = [...setA].filter(t => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

// Extrai imagem de CSS background-image (para sites que não usam <img>)
function extrairImagemDeCssBg(el, $) {
  const style = $(el).find('[style*="background-image"]').first().attr('style') || '';
  const m = style.match(/url\(['"]?(.*?)['"]?\)/);
  return m ? m[1] : null;
}

// Extrai a primeira imagem do conteúdo HTML de um item RSS
function extrairImagemDoConteudo(html) {
  if (!html) return null;
  try {
    const $ = cheerio.load(html);
    const src = $('img').first().attr('src');
    return src && src.startsWith('http') ? src : null;
  } catch { return null; }
}

// Normaliza uma data para ISO string; retorna agora se inválida ou futura
// Mapa de meses em português pra número (case-insensitive, com/sem acento)
const MESES_PT = {
  janeiro: 0, jan: 0,
  fevereiro: 1, fev: 1,
  marco: 2, 'março': 2, mar: 2,
  abril: 3, abr: 3,
  maio: 4, mai: 4,
  junho: 5, jun: 5,
  julho: 6, jul: 6,
  agosto: 7, ago: 7,
  setembro: 8, set: 8,
  outubro: 9, out: 9,
  novembro: 10, nov: 10,
  dezembro: 11, dez: 11,
};

// Tenta parsear data em formato português: "6 de agosto de 2025"
function parsePtDate(val) {
  if (!val || typeof val !== 'string') return null;
  // "6 de agosto de 2025" ou "06 de Agosto de 2025"
  const m = val.toLowerCase().match(/(\d{1,2})\s+de\s+([a-zçãé]+)\s+de\s+(\d{4})/i);
  if (!m) return null;
  const dia = parseInt(m[1], 10);
  const mes = MESES_PT[m[2].normalize('NFD').replace(/[̀-ͯ]/g, '')];
  const ano = parseInt(m[3], 10);
  if (mes === undefined) return null;
  const d = new Date(Date.UTC(ano, mes, dia, 12, 0, 0));  // meio-dia UTC pra evitar borda de timezone
  return isNaN(d.getTime()) ? null : d;
}

// Tenta extrair data de URL com padrão /AAAA/MM/DD/ (comum em WordPress)
function parseDateFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12, 0, 0));
  return isNaN(d.getTime()) ? null : d;
}

function normalizarData(val, fallbackUrl) {
  // 1. Tenta parseamento padrão (ISO, RFC etc)
  if (val) {
    const d = new Date(val);
    if (!isNaN(d.getTime()) && d.getTime() <= Date.now() + 24*3600*1000) {
      return d.toISOString();
    }
    // 2. Tenta formato português "6 de agosto de 2025"
    const dPt = parsePtDate(val);
    if (dPt && dPt.getTime() <= Date.now() + 24*3600*1000) {
      return dPt.toISOString();
    }
  }
  // 3. Tenta extrair da URL (WordPress costuma usar /YYYY/MM/DD/)
  if (fallbackUrl) {
    const dUrl = parseDateFromUrl(fallbackUrl);
    if (dUrl && dUrl.getTime() <= Date.now() + 24*3600*1000) {
      return dUrl.toISOString();
    }
  }
  // 4. Último recurso: agora
  return new Date().toISOString();
}

// Resolve URL relativa usando a base da fonte
function resolverUrl(href, base) {
  if (!href) return null;
  if (href.startsWith('http')) return href;
  try { return new URL(href, base).href; } catch { return null; }
}

// ─── Helpers de feed ──────────────────────────────────────────────────────────
function mapearItensFeed(items, source) {
  return items.map(item => {
    const imagem =
      item.mediaContent?.$?.url         ||
      item.mediaThumbnail?.$?.url        ||
      item.enclosure?.url                ||
      item['media:content']?.$?.url      ||
      (source.extract_body_image ? extrairImagemDoConteudo(item['content:encoded'] || item.content || '') : null) ||
      null;
    const conteudo = item['content:encoded'] || item.content || item.contentSnippet || '';
    return {
      id:           md5(item.link || item.guid || item.title || ''),
      source:       source.name,
      source_slug:  source.slug,
      category:     source.category,
      title:        (item.title || '').trim(),
      summary:      (item.contentSnippet || item.summary || '').replace(/<[^>]*>/g, '').trim(),
      url:          item.link || item.guid || '',
      image:        imagem,
      published_at: normalizarData(item.isoDate || item.pubDate),
      content:      conteudo
    };
  });
}

function normalizarXml(xml) {
  return xml
    .replace(/^﻿/, '')
    .replace(/^[\s\S]*?(<\?xml|<rss|<feed|<channel)/i, '$1')
    .replace(/&(?!(?:#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);)/g, '&amp;');
}

// ─── Busca RSS ────────────────────────────────────────────────────────────────
async function buscarRSS(source) {
  // Para fontes que bloqueiam ou têm BOM/encoding: baixar primeiro e depois parsear
  const userAgent = source.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  let feed;
  try {
    // Tentativa 1: parseURL padrão
    feed = await rss.parseURL(source.url);
  } catch (errDireto) {
    // Tentativa 2: baixar com axios (User-Agent de browser) e parsear como string
    const respAxios = await axios.get(source.url, {
      timeout: 12000,
      headers: {
        'User-Agent': userAgent,
        'Accept': 'application/rss+xml, application/xml, text/xml, */*'
      },
      responseType: 'text'
    });
    feed = await rss.parseString(normalizarXml(respAxios.data));
  }

  return mapearItensFeed(feed.items, source);
}

async function buscarSitemap(source) {
  const resp = await axios.get(source.url, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 RB24Horas-Aggregator/1.0' },
    responseType: 'text'
  });
  const $ = cheerio.load(resp.data, { xmlMode: true });
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;

  const items = [];
  $('url').each((_, el) => {
    const url     = $('loc', el).first().text().trim();
    const title   = $('news\\:title', el).first().text().trim() || $('title', el).first().text().trim();
    const pubDate = $('news\\:publication_date', el).first().text().trim() || $('lastmod', el).first().text().trim();
    if (!url || !title) return;
    if (pubDate && new Date(pubDate).getTime() < cutoff) return;
    items.push({
      id:           md5(url),
      source:       source.name,
      source_slug:  source.slug,
      category:     source.category,
      title,
      summary:      '',
      url,
      image:        null,
      published_at: normalizarData(pubDate),
      content:      ''
    });
  });

  return items.slice(0, 25);
}

const PUPPETEER_OPTS = {
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  ...(process.env.PUPPETEER_EXECUTABLE_PATH && { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }),
};

async function buscarRSSHeadless(source) {
  let browser;
  try {
    const puppeteer = require('puppeteer');
    browser = await puppeteer.launch(PUPPETEER_OPTS);
    const page     = await browser.newPage();
    const response = await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const buffer   = await response.buffer();
    const feed     = await rss.parseString(normalizarXml(buffer.toString('utf8')));
    return mapearItensFeed(feed.items, source);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─── Busca por Scraping (prefeituras e outros sem RSS) ─────────────────────────
function extrairArtigosDeHTML(html, source) {
  const $ = cheerio.load(html);

  // Seletores de item configuráveis ou auto-detecção
  const cfg = source.scraping || {};
  const itemSels = (cfg.itemSelector || 'article, .noticia, .item-noticia, .news-item, .card-noticia, .post, li.item').split(', ');

  let $items = $();
  for (const sel of itemSels) {
    $items = $(sel);
    if ($items.length > 0) break;
  }

  // Fallback: pegar todos os links com texto relevante
  if ($items.length === 0) {
    $items = $('a[href]').filter((_, el) => {
      const txt = $(el).text().trim();
      return txt.length > 20 && txt.length < 300;
    });
  }

  // Filtro opcional de URL (regex string em cfg.linkFilter)
  const linkFilterRe = cfg.linkFilter ? new RegExp(cfg.linkFilter) : null;

  const artigos = [];
  $items.each((i, el) => {
    if (i >= 25) return false; // máximo 25 por fonte

    const $el   = $(el);
    const $link  = $el.is('a') ? $el : $el.find('a[href]').first();
    const href   = $link.attr('href');
    const url    = resolverUrl(href, source.url);
    if (!url) return;

    // Aplica filtro de URL se configurado
    if (linkFilterRe && !linkFilterRe.test(url)) return;

    // Título: tenta seletores configuráveis, depois h1/h2/h3, depois texto do link
    const titleSel = cfg.titleSelector || 'h1, h2, h3, h4, .titulo, .title, .entry-title';
    let titulo = $el.find(titleSel).first().text().trim() ||
                 $link.attr('title') ||
                 $link.text().trim();
    titulo = titulo.replace(/\s+/g, ' ').trim();
    if (!titulo || titulo.length < 5) return;

    // Imagem — tenta <img> primeiro, depois CSS background-image
    const imgSel  = cfg.imageSelector || 'img';
    const imgEl   = $el.find(imgSel).first();
    const imgSrc  =
      imgEl.attr('src') || imgEl.attr('data-src') || imgEl.attr('data-lazy-src') ||
      extrairImagemDeCssBg(el, $) ||
      null;
    const imagemRaw = resolverUrl(imgSrc, source.url);
    // Filtra imagens com dimensões muito pequenas no URL (ícones, avatares)
    // Ex: width=128, width=56 são avatares; width=200 pode ser thumbnail pequena
    const imagemPequena = (() => {
      if (!imagemRaw) return false;
      const m = imagemRaw.match(/[,/?&]width=(\d+)/i);
      return m ? parseInt(m[1]) < 280 : false;
    })();
    const imagem = imagemPequena ? null : imagemRaw;

    // Data — passa também a URL para tentar extrair /AAAA/MM/DD/ se o seletor falhar
    const dateSel = cfg.dateSelector || 'time, .date, .data, .published, .post-date';
    const dateEl  = $el.find(dateSel).first();
    const dataISO = normalizarData(dateEl.attr('datetime') || dateEl.text().trim(), url);

    // Resumo: primeiro <p> que não seja vazio
    const resumo  = $el.find('p').first().text().trim();

    artigos.push({
      id:           md5(url),
      source:       source.name,
      source_slug:  source.slug,
      category:     source.category,
      title:        titulo,
      summary:      resumo,
      url,
      image:        imagem,
      published_at: dataISO,
      content:      ''
    });
  });

  return artigos;
}

async function buscarScraping(source) {
  const resp = await axios.get(source.url, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 RB24Horas-Aggregator/1.0' },
    httpsAgent: agenteSemSSL,
  });
  return extrairArtigosDeHTML(resp.data, source);
}

async function buscarScrapingHeadless(source) {
  let browser;
  try {
    const puppeteer = require('puppeteer');
    browser = await puppeteer.launch(PUPPETEER_OPTS);
    const page = await browser.newPage();
    await page.goto(source.url, { waitUntil: 'networkidle2', timeout: 30000 });
    const html = await page.content();
    return extrairArtigosDeHTML(html, source);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─── Criar índices no banco (executado uma vez na inicialização) ─────────────
async function criarIndicesBanco() {
  if (!pool) return;
  // Helper: roda cada migration isoladamente; se uma falhar, as próximas continuam.
  const tryMigrate = async (label, sql) => {
    try { await pool.query(sql); }
    catch (e) { console.warn(`[migration] ${label}: ${e.message}`); }
  };

  await tryMigrate('idx_articles', `
    CREATE INDEX IF NOT EXISTS idx_articles_url  ON articles(external_url);
    CREATE INDEX IF NOT EXISTS idx_articles_date ON articles(published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_articles_src  ON articles(source_id);
  `);
  await tryMigrate('subscribers.phone',   `ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS phone   VARCHAR(30)`);
  await tryMigrate('subscribers.address', `ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS address TEXT`);

  await tryMigrate('sites_catalog table', `
    CREATE TABLE IF NOT EXISTS sites_catalog (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name            TEXT NOT NULL,
      platform        VARCHAR(30) NOT NULL DEFAULT 'wordpress',
      site_url        TEXT,
      xixo_api_key    TEXT,
      wp_username     TEXT,
      wp_app_password TEXT,
      blogger_blog_id TEXT,
      blogger_access_token  TEXT,
      blogger_refresh_token TEXT,
      webhook_url     TEXT,
      webhook_secret  TEXT,
      post_format     VARCHAR(20) DEFAULT 'editorial',
      active          BOOLEAN DEFAULT true,
      created_at      TIMESTAMPTZ DEFAULT now()
    )
  `);
  await tryMigrate('subscriber_sites.site_id', `ALTER TABLE subscriber_sites ADD COLUMN IF NOT EXISTS site_id UUID REFERENCES sites_catalog(id)`);
  await tryMigrate('autopub_rules.default_category_id', `ALTER TABLE autopub_rules ADD COLUMN IF NOT EXISTS default_category_id INTEGER`);
  await tryMigrate('autopub_rules pkey drop', `ALTER TABLE autopub_rules DROP CONSTRAINT IF EXISTS autopub_rules_pkey`);
  await tryMigrate('autopub_rules.site_id nullable', `ALTER TABLE autopub_rules ALTER COLUMN site_id DROP NOT NULL`);
  await tryMigrate('autopub_rules.catalog_id', `ALTER TABLE autopub_rules ADD COLUMN IF NOT EXISTS catalog_id UUID REFERENCES sites_catalog(id)`);
  await tryMigrate('autopub_rules backfill', `
    UPDATE autopub_rules ar
    SET catalog_id = ss.site_id
    FROM subscriber_sites ss
    WHERE ar.site_id = ss.id AND ar.catalog_id IS NULL AND ss.site_id IS NOT NULL
  `);
  await tryMigrate('idx_autopub_catalog_source', `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_autopub_catalog_source
    ON autopub_rules(catalog_id, source_id)
    WHERE catalog_id IS NOT NULL
  `);
  await tryMigrate('fix slug www2', `UPDATE sources SET slug = 'pref-de-praia-grande' WHERE slug = 'www2'`);
  await tryMigrate('subscribers.telegram_chat_id', `ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT UNIQUE`);
  await tryMigrate('subscribers.telegram_link_code', `ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS telegram_link_code VARCHAR(8)`);
  await tryMigrate('sites_catalog.ai_prompt', `ALTER TABLE sites_catalog ADD COLUMN IF NOT EXISTS ai_prompt TEXT`);
  await tryMigrate('subscribers.telegram_link_expires_at', `ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS telegram_link_expires_at TIMESTAMPTZ`);
  await tryMigrate('article_drafts.article_id nullable', `ALTER TABLE article_drafts ALTER COLUMN article_id DROP NOT NULL`);
  await tryMigrate('article_drafts.external_post_url', `ALTER TABLE article_drafts ADD COLUMN IF NOT EXISTS external_post_url TEXT`);
  // Facebook: por catálogo + por fonte no autopub
  await tryMigrate('sites_catalog.facebook_enabled',    `ALTER TABLE sites_catalog ADD COLUMN IF NOT EXISTS facebook_enabled BOOLEAN DEFAULT false`);
  await tryMigrate('sites_catalog.facebook_page_id',    `ALTER TABLE sites_catalog ADD COLUMN IF NOT EXISTS facebook_page_id VARCHAR(50)`);
  await tryMigrate('sites_catalog.facebook_page_token', `ALTER TABLE sites_catalog ADD COLUMN IF NOT EXISTS facebook_page_token TEXT`);
  await tryMigrate('autopub_rules.facebook_enabled',    `ALTER TABLE autopub_rules ADD COLUMN IF NOT EXISTS facebook_enabled BOOLEAN DEFAULT false`);
  await tryMigrate('publications.facebook_post_id',     `ALTER TABLE publications ADD COLUMN IF NOT EXISTS facebook_post_id VARCHAR(100)`);
  await tryMigrate('publications.facebook_post_url',    `ALTER TABLE publications ADD COLUMN IF NOT EXISTS facebook_post_url TEXT`);
  // Instagram: detectado a partir do Page Token (mesmas credenciais do FB)
  await tryMigrate('sites_catalog.instagram_enabled',     `ALTER TABLE sites_catalog ADD COLUMN IF NOT EXISTS instagram_enabled BOOLEAN DEFAULT false`);
  await tryMigrate('sites_catalog.instagram_business_id', `ALTER TABLE sites_catalog ADD COLUMN IF NOT EXISTS instagram_business_account_id VARCHAR(50)`);
  await tryMigrate('sites_catalog.instagram_username',    `ALTER TABLE sites_catalog ADD COLUMN IF NOT EXISTS instagram_username VARCHAR(100)`);
  await tryMigrate('publications.instagram_post_id',      `ALTER TABLE publications ADD COLUMN IF NOT EXISTS instagram_post_id VARCHAR(100)`);
  await tryMigrate('publications.instagram_post_url',     `ALTER TABLE publications ADD COLUMN IF NOT EXISTS instagram_post_url TEXT`);
  // Flag de pausa do autopub por site (sem perder configuração de fontes)
  await tryMigrate('sites_catalog.autopub_enabled',       `ALTER TABLE sites_catalog ADD COLUMN IF NOT EXISTS autopub_enabled BOOLEAN DEFAULT true`);
  await tryMigrate('sites_catalog.social_config',         `ALTER TABLE sites_catalog ADD COLUMN IF NOT EXISTS social_config JSONB DEFAULT '{}'`);
  // WhatsApp (Evolution): instância e status da conexão por portal
  await tryMigrate('sites_catalog.evolution_instance',    `ALTER TABLE sites_catalog ADD COLUMN IF NOT EXISTS evolution_instance VARCHAR(60)`);
  await tryMigrate('sites_catalog.whatsapp_status',       `ALTER TABLE sites_catalog ADD COLUMN IF NOT EXISTS whatsapp_status VARCHAR(20) DEFAULT 'desconectado'`);
  await tryMigrate('sites_catalog.whatsapp_enabled',      `ALTER TABLE sites_catalog ADD COLUMN IF NOT EXISTS whatsapp_enabled BOOLEAN DEFAULT false`);
  await tryMigrate('sites_catalog.whatsapp_autopub_enabled', `ALTER TABLE sites_catalog ADD COLUMN IF NOT EXISTS whatsapp_autopub_enabled BOOLEAN DEFAULT false`);
  await tryMigrate('grupos_whatsapp table', `
    CREATE TABLE IF NOT EXISTS grupos_whatsapp (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      catalog_id  UUID NOT NULL REFERENCES sites_catalog(id) ON DELETE CASCADE,
      group_jid   VARCHAR(80) NOT NULL,
      nome        VARCHAR(200),
      ativo       BOOLEAN DEFAULT true,
      criado_em   TIMESTAMPTZ DEFAULT now(),
      UNIQUE(catalog_id, group_jid)
    )`);
  await tryMigrate('publications.meta_ad_id',             `ALTER TABLE publications ADD COLUMN IF NOT EXISTS meta_ad_id VARCHAR(100)`);
  await tryMigrate('publications.meta_ad_url',            `ALTER TABLE publications ADD COLUMN IF NOT EXISTS meta_ad_url TEXT`);

  await tryMigrate('autopub_queue table', `
    CREATE TABLE IF NOT EXISTS autopub_queue (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      catalog_id          UUID NOT NULL REFERENCES sites_catalog(id),
      site_id             UUID REFERENCES subscriber_sites(id),
      subscriber_id       UUID REFERENCES subscribers(id),
      source_id           UUID NOT NULL REFERENCES sources(id),
      article_id          UUID NOT NULL REFERENCES articles(id),
      status              VARCHAR(20) DEFAULT 'pending',
      attempts            INT DEFAULT 0,
      publish_facebook    BOOLEAN DEFAULT false,
      publish_instagram   BOOLEAN DEFAULT false,
      default_category_id INT,
      enqueued_at         TIMESTAMPTZ DEFAULT now(),
      processed_at        TIMESTAMPTZ,
      error_message       TEXT,
      UNIQUE (catalog_id, article_id)
    )
  `);
  await tryMigrate('idx_queue_pending', `
    CREATE INDEX IF NOT EXISTS idx_queue_pending ON autopub_queue(status, enqueued_at) WHERE status = 'pending'
  `);
}

// ─── Sincronizar sources.json → tabela sources do banco ──────────────────────
// Garante que featured_image_selector e content_selector estejam gravados
// para fontes adicionadas diretamente ao arquivo (sem passar pelo admin UI).
async function sincronizarFontesDB() {
  if (!pool) return;
  try {
    for (const s of sources) {
      const cfg = s.scraping || {};
      await pool.query(`
        INSERT INTO sources
          (name, slug, type, url, section_selector, title_selector, date_selector,
           link_selector, image_selector, content_selector, category, active,
           extract_body_image, featured_image_selector)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (slug) DO UPDATE SET
          name                    = EXCLUDED.name,
          url                     = EXCLUDED.url,
          type                    = EXCLUDED.type,
          category                = EXCLUDED.category,
          active                  = CASE WHEN sources.active = false THEN false ELSE EXCLUDED.active END,
          content_selector        = EXCLUDED.content_selector,
          extract_body_image      = EXCLUDED.extract_body_image,
          featured_image_selector = EXCLUDED.featured_image_selector`,
        [
          s.name, s.slug, s.type || 'rss', s.url || null,
          cfg.itemSelector  || null,
          cfg.titleSelector || null,
          cfg.dateSelector  || null,
          cfg.linkSelector  || null,
          cfg.imageSelector || null,
          s.content_selector        || cfg.contentSelector || null,
          s.category || null,
          s.active !== false,
          s.extract_body_image || false,
          s.featured_image_selector || null,
        ]
      );
    }
    console.log(`[DB] ${sources.length} fontes sincronizadas com o banco.`);

    // Repara artigos antigos com source_id = NULL: vincula pelo domínio da URL da fonte.
    // Isso corrige artigos inseridos antes da fonte existir na tabela sources.
    await pool.query(`
      UPDATE articles a
      SET source_id = s.id
      FROM sources s
      WHERE a.source_id IS NULL
        AND a.external_url ILIKE (
          regexp_replace(s.url, '^(https?://[^/?#]+).*', '\\1') || '%'
        )
    `);
  } catch (err) {
    console.error('[DB] Erro ao sincronizar fontes:', err.message);
  }
}

// ─── Reparar imagens nulas em artigos recentes (sc.gov.br RSS) ────────────────
// Fontes sc.gov.br RSS não incluem imagens no feed. O enriquecimento ao inserir
// cobre novos artigos, mas artigos já no banco ficam com image_url = NULL.
// Este job cobre artigos dos últimos 7 dias que ainda estão sem imagem.
async function repararImagensNulas() {
  if (!pool) return;
  try {
    const { rows } = await pool.query(`
      SELECT a.id, a.external_url, so.slug, so.content_selector, so.featured_image_selector, so.extract_body_image
      FROM articles a
      JOIN sources so ON so.id = a.source_id
      WHERE a.image_url IS NULL
        AND so.url ILIKE '%sc.gov.br%'
        AND so.type = 'rss'
        AND a.published_at >= NOW() - INTERVAL '7 days'
      ORDER BY a.published_at DESC
      LIMIT 30
    `);
    if (!rows.length) return;
    console.log(`[image-repair] ${rows.length} artigos sc.gov.br sem imagem — iniciando reparo em background`);
    const { fetchFullContent } = require('./scrapers/full-content');
    (async () => {
      for (const art of rows) {
        try {
          const source = {
            content_selector: art.content_selector || null,
            featured_image_selector: art.featured_image_selector || null,
            extract_body_image: art.extract_body_image || false,
            url: art.external_url,
          };
          const { image_url } = await fetchFullContent(art.external_url, source);
          if (image_url) {
            await pool.query(
              'UPDATE articles SET image_url = $1 WHERE id = $2 AND image_url IS NULL',
              [image_url, art.id]
            );
            console.log(`[image-repair] ${art.slug}: imagem reparada → ${image_url.slice(0, 60)}`);
          }
        } catch { /* artigo individual falha — continua */ }
        // Pausa entre requisições para não sobrecarregar CF Worker / Puppeteer
        await new Promise(r => setTimeout(r, 1500));
      }
      console.log('[image-repair] Reparo concluído.');
    })();
  } catch (err) {
    console.error('[image-repair] Erro:', err.message);
  }
}

// ─── Migrar sites antigos (subscriber_sites sem site_id) para o sites_catalog ─
// Roda no startup. Só processa linhas com site_id = NULL — idempotente.
async function migrarSitesParaCatalogo() {
  if (!pool) return;
  try {
    const { rows: antigos } = await pool.query(`
      SELECT id, name, platform, site_url, xixo_api_key, wp_username, wp_app_password,
             blogger_blog_id, blogger_access_token, blogger_refresh_token,
             webhook_url, webhook_secret, post_format, active
      FROM subscriber_sites
      WHERE site_id IS NULL AND name IS NOT NULL
    `);
    if (!antigos.length) return;

    // Mapa chave → catalog_id para deduplicar sites idênticos por URL (ou nome)
    const vistos = new Map();
    let migrados = 0;

    for (const ss of antigos) {
      const chave = (ss.site_url || ss.name).toLowerCase().trim().replace(/\/$/, '');

      if (!vistos.has(chave)) {
        // Verifica se já existe entrada compatível no catálogo
        const { rows: ex } = await pool.query(
          `SELECT id FROM sites_catalog
           WHERE LOWER(TRIM(TRAILING '/' FROM COALESCE(site_url, name))) = $1
           LIMIT 1`,
          [chave]
        );
        let catalogId;
        if (ex[0]) {
          catalogId = ex[0].id;
        } else {
          const { rows: novo } = await pool.query(
            `INSERT INTO sites_catalog
               (name, platform, site_url, xixo_api_key, wp_username, wp_app_password,
                blogger_blog_id, blogger_access_token, blogger_refresh_token,
                webhook_url, webhook_secret, post_format, active)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
             RETURNING id`,
            [
              ss.name,
              ss.platform || 'wordpress',
              ss.site_url  || null,
              ss.xixo_api_key || null,
              ss.wp_username  || null,
              ss.wp_app_password || null,   // já está criptografado
              ss.blogger_blog_id || null,
              ss.blogger_access_token  || null,
              ss.blogger_refresh_token || null,
              ss.webhook_url    || null,
              ss.webhook_secret || null,
              ss.post_format || 'editorial',
              ss.active !== false,
            ]
          );
          catalogId = novo[0].id;
        }
        vistos.set(chave, catalogId);
      }

      await pool.query(
        'UPDATE subscriber_sites SET site_id = $1 WHERE id = $2',
        [vistos.get(chave), ss.id]
      );
      migrados++;
    }

    if (migrados) console.log(`[DB] ${migrados} site(s) migrado(s) para o catálogo.`);
  } catch (err) {
    console.error('[DB] Erro ao migrar sites para o catálogo:', err.message);
  }
}

// ─── Persistir artigos no banco (fire-and-forget, não bloqueia o cache) ──────
const { isAllowed: isImageAllowed } = require('./utils/allowed-hosts');
async function persistirArtigos(itens, sourceSlug, source) {
  if (!pool) return;

  let novos = 0;
  const toEnrich = []; // artigos novos sem imagem no feed — scraping vai preencher
  try {
    // Busca o UUID da fonte pelo slug
    const { rows } = await pool.query(
      'SELECT id FROM sources WHERE slug = $1', [sourceSlug]
    );
    const sourceId = rows[0]?.id || null;

    for (const item of itens) {
      if (!item.url) continue;

      // Normaliza o artigo antes de persistir
      const norm = normalizeArticle(item, source || { category: item.category });

      // Rejeita artigos mais antigos que 7 dias
      // (2 dias era muito curto: falhas de deploy causavam perda de artigos de prefeituras
      // que publicam a cada 3-5 dias — ex: Epitaciolândia, Plácido de Castro, Içara)
      if (norm.published_at) {
        const idadeMs = Date.now() - new Date(norm.published_at).getTime();
        if (idadeMs > 7 * 86400000) continue;
      }

      // Verifica se já existe pela URL
      const { rows: exist } = await pool.query(
        'SELECT id FROM articles WHERE external_url = $1', [norm.external_url]
      );
      if (exist.length > 0) continue;

      // Detecção de duplicata por similaridade de título (mesmo dia, mesma fonte)
      if (norm.title && norm.published_at && sourceId) {
        const dayStart = new Date(norm.published_at);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd   = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);

        const { rows: sameDay } = await pool.query(
          `SELECT title FROM articles
           WHERE source_id = $1
             AND published_at >= $2
             AND published_at <  $3
           LIMIT 50`,
          [sourceId, dayStart, dayEnd]
        );
        const isDup = sameDay.some(r => titleSimilarity(norm.title, r.title) >= 0.85);
        if (isDup) continue;
      }

      // ⚠️ Warning se imagem viria de domínio não mapeado (ficará sem imagem no frontend)
      if (norm.image_url && !isImageAllowed(norm.image_url)) {
        try {
          const imgHost = new URL(norm.image_url).hostname;
          console.warn(`[ALLOWED_HOSTS] ⚠️  ${sourceSlug}: imagem de "${imgHost}" não está em allowed-hosts.js — adicionar para exibir no frontend`);
        } catch {}
      }

      await pool.query(`
        INSERT INTO articles
          (source_id, external_url, chapeu, title, summary, body, image_url, tags, author, published_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (external_url) DO NOTHING
      `, [
        sourceId,
        norm.external_url,
        norm.chapeu       || null,
        norm.title        || '',
        norm.summary      || null,
        norm.body         || null,
        norm.image_url    || null,
        norm.tags?.length ? norm.tags : null,
        norm.author       || null,
        norm.published_at ? new Date(norm.published_at) : null,
      ]);
      novos++;
      // Artigo novo sem imagem: enriquecer depois via scraping da página do artigo
      if (!norm.image_url) toEnrich.push(norm.external_url);
    }

    if (novos > 0) console.log(`[DB] ${sourceSlug}: ${novos} artigos novos salvos`);
  } catch (err) {
    console.error(`[DB] Erro ao persistir artigos de ${sourceSlug}:`, err.message);
  }

  // Enriquece imagem via scraping para artigos novos que vieram sem imagem no feed.
  // Sequencial (não paralelo) para não sobrecarregar o servidor/proxy.
  // Cobre sc.gov.br e qualquer fonte cujo RSS não inclua featured image.
  if (toEnrich.length > 0) {
    const { fetchFullContent } = require('./scrapers/full-content');
    (async () => {
      for (const url of toEnrich.slice(0, 5)) {
        try {
          const { image_url: scraped } = await fetchFullContent(url, source);
          if (scraped) {
            await pool.query(
              'UPDATE articles SET image_url = $1 WHERE external_url = $2 AND image_url IS NULL',
              [scraped, url]
            );
            console.log(`[image-enrich] ${sourceSlug}: imagem recuperada para ${url}`);
          }
        } catch { /* imagem fica nula; autopub tenta novamente ao publicar */ }
      }
    })();
  }
}

// ─── Atualizar log de fonte no banco ─────────────────────────────────────────
async function atualizarLogFonte(slug, erro) {
  if (!pool) return;
  try {
    await pool.query(
      `UPDATE sources SET last_fetched_at = NOW(), last_error = $2 WHERE slug = $1`,
      [slug, erro || null]
    );
  } catch { /* não bloqueia */ }
}

// ─── Busca via JSON API própria ───────────────────────────────────────────────
async function buscarAPI(source) {
  const url = source.url;
  const fm = source.api_field_map || {};
  const params = source.api_scroll_pagination
    ? { scroll: 'true', page: 1 }
    : { limit: source.api_limit || 20 };

  let items = [];
  if (source.api_scroll_pagination) {
    const totalPages = source.api_pages || 1;
    for (let page = 1; page <= totalPages; page++) {
      const r = await axios.get(url, {
        timeout: 15000,
        params: { scroll: 'true', page },
        headers: { 'Accept': 'application/json', 'User-Agent': '' },
      });
      const pageItems = r.data?.data || r.data?.items || r.data || [];
      if (!pageItems.length) break;
      items = items.concat(pageItems);
    }
  } else {
    const resp = await axios.get(url, {
      timeout: 15000,
      params,
      headers: { 'Accept': 'application/json', 'User-Agent': '' },
    });
    items = resp.data?.data || resp.data?.items || resp.data || [];
  }
  const baseUrl = source.api_article_base || new URL(url).origin;
  const slugPath = source.api_slug_path || '/materia/';

  return items.filter(a => a.isPublished !== false).map(a => {
    const title   = ((fm.title       ? a[fm.title]          : null) || a.title           || '').trim();
    const rawUrl  =  (fm.url         ? a[fm.url]            : null) || '';
    const rawImg  =  (fm.image       ? a[fm.image]          : null) || a.coverImage       || null;
    let   rawDate =  (fm.published_at ? a[fm.published_at]  : null) || a.publishedAt || a.published_at || '';
    const summary =  (fm.summary     ? a[fm.summary]        : null) || a.excerpt || a.metaDescription || '';

    // Alguns CMSs retornam horário local (BRT) com sufixo Z errado — reinterpretar com timezone correto
    if (source.api_date_timezone && rawDate) {
      const tzOffset = source.api_date_timezone === 'America/Sao_Paulo' ? '-03:00' : '+00:00';
      rawDate = new Date(rawDate.replace(/Z$|[+-]\d{2}:?\d{2}$/, '') + tzOffset).toISOString();
    }

    const articleUrl = rawUrl
      ? (rawUrl.startsWith('http') ? rawUrl : `${baseUrl}${rawUrl}`)
      : `${baseUrl}${slugPath}${a.slug}`;

    const image = rawImg
      ? (rawImg.startsWith('http') ? rawImg : `${baseUrl}${rawImg}`)
      : null;

    return {
      id:           md5(rawUrl || a.slug || String(a.id) || title || ''),
      source:       source.name,
      source_slug:  source.slug,
      category:     source.category,
      title,
      summary,
      url:          articleUrl,
      image,
      published_at: normalizarData(rawDate),
      content:      a.body || '',
      tags:         Array.isArray(a.tags) ? a.tags : [],
      author:       a.author?.name || null,
    };
  });
}

// ─── Busca RSS via Cloudflare Worker (para fontes bloqueadas na Oracle Cloud) ──
async function buscarRSSViaProxy(source, cfProxy) {
  const resp = await cfProxy.fetchViaCFProxy(source.url, {
    responseType: 'text',
    timeout: 20000,
  });
  const feed = await rss.parseString(normalizarXml(resp.data));
  return mapearItensFeed(feed.items, source);
}

// ─── Atualizar uma fonte ──────────────────────────────────────────────────────
async function atualizarFonte(source) {
  try {
    let itens;
    if (source.headless) {
      // Fonte bloqueada na Oracle Cloud — usa CF Worker se disponível, senão Puppeteer
      const cfProxy = require('./utils/cf-proxy');
      if (cfProxy.isAvailable() && source.type === 'rss') {
        console.log(`[${source.name}] headless=true — usando CF Worker`);
        itens = await buscarRSSViaProxy(source, cfProxy);
      } else {
        console.log(`[${source.name}] headless=true — usando Puppeteer diretamente`);
        itens = await (source.type === 'rss' ? buscarRSSHeadless(source) : buscarScrapingHeadless(source));
      }
    } else if (source.type === 'api') {
      itens = await buscarAPI(source);
    } else if (source.type === 'sitemap') {
      itens = await buscarSitemap(source);
    } else if (source.type === 'rss') {
      itens = await buscarRSS(source);
    } else {
      itens = await buscarScraping(source);
    }

    cache[source.slug] = {
      data:        itens,
      lastUpdated: new Date(),
      error:       null
    };
    console.log(`[OK] Fonte "${source.name}": ${itens.length} itens coletados`);

    // Persiste no banco em background (não bloqueia o cache em memória)
    persistirArtigos(itens, source.slug, source).catch(() => {});
    atualizarLogFonte(source.slug, null).catch(() => {});

  } catch (err) {
    const is403 = err.response?.status === 403 || /\b403\b/.test(err.message || '');
    if (is403 && source.type !== 'api') {
      try {
        console.log(`[${source.name}] Bloqueio 403 — tentando Puppeteer`);
        const itens = await (source.type === 'rss'
          ? buscarRSSHeadless(source)
          : buscarScrapingHeadless(source));
        cache[source.slug] = { data: itens, lastUpdated: new Date(), error: null };
        console.log(`[OK] Fonte "${source.name}" (headless): ${itens.length} itens`);
        persistirArtigos(itens, source.slug, source).catch(() => {});
        atualizarLogFonte(source.slug, null).catch(() => {});
        return;
      } catch (e2) {
        console.error(`[ERRO] "${source.name}" — headless também falhou: ${e2.message}`);
      }
    }
    cache[source.slug] = {
      ...cache[source.slug],
      lastUpdated: new Date(),
      error:       err.message
    };
    console.error(`[ERRO] Fonte "${source.name}" falhou: ${err.message}`);
    atualizarLogFonte(source.slug, err.message).catch(() => {});
  }
}

// ─── Atualizar todas as fontes ativas (com limite de concorrência) ────────────
async function atualizarTodasFontes() {
  console.log(`[CRON] Atualizando ${sources.filter(s => s.active).length} fontes...`);
  const ativas  = sources.filter(s => s.active);
  const tamanho = 5; // 5 em paralelo

  for (let i = 0; i < ativas.length; i += tamanho) {
    await Promise.all(ativas.slice(i, i + tamanho).map(s => atualizarFonte(s)));
  }
  console.log('[CRON] Atualização concluída.');
}

// ─── Limpeza de artigos com mais de 2 dias ────────────────────────────────────
async function limparArtigosAntigos() {
  if (!pool) return;
  try {
    // Exclui apenas artigos que NÃO foram publicados (sem registro em publications)
    // Artigos publicados são preservados para manter o histórico de publicações.
    const r = await pool.query(
      `DELETE FROM articles
       WHERE published_at < NOW() - INTERVAL '2 days'
         AND id NOT IN (SELECT DISTINCT article_id FROM publications WHERE article_id IS NOT NULL)`
    );
    if (r.rowCount > 0) console.log(`[CLEANUP] ${r.rowCount} artigos antigos removidos.`);
  } catch (e) {
    console.error('[CLEANUP] Erro:', e.message);
  }
}

// ─── Validação de configuração (roda antes de qualquer cron) ─────────────────
const { validateSources, checkUrlsAsync } = require('./startup-validator');
validateSources(sources); // síncrono — loga erros/avisos imediatamente
setImmediate(() => checkUrlsAsync(sources).catch(() => {})); // async, não bloqueia

// ─── Carga inicial e agendamento ──────────────────────────────────────────────
criarIndicesBanco().catch(() => {});
sincronizarFontesDB().catch(() => {});
migrarSitesParaCatalogo().catch(() => {});
// Repara imagens nulas de artigos recentes de fontes sc.gov.br RSS
// (fontes como Araranguá, Arroio do Silva, Sangão, etc. não têm imagem no feed)
setTimeout(() => repararImagensNulas().catch(() => {}), 15000);
atualizarTodasFontes();
limparArtigosAntigos();
cron.schedule('*/15 * * * *', atualizarTodasFontes);
cron.schedule('0 * * * *', limparArtigosAntigos); // limpeza a cada hora

// Autopub — producer enfileira a cada 5min; worker processa 1 item a cada 30s
const { rodarProdutor, workerLoop } = require('./autopub');
cron.schedule('*/5 * * * *', () => rodarProdutor().catch(e => console.error('[PRODUCER]', e.message)));
workerLoop().catch(e => console.error('[WORKER] Fatal:', e));

const { iniciarBot } = require('./telegram');
iniciarBot();

// Cleanup diário de cards antigos do Instagram (> 7 dias)
const { limparCardsAntigos } = require('./utils/card-generator');
cron.schedule('0 3 * * *', () => limparCardsAntigos(7));
limparCardsAntigos(7); // roda na inicialização também

// ─── Monitor de saúde ─────────────────────────────────────────────────────────
// Só ativa se banco configurado e MONITOR_CHAT_ID definido no .env
if (pool && process.env.MONITOR_CHAT_ID) {
  const { verificarSaude, relatorioDiario, verificarDisco } = require('./monitor');
  cron.schedule('0 */2 * * *',  () => verificarSaude().catch(e => console.error('[MONITOR]', e.message)));
  cron.schedule('0 7 * * *',    () => relatorioDiario().catch(e => console.error('[MONITOR]', e.message)));
  // Monitor de disco proativo — a cada 1h: alerta a 80%, auto-limpeza emergencial a 90%
  cron.schedule('0 * * * *',    () => verificarDisco().catch(e => console.error('[MONITOR/disco]', e.message)));
  verificarDisco().catch(() => {}); // checagem inicial no boot
  console.log('[MONITOR] Monitor de saúde ativo — saúde 2h + resumo 7h + disco 1h.');
} else {
  console.log('[MONITOR] Monitor desativado — defina MONITOR_CHAT_ID no .env para ativar.');
}

// ─── ROTAS ────────────────────────────────────────────────────────────────────

// Bloqueio global de escrita para contas "visualizador" (is_readonly no JWT).
// Conta de apresentação/demo: vê tudo (perfil admin) mas não altera nada.
// Ponto único — bloqueia POST/PUT/PATCH/DELETE antes de qualquer rota agir.
app.use('/api', (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  // Permite autenticar e encerrar sessão mesmo em modo visualização
  if (req.path === '/auth/login' || req.path === '/auth/logout') return next();

  const header = req.headers['authorization'] || '';
  const tk = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!tk) return next(); // sem token: deixa a própria rota/authMiddleware tratar

  try {
    const payload = require('jsonwebtoken').verify(tk, process.env.JWT_SECRET);
    if (payload.is_readonly) {
      return res.status(403).json({
        error: 'readonly',
        message: 'Modo apresentação: alterações estão desabilitadas nesta conta.',
      });
    }
  } catch { /* token inválido/expirado: deixa a rota tratar com seu próprio 401 */ }
  next();
});

// Auth (login / logout / me)
app.use('/api/auth', require('./routes/auth'));

// Artigos e publicação (Fase 2)
app.use('/api/articles',           require('./routes/articles'));
app.use('/api/publish',            require('./routes/publish'));
app.use('/api/sites',              require('./routes/sites'));
app.use('/api/drafts',             require('./routes/drafts'));
app.use('/api/publications',       require('./routes/publications'));
app.use('/api/subscriber/sources',  require('./routes/subscriber-sources'));
app.use('/api/subscriber',          require('./routes/subscriber-telegram'));

// IA — reescrita de artigos (usa DEEPSEEK_KEY do servidor)
app.use('/api/ia', require('./routes/ia'));

// Configurações públicas (provedor de IA global, sem autenticação)
app.get('/api/settings', (req, res) => {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf8'));
    res.json(s);
  } catch { res.json({ ia_provider: 'deepseek' }); }
});

// Proxy de imagens (evita bloqueio de hotlink nos portais)
app.use('/api/proxy-image', require('./routes/image-proxy'));

// Catálogo central de sites (admin)
app.use('/api/admin/sites-catalog', require('./routes/sites-catalog'));

// WhatsApp (Evolution) — conexão/QR/status por portal (admin)
app.use('/api/admin/whatsapp', require('./routes/whatsapp'));

// ─── Templates de card (admin) ────────────────────────────────────────────────
// Dimensões obrigatórias do template — as coordenadas de chapéu/texto são fixas.
const CARD_TEMPLATE_W = 1600;
const CARD_TEMPLATE_H = 2000;
// Slugs reservados que não podem ser sobrescritos nem excluídos.
const CARD_TEMPLATE_RESERVED = ['xmnews', 'default'];

// Só admin pode gerenciar templates
function requireAdmin(req, res, next) {
  if (!req.subscriber || !req.subscriber.is_admin) {
    return res.status(403).json({ error: 'Acesso restrito a administradores.' });
  }
  next();
}

// Lista templates com preview (thumbnail base64) — para a UI admin
app.get('/api/admin/card-templates', authMiddleware, async (req, res) => {
  try {
    const { listarTemplatesComPreview } = require('./utils/card-generator');
    res.json(await listarTemplatesComPreview());
  } catch (err) {
    console.error('[card-templates/list]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Saúde de todas as fontes ativas (painel admin)
app.get('/api/admin/fontes-saude', authMiddleware, async (req, res) => {
  try {
    const { saudeDasFontes } = require('./monitor');
    res.json(await saudeDasFontes());
  } catch (err) {
    console.error('[fontes-saude]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Upload de novo template (base64). Valida PNG e dimensões 1600×2000.
app.post('/api/admin/card-templates', authMiddleware, requireAdmin, async (req, res) => {
  const { slug: rawSlug, image_base64 } = req.body || {};
  if (!rawSlug || !image_base64) {
    return res.status(400).json({ error: 'slug e image_base64 são obrigatórios.' });
  }
  // Sanitiza o slug: minúsculas, só letras/números/hífen
  const slug = String(rawSlug).toLowerCase().trim().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!slug) return res.status(400).json({ error: 'Nome do template inválido.' });
  if (CARD_TEMPLATE_RESERVED.includes(slug)) {
    return res.status(400).json({ error: `"${slug}" é um nome reservado. Escolha outro.` });
  }

  try {
    const sharp = require('sharp');
    const fs    = require('fs');
    const { templatePathFor } = require('./utils/card-generator');

    const buffer = Buffer.from(image_base64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    const meta   = await sharp(buffer).metadata();

    if (meta.format !== 'png') {
      return res.status(400).json({ error: 'O template precisa ser um arquivo PNG.' });
    }
    if (meta.width !== CARD_TEMPLATE_W || meta.height !== CARD_TEMPLATE_H) {
      return res.status(400).json({
        error: `Dimensões inválidas: ${meta.width}×${meta.height}. O template precisa ter exatamente ${CARD_TEMPLATE_W}×${CARD_TEMPLATE_H} px.`
      });
    }

    fs.writeFileSync(templatePathFor(slug), buffer);
    console.log(`[card-templates] template "${slug}" salvo (${buffer.length} bytes)`);
    res.status(201).json({ ok: true, slug });
  } catch (err) {
    console.error('[card-templates/upload]', err.message);
    res.status(500).json({ error: 'Falha ao processar a imagem: ' + err.message });
  }
});

// Exclui um template. Bloqueia os reservados.
app.delete('/api/admin/card-templates/:slug', authMiddleware, requireAdmin, async (req, res) => {
  const slug = String(req.params.slug || '').toLowerCase();
  if (CARD_TEMPLATE_RESERVED.includes(slug)) {
    return res.status(400).json({ error: 'O template padrão não pode ser excluído.' });
  }
  try {
    const fs = require('fs');
    const { templatePathFor } = require('./utils/card-generator');
    const fpath = templatePathFor(slug);
    if (!fs.existsSync(fpath)) return res.status(404).json({ error: 'Template não encontrado.' });

    // Conta quantos portais usam este template (caem no fallback após excluir)
    let emUso = 0;
    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS total FROM sites_catalog WHERE social_config->>'card_template' = $1`,
        [slug]
      );
      emUso = rows[0]?.total || 0;
    } catch {}

    fs.unlinkSync(fpath);
    console.log(`[card-templates] template "${slug}" excluído (${emUso} portal(is) caíram no padrão)`);
    res.json({ ok: true, slug, portais_afetados: emUso });
  } catch (err) {
    console.error('[card-templates/delete]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Editor de layout de template ──────────────────────────────────────────────
// Sanitiza o layout vindo do editor: só chaves conhecidas, números clampados,
// fonte por whitelist (evita injeção no SVG e valores absurdos).
function sanitizeLayoutInput(raw = {}) {
  const num = (v, d, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d; };
  const out = {};
  if (raw.fotoArea) out.fotoArea = {
    x: num(raw.fotoArea.x, 0, 0, 1600), y: num(raw.fotoArea.y, 0, 0, 2000),
    w: num(raw.fotoArea.w, 1600, 1, 1600), h: num(raw.fotoArea.h, 1195, 1, 2000),
  };
  if (raw.titulo) {
    const t = raw.titulo, o = {};
    o.x = num(t.x, 90, 0, 1600); o.y = num(t.y, 1450, 0, 2000); o.w = num(t.w, 1420, 1, 1600);
    o.yOffset = num(t.yOffset, 50, 0, 400);
    o.fontSize = num(t.fontSize, 60, 16, 200);
    o.lineHeight = num(t.lineHeight, Math.round(o.fontSize * 1.25), 16, 300);
    o.fontWeight = [400, 700].includes(Number(t.fontWeight)) ? Number(t.fontWeight) : 700;
    o.maxChars = num(t.maxChars, 42, 6, 80);
    o.maxLinhas = num(t.maxLinhas, 6, 1, 10);
    o.align = (t.align === 'middle') ? 'middle' : 'start';
    o.uppercase = !!t.uppercase;
    o.justify = !!t.justify;
    o.wrapByWidth = t.wrapByWidth !== false; // layouts do editor quebram por largura da caixa
    const fam = String(t.font || t.fontFamily || '').toLowerCase();
    o.fontFamily = fam.includes('montser') ? "'Montserrat', 'DejaVu Sans', sans-serif"
                                           : "'Open Sans', 'DejaVu Sans', sans-serif";
    out.titulo = o;
  }
  if (raw.chapeu) out.chapeu = {
    show: !!raw.chapeu.show,
    centerX: num(raw.chapeu.centerX, 405, 0, 1600),
    centerY: num(raw.chapeu.centerY, 1337, 0, 2000),
  };
  return out;
}

// Carrega o layout de um template (+ área da foto auto-detectada + a própria imagem)
app.get('/api/admin/card-templates/:slug/layout', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const fs = require('fs');
    const cg = require('./utils/card-generator');
    const slug  = String(req.params.slug || '').toLowerCase();
    const tpath = cg.templatePathFor(slug);
    if (!fs.existsSync(tpath)) return res.status(404).json({ error: 'Template não encontrado.' });
    let layout = null;
    const lpath = cg.layoutPathFor(slug);
    if (fs.existsSync(lpath)) { try { layout = JSON.parse(fs.readFileSync(lpath, 'utf8')); } catch {} }
    let photoArea = null;
    try { photoArea = await cg.detectarAreaFoto(slug); } catch {}
    const imageBase64 = 'data:image/png;base64,' + fs.readFileSync(tpath).toString('base64');
    res.json({ slug, layout, photoArea, default: cg.LAYOUT_DEFAULT, imageBase64 });
  } catch (err) {
    console.error('[card-templates/layout/get]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Gera um preview real (mesmo motor de publicação) com o layout em edição
app.post('/api/admin/card-templates/:slug/preview', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const fs = require('fs');
    const cg = require('./utils/card-generator');
    const slug = String(req.params.slug || '').toLowerCase();
    if (!fs.existsSync(cg.templatePathFor(slug))) return res.status(404).json({ error: 'Template não encontrado.' });
    const layout = sanitizeLayoutInput((req.body && req.body.layout) || {});
    // Foto fixa de exemplo (não depende de internet); fallback p/ picsum se faltar o arquivo.
    let imageBuffer = null;
    try {
      const samplePath = require('path').join(cg.TEMPLATES_DIR, 'preview-sample.jpg');
      if (fs.existsSync(samplePath)) imageBuffer = fs.readFileSync(samplePath);
    } catch {}
    const buf = await cg.gerarCard({
      chapeu:   (req.body && req.body.chapeu)  || 'EXEMPLO',
      titulo:   (req.body && req.body.titulo)  || 'Título de exemplo para visualizar o card neste layout',
      imageUrl: 'https://picsum.photos/1600/1320',
      imageBuffer,
      cardConfig: { card_template: slug },
      layoutOverride: layout,
    });
    res.json({ image_base64: 'data:image/jpeg;base64,' + buf.toString('base64') });
  } catch (err) {
    console.error('[card-templates/preview]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Salva o layout (grava {slug}-layout.json)
app.put('/api/admin/card-templates/:slug/layout', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const fs = require('fs');
    const cg = require('./utils/card-generator');
    const slug = String(req.params.slug || '').toLowerCase();
    if (!fs.existsSync(cg.templatePathFor(slug))) return res.status(404).json({ error: 'Template não encontrado.' });
    const layout = sanitizeLayoutInput((req.body && req.body.layout) || {});
    if (!layout.fotoArea && !layout.titulo) return res.status(400).json({ error: 'Layout vazio.' });
    fs.writeFileSync(cg.layoutPathFor(slug), JSON.stringify(layout, null, 2));
    console.log(`[card-templates] layout "${slug}" salvo`);
    res.json({ ok: true, slug, layout });
  } catch (err) {
    console.error('[card-templates/layout/put]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Admin (Fase 4) — injeta contexto mutável do servidor
app.use('/api/admin', require('./routes/admin')({ sources, cache, atualizarFonte }));

// Página HTML com lista de matérias recentes pra testar geração de card
app.get('/api/test-card', async (req, res) => {
  const { gerarCard } = require('./utils/card-generator');
  const pool = require('./db/connection');

  // Modo lista: HTML com últimas matérias
  if (!req.query.article_id && !req.query.chapeu && !req.query.image_url) {
    try {
      const { rows } = await pool.query(`
        SELECT id, chapeu, title, summary, image_url, fetched_at
        FROM articles
        WHERE image_url IS NOT NULL AND summary IS NOT NULL AND length(summary) > 50
        ORDER BY fetched_at DESC
        LIMIT 20
      `);
      const cards = rows.map(r => `
        <div style="border:1px solid #ddd;border-radius:8px;padding:12px;margin:8px 0;background:#fff">
          <div style="font-size:12px;color:#666">${r.chapeu || '—'}</div>
          <div style="font-weight:600;margin:4px 0">${r.title || ''}</div>
          <div style="font-size:13px;color:#444;margin-bottom:8px">${(r.summary || '').substring(0, 200)}</div>
          <a href="/api/test-card?article_id=${r.id}" target="_blank"
             style="display:inline-block;background:#2563eb;color:#fff;padding:6px 14px;border-radius:6px;text-decoration:none;font-size:13px">
            🎨 Gerar card
          </a>
        </div>
      `).join('');
      return res.type('text/html').send(`
<!DOCTYPE html><html><head><meta charset="utf-8"><title>Teste Card XMNews</title></head>
<body style="font-family:sans-serif;background:#f5f5f5;padding:20px;max-width:900px;margin:0 auto">
  <h2>Teste de geração de card — XMNews</h2>
  <p>Últimas 20 matérias com imagem e resumo. Clique em "Gerar card" pra ver o resultado.</p>
  ${cards}
</body></html>`);
    } catch (err) {
      console.error('[test-card/list]', err);
      return res.status(500).type('text/plain').send('Erro: ' + err.message);
    }
  }

  // Modo render: gera e retorna o JPG
  try {
    const articleId = req.query.article_id;
    let chapeu = req.query.chapeu || 'COPA DO MUNDO';
    let titulo = req.query.titulo || 'Título de exemplo do card de notícias.';
    let imageUrl = req.query.image_url || 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/17/Luiz_In%C3%A1cio_Lula_da_Silva_and_George_W._Bush_20080709.jpg/1280px-Luiz_In%C3%A1cio_Lula_da_Silva_and_George_W._Bush_20080709.jpg';

    if (articleId) {
      const { rows } = await pool.query(
        'SELECT chapeu, title, image_url FROM articles WHERE id = $1',
        [articleId]
      );
      if (rows[0]) {
        chapeu   = rows[0].chapeu    || chapeu;
        titulo   = rows[0].title     || titulo;
        imageUrl = rows[0].image_url || imageUrl;
      }
    }

    const buffer = await gerarCard({ chapeu, titulo, imageUrl });
    res.type('image/jpeg').send(buffer);
  } catch (err) {
    console.error('[test-card]', err);
    res.status(500).type('text/plain').send('Erro: ' + err.message);
  }
});


// ─── Health check ─────────────────────────────────────────────────────────────
// GET /api/health — usado pelo deploy.sh para smoke test pós-restart
app.get('/api/health', async (req, res) => {
  const status = {
    status:    'ok',
    timestamp: new Date().toISOString(),
    uptime_s:  Math.floor(process.uptime()),
    db:        pool ? 'unknown' : 'not_configured',
    sources: {
      total:  sources.length,
      active: sources.filter(s => s.active).length,
    },
    cache: {
      loaded: Object.values(cache).filter(c => c.data.length > 0).length,
    },
  };

  if (pool) {
    try {
      await pool.query('SELECT 1');
      status.db = 'ok';

      const { rows } = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE fetched_at > NOW() - INTERVAL '1 hour')   AS last_1h,
          COUNT(*) FILTER (WHERE fetched_at > NOW() - INTERVAL '24 hours') AS last_24h
        FROM articles
      `);
      status.articles = {
        last_1h:  parseInt(rows[0].last_1h)  || 0,
        last_24h: parseInt(rows[0].last_24h) || 0,
      };

      const { rows: srcRows } = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE last_error IS NOT NULL)                                  AS com_erro,
          COUNT(*) FILTER (WHERE last_fetched_at < NOW() - INTERVAL '1 hour')             AS sem_coleta_1h
        FROM sources
        WHERE active = true AND last_fetched_at IS NOT NULL
      `);
      status.sources.com_erro      = parseInt(srcRows[0].com_erro) || 0;
      status.sources.sem_coleta_1h = parseInt(srcRows[0].sem_coleta_1h) || 0;

    } catch (e) {
      status.db     = 'error';
      status.db_err = e.message;
      status.status = 'degraded';
    }
  }

  const httpCode = status.status === 'ok' ? 200 : 503;
  res.status(httpCode).json(status);
});

// GET /api/proxy-image?url=... → proxy de imagens para contornar hotlink protection
app.get('/api/proxy-image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).end();

  // Validação básica: deve ser http/https
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return res.status(400).end();
  }

  try {
    const parsed    = new URL(url);
    const referer   = parsed.origin + '/';
    const UA        = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    const response = await axios.get(url, {
      responseType : 'stream',
      timeout      : 10000,
      headers      : {
        'User-Agent' : UA,
        'Referer'    : referer,
        'Accept'     : 'image/webp,image/apng,image/*,*/*;q=0.8',
      },
      httpsAgent: agenteSemSSL,
    });

    const contentType = response.headers['content-type'] || 'image/jpeg';
    res.set('Content-Type',  contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('Access-Control-Allow-Origin', '*');
    response.data.pipe(res);
  } catch (e) {
    // Fallback CF Worker para domínios bloqueados na Oracle Cloud (sc.gov.br etc)
    const cfProxy = require('./utils/cf-proxy');
    if (cfProxy.needsCFProxy(url) && cfProxy.isAvailable()) {
      try {
        const resp = await cfProxy.fetchViaCFProxy(url, { responseType: 'arraybuffer', timeout: 20000 });
        const contentType = resp.headers['content-type'] || 'image/jpeg';
        res.set('Content-Type',  contentType);
        res.set('Cache-Control', 'public, max-age=86400');
        res.set('Access-Control-Allow-Origin', '*');
        return res.send(Buffer.from(resp.data));
      } catch (e2) {
        console.warn(`[proxy-image] CF Worker falhou: ${e2.message} para ${url}`);
        return res.status(502).end();
      }
    }
    console.warn(`[proxy-image] ${e.message}`);
    res.status(404).end();
  }
});

// GET /api/sources → lista de fontes com status (requer login)
app.get('/api/sources', authMiddleware, (req, res) => {
  const resultado = sources.map(s => ({
    name:        s.name,
    slug:        s.slug,
    category:    s.category,
    type:        s.type,
    active:      s.active,
    status:      cache[s.slug]?.error ? 'error' : (cache[s.slug]?.lastUpdated ? 'ok' : 'pending'),
    lastUpdated: cache[s.slug]?.lastUpdated || null,
    error:       cache[s.slug]?.error || null,
    count:       cache[s.slug]?.data?.length || 0
  }));
  res.json(resultado);
});

// GET /api/feeds[?source=slug&category=cat&since=ISO] → notícias (requer login)
app.get('/api/feeds', authMiddleware, (req, res) => {
  const { source, category, since } = req.query;

  let itens = [];
  const ativas = sources.filter(s => s.active);
  const filtradas = source
    ? ativas.filter(s => s.slug === source)
    : category
      ? ativas.filter(s => s.category === category)
      : ativas;

  filtradas.forEach(s => {
    if (cache[s.slug]?.data?.length) {
      itens = itens.concat(cache[s.slug].data);
    }
  });

  // Filtro de data
  if (since) {
    const limite = new Date(since);
    if (!isNaN(limite.getTime())) {
      itens = itens.filter(it => new Date(it.published_at) >= limite);
    }
  }

  // Ordenar do mais novo para o mais antigo
  itens.sort((a, b) => new Date(b.published_at) - new Date(a.published_at));

  res.json(itens);
});

// GET /api/article?url=... → conteúdo completo do artigo via scraping (requer login + anti-SSRF)
app.get('/api/article', authMiddleware, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Parâmetro url é obrigatório.' });

  // Validação anti-SSRF: bloqueia IPs internos e protocolos não-HTTP
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({ error: 'URL inválida.' });
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return res.status(400).json({ error: 'Protocolo não permitido.' });
  }
  if (PRIVATE_IP_RE.test(parsedUrl.hostname)) {
    console.warn(`[api/article] Bloqueado acesso a IP interno: ${parsedUrl.hostname}`);
    return res.status(403).json({ error: 'URL não permitida.' });
  }

  try {
    const resp = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });

    const $ = cheerio.load(resp.data);

    // Remove elementos desnecessários
    $('script, style, nav, header, footer, .ad, .ads, .publicidade, .sidebar, .menu, .navigation, aside, .comments, .related, .share, iframe, noscript').remove();

    // Título da página
    const titulo =
      $('h1').first().text().trim() ||
      $('title').text().replace(/\s*[-|].*$/, '').trim() ||
      '';

    // Imagem principal (og:image ou primeira img relevante)
    const ogImage = $('meta[property="og:image"]').attr('content') ||
                    $('meta[name="twitter:image"]').attr('content') || null;

    // Conteúdo principal — tenta seletores comuns
    const seletores = [
      'article .entry-content',
      'article .post-content',
      'article .article-body',
      'article',
      '.entry-content',
      '.post-content',
      '.article-content',
      '.article-body',
      '.content-body',
      '.noticia-conteudo',
      '.texto-noticia',
      '[itemprop="articleBody"]',
      'main article',
      'main .content',
      'main'
    ];

    let conteudo = '';
    for (const sel of seletores) {
      const $el = $(sel);
      const texto = $el.text().replace(/\s+/g, ' ').trim();
      if ($el.length && texto.length > 150) {
        // Limpar links de publicidade e botões
        $el.find('a').each((_, a) => {
          const href = $(a).attr('href') || '';
          if (href.includes('javascript') || href.includes('utm_')) $(a).remove();
        });
        conteudo = $el.html() || '';
        break;
      }
    }

    // Último recurso: body inteiro
    if (!conteudo) {
      conteudo = $('body').html() || '';
    }

    res.json({
      url,
      titulo,
      imagem: ogImage,
      content: conteudo
    });

  } catch (err) {
    res.status(500).json({ error: `Não foi possível buscar o artigo: ${err.message}` });
  }
});

// GET /api/refresh[?source=slug] → forçar atualização manual
// ─── Config do .env ──────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  const cfg = {
    wpUrl:        process.env.WP_URL        || '',
    wpUsuario:    process.env.WP_USER       || '',
    wpSenha:      process.env.WP_PASSWORD   || '',
    deepseekKey:  process.env.DEEPSEEK_KEY  || '',
    backendUrl:   process.env.BACKEND_URL   || `http://localhost:${PORT}`,
  };
  const configurado = !!(cfg.wpUrl && cfg.wpUsuario && cfg.wpSenha && cfg.deepseekKey);
  res.json({ configurado, cfg });
});

app.get('/api/refresh', async (req, res) => {
  const { source: slug } = req.query;
  if (slug) {
    const fonte = sources.find(s => s.slug === slug);
    if (!fonte) return res.status(404).json({ error: 'Fonte não encontrada.' });
    await atualizarFonte(fonte);
    res.json({ ok: true, slug, count: cache[slug]?.data?.length || 0 });
  } else {
    // Atualizar em background, responder imediatamente
    atualizarTodasFontes();
    res.json({ ok: true, message: 'Atualização iniciada em background.' });
  }
});

// ─── Rota raiz → painel ───────────────────────────────────────────────────────
app.get('/', (req, res) => res.redirect('/login.html'));

// ─── Iniciar servidor ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🔴 RB24Horas Backend rodando em http://localhost:${PORT}`);
  console.log(`\n   ➤ Painel do assinante: http://localhost:${PORT}/login.html`);
  console.log(`\n   API disponível:`);
  console.log(`   GET  /api/sources          — status das fontes`);
  console.log(`   GET  /api/feeds            — todas as notícias`);
  console.log(`   POST /api/auth/login       — autenticação`);
  console.log(`   GET  /api/articles         — artigos do banco (JWT)`);
  console.log(`   GET  /api/refresh          — atualizar agora\n`);
});
