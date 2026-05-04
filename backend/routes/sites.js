'use strict';

const express = require('express');
const axios   = require('axios');
const https   = require('https');
const pool    = require('../db/connection');
const auth    = require('../middleware/auth');
const { encryptToken } = require('../connectors/encrypt');

const router = express.Router();
const HTTPS_AGENT = new https.Agent({ rejectUnauthorized: false });

router.use(auth);

// ── GET /api/sites ────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, platform, site_url, wp_username,
              blogger_blog_id, webhook_url, ai_prompt,
              default_category_id, post_format, xixo_api_key, active, created_at
       FROM subscriber_sites
       WHERE subscriber_id = $1
       ORDER BY created_at DESC`,
      [req.subscriber.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('[sites/list]', err.message);
    res.status(500).json({ error: 'Erro ao listar sites.' });
  }
});

// ── GET /api/sites/:id/wp-categories — lista categorias do WP do site ────────
router.get('/:id/wp-categories', async (req, res) => {
  try {
    // Admin pode buscar categorias de qualquer site; assinante só dos seus
    const isAdmin = req.subscriber.is_admin;
    const query   = isAdmin
      ? 'SELECT site_url, wp_username, wp_app_password, platform, xixo_api_key FROM subscriber_sites WHERE id = $1'
      : 'SELECT site_url, wp_username, wp_app_password, platform, xixo_api_key FROM subscriber_sites WHERE id = $1 AND subscriber_id = $2';
    const params  = isAdmin ? [req.params.id] : [req.params.id, req.subscriber.id];

    const { rows } = await pool.query(query, params);
    const site = rows[0];
    if (!site) return res.status(404).json({ error: 'Site não encontrado.' });
    if (site.platform !== 'wordpress') return res.json([]);

    const baseUrl = (site.site_url || '').replace(/\/$/, '');
    if (!baseUrl) return res.status(400).json({ error: 'URL do site não configurada.' });

    // Auth é opcional — categorias WP são públicas.
    // Inclui credenciais básicas se disponíveis (evita cache privado em alguns hosts).
    const headers = {};
    if (site.wp_username && site.wp_app_password) {
      const { decryptToken } = require('../connectors/encrypt');
      const password = decryptToken(site.wp_app_password);
      if (password) {
        headers['Authorization'] = `Basic ${Buffer.from(`${site.wp_username}:${password}`).toString('base64')}`;
      }
    }

    // Busca todas as categorias (até 100) em ordem de nome
    const r = await axios.get(`${baseUrl}/wp-json/wp/v2/categories?per_page=100&orderby=name&order=asc`, {
      timeout: 10000,
      httpsAgent: HTTPS_AGENT,
      headers,
    });
    const cats = (r.data || []).map(c => ({ id: c.id, name: c.name, slug: c.slug, count: c.count }));
    res.json(cats);
  } catch (err) {
    console.error('[sites/wp-categories]', err.message);
    res.status(500).json({ error: 'Não foi possível buscar categorias: ' + err.message });
  }
});

// ── POST /api/sites/test-wp — testa credenciais WordPress ────────────────────
router.post('/test-wp', async (req, res) => {
  const { site_url, wp_username, wp_app_password } = req.body || {};
  if (!site_url) return res.status(400).json({ error: 'URL do site é obrigatória.' });

  const baseUrl = site_url.replace(/\/$/, '');
  try {
    const headers = {};
    if (wp_username && wp_app_password) {
      headers['Authorization'] = `Basic ${Buffer.from(`${wp_username}:${wp_app_password}`).toString('base64')}`;
    }
    const r = await axios.get(`${baseUrl}/wp-json/wp/v2/posts?per_page=1`, {
      timeout: 10000,
      httpsAgent: HTTPS_AGENT,
      headers,
    });
    // Pega versão do WordPress se disponível
    const rootRes = await axios.get(`${baseUrl}/wp-json/`, { timeout: 8000, httpsAgent: HTTPS_AGENT }).catch(() => null);
    const version = rootRes?.data?.['generator']?.replace('https://wordpress.org/?v=', '') || '';
    res.json({ ok: true, status: r.status, version });
  } catch (err) {
    let msg = err.message;
    if (err.code === 'ENOTFOUND')   msg = `Domínio não encontrado: ${baseUrl}`;
    if (err.code === 'ECONNREFUSED') msg = `Servidor recusou a conexão: ${baseUrl}`;
    if (err.response?.status === 401) msg = 'Credenciais inválidas (401). Verifique usuário e senha.';
    if (err.response?.status === 403) msg = 'Acesso negado (403). Verifique permissões do usuário.';
    res.status(400).json({ ok: false, error: msg });
  }
});

// ── POST /api/sites ───────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const {
    name, platform, site_url,
    wp_username, wp_app_password,
    blogger_blog_id, blogger_access_token, blogger_refresh_token,
    webhook_url, webhook_secret,
    ai_prompt, default_category_id, post_format, xixo_api_key
  } = req.body || {};

  if (!name || !platform) {
    return res.status(400).json({ error: 'name e platform são obrigatórios.' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO subscriber_sites
         (subscriber_id, name, platform, site_url,
          wp_username, wp_app_password,
          blogger_blog_id, blogger_access_token, blogger_refresh_token,
          webhook_url, webhook_secret,
          ai_prompt, default_category_id, post_format, xixo_api_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id, name, platform, site_url, post_format, xixo_api_key, active, created_at`,
      [
        req.subscriber.id, name, platform, site_url || null,
        wp_username        || null,
        wp_app_password    ? encryptToken(wp_app_password)    : null,
        blogger_blog_id    || null,
        blogger_access_token  ? encryptToken(blogger_access_token)  : null,
        blogger_refresh_token ? encryptToken(blogger_refresh_token) : null,
        webhook_url    || null,
        webhook_secret || null,
        ai_prompt             || null,
        default_category_id   || null,
        post_format           || 'editorial',
        xixo_api_key          || null
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[sites/create]', err.message);
    res.status(500).json({ error: 'Erro ao cadastrar site.' });
  }
});

