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

    // Busca o site — admin pode publicar em qualquer site, assinante só nos seus
    const siteQuery = req.subscriber.is_admin
      ? 'SELECT * FROM subscriber_sites WHERE id = $1 AND active = true'
      : 'SELECT * FROM subscriber_sites WHERE id = $1 AND subscriber_id = $2 AND active = true';
    const siteParams = req.subscriber.is_admin ? [site_id] : [site_id, req.subscriber.id];
    const { rows: siteRows } = await pool.query(siteQuery, siteParams);
    const site = siteRows[0];
    if (!site) return res.status(404).json({ error: 'Site não encontrado ou sem permissão.' });

    // Verifica duplicata — salvo quando force=true (re-publicação confirmada pelo usuário)
    if (!force) {
      const { rows: pubExist } = await pool.query(
        `SELECT id, status, external_post_url FROM publications
         WHERE subscriber_id = $1 AND article_id = $2 AND site_id = $3
           AND (status = 'published' OR external_post_url IS NOT NULL)
         LIMIT 1`,
        [req.subscriber.id, article_id, site_id]
      );
      if (pubExist.length > 0) {
        return res.status(409).json({
          already_published: true,
          post_url: pubExist[0].external_post_url || null,
          error: 'Este artigo já foi publicado neste site anteriormente.'
        });
      }
    }

    // Publica na plataforma correta
    let result;
    try {
      switch (site.platform) {
        case 'wordpress': result = await publishToWordPress(site, rewritten, article); break;
        case 'blogger':   result = await publishToBlogger(site, rewritten, article);   break;
        case 'webhook':   result = await publishViaWebhook(site, rewritten, article);  break;
        default: return res.status(400).json({ error: `Plataforma desconhecida: ${site.platform}` });
      }
    } catch (publishErr) {
      console.error('[publish] falha na publicação:', publishErr.message);
      try {
        await pool.query(
          `INSERT INTO publications (subscriber_id, article_id, site_id, platform, status, error_message)
           VALUES ($1,$2,$3,'unknown','error',$4)`,
          [site.subscriber_id || req.subscriber.id, article_id, site_id, publishErr.message]
        );
      } catch { /* ignora erro de log */ }
      return res.status(500).json({ error: publishErr.message });
    }

    // Post criado com sucesso — registra no banco.
    // Se o INSERT falhar (ex: schema desatualizado), retorna sucesso mesmo assim:
    // o post JÁ EXISTE no WordPress e não deve ser duplicado numa nova tentativa.
    const pubSubscriberId = site.subscriber_id || req.subscriber.id;
    const tagsStr = Array.isArray(rewritten.tags)
      ? rewritten.tags.join(', ')
      : (rewritten.tags || null);
    try {
      await pool.query(
        `INSERT INTO publications
           (subscriber_id, article_id, site_id, platform, external_post_id, external_post_url,
            rewritten_title, rewritten_body, rewritten_chapeu, rewritten_summary, rewritten_tags, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'published')`,
        [
          pubSubscriberId, article_id, site_id, site.platform,
          result.post_id, result.post_url,
          rewritten.title, rewritten.body,
          rewritten.chapeu || null, rewritten.summary || null, tagsStr
        ]
      );
    } catch (dbErr) {
      // Falha no registro não impede retornar sucesso — post já está no ar
      console.error('[publish] falha ao registrar no banco (post criado):', dbErr.message);
    }

    res.json({ success: true, post_url: result.post_url, post_id: result.post_id });
  } catch (err) {
    console.error('[publish]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/publish/manual — publicação de artigo criado manualmente (sem article_id) ──
// A imagem deve ser pré-carregada via POST /api/sites/:id/upload-image antes de chamar esta rota.
// Recebe image_url (URL real no WP) e image_media_id — exatamente como o sistema normal.
router.post('/manual', async (req, res) => {
  const { site_id, chapeu, titulo, resumo, corpo, tags, category_ids,
          image_url, image_media_id,
          fonte_url, fonte_nome } = req.body || {};

  if (!site_id || !titulo || !corpo) {
    return res.status(400).json({ error: 'site_id, titulo e corpo são obrigatórios.' });
  }

  try {
    // Busca o site
    const siteQuery  = req.subscriber.is_admin
      ? 'SELECT * FROM subscriber_sites WHERE id = $1 AND active = true'
      : 'SELECT * FROM subscriber_sites WHERE id = $1 AND subscriber_id = $2 AND active = true';
    const siteParams = req.subscriber.is_admin ? [site_id] : [site_id, req.subscriber.id];
    const { rows: siteRows } = await pool.query(siteQuery, siteParams);
    const site = siteRows[0];
    if (!site) return res.status(404).json({ error: 'Site não encontrado ou sem permissão.' });

    const rewritten = {
      chapeu:       chapeu || '',
      title:        titulo,
      summary:      resumo || '',
      body:         corpo,
      tags:         Array.isArray(tags) ? tags : (tags || '').split(',').map(t => t.trim()).filter(Boolean),
      category_ids: Array.isArray(category_ids) ? category_ids.map(Number) : [],
    };

    // Artigo fictício — usa image_url e image_media_id já subidos para o WP,
    // exatamente como um artigo normal usa a URL da fonte original.
    const article = {
      id:             null,
      external_url:   fonte_url      || null,
      image_url:      image_url      || null,
      image_media_id: image_media_id || null,
      source_name:    fonte_nome || (fonte_url ? '' : 'Postagem Manual'),
      title:          titulo,
    };

    let result;
    switch (site.platform) {
      case 'wordpress': result = await publishToWordPress(site, rewritten, article); break;
      case 'blogger':   result = await publishToBlogger(site, rewritten, article);   break;
      case 'webhook':   result = await publishViaWebhook(site, rewritten, article);  break;
      default: return res.status(400).json({ error: `Plataforma desconhecida: ${site.platform}` });
    }

    // Grava em publications (sem article_id)
    const tagsStr = rewritten.tags.join(', ') || null;
    await pool.query(
      `INSERT INTO publications
         (subscriber_id, site_id, platform, external_post_id, external_post_url,
          rewritten_title, rewritten_body, rewritten_chapeu, rewritten_summary, rewritten_tags, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'published')`,
      [
        site.subscriber_id || req.subscriber.id, site_id, site.platform,
        result.post_id, result.post_url,
        rewritten.title, rewritten.body,
        rewritten.chapeu || null, rewritten.summary || null, tagsStr,
      ]
    );

    res.json({ success: true, post_url: result.post_url, post_id: result.post_id });
  } catch (err) {
    const status = err.response?.status;
    const wpMsg  = err.response?.data?.message || err.response?.data?.error || JSON.stringify(err.response?.data);
    console.error(`[publish/manual] status=${status || 'rede'}`, wpMsg || err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
