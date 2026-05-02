'use strict';

const express = require('express');
const pool    = require('../db/connection');
const auth    = require('../middleware/auth');
const router  = express.Router();

router.use(auth);

// ── Cria ou migra a tabela article_drafts ────────────────────────────────────
// O schema usa UUID em todas as tabelas. Se a tabela foi criada com INTEGER
// (versão antiga), dropa e recria com os tipos corretos.
(async () => {
  try {
    const { rows } = await pool.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'article_drafts' AND column_name = 'subscriber_id'
    `);
    // Se existir com tipo errado, remove para recriar
    if (rows.length > 0 && rows[0].data_type !== 'uuid') {
      await pool.query('DROP TABLE IF EXISTS article_drafts CASCADE');
      console.log('[drafts] Tabela antiga removida (tipo incorreto). Recriando...');
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS article_drafts (
        id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        subscriber_id        UUID NOT NULL,
        article_id           UUID NOT NULL,
        chapeu               TEXT NOT NULL DEFAULT '',
        title                TEXT NOT NULL DEFAULT '',
        summary              TEXT NOT NULL DEFAULT '',
        body                 TEXT NOT NULL DEFAULT '',
        tags                 TEXT NOT NULL DEFAULT '',
        article_title        TEXT NOT NULL DEFAULT '',
        article_source       TEXT NOT NULL DEFAULT '',
        article_image_url    TEXT NOT NULL DEFAULT '',
        article_external_url TEXT NOT NULL DEFAULT '',
        created_at           TIMESTAMPTZ DEFAULT NOW(),
        updated_at           TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (subscriber_id, article_id)
      )
    `);
    console.log('[drafts] Tabela article_drafts OK.');
  } catch (err) {
    console.error('[drafts] Erro ao criar/migrar tabela:', err.message);
  }
})();

// ── GET /api/drafts — lista rascunhos do assinante ────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM article_drafts
       WHERE subscriber_id = $1
       ORDER BY updated_at DESC
       LIMIT 100`,
      [req.subscriber.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('[drafts/list]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/drafts — cria ou atualiza rascunho (upsert por article_id) ──────
router.post('/', async (req, res) => {
  const {
    article_id, chapeu, title, summary, body, tags,
    article_title, article_source, article_image_url, article_external_url
  } = req.body || {};

  if (!article_id || !title) {
    return res.status(400).json({ error: 'article_id e title são obrigatórios.' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO article_drafts
         (subscriber_id, article_id, chapeu, title, summary, body, tags,
          article_title, article_source, article_image_url, article_external_url, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW())
       ON CONFLICT (subscriber_id, article_id) DO UPDATE SET
         chapeu               = EXCLUDED.chapeu,
         title                = EXCLUDED.title,
         summary              = EXCLUDED.summary,
         body                 = EXCLUDED.body,
         tags                 = EXCLUDED.tags,
         article_title        = EXCLUDED.article_title,
         article_source       = EXCLUDED.article_source,
         article_image_url    = EXCLUDED.article_image_url,
         article_external_url = EXCLUDED.article_external_url,
         updated_at           = NOW()
       RETURNING *`,
      [
        req.subscriber.id, article_id,
        chapeu || '', title, summary || '', body || '', tags || '',
        article_title || '', article_source || '',
        article_image_url || '', article_external_url || ''
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[drafts/save]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/drafts/:id — remove rascunho ──────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM article_drafts WHERE id = $1 AND subscriber_id = $2',
      [req.params.id, req.subscriber.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Rascunho não encontrado.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[drafts/delete]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