// ── PUT /api/sites/:id ───────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const {
    name, platform, site_url,
    wp_username, wp_app_password,
    blogger_blog_id, blogger_access_token, blogger_refresh_token,
    webhook_url, webhook_secret,
    ai_prompt, default_category_id, post_format, xixo_api_key
  } = req.body || {};

  try {
    const sets = [];
    const vals = [];
    let p = 1;

    if (name        !== undefined) { sets.push(`name = $${p++}`);             vals.push(name); }
    if (platform    !== undefined) { sets.push(`platform = $${p++}`);         vals.push(platform); }
    if (site_url    !== undefined) { sets.push(`site_url = $${p++}`);         vals.push(site_url || null); }
    if (wp_username !== undefined) { sets.push(`wp_username = $${p++}`);      vals.push(wp_username || null); }
    if (wp_app_password)           { sets.push(`wp_app_password = $${p++}`);  vals.push(encryptToken(wp_app_password)); }
    if (blogger_blog_id !== undefined) { sets.push(`blogger_blog_id = $${p++}`); vals.push(blogger_blog_id || null); }
    if (ai_prompt   !== undefined) { sets.push(`ai_prompt = $${p++}`);        vals.push(ai_prompt || null); }
    if (webhook_url !== undefined) { sets.push(`webhook_url = $${p++}`);      vals.push(webhook_url || null); }
    if (webhook_secret !== undefined) { sets.push(`webhook_secret = $${p++}`); vals.push(webhook_secret || null); }
    if (default_category_id !== undefined) { sets.push(`default_category_id = $${p++}`); vals.push(default_category_id || null); }
    if (post_format         !== undefined) { sets.push(`post_format = $${p++}`);         vals.push(post_format || 'editorial'); }
    if (xixo_api_key        !== undefined) { sets.push(`xixo_api_key = $${p++}`);        vals.push(xixo_api_key || null); }

    if (!sets.length) return res.status(400).json({ error: 'Nenhum campo para atualizar.' });

    vals.push(req.params.id, req.subscriber.id);
    const { rows } = await pool.query(
      `UPDATE subscriber_sites SET ${sets.join(', ')}
       WHERE id = $${p++} AND subscriber_id = $${p}
       RETURNING id, name, platform, site_url, active`,
      vals
    );
    if (!rows[0]) return res.status(404).json({ error: 'Site não encontrado.' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[sites/update]', err.message);
    res.status(500).json({ error: 'Erro ao atualizar site.' });
  }
});

// ── DELETE /api/sites/:id ─────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM subscriber_sites WHERE id = $1 AND subscriber_id = $2',
      [req.params.id, req.subscriber.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Site não encontrado.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[sites/delete]', err.message);
    res.status(500).json({ error: 'Erro ao remover site.' });
  }
});

module.exports = router;
