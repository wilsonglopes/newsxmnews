'use strict';

const express = require('express');
const pool    = require('../db/connection');
const auth    = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// ── GET /api/publications — publicações do próprio usuário ──────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.id, p.article_id, p.platform, p.status,
             p.rewritten_title, p.rewritten_body,
             p.rewritten_chapeu, p.rewritten_summary, p.rewritten_tags,
             p.external_post_url, p.published_at,
             p.facebook_post_url, p.instagram_post_url,
             ss.name AS site_name, ss.site_url,
             COALESCE(sc.name, ss.name) AS site_label,
             a.title AS original_title,
             a.image_url AS article_image_url,
             a.external_url AS article_external_url,
             so.name AS article_source_name
      FROM publications p
      LEFT JOIN subscriber_sites ss ON ss.id = p.site_id
      LEFT JOIN sites_catalog sc ON sc.id = ss.site_id
      LEFT JOIN articles a ON a.id = p.article_id
      LEFT JOIN sources so ON so.id = a.source_id
      WHERE p.subscriber_id = $1
      ORDER BY p.published_at DESC
      LIMIT 100
    `, [req.subscriber.id]);
    res.json(rows);
  } catch (err) {
    console.error('[publications/list]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
