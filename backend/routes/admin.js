'use strict';

const express  = require('express');
const bcrypt   = require('bcrypt');
const fs       = require('fs');
const path     = require('path');
const pool     = require('../db/connection');
const adminAuth = require('../middleware/adminAuth');

const SOURCES_PATH   = path.join(__dirname, '../sources.json');
const SETTINGS_PATH  = path.join(__dirname, '../settings.json');

function lerSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch { return {}; }
}
function salvarSettings(obj) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(obj, null, 2), 'utf8');
}

/**
 * Cria o router admin injetando o contexto do servidor
 * (sources array mutável, cache, atualizarFonte).
 */
module.exports = function createAdminRouter({ sources, cache, atualizarFonte }) {
  const router = express.Router();
  router.use(adminAuth);

  // ── Salva sources.json no disco ─────────────────────────────────────────────
  function salvarSourcesJson() {
    fs.writeFileSync(SOURCES_PATH, JSON.stringify(sources, null, 2), 'utf8');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ESTATÍSTICAS
  // ════════════════════════════════════════════════════════════════════════════

  // GET /api/admin/stats
  router.get('/stats', async (req, res) => {
    try {
      const [totalArt, hojeArt, erros, totalSubs] = await Promise.all([
        pool.query('SELECT COUNT(*) FROM articles'),
        pool.query("SELECT COUNT(*) FROM articles WHERE fetched_at >= now() - interval '24 hours'"),
        pool.query('SELECT COUNT(*) FROM articles WHERE fetched_at IS NULL'),
        pool.query('SELECT COUNT(*) FROM subscribers WHERE active = true'),
      ]);

      const bySource = await pool.query(`
        SELECT so.name, so.slug, so.category, COUNT(a.id)::int AS total
        FROM sources so
        LEFT JOIN articles a ON a.source_id = so.id
        GROUP BY so.id, so.name, so.slug, so.category
        ORDER BY total DESC
      `);

      res.json({
        totalArticles:      parseInt(totalArt.rows[0].count),
        articlesToday:      parseInt(hojeArt.rows[0].count),
        activeSubscribers:  parseInt(totalSubs.rows[0].count),
        activeSources:      sources.filter(s => s.active).length,
        totalSources:       sources.length,
        bySource:           bySource.rows,
      });
    } catch (err) {
      console.error('[admin/stats]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // FONTES
  // ════════════════════════════════════════════════════════════════════════════

  // GET /api/admin/sources — lista completa com status do cache
  router.get('/sources', (req, res) => {
    const lista = sources.map(s => ({
      ...s,
      status:      cache[s.slug]?.error ? 'error' : (cache[s.slug]?.lastUpdated ? 'ok' : 'pending'),
      lastUpdated: cache[s.slug]?.lastUpdated || null,
      error:       cache[s.slug]?.error || null,
      count:       cache[s.slug]?.data?.length || 0,
    }));
    res.json(lista);
  });

  // PATCH /api/admin/sources/:slug/toggle — ativa/desativa
  router.patch('/sources/:slug/toggle', async (req, res) => {
    const { slug } = req.params;
    const fonte = sources.find(s => s.slug === slug);
    if (!fonte) return res.status(404).json({ error: 'Fonte não encontrada.' });

    fonte.active = !fonte.active;
    salvarSourcesJson();

    // Sincroniza com DB
    try {
      await pool.query('UPDATE sources SET active = $1 WHERE slug = $2', [fonte.active, slug]);
    } catch {}

    // Se ativou, coleta imediatamente
    if (fonte.active) {
      cache[slug] = cache[slug] || { data: [], lastUpdated: null, error: null };
      atualizarFonte(fonte).catch(() => {});
    }

    res.json({ slug, active: fonte.active });
  });

  // PATCH /api/admin/sources/:slug/refresh — força atualização
  router.patch('/sources/:slug/refresh', async (req, res) => {
    const { slug } = req.params;
    const fonte = sources.find(s => s.slug === slug);
    if (!fonte) return res.status(404).json({ error: 'Fonte não encontrada.' });
    if (!fonte.active) return res.status(400).json({ error: 'Fonte inativa.' });

    atualizarFonte(fonte).catch(() => {});
    res.json({ ok: true, message: 'Atualização iniciada.' });
  });

  // POST /api/admin/sources — cria nova fonte
  router.post('/sources', async (req, res) => {
    const { name, slug, type, url, category, scraping, extract_body_image, featured_image_selector } = req.body || {};
    if (!name || !slug || !type || !url) {
      return res.status(400).json({ error: 'name, slug, type e url são obrigatórios.' });
    }
    if (sources.find(s => s.slug === slug)) {
      return res.status(409).json({ error: 'Slug já existe.' });
    }

    const novaFonte = { name, slug, type, url, active: true, category: category || 'nacional' };
    if (scraping && Object.keys(scraping).length) novaFonte.scraping = scraping;
    if (extract_body_image) novaFonte.extract_body_image = true;
    if (featured_image_selector) novaFonte.featured_image_selector = featured_image_selector;

    sources.push(novaFonte);
    cache[slug] = { data: [], lastUpdated: null, error: null };
    salvarSourcesJson();

    // Salva no DB
    try {
      const cfg = scraping || {};
      await pool.query(`
        INSERT INTO sources (name, slug, type, url, section_selector, title_selector,
          date_selector, link_selector, image_selector, category, active, extract_body_image,
          featured_image_selector)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (slug) DO UPDATE SET name=$1, url=$4, type=$3, active=$11, extract_body_image=$12,
          featured_image_selector=$13
      `, [name, slug, type, url,
          cfg.itemSelector || null, cfg.titleSelector || null, cfg.dateSelector || null,
          cfg.linkSelector || null, cfg.imageSelector || null,
          category || 'nacional', true, !!extract_body_image,
          featured_image_selector || null]);
    } catch {}

    // Coleta imediatamente
    atualizarFonte(novaFonte).catch(() => {});
    res.status(201).json(novaFonte);
  });

  // PUT /api/admin/sources/:slug — edita fonte
  router.put('/sources/:slug', async (req, res) => {
    const { slug } = req.params;
    const idx = sources.findIndex(s => s.slug === slug);
    if (idx === -1) return res.status(404).json({ error: 'Fonte não encontrada.' });

    const { name, url, category, type, scraping, extract_body_image, content_selector, featured_image_selector } = req.body || {};
    const fonte = sources[idx];

    // Detecta mudança de config de scraping antes de atualizar
    const scraperConfigMudou =
      (content_selector        || null) !== (fonte.content_selector        || null) ||
      (featured_image_selector || null) !== (fonte.featured_image_selector || null) ||
      (!!extract_body_image)            !== (!!fonte.extract_body_image);

    if (name)     fonte.name     = name;
    if (url)      fonte.url      = url;
    if (category) fonte.category = category;
    if (type)     fonte.type     = type;
    if (scraping !== undefined) {
      if (scraping && Object.keys(scraping).length) fonte.scraping = scraping;
      else delete fonte.scraping;
    }
    fonte.extract_body_image      = !!extract_body_image;
    fonte.content_selector        = content_selector        || null;
    fonte.featured_image_selector = featured_image_selector || null;

    salvarSourcesJson();

    try {
      await pool.query(
        'UPDATE sources SET name=$1, url=$2, category=$3, type=$4, extract_body_image=$5, content_selector=$6, featured_image_selector=$7 WHERE slug=$8',
        [fonte.name, fonte.url, fonte.category, fonte.type, !!extract_body_image, content_selector || null, featured_image_selector || null, slug]
      );
      // Quando config de scraping muda, invalida corpos cacheados para que a próxima
      // abertura use os novos seletores. Só executa se algo mudou para evitar trabalho desnecessário.
      if (scraperConfigMudou) {
        await pool.query(
          'UPDATE articles SET body = NULL WHERE source_id = (SELECT id FROM sources WHERE slug = $1)',
          [slug]
        );
        console.log(`[admin/sources] config scraping alterada em "${slug}" → cache de body limpo`);
      }
    } catch {}

    res.json(fonte);
  });

  // POST /api/admin/sources/analyze — detecta RSS, seletor e imagem automaticamente
  router.post('/sources/analyze', async (req, res) => {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url é obrigatório.' });

    const axios   = require('axios');
    const cheerio = require('cheerio');

    const CONTENT_SELECTORS = [
      'article .entry-content', '.entry-content', '.article-content',
      '.article-body', '.post-content', '.post-body', '.content-body',
      '[itemprop="articleBody"]', '.td-post-content', '.jeg_post_content',
      '.tdb-block-inner', '.noticia-texto', '.materia-conteudo', '.texto-noticia',
      '.corpo-noticia', '#article-body', '.story-body', '.article__body',
      '.article__content', '.single-content', '.entry-content.single-content',
      'article', 'main article',
    ];

    const hdrs = {
      'Accept':          'text/html,application/xhtml+xml,*/*',
      'Accept-Language': 'pt-BR,pt;q=0.9',
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    };

    try {
      const parsed = new URL(url);
      const origin = parsed.origin;
      const domain = parsed.hostname.replace(/^www\./, '');

      const resp = await axios.get(url, { headers: hdrs, timeout: 15000, maxRedirects: 5 });
      const html = typeof resp.data === 'string' ? resp.data : '';
      const $    = cheerio.load(html);

      // Nome do site
      const siteName =
        $('meta[property="og:site_name"]').attr('content')?.trim() ||
        ($('title').text() || '').split(/[\-\|]/)[0].trim() ||
        domain.split('.')[0];

      // RSS — meta tag
      let rssUrl = null;
      const rssLink = $('link[rel="alternate"][type="application/rss+xml"]').first();
      if (rssLink.length) {
        const href = rssLink.attr('href') || '';
        rssUrl = href.startsWith('http') ? href : new URL(href, origin).href;
      }
      // RSS — caminhos comuns
      if (!rssUrl) {
        for (const path of ['/feed', '/feed/', '/rss', '/feed.xml', '/rss.xml', '/atom.xml', '/feed/rss2']) {
          try {
            const fr = await axios.get(origin + path, { headers: hdrs, timeout: 5000, maxRedirects: 3 });
            const ct = fr.headers['content-type'] || '';
            const bd = typeof fr.data === 'string' ? fr.data : '';
            if (ct.includes('xml') || ct.includes('rss') || bd.includes('<rss') || bd.includes('<feed ')) {
              rssUrl = origin + path; break;
            }
          } catch {}
        }
      }

      // Slug
      const slug = domain.split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, '');

      // Links de artigos na página
      const articleLinks = [];
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('#')) return;
        let full;
        try { full = new URL(href, url).href.split('?')[0].split('#')[0]; } catch { return; }
        if (!full.startsWith(origin)) return;
        if (full === url || full === origin || full === origin + '/') return;
        const segs = new URL(full).pathname.split('/').filter(Boolean);
        if (segs.length >= 2 && !full.match(/\.(css|js|xml|pdf|jpg|png|webp|gif|svg)$/)) {
          articleLinks.push(full);
        }
      });
      const uniqueLinks = [...new Set(articleLinks)].slice(0, 5);

      // Artigo de amostra — prefer link encontrado; se a própria URL já é artigo usa ela
      let sampleUrl = uniqueLinks[0] || null;
      if (!sampleUrl && parsed.pathname.split('/').filter(Boolean).length >= 2) sampleUrl = url;

      // Testa seletores no artigo de amostra
      let bestSelector   = null;
      let extractBodyImg = false;
      let ogImageUrl     = null;

      if (sampleUrl) {
        try {
          const ar = await axios.get(sampleUrl, { headers: hdrs, timeout: 15000, maxRedirects: 5 });
          const ah = typeof ar.data === 'string' ? ar.data : '';
          const $a = cheerio.load(ah);

          ogImageUrl = $a('meta[property="og:image"]').attr('content') || null;
          if (ogImageUrl) {
            const lc  = ogImageUrl.toLowerCase();
            const bad = ['logo', 'default', 'placeholder', 'banner', 'frame-video', 'icon', 'favicon', '-og-', 'og-image', 'site-image', 'home-'];
            if (bad.some(p => lc.includes(p))) extractBodyImg = true;
          } else {
            extractBodyImg = true;
          }

          let best = { selector: null, score: 0 };
          for (const sel of CONTENT_SELECTORS) {
            try {
              const el = $a(sel).first();
              if (!el.length) continue;
              const txt = el.text().replace(/\s+/g, ' ').trim();
              if (txt.length > best.score) best = { selector: sel, score: txt.length };
            } catch {}
          }
          if (best.score > 200) bestSelector = best.selector;
        } catch {}
      }

      // Detecta seletores de scraping (listagem) quando não há RSS
      let scrapingSelectors = null;
      if (!rssUrl) {
        // Conta quantos links de artigo cada elemento pai contém
        const parentCount = new Map();
        $('a[href]').each((_, el) => {
          const href = $(el).attr('href') || '';
          let isArticle = false;
          try {
            const full = new URL(href, origin).href.split('?')[0].split('#')[0];
            if (full.startsWith(origin) && full !== origin && full !== origin + '/') {
              const segs = new URL(full).pathname.split('/').filter(Boolean);
              if (segs.length >= 2) isArticle = true;
            }
          } catch {}
          if (!isArticle) return;

          // Sobe até 3 níveis para encontrar o container do item
          let node = $(el);
          for (let i = 0; i < 3; i++) {
            node = node.parent();
            const tag = (node.prop('tagName') || '').toLowerCase();
            if (!tag || tag === 'body' || tag === 'html') break;
            const cls = (node.attr('class') || '').split(/\s+/).filter(c => c && !c.match(/^(active|current|first|last|odd|even|\d+)$/i)).slice(0, 2).join('.');
            const key = cls ? `${tag}.${cls}` : tag;
            if (!key.match(/nav|menu|footer|header|breadcrumb|sidebar|widget/i)) {
              parentCount.set(key, (parentCount.get(key) || 0) + 1);
            }
          }
        });

        // Pega o elemento com mais links de artigo (mínimo 3)
        let bestItemSel = null, bestItemCount = 0;
        for (const [sel, cnt] of parentCount) {
          if (cnt > bestItemCount && cnt >= 3) { bestItemCount = cnt; bestItemSel = sel; }
        }

        if (bestItemSel) {
          // Detecta título e link dentro do item
          const sample = $(bestItemSel).first();
          const headingTag = ['h1','h2','h3','h4'].find(h => sample.find(h).length > 0);
          scrapingSelectors = {
            itemSelector:  bestItemSel,
            titleSelector: headingTag || 'a',
            linkSelector:  'a',
            imageSelector: sample.find('img').length ? 'img' : null,
          };
        }
      }

      res.json({
        name:               siteName,
        slug,
        type:               rssUrl ? 'rss' : 'scraping',
        url:                rssUrl || url,
        rss_url:            rssUrl,
        content_selector:   bestSelector,
        extract_body_image: extractBodyImg,
        category:           'nacional',
        sample_article_url: sampleUrl,
        og_image_url:       ogImageUrl,
        scraping:           scrapingSelectors,
      });
    } catch (err) {
      console.error('[sources/analyze]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/sources/test-scraping — testa extração sem precisar de fonte salva
  router.post('/sources/test-scraping', async (req, res) => {
    const { test_url, content_selector, extract_body_image, featured_image_selector } = req.body || {};
    if (!test_url) return res.status(400).json({ error: 'test_url é obrigatório.' });
    const { fetchFullContent } = require('../scrapers/full-content');
    try {
      const result = await fetchFullContent(test_url, {
        content_selector:        content_selector        || null,
        featured_image_selector: featured_image_selector || null,
        extract_body_image:      !!extract_body_image,
        url:                     test_url,
      });
      const bodyText = (result.body || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      res.json({
        body_length:  bodyText.length,
        body_preview: bodyText.slice(0, 600),
        image_url:    result.image_url || null,
        ok:           bodyText.length > 100,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/admin/sources/:slug/test-scraping — testa extração de conteúdo
  router.post('/sources/:slug/test-scraping', async (req, res) => {
    const { slug } = req.params;
    const { test_url } = req.body || {};
    if (!test_url) return res.status(400).json({ error: 'test_url é obrigatório.' });

    const fonte = sources.find(s => s.slug === slug);
    const { fetchFullContent } = require('../scrapers/full-content');

    try {
      const result = await fetchFullContent(test_url, {
        content_selector:        (req.body.content_selector        ?? fonte?.content_selector)        || null,
        featured_image_selector: (req.body.featured_image_selector ?? fonte?.featured_image_selector) || null,
        extract_body_image:       req.body.extract_body_image      ?? fonte?.extract_body_image       ?? false,
        url:                     test_url,
      });
      const bodyText  = (result.body || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      res.json({
        body_length:  bodyText.length,
        body_preview: bodyText.slice(0, 600),
        image_url:    result.image_url || null,
        ok:           bodyText.length > 100,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE /api/admin/sources/:slug — remove fonte
  router.delete('/sources/:slug', async (req, res) => {
    const { slug } = req.params;
    const idx = sources.findIndex(s => s.slug === slug);
    if (idx === -1) return res.status(404).json({ error: 'Fonte não encontrada.' });

    sources.splice(idx, 1);
    delete cache[slug];
    salvarSourcesJson();

    try {
      await pool.query('UPDATE sources SET active = false WHERE slug = $1', [slug]);
    } catch {}

    res.json({ ok: true, slug });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // ASSINANTES
  // ════════════════════════════════════════════════════════════════════════════

  // GET /api/admin/subscribers[?includeInactive=true]
  router.get('/subscribers', async (req, res) => {
    const includeInactive = req.query.includeInactive === 'true';
    try {
      const { rows } = await pool.query(`
        SELECT s.id, s.name, s.email, s.active, s.is_admin,
               s.created_at, s.plan_expires_at, s.plan_value, s.gemini_key,
               s.telegram_chat_id,
               p.name AS plan_name, p.id AS plan_id
        FROM subscribers s
        LEFT JOIN plans p ON p.id = s.plan_id
        ${includeInactive ? '' : 'WHERE s.active = true'}
        ORDER BY s.created_at DESC
      `);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/subscribers — cria novo assinante
  router.post('/subscribers', async (req, res) => {
    const { name, email, password, plan_id, is_admin = false } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email e password são obrigatórios.' });
    }
    try {
      const hash = await bcrypt.hash(password, 10);
      const { rows } = await pool.query(`
        INSERT INTO subscribers (name, email, password_hash, plan_id, is_admin)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, name, email, active, is_admin, created_at
      `, [name, email.toLowerCase().trim(), hash, plan_id || null, is_admin]);
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'Email já cadastrado.' });
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/admin/subscribers/:id — edita assinante
  router.put('/subscribers/:id', async (req, res) => {
    const { name, email, password, plan_id, active, is_admin, plan_expires_at } = req.body || {};
    try {
      const sets = [];
      const vals = [];
      let p = 1;
      if (name     !== undefined) { sets.push(`name = $${p++}`);            vals.push(name); }
      if (email    !== undefined) { sets.push(`email = $${p++}`);           vals.push(email.toLowerCase().trim()); }
      if (plan_id  !== undefined) { sets.push(`plan_id = $${p++}`);         vals.push(plan_id); }
      if (active   !== undefined) { sets.push(`active = $${p++}`);          vals.push(active); }
      if (is_admin !== undefined) { sets.push(`is_admin = $${p++}`);        vals.push(is_admin); }
      if (plan_expires_at !== undefined) { sets.push(`plan_expires_at = $${p++}`); vals.push(plan_expires_at); }
      if (req.body.plan_value  !== undefined) { sets.push(`plan_value = $${p++}`);  vals.push(req.body.plan_value); }
      if (req.body.gemini_key       !== undefined) { sets.push(`gemini_key = $${p++}`);        vals.push(req.body.gemini_key || null); }
      if (req.body.ai_prompt        !== undefined) { sets.push(`ai_prompt = $${p++}`);         vals.push(req.body.ai_prompt || null); }
      if (req.body.telegram_chat_id !== undefined) { sets.push(`telegram_chat_id = $${p++}`); vals.push(req.body.telegram_chat_id ? String(req.body.telegram_chat_id) : null); }
      if (password) {
        const hash = await bcrypt.hash(password, 10);
        sets.push(`password_hash = $${p++}`);
        vals.push(hash);
      }
      if (!sets.length) return res.status(400).json({ error: 'Nenhum campo para atualizar.' });

      vals.push(req.params.id);
      const { rows } = await pool.query(
        `UPDATE subscribers SET ${sets.join(', ')} WHERE id = $${p} RETURNING id, name, email, active, is_admin`,
        vals
      );
      if (!rows[0]) return res.status(404).json({ error: 'Assinante não encontrado.' });
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/admin/subscribers/:id — desativa assinante
  router.delete('/subscribers/:id', async (req, res) => {
    try {
      await pool.query('UPDATE subscribers SET active = false WHERE id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/admin/subscribers/:id/permanente — exclui assinante e todos os dados vinculados
  router.delete('/subscribers/:id/permanente', async (req, res) => {
    const { id } = req.params;
    try {
      await pool.query('DELETE FROM publications WHERE subscriber_id = $1', [id]);
      await pool.query('DELETE FROM subscribers   WHERE id           = $1', [id]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/admin/all-sites — todos os sites de todos os assinantes (para publicação pelo admin)
  router.get('/all-sites', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT ss.id, ss.ai_prompt, ss.default_category_id, ss.active,
               ss.site_id                                        AS catalog_id,
               COALESCE(sc.name, ss.name)                       AS name,
               COALESCE(sc.platform, ss.platform)               AS platform,
               COALESCE(sc.site_url, ss.site_url)               AS site_url,
               COALESCE(sc.wp_username, ss.wp_username)         AS wp_username,
               COALESCE(sc.wp_app_password, ss.wp_app_password) AS wp_app_password,
               COALESCE(sc.blogger_blog_id, ss.blogger_blog_id) AS blogger_blog_id,
               COALESCE(sc.xixo_api_key, ss.xixo_api_key)       AS xixo_api_key,
               COALESCE(sc.webhook_url, ss.webhook_url)         AS webhook_url,
               COALESCE(sc.webhook_secret, ss.webhook_secret)   AS webhook_secret,
               COALESCE(sc.post_format, ss.post_format)         AS post_format,
               COALESCE(sc.facebook_enabled, false)             AS facebook_enabled,
               sub.name  AS subscriber_name,
               sub.email AS subscriber_email
        FROM subscriber_sites ss
        LEFT JOIN sites_catalog sc  ON sc.id = ss.site_id
        JOIN subscribers        sub ON sub.id = ss.subscriber_id
        WHERE ss.active = true
        ORDER BY sub.name, name
      `);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PATCH /api/admin/publications/:id — atualiza campos rewritten de uma publicação existente
  router.patch('/publications/:id', async (req, res) => {
    const { id } = req.params;
    const { rewritten_title, rewritten_body, rewritten_chapeu, rewritten_summary, rewritten_tags } = req.body || {};
    try {
      await pool.query(
        `UPDATE publications
         SET rewritten_title   = COALESCE($1, rewritten_title),
             rewritten_body    = COALESCE($2, rewritten_body),
             rewritten_chapeu  = COALESCE($3, rewritten_chapeu),
             rewritten_summary = COALESCE($4, rewritten_summary),
             rewritten_tags    = COALESCE($5, rewritten_tags)
         WHERE id = $6`,
        [
          rewritten_title  || null,
          rewritten_body   || null,
          rewritten_chapeu || null,
          rewritten_summary|| null,
          rewritten_tags   || null,
          id
        ]
      );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/admin/recent-publications — últimas publicações de todos os clientes
  router.get('/recent-publications', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT p.id, p.article_id, p.platform, p.status,
               p.rewritten_title, p.rewritten_body,
               p.rewritten_chapeu, p.rewritten_summary, p.rewritten_tags,
               p.external_post_url, p.published_at,
               sub.name AS subscriber_name,
               ss.name AS site_name, ss.site_url,
               a.title AS original_title,
               a.image_url AS article_image_url,
               a.external_url AS article_external_url,
               so.name AS article_source_name
        FROM publications p
        JOIN subscribers sub ON sub.id = p.subscriber_id
        LEFT JOIN subscriber_sites ss ON ss.id = p.site_id
        LEFT JOIN articles a ON a.id = p.article_id
        LEFT JOIN sources so ON so.id = a.source_id
        ORDER BY p.published_at DESC
        LIMIT 50
      `);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/admin/plans — lista planos disponíveis
  router.get('/plans', async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM plans WHERE active = true ORDER BY price_cents');
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // FONTES POR ASSINANTE (gestão pelo admin)
  // ════════════════════════════════════════════════════════════════════════════

  // GET /api/admin/subscribers/:id/sources — catálogo completo + flag selected
  router.get('/subscribers/:id/sources', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT
          s.id, s.name, s.slug, s.type, s.category, s.active,
          CASE WHEN ss.subscriber_id IS NOT NULL THEN true ELSE false END AS selected
        FROM sources s
        LEFT JOIN subscriber_sources ss
          ON ss.source_id = s.id AND ss.subscriber_id = $1
        WHERE s.active = true
        ORDER BY s.category, s.name
      `, [req.params.id]);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/subscribers/:id/sources/:slug — atribui fonte ao assinante
  router.post('/subscribers/:id/sources/:slug', async (req, res) => {
    try {
      const { rows: src } = await pool.query('SELECT id FROM sources WHERE slug = $1', [req.params.slug]);
      if (!src[0]) return res.status(404).json({ error: 'Fonte não encontrada.' });
      await pool.query(`
        INSERT INTO subscriber_sources (subscriber_id, source_id)
        VALUES ($1, $2) ON CONFLICT DO NOTHING
      `, [req.params.id, src[0].id]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/admin/subscribers/:id/sources/:slug — remove fonte do assinante
  router.delete('/subscribers/:id/sources/:slug', async (req, res) => {
    try {
      const { rows: src } = await pool.query('SELECT id FROM sources WHERE slug = $1', [req.params.slug]);
      if (!src[0]) return res.status(404).json({ error: 'Fonte não encontrada.' });
      await pool.query(`
        DELETE FROM subscriber_sources WHERE subscriber_id = $1 AND source_id = $2
      `, [req.params.id, src[0].id]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // SITES POR ASSINANTE (gestão pelo admin)
  // ════════════════════════════════════════════════════════════════════════════

  const { encryptToken } = require('../connectors/encrypt');

  // Regras de autopub agora são gerenciadas no nível do catálogo (sites_catalog).
  // Esta função é mantida apenas para não quebrar chamadas legadas, mas não faz nada.
  async function salvarAutopubRules() {}

  // GET /api/admin/subscribers/:id/sites
  router.get('/subscribers/:id/sites', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT ss.id, ss.ai_prompt, ss.default_category_id,
                ss.active, ss.created_at, ss.site_id AS catalog_id,
                COALESCE(sc.name, ss.name)                       AS name,
                COALESCE(sc.platform, ss.platform)               AS platform,
                COALESCE(sc.site_url, ss.site_url)               AS site_url,
                COALESCE(sc.wp_username, ss.wp_username)         AS wp_username,
                COALESCE(sc.xixo_api_key, ss.xixo_api_key)       AS xixo_api_key,
                COALESCE(sc.blogger_blog_id, ss.blogger_blog_id) AS blogger_blog_id,
                COALESCE(sc.webhook_url, ss.webhook_url)         AS webhook_url,
                COALESCE(sc.webhook_secret, ss.webhook_secret)   AS webhook_secret,
                COALESCE(sc.post_format, ss.post_format)         AS post_format
         FROM subscriber_sites ss
         LEFT JOIN sites_catalog sc ON sc.id = ss.site_id
         WHERE ss.subscriber_id = $1
         ORDER BY ss.created_at DESC`,
        [req.params.id]
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // GET /api/admin/sources-list — lista todas as fontes ativas para UI de autopub
  router.get('/sources-list', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, name, slug, category FROM sources WHERE active = true ORDER BY category, name`
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // POST /api/admin/subscribers/:id/sites — vincula site do catálogo ao assinante
  router.post('/subscribers/:id/sites', async (req, res) => {
    const { site_id, ai_prompt, default_category_id,
            autopub_source_ids } = req.body || {};
    if (!site_id) return res.status(400).json({ error: 'site_id é obrigatório.' });
    try {
      const { rows: cat } = await pool.query(
        `SELECT id, name, platform, site_url FROM sites_catalog WHERE id = $1 AND active = true`,
        [site_id]
      );
      if (!cat[0]) return res.status(404).json({ error: 'Site não encontrado no catálogo.' });
      const { rows } = await pool.query(
        `INSERT INTO subscriber_sites
           (subscriber_id, site_id, name, platform, site_url, ai_prompt, default_category_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, active`,
        [req.params.id, site_id, cat[0].name, cat[0].platform, cat[0].site_url,
         ai_prompt || null, default_category_id || null]
      );
      await salvarAutopubRules(rows[0].id, req.params.id, autopub_source_ids);
      res.status(201).json({ ...rows[0], name: cat[0].name, platform: cat[0].platform, site_url: cat[0].site_url });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // PUT /api/admin/subscribers/:id/sites/:siteId — atualiza config do assinante (não as credenciais)
  router.put('/subscribers/:id/sites/:siteId', async (req, res) => {
    const { ai_prompt, default_category_id, autopub_source_ids } = req.body || {};
    try {
      const sets = []; const vals = []; let p = 1;
      if (ai_prompt           !== undefined) { sets.push(`ai_prompt = $${p++}`);           vals.push(ai_prompt || null); }
      if (default_category_id !== undefined) { sets.push(`default_category_id = $${p++}`); vals.push(default_category_id || null); }
      if (!sets.length && autopub_source_ids === undefined)
        return res.status(400).json({ error: 'Nada para atualizar.' });
      if (sets.length) {
        vals.push(req.params.siteId, req.params.id);
        const { rows } = await pool.query(
          `UPDATE subscriber_sites SET ${sets.join(', ')}
           WHERE id = $${p++} AND subscriber_id = $${p} RETURNING id`,
          vals
        );
        if (!rows[0]) return res.status(404).json({ error: 'Vínculo não encontrado.' });
      }
      if (autopub_source_ids !== undefined)
        await salvarAutopubRules(req.params.siteId, req.params.id, autopub_source_ids);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // DELETE /api/admin/subscribers/:id/sites/:siteId
  router.delete('/subscribers/:id/sites/:siteId', async (req, res) => {
    try {
      await pool.query('DELETE FROM subscriber_sites WHERE id = $1 AND subscriber_id = $2',
        [req.params.siteId, req.params.id]);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // GET /api/admin/sites/lookup-by-url?url=... — busca site no catálogo pela URL
  router.get('/sites/lookup-by-url', async (req, res) => {
    const url = (req.query.url || '').replace(/\/$/, '').trim();
    if (!url) return res.json(null);
    try {
      const { rows } = await pool.query(
        `SELECT id, name, xixo_api_key, wp_username, platform, post_format
         FROM sites_catalog
         WHERE LOWER(TRIM(TRAILING '/' FROM site_url)) = LOWER($1)
           AND (xixo_api_key IS NOT NULL OR wp_username IS NOT NULL)
         LIMIT 1`,
        [url]
      );
      res.json(rows[0] || null);
    } catch (err) {
      console.error('[admin/sites/lookup]', err.message);
      res.json(null);
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // AUTOPUB LOG

  // GET /api/admin/autopub-log?limit=50
  router.get('/autopub-log', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    try {
      const { rows } = await pool.query(`
        SELECT al.status, al.error_msg, al.processed_at,
               a.title  AS article_title, a.external_url,
               ss.name  AS site_name,    ss.site_url,
               s.name   AS subscriber_name,
               src.name AS source_name,  src.slug AS source_slug,
               p.external_post_url, p.rewritten_title, p.rewritten_categories
        FROM autopub_log al
        JOIN articles         a   ON a.id   = al.article_id
        LEFT JOIN sources     src ON src.id = a.source_id
        JOIN subscriber_sites ss  ON ss.id  = al.site_id
        JOIN subscribers      s   ON s.id   = al.subscriber_id
        LEFT JOIN publications p  ON p.article_id = al.article_id AND p.site_id = al.site_id
        ORDER BY al.processed_at DESC
        LIMIT $1
      `, [limit]);
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // GET /api/admin/autopub-stats — estatísticas rápidas do autopub
  router.get('/autopub-stats', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT
          COUNT(*)                                                                    AS total_geral,
          COUNT(*) FILTER (WHERE processed_at >= now() - interval '24 hours')        AS hoje_total,
          COUNT(*) FILTER (WHERE status = 'ok'   AND processed_at >= now() - interval '24 hours') AS hoje_ok,
          COUNT(*) FILTER (WHERE status = 'erro' AND processed_at >= now() - interval '24 hours') AS hoje_erro,
          MAX(processed_at)                                                           AS ultima_rodada
        FROM autopub_log
      `);
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // SETTINGS
  // ════════════════════════════════════════════════════════════════════════════

  // GET /api/admin/settings
  router.get('/settings', (req, res) => {
    res.json(lerSettings());
  });

  // PUT /api/admin/settings — merge parcial (só os campos enviados)
  router.put('/settings', (req, res) => {
    const atual = lerSettings();
    const novo  = { ...atual, ...req.body };
    salvarSettings(novo);
    res.json(novo);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // FINANCEIRO
  // ════════════════════════════════════════════════════════════════════════════

  // GET /api/admin/queue — stats e itens recentes da fila de autopublicação
  router.get('/queue', async (req, res) => {
    try {
      const { rows: statsRows } = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending')                               AS pending,
          COUNT(*) FILTER (WHERE status = 'processing')                            AS processing,
          COUNT(*) FILTER (WHERE status = 'done' AND processed_at >= CURRENT_DATE) AS done_today,
          COUNT(*) FILTER (WHERE status = 'error')                                 AS error_total,
          COUNT(*) FILTER (WHERE status = 'done')                                  AS done_total
        FROM autopub_queue
      `);
      const { rows: items } = await pool.query(`
        SELECT q.id, q.status, q.attempts, q.enqueued_at, q.processed_at, q.error_message,
               q.publish_facebook, q.publish_instagram,
               sc.name     AS site_name,
               a.title     AS article_title,
               src.name    AS source_name,
               src.slug    AS source_slug
        FROM autopub_queue q
        JOIN sites_catalog sc  ON sc.id  = q.catalog_id
        JOIN articles      a   ON a.id   = q.article_id
        JOIN sources       src ON src.id = q.source_id
        ORDER BY q.enqueued_at DESC
        LIMIT 100
      `);
      res.json({ stats: statsRows[0], items });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // GET /api/admin/financial
  router.get('/financial', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT s.id, s.name, s.email, s.active, s.plan_expires_at,
               s.plan_value, s.created_at,
               p.name AS plan_name,
               (SELECT COUNT(*) FROM subscriber_sites ss WHERE ss.subscriber_id = s.id AND ss.active = true)::int AS sites_count
        FROM subscribers s
        LEFT JOIN plans p ON p.id = s.plan_id
        WHERE s.is_admin = false
        ORDER BY s.plan_expires_at ASC NULLS LAST, s.name
      `);
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
};
