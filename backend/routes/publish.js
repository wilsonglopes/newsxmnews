'use strict';

const express = require('express');
const pool    = require('../db/connection');
const auth    = require('../middleware/auth');
const { publishToWordPress } = require('../connectors/wordpress');
const { publishToBlogger }   = require('../connectors/blogger');
const { publishViaWebhook }  = require('../connectors/webhook');

const router = express.Router();

router.use(auth);

// ── POST /api/publish ─────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { article_id, site_id, rewritten, force } = req.body || {};

  if (!article_id || !site_id || !rewritten) {
    return res.status(400).json({ error: 'article_id, site_id e rewritten são obrigatórios.' });
  }

  try {
    // Busca o artigo (com nome da fonte para compor o crédito)
    const { rows: artRows } = await pool.query(
      `SELECT a.*, so.name AS source_name
       FROM articles a
       LEFT JOIN sources so ON so.id = a.source_id
       WHERE a.id = $1`,
      [article_id]
    );
    const article = artRows[0];
    if (!article) return res.status(404).json({ error: 'Artigo não encontrado.' });

    // Busca o site e confirma que pertence ao assinante
    const { rows: siteRows } = await pool.query(
      'SELECT * FROM subscriber_sites WHERE id = $1 AND subscriber_id = $2 AND active = true',
      [site_id, req.subscriber.id]
    );
    const site = siteRows[0];
    if (!site) return res.status(404).json({ error: 'Site não encontrado ou sem permissão.' });

    // Verifica duplicata — salvo quando force=true (re-publicação confirmada pelo usuário)
    if (!force) {
      const { rows: pubExist } = await pool.query(
        `SELECT id FROM publications
         WHERE subscriber_id = $1 AND article_id = $2 AND site_id = $3 AND status = 'published'
         LIMIT 1`,
        [req.subscriber.id, article_id, site_id]
      );
      if (pubExist.length > 0) {
        return res.status(409).json({
          already_published: true,
          error: 'Este artigo já foi publicado neste site anteriormente.'
        });
      }
    }

    // Publica na plataforma correta
    let result;
    switch (site.platform) {
      case 'wordpress': result = await publishToWordPress(site, rewritten, article); break;
      case 'blogger':   result = await publishToBlogger(site, rewritten, article);   break;
      case 'webhook':   result = await publishViaWebhook(site, rewritten, article);  break;
      default: return res.status(400).json({ error: `Plataforma desconhecida: ${site.platform}` });
    }

    // Registra publicação
    await pool.query(
      `INSERT INTO publications
         (subscriber_id, article_id, site_id, platform, external_post_id, external_post_url,
          rewritten_title, rewritten_body, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'published')`,
      [
        req.subscriber.id, article_id, site_id, site.platform,
        result.post_id, result.post_url,
        rewritten.title, rewritten.body
      ]
    );

    res.json({ success: true, post_url: result.post_url, post_id: result.post_id });
  } catch (err) {
    console.error('[publish]', err.message);

    // Registra falha
    try {
      await pool.query(
        `INSERT INTO publications
           (subscriber_id, article_id, site_id, platform, status, error_message)
         VALUES ($1,$2,$3,'unknown','error',$4)`,
        [req.subscriber.id, article_id, site_id, err.message]
      );
    } catch { /* ignora erro de log */ }

    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
