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
      extrairImagemDoConteudo(item['content:encoded'] || item.content || '') ||
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
          active                  = EXCLUDED.active,
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
async function persistirArtigos(itens, sourceSlug, source) {
  if (!pool) return;

  let novos = 0;
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

      // Rejeita artigos mais antigos que 45 dias
      if (norm.published_at) {
        const idadeMs = Date.now() - new Date(norm.published_at).getTime();
        if (idadeMs > 2 * 86400000) continue;
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
    }

    if (novos > 0) console.log(`[DB] ${sourceSlug}: ${novos} artigos novos salvos`);
  } catch (err) {
    console.error(`[DB] Erro ao persistir artigos de ${sourceSlug}:`, err.message);
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
  const resp = await axios.get(url, {
    timeout: 15000,
    params: { limit: source.api_limit || 20 },
    headers: { 'Accept': 'application/json', 'User-Agent': '' },
  });
  const items = resp.data?.data || resp.data?.items || resp.data || [];
  const baseUrl = source.api_article_base || new URL(url).origin;
  const slugPath = source.api_slug_path || '/materia/';

  return items.filter(a => a.isPublished !== false).map(a => ({
    id:           md5(a.slug || String(a.id) || a.title || ''),
    source:       source.name,
    source_slug:  source.slug,
    category:     source.category,
    title:        (a.title || '').trim(),
    summary:      a.excerpt || a.metaDescription || '',
    url:          `${baseUrl}${slugPath}${a.slug}`,
    image:        a.coverImage || null,
    published_at: normalizarData(a.publishedAt || a.published_at),
    content:      a.body || '',
    tags:         Array.isArray(a.tags) ? a.tags : [],
    author:       a.author?.name || null,
  }));
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

// ─── Carga inicial e agendamento ──────────────────────────────────────────────
criarIndicesBanco().catch(() => {});
sincronizarFontesDB().catch(() => {});
migrarSitesParaCatalogo().catch(() => {});
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

// ─── ROTAS ────────────────────────────────────────────────────────────────────

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

// IA — reescrita de artigos (usa GEMINI_KEY do servidor)
app.use('/api/ia', require('./routes/ia'));

// Configurações públicas (provedor de IA global, sem autenticação)
app.get('/api/settings', (req, res) => {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf8'));
    res.json(s);
  } catch { res.json({ ia_provider: 'gemini' }); }
});

// Proxy de imagens (evita bloqueio de hotlink nos portais)
app.use('/api/proxy-image', require('./routes/image-proxy'));

// Catálogo central de sites (admin)
app.use('/api/admin/sites-catalog', require('./routes/sites-catalog'));

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
    let resumo = req.query.resumo || 'Texto de exemplo do resumo.';
    let imageUrl = req.query.image_url || 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/17/Luiz_In%C3%A1cio_Lula_da_Silva_and_George_W._Bush_20080709.jpg/1280px-Luiz_In%C3%A1cio_Lula_da_Silva_and_George_W._Bush_20080709.jpg';

    if (articleId) {
      const { rows } = await pool.query(
        'SELECT chapeu, summary, image_url FROM articles WHERE id = $1',
        [articleId]
      );
      if (rows[0]) {
        chapeu   = rows[0].chapeu   || chapeu;
        resumo   = rows[0].summary  || resumo;
        imageUrl = rows[0].image_url || imageUrl;
      }
    }

    const buffer = await gerarCard({ chapeu, resumo, imageUrl });
    res.type('image/jpeg').send(buffer);
  } catch (err) {
    console.error('[test-card]', err);
    res.status(500).type('text/plain').send('Erro: ' + err.message);
  }
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

// GET /api/sources → lista de fontes com status
app.get('/api/sources', (req, res) => {
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

// GET /api/feeds[?source=slug&category=cat&since=ISO] → notícias
app.get('/api/feeds', (req, res) => {
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

// GET /api/article?url=... → conteúdo completo do artigo via scraping
app.get('/api/article', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Parâmetro url é obrigatório.' });

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
    geminiKey:    process.env.GEMINI_KEY    || '',
    backendUrl:   process.env.BACKEND_URL   || `http://localhost:${PORT}`,
  };
  // Só retorna se ao menos wpUrl e wpUsuario estiverem preenchidos
  const configurado = !!(cfg.wpUrl && cfg.wpUsuario && cfg.wpSenha && cfg.geminiKey);
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
