'use strict';

require('dotenv').config();

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
function normalizarData(val) {
  if (!val) return new Date().toISOString();
  try {
    const d = new Date(val);
    if (isNaN(d.getTime()) || d.getTime() > Date.now()) return new Date().toISOString();
    return d.toISOString();
  } catch { return new Date().toISOString(); }
}

// Resolve URL relativa usando a base da fonte
function resolverUrl(href, base) {
  if (!href) return null;
  if (href.startsWith('http')) return href;
  try { return new URL(href, base).href; } catch { return null; }
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
    // Remover BOM (UTF-8: EF BB BF) e whitespace antes da tag XML
    let xml = respAxios.data;
    xml = xml.replace(/^\uFEFF/, '').replace(/^[\s\S]*?(<\?xml|<rss|<feed|<channel)/i, '$1');
    feed = await rss.parseString(xml);
  }

  return feed.items.map(item => {
    // Tentar obter imagem de várias fontes comuns
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

// ─── Busca por Scraping (prefeituras e outros sem RSS) ─────────────────────────
async function buscarScraping(source) {
  const resp = await axios.get(source.url, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 RB24Horas-Aggregator/1.0' },
    httpsAgent: agenteSemSSL  // ignora erros de cert em sites de prefeitura
  });
  const $ = cheerio.load(resp.data);

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

    // Data
    const dateSel = cfg.dateSelector || 'time, .date, .data, .published, .post-date';
    const dateEl  = $el.find(dateSel).first();
    const dataISO = normalizarData(dateEl.attr('datetime') || dateEl.text().trim());

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

// ─── Criar índices no banco (executado uma vez na inicialização) ─────────────
async function criarIndicesBanco() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_articles_url  ON articles(external_url);
      CREATE INDEX IF NOT EXISTS idx_articles_date ON articles(published_at DESC);
      CREATE INDEX IF NOT EXISTS idx_articles_src  ON articles(source_id);
    `);
    // Colunas de perfil do assinante — precisam existir antes do GET /auth/me
    await pool.query(`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS phone   VARCHAR(30)`);
    await pool.query(`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS address TEXT`);
  } catch (err) {
    console.error('[DB] Erro ao criar índices:', err.message);
  }
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

// ─── Atualizar uma fonte ──────────────────────────────────────────────────────
async function atualizarFonte(source) {
  try {
    let itens;
    if (source.type === 'rss') {
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
atualizarTodasFontes();
limparArtigosAntigos();
cron.schedule('*/15 * * * *', atualizarTodasFontes);
cron.schedule('0 * * * *', limparArtigosAntigos); // limpeza a cada hora

// Autopub — verifica a cada minuto se chegou a hora de rodar (intervalo configurável)
const { verificarERotar } = require('./autopub');
cron.schedule('* * * * *', () => verificarERotar().catch(e => console.error('[AUTOPUB]', e.message)));

// ─── ROTAS ────────────────────────────────────────────────────────────────────

// Auth (login / logout / me)
app.use('/api/auth', require('./routes/auth'));

// Artigos e publicação (Fase 2)
app.use('/api/articles',           require('./routes/articles'));
app.use('/api/publish',            require('./routes/publish'));
app.use('/api/sites',              require('./routes/sites'));
app.use('/api/drafts',             require('./routes/drafts'));
app.use('/api/subscriber/sources', require('./routes/subscriber-sources'));

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
  } catch {
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
