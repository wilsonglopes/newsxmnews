'use strict';

const express = require('express');
const pool    = require('../db/connection');
const auth    = require('../middleware/auth');
const { encryptToken, decryptToken } = require('../connectors/encrypt');

const router = express.Router();
router.use(auth);

// Apenas admin acessa o catálogo
router.use((req, res, next) => {
  if (!req.subscriber.is_admin) return res.status(403).json({ error: 'Acesso restrito.' });
  next();
});

// ── GET /api/admin/sites-catalog ──────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT sc.*,
             COUNT(ss.id)::int AS subscribers_count
      FROM sites_catalog sc
      LEFT JOIN subscriber_sites ss ON ss.site_id = sc.id
      GROUP BY sc.id
      ORDER BY sc.name
    `);
    // Não retorna senhas/tokens ao frontend
    res.json(rows.map(r => ({
      ...r,
      wp_app_password:     r.wp_app_password     ? '••••••••' : null,
      facebook_page_token: r.facebook_page_token ? '••••••••' : null,
    })));
  } catch (err) {
    console.error('[sites-catalog/list]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/sites-catalog ─────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { name, platform, site_url, xixo_api_key, wp_username, wp_app_password,
          blogger_blog_id, webhook_url, webhook_secret, post_format, ai_prompt,
          facebook_enabled, facebook_page_id, facebook_page_token } = req.body || {};
  if (!name || !platform) return res.status(400).json({ error: 'name e platform são obrigatórios.' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO sites_catalog
         (name, platform, site_url, xixo_api_key, wp_username, wp_app_password,
          blogger_blog_id, webhook_url, webhook_secret, post_format, ai_prompt,
          facebook_enabled, facebook_page_id, facebook_page_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id, name, platform, site_url, post_format, active, created_at`,
      [
        name, platform, site_url || null, xixo_api_key || null, wp_username || null,
        wp_app_password ? encryptToken(wp_app_password) : null,
        blogger_blog_id || null, webhook_url || null, webhook_secret || null,
        post_format || 'editorial', ai_prompt || null,
        facebook_enabled === true || facebook_enabled === 'true',
        facebook_page_id || null,
        facebook_page_token ? encryptToken(facebook_page_token) : null,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[sites-catalog/create]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/admin/sites-catalog/:id ─────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const { name, platform, site_url, xixo_api_key, wp_username, wp_app_password,
          blogger_blog_id, webhook_url, webhook_secret, post_format, active, ai_prompt,
          facebook_enabled, facebook_page_id, facebook_page_token,
          instagram_enabled } = req.body || {};
  try {
    const sets = []; const vals = []; let p = 1;
    if (name        !== undefined) { sets.push(`name = $${p++}`);        vals.push(name); }
    if (platform    !== undefined) { sets.push(`platform = $${p++}`);    vals.push(platform); }
    if (site_url    !== undefined) { sets.push(`site_url = $${p++}`);    vals.push(site_url || null); }
    if (xixo_api_key!== undefined) { sets.push(`xixo_api_key = $${p++}`);vals.push(xixo_api_key || null); }
    if (wp_username !== undefined) { sets.push(`wp_username = $${p++}`); vals.push(wp_username || null); }
    if (wp_app_password && wp_app_password !== '••••••••') {
      sets.push(`wp_app_password = $${p++}`);
      vals.push(encryptToken(wp_app_password));
    }
    if (blogger_blog_id !== undefined) { sets.push(`blogger_blog_id = $${p++}`); vals.push(blogger_blog_id || null); }
    if (webhook_url     !== undefined) { sets.push(`webhook_url = $${p++}`);     vals.push(webhook_url || null); }
    if (webhook_secret  !== undefined) { sets.push(`webhook_secret = $${p++}`);  vals.push(webhook_secret || null); }
    if (post_format     !== undefined) { sets.push(`post_format = $${p++}`);     vals.push(post_format || 'editorial'); }
    if (active          !== undefined) { sets.push(`active = $${p++}`);          vals.push(active === true || active === 'true'); }
    if (ai_prompt       !== undefined) { sets.push(`ai_prompt = $${p++}`);       vals.push(ai_prompt || null); }
    if (facebook_enabled  !== undefined) { sets.push(`facebook_enabled = $${p++}`);  vals.push(facebook_enabled === true || facebook_enabled === 'true'); }
    if (facebook_page_id  !== undefined) { sets.push(`facebook_page_id = $${p++}`);  vals.push(facebook_page_id || null); }
    if (facebook_page_token && facebook_page_token !== '••••••••') {
      sets.push(`facebook_page_token = $${p++}`);
      vals.push(encryptToken(facebook_page_token));
    }
    if (instagram_enabled !== undefined) { sets.push(`instagram_enabled = $${p++}`); vals.push(instagram_enabled === true || instagram_enabled === 'true'); }
    if (!sets.length) return res.status(400).json({ error: 'Nada para atualizar.' });
    vals.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE sites_catalog SET ${sets.join(', ')} WHERE id = $${p} RETURNING id, name, platform, site_url, post_format, active`,
      vals
    );
    if (!rows[0]) return res.status(404).json({ error: 'Site não encontrado.' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[sites-catalog/update]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/admin/sites-catalog/:id ──────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM subscriber_sites WHERE site_id = $1`,
      [req.params.id]
    );
    if (rows[0].total > 0) {
      return res.status(409).json({
        error: `Este site está vinculado a ${rows[0].total} assinante(s). Remova os vínculos antes de excluir.`
      });
    }
    await pool.query('DELETE FROM sites_catalog WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[sites-catalog/delete]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/sites-catalog/:id/wp-categories ───────────────────────────
router.get('/:id/wp-categories', async (req, res) => {
  const axios  = require('axios');
  const https  = require('https');
  const AGENT  = new https.Agent({ rejectUnauthorized: false });
  try {
    const { rows } = await pool.query(
      `SELECT site_url, wp_username, wp_app_password, platform, xixo_api_key
       FROM sites_catalog WHERE id = $1`,
      [req.params.id]
    );
    const site = rows[0];
    if (!site) return res.status(404).json({ error: 'Site não encontrado.' });
    if (site.platform !== 'wordpress') return res.json([]);
    const baseUrl = (site.site_url || '').replace(/\/$/, '');
    if (!baseUrl) return res.status(400).json({ error: 'URL do site não configurada.' });
    const headers = {};
    if (site.wp_username && site.wp_app_password) {
      const pwd = decryptToken(site.wp_app_password);
      if (pwd) headers['Authorization'] = `Basic ${Buffer.from(`${site.wp_username}:${pwd}`).toString('base64')}`;
    }
    const r = await axios.get(`${baseUrl}/wp-json/wp/v2/categories?per_page=100&orderby=name&order=asc`, {
      timeout: 10000, httpsAgent: AGENT, headers,
    });
    res.json((r.data || []).map(c => ({ id: c.id, name: c.name, slug: c.slug, count: c.count, parent: c.parent || 0 })));
  } catch (err) {
    console.error('[sites-catalog/wp-categories]', err.message);
    res.status(500).json({ error: 'Não foi possível buscar categorias: ' + err.message });
  }
});

// ── GET /api/admin/sites-catalog/:id/autopub ─────────────────────────────────
router.get('/:id/autopub', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT source_id AS "sourceId", default_category_id AS "categoryId",
              COALESCE(facebook_enabled, false) AS "facebookEnabled"
       FROM autopub_rules WHERE catalog_id = $1`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('[sites-catalog/autopub/get]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/admin/sites-catalog/:id/autopub — substitui todas as regras ──────
router.put('/:id/autopub', async (req, res) => {
  const { sources } = req.body || {};
  try {
    await pool.query('DELETE FROM autopub_rules WHERE catalog_id = $1', [req.params.id]);
    if (Array.isArray(sources) && sources.length) {
      for (const item of sources) {
        const srcId = (typeof item === 'object' && item !== null) ? item.sourceId : item;
        const catId = (typeof item === 'object' && item !== null) ? (item.categoryId || null) : null;
        const fbEn  = (typeof item === 'object' && item !== null) ? (item.facebookEnabled === true) : false;
        if (!srcId) continue;
        await pool.query(
          `INSERT INTO autopub_rules (catalog_id, source_id, default_category_id, facebook_enabled)
           VALUES ($1, $2, $3, $4)`,
          [req.params.id, srcId, catId, fbEn]
        );
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[sites-catalog/autopub/put]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/sites-catalog/test-fb ────────────────────────────────────
// Body: { facebook_page_id, facebook_page_token, site_id? }
// Se token = '••••••••' (placeholder) E o ID do site é passado, usa o token salvo.
// Após validar a Page, tenta auto-detectar o Instagram Business Account conectado.
router.post('/test-fb', async (req, res) => {
  const { testarConexao } = require('../connectors/facebook');
  const { descobrirIgBusinessAccount } = require('../connectors/instagram');
  let { facebook_page_id, facebook_page_token, site_id } = req.body || {};
  try {
    if ((!facebook_page_token || facebook_page_token === '••••••••') && site_id) {
      const { rows } = await pool.query(
        'SELECT facebook_page_id, facebook_page_token FROM sites_catalog WHERE id = $1',
        [site_id]
      );
      if (rows[0]) {
        facebook_page_id    = facebook_page_id || rows[0].facebook_page_id;
        facebook_page_token = decryptToken(rows[0].facebook_page_token);
      }
    }
    const r = await testarConexao({ page_id: facebook_page_id, page_token: facebook_page_token });
    if (!r.ok) return res.status(400).json(r);

    // Auto-discovery do Instagram (opcional, não falha se não tiver)
    const ig = await descobrirIgBusinessAccount({ page_id: facebook_page_id, page_token: facebook_page_token });
    if (ig && site_id) {
      // Salva o ID/username do IG no banco automaticamente
      try {
        await pool.query(
          `UPDATE sites_catalog SET instagram_business_account_id = $1, instagram_username = $2 WHERE id = $3`,
          [ig.id, ig.username || null, site_id]
        );
      } catch (e) { console.warn('[test-fb] salvar IG:', e.message); }
    }

    res.json({ ...r, instagram: ig });
  } catch (err) {
    console.error('[sites-catalog/test-fb]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/sites-catalog/test-wp ────────────────────────────────────
router.post('/test-wp', async (req, res) => {
  const axios  = require('axios');
  const https  = require('https');
  const AGENT  = new https.Agent({ rejectUnauthorized: false });
  const { site_url, wp_username, wp_app_password } = req.body || {};
  if (!site_url || !wp_username || !wp_app_password) {
    return res.status(400).json({ error: 'URL, usuário e senha são obrigatórios.' });
  }
  try {
    const baseUrl = site_url.replace(/\/$/, '');
    const auth64  = Buffer.from(`${wp_username}:${wp_app_password}`).toString('base64');
    await axios.get(`${baseUrl}/wp-json/wp/v2/posts?per_page=1`, {
      timeout: 10000, httpsAgent: AGENT,
      headers: { Authorization: `Basic ${auth64}` },
    });
    res.json({ ok: true });
  } catch (err) {
    const status = err.response?.status;
    if (status === 401) return res.status(401).json({ error: 'Credenciais inválidas.' });
    if (status === 403) return res.status(403).json({ error: 'Acesso negado.' });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
