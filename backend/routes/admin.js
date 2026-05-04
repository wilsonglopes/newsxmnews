'use strict';

const express  = require('express');
const bcrypt   = require('bcrypt');
const fs       = require('fs');
const path     = require('path');
const pool     = require('../db/connection');
const adminAuth = require('../middleware/adminAuth');

const SOURCES_PATH = path.join(__dirname, '../sources.json');

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
    const { name, slug, type, url, category, scraping, extract_body_image } = req.body || {};
    if (!name || !slug || !type || !url) {
      return res.status(400).json({ error: 'name, slug, type e url são obrigatórios.' });
    }
    if (sources.find(s => s.slug === slug)) {
      return res.status(409).json({ error: 'Slug já existe.' });
    }

    const novaFonte = { name, slug, type, url, active: true, category: category || 'nacional' };
    if (scraping && Object.keys(scraping).length) novaFonte.scraping = scraping;
    if (extract_body_image) novaFonte.extract_body_image = true;

    sources.push(novaFonte);
    cache[slug] = { data: [], lastUpdated: null, error: null };
    salvarSourcesJson();

    // Salva no DB
    try {
      const cfg = scraping || {};
      await pool.query(`
        INSERT INTO sources (name, slug, type, url, section_selector, title_selector,
          date_selector, link_selector, image_selector, category, active, extract_body_image)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (slug) DO UPDATE SET name=$1, url=$4, type=$3, active=$11, extract_body_image=$12
      `, [name, slug, type, url,
          cfg.itemSelector || null, cfg.titleSelector || null, cfg.dateSelector || null,
          cfg.linkSelector || null, cfg.imageSelector || null,
          category || 'nacional', true, !!extract_body_image]);
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

    const { name, url, category, type, scraping, extract_body_image } = req.body || {};
    const fonte = sources[idx];

    if (name)     fonte.name     = name;
    if (url)      fonte.url      = url;
    if (category) fonte.category = category;
    if (type)     fonte.type     = type;
    if (scraping !== undefined) {
      if (scraping && Object.keys(scraping).length) fonte.scraping = scraping;
      else delete fonte.scraping;
    }
    fonte.extract_body_image = !!extract_body_image;

    salvarSourcesJson();

    // Sincroniza DB
    try {
      await pool.query(
        'UPDATE sources SET name=$1, url=$2, category=$3, type=$4, extract_body_image=$5 WHERE slug=$6',
        [fonte.name, fonte.url, fonte.category, fonte.type, !!extract_body_image, slug]
      );
    } catch {}

    res.json(fonte);
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

  // GET /api/admin/subscribers
  router.get('/subscribers', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT s.id, s.name, s.email, s.active, s.is_admin,
               s.created_at, s.plan_expires_at, s.plan_value, s.gemini_key,
               p.name AS plan_name, p.id AS plan_id
        FROM subscribers s
        LEFT JOIN plans p ON p.id = s.plan_id
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
      if (req.body.gemini_key  !== undefined) { sets.push(`gemini_key = $${p++}`);  vals.push(req.body.gemini_key || null); }
      if (req.body.ai_prompt   !== undefined) { sets.push(`ai_prompt = $${p++}`);   vals.push(req.body.ai_prompt || null); }
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

  // GET /api/admin/all-sites — todos os sites de todos os assinantes (para publicação pelo admin)
  router.get('/all-sites', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT ss.id, ss.name, ss.platform, ss.site_url, ss.wp_username,
               ss.wp_app_password, ss.blogger_blog_id, ss.blogger_access_token,
               ss.webhook_url, ss.webhook_secret, ss.ai_prompt,
               ss.default_category_id, ss.active,
               sub.name AS subscriber_name, sub.email AS subscriber_email
        FROM subscriber_sites ss
        JOIN subscribers sub ON sub.id = ss.subscriber_id
        WHERE ss.active = true
        ORDER BY sub.name, ss.name
      `);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/admin/recent-publications — últimas publicações de todos os clientes
  router.get('/recent-publications', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT p.id, p.platform, p.rewritten_title, p.status,
               p.external_post_url, p.published_at,
               sub.name AS subscriber_name,
               ss.name AS site_name, ss.site_url,
               a.title AS original_title
        FROM publications p
        JOIN subscribers sub ON sub.id = p.subscriber_id
        LEFT JOIN subscriber_sites ss ON ss.id = p.site_id
        LEFT JOIN articles a ON a.id = p.article_id
        ORDER BY p.published_at DESC
        LIMIT 20
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

  // GET /api/admin/subscribers/:id/sites
  router.get('/subscribers/:id/sites', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, name, platform, site_url, wp_username, ai_prompt,
                default_category_id, webhook_url, webhook_secret,
                blogger_blog_id, post_format, active, created_at, xixo_api_key
         FROM subscriber_sites WHERE subscriber_id = $1 ORDER BY created_at DESC`,
        [req.params.id]
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // POST /api/admin/subscribers/:id/sites
  router.post('/subscribers/:id/sites', async (req, res) => {
    const { name, platform, site_url, wp_username, wp_app_password,
            blogger_blog_id, webhook_url, webhook_secret, ai_prompt,
            default_category_id, post_format, xixo_api_key } = req.body || {};
    if (!name || !platform) return res.status(400).json({ error: 'name e platform obrigatórios.' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO subscriber_sites
           (subscriber_id, name, platform, site_url, wp_username, wp_app_password,
            blogger_blog_id, webhook_url, webhook_secret, ai_prompt, default_category_id, post_format, xixo_api_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id, name, platform, site_url, active`,
        [req.params.id, name, platform, site_url || null, wp_username || null,
         wp_app_password ? encryptToken(wp_app_password) : null,
         blogger_blog_id || null, webhook_url || null, webhook_secret || null,
         ai_prompt || null, default_category_id || null, post_format || 'editorial',
         xixo_api_key || null]
      );
      res.status(201).json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // PUT /api/admin/subscribers/:id/sites/:siteId
  router.put('/subscribers/:id/sites/:siteId', async (req, res) => {
    const { name, platform, site_url, wp_username, wp_app_password,
            blogger_blog_id, webhook_url, webhook_secret, ai_prompt,
            default_category_id, post_format, xixo_api_key } = req.body || {};
    try {
      const sets = []; const vals = []; let p = 1;
      if (name       !== undefined) { sets.push(`name = $${p++}`);       vals.push(name); }
      if (platform   !== undefined) { sets.push(`platform = $${p++}`);   vals.push(platform); }
      if (site_url   !== undefined) { sets.push(`site_url = $${p++}`);   vals.push(site_url || null); }
      if (wp_username!== undefined) { sets.push(`wp_username = $${p++}`);vals.push(wp_username || null); }
      if (wp_app_password)          { sets.push(`wp_app_password = $${p++}`); vals.push(encryptToken(wp_app_password)); }
      if (blogger_blog_id !== undefined) { sets.push(`blogger_blog_id = $${p++}`); vals.push(blogger_blog_id || null); }
      if (webhook_url     !== undefined) { sets.push(`webhook_url = $${p++}`);     vals.push(webhook_url || null); }
      if (webhook_secret  !== undefined) { sets.push(`webhook_secret = $${p++}`);  vals.push(webhook_secret || null); }
      if (ai_prompt       !== undefined) { sets.push(`ai_prompt = $${p++}`);       vals.push(ai_prompt || null); }
      if (default_category_id !== undefined) { sets.push(`default_category_id = $${p++}`); vals.push(default_category_id || null); }
      if (post_format         !== undefined) { sets.push(`post_format = $${p++}`);         vals.push(post_format || 'editorial'); }
      if (xixo_api_key        !== undefined) { sets.push(`xixo_api_key = $${p++}`);        vals.push(xixo_api_key || null); }
      if (!sets.length) return res.status(400).json({ error: 'Nada para atualizar.' });
      vals.push(req.params.siteId, req.params.id);
      const { rows } = await pool.query(
        `UPDATE subscriber_sites SET ${sets.join(', ')} WHERE id = $${p++} AND subscriber_id = $${p} RETURNING id, name, platform, site_url, active`,
        vals
      );
      if (!rows[0]) return res.status(404).json({ error: 'Site não encontrado.' });
      res.json(rows[0]);
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

  // ════════════════════════════════════════════════════════════════════════════
  // FINANCEIRO
  // ════════════════════════════════════════════════════════════════════════════

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
