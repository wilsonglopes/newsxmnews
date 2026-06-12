'use strict';

const express = require('express');
const pool    = require('../db/connection');
const auth    = require('../middleware/auth');
const yt      = require('../youtube-videos');

const router = express.Router();
router.use(auth);

// Apenas admin gerencia canais do YouTube
router.use((req, res, next) => {
  if (!req.subscriber.is_admin) return res.status(403).json({ error: 'Acesso restrito.' });
  next();
});

// ── GET /api/admin/youtube/channels?catalog_id=… — canais de um portal ────────
router.get('/channels', async (req, res) => {
  const { catalog_id } = req.query;
  if (!catalog_id) return res.status(400).json({ error: 'catalog_id é obrigatório.' });
  try {
    const { rows } = await pool.query(
      `SELECT id, channel_id, name, active, created_at
       FROM youtube_channels WHERE catalog_id = $1 ORDER BY created_at`,
      [catalog_id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/youtube/channels — cadastra canal (URL/@handle/ID) ───────
router.post('/channels', async (req, res) => {
  const { catalog_id, url } = req.body || {};
  if (!catalog_id || !url) return res.status(400).json({ error: 'catalog_id e url são obrigatórios.' });
  try {
    const channelId = await yt.resolverChannelId(url);

    // Busca o nome real do canal pelo feed (e valida que o RSS responde)
    const info = await yt.coletarCanal(channelId);

    const { rows } = await pool.query(
      `INSERT INTO youtube_channels (catalog_id, channel_id, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (catalog_id, channel_id) DO UPDATE SET active = true, name = EXCLUDED.name
       RETURNING id, channel_id, name, active`,
      [catalog_id, channelId, info.canalNome.slice(0, 200)]
    );
    res.json({ ...rows[0], videos_no_feed: info.total });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── PATCH /api/admin/youtube/channels/:id — ativa/pausa canal ────────────────
router.patch('/channels/:id', async (req, res) => {
  const { active } = req.body || {};
  try {
    const { rows } = await pool.query(
      `UPDATE youtube_channels SET active = COALESCE($1, active)
       WHERE id = $2 RETURNING id, channel_id, name, active`,
      [typeof active === 'boolean' ? active : null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Canal não encontrado.' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/admin/youtube/channels/:id ────────────────────────────────────
router.delete('/channels/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM youtube_channels WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/youtube/selection/:catalogId — slots atuais do portal ─────
router.get('/selection/:catalogId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT videos, updated_at FROM youtube_selection WHERE catalog_id = $1`,
      [req.params.catalogId]
    );
    res.json(rows[0] || { videos: [], updated_at: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/youtube/run — força coleta + rotação agora ───────────────
// Body opcional: { catalog_id } — só este portal; sem body roda todos
router.post('/run', async (req, res) => {
  const { catalog_id } = req.body || {};
  try {
    if (catalog_id) {
      await yt.coletarTodos(); // coleta é barata e compartilhada entre portais
      const sel = await yt.rotacionarPortal(catalog_id);
      let push = { pushed: false };
      if (sel) {
        try { push = await yt.pushParaSite(catalog_id, sel); }
        catch (e) { push = { pushed: false, motivo: e.message }; }
      }
      return res.json({ ok: true, videos: sel || [], push });
    }
    await yt.rodada();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
