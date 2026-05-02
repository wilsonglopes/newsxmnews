'use strict';

/**
 * routes/subscriber-sources.js
 *
 * Gerencia quais fontes do catálogo global cada assinante acompanha.
 *
 * GET  /api/subscriber/sources          — lista o catálogo completo com flag "selected"
 * POST /api/subscriber/sources/:slug    — adiciona fonte ao assinante
 * DELETE /api/subscriber/sources/:slug  — remove fonte do assinante
 */

const express = require('express');
const pool    = require('../db/connection');
const auth    = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// ── GET /api/subscriber/sources ───────────────────────────────────────────────
// Retorna todas as fontes do catálogo + flag `selected` para cada uma
router.get('/', async (req, res) => {
  const subscriberId = req.subscriber.id;

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
    `, [subscriberId]);

    res.json(rows);
  } catch (err) {
    console.error('[subscriber-sources/list]', err.message);
    res.status(500).json({ error: 'Erro ao buscar fontes.' });
  }
});

// ── POST /api/subscriber/sources/:slug ───────────────────────────────────────
// Adiciona uma fonte ao assinante (respeitando limite do plano)
router.post('/:slug', async (req, res) => {
  const subscriberId = req.subscriber.id;
  const { slug }     = req.params;

  try {
    // Busca fonte
    const { rows: srcRows } = await pool.query(
      'SELECT id FROM sources WHERE slug = $1 AND active = true',
      [slug]
    );
    if (!srcRows[0]) return res.status(404).json({ error: 'Fonte não encontrada.' });

    const sourceId = srcRows[0].id;

    // Verifica limite do plano
    const { rows: subRows } = await pool.query(`
      SELECT p.max_sources,
             (SELECT COUNT(*) FROM subscriber_sources WHERE subscriber_id = $1) AS current_count
      FROM subscribers sub
      LEFT JOIN plans p ON p.id = sub.plan_id
      WHERE sub.id = $1
    `, [subscriberId]);

    const { max_sources, current_count } = subRows[0] || {};
    if (max_sources > 0 && parseInt(current_count) >= parseInt(max_sources)) {
      return res.status(403).json({
        error: `Limite do plano atingido (${max_sources} fontes). Faça upgrade para adicionar mais.`
      });
    }

    // Insere (ignora se já existe)
    await pool.query(`
      INSERT INTO subscriber_sources (subscriber_id, source_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
    `, [subscriberId, sourceId]);

    res.json({ ok: true, slug });
  } catch (err) {
    console.error('[subscriber-sources/add]', err.message);
    res.status(500).json({ error: 'Erro ao adicionar fonte.' });
  }
});

// ── DELETE /api/subscriber/sources/:slug ─────────────────────────────────────
router.delete('/:slug', async (req, res) => {
  const subscriberId = req.subscriber.id;
  const { slug }     = req.params;

  try {
    const { rows: srcRows } = await pool.query(
      'SELECT id FROM sources WHERE slug = $1',
      [slug]
    );
    if (!srcRows[0]) return res.status(404).json({ error: 'Fonte não encontrada.' });

    await pool.query(`
      DELETE FROM subscriber_sources
      WHERE subscriber_id = $1 AND source_id = $2
    `, [subscriberId, srcRows[0].id]);

    res.json({ ok: true, slug });
  } catch (err) {
    console.error('[subscriber-sources/remove]', err.message);
    res.status(500).json({ error: 'Erro ao remover fonte.' });
  }
});

module.exports = router;
