'use strict';

const express = require('express');
const pool    = require('../db/connection');
const auth    = require('../middleware/auth');
const { publishToWordPress } = require('../connectors/wordpress');
const { publishToBlogger }   = require('../connectors/blogger');
const { publishViaWebhook }  = require('../connectors/webhook');
const wa                     = require('../connectors/whatsapp');

const router = express.Router();

router.use(auth);

// ── POST /api/publish ─────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { article_id, site_id, rewritten, force, publish_to_facebook, publish_to_story, publish_to_whatsapp,
          image_override_url, image_base64, image_mime, image_name } = req.body || {};

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

    // ── Imagem alternativa (opcional) — substitui a imagem da fonte nesta publicação ──
    // Vale para o post (WordPress) E para o card do Facebook/Instagram. Pontual: não altera o artigo no banco.
    if (image_override_url) {
      article.image_url = image_override_url;
      article.image_media_id = null;
    } else if (image_base64) {
      // Upload do PC: hospeda temporariamente para virar uma URL que o WP e o card conseguem usar
      try {
        const { resolveImageBuffer, criarTempImagemPublica } = require('../connectors/wordpress');
        const img = await resolveImageBuffer({ image_base64, image_mime, image_name });
        const tempUrl = img && criarTempImagemPublica(img);
        if (tempUrl) {
          article.image_url = tempUrl;
          article.image_media_id = null;
          console.log(`[publish] imagem alternativa (upload) hospedada: ${tempUrl}`);
        }
      } catch (e) {
        console.warn(`[publish] falha ao hospedar imagem alternativa: ${e.message} — mantendo imagem da fonte`);
      }
    }

    // Busca o site — admin pode publicar em qualquer site, assinante só nos seus
    const siteBase = `
      SELECT ss.id, ss.subscriber_id, COALESCE(ss.ai_prompt, sc.ai_prompt) AS ai_prompt, ss.default_category_id, ss.auto_publish,
             COALESCE(sc.name, ss.name)                       AS name,
             COALESCE(sc.platform, ss.platform)               AS platform,
             COALESCE(sc.site_url, ss.site_url)               AS site_url,
             COALESCE(sc.wp_username, ss.wp_username)         AS wp_username,
             COALESCE(sc.wp_app_password, ss.wp_app_password) AS wp_app_password,
             COALESCE(sc.xixo_api_key, ss.xixo_api_key)       AS xixo_api_key,
             COALESCE(sc.blogger_blog_id, ss.blogger_blog_id) AS blogger_blog_id,
             COALESCE(sc.blogger_access_token, ss.blogger_access_token)   AS blogger_access_token,
             COALESCE(sc.blogger_refresh_token, ss.blogger_refresh_token) AS blogger_refresh_token,
             COALESCE(sc.webhook_url, ss.webhook_url)         AS webhook_url,
             COALESCE(sc.webhook_secret, ss.webhook_secret)   AS webhook_secret,
             COALESCE(sc.post_format, ss.post_format)         AS post_format,
             sc.facebook_enabled, sc.facebook_page_id, sc.facebook_page_token,
             sc.instagram_enabled, sc.instagram_business_account_id, sc.instagram_username,
             sc.social_config,
             sc.id AS catalog_id, COALESCE(sc.whatsapp_enabled, false) AS whatsapp_enabled, sc.evolution_instance
      FROM subscriber_sites ss
      LEFT JOIN sites_catalog sc ON sc.id = ss.site_id
      WHERE ss.id = $1 AND ss.active = true`;
    const siteQuery  = req.subscriber.is_admin ? siteBase : siteBase + ' AND ss.subscriber_id = $2';
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

    // ── Publicação no Facebook + Instagram (opcional) ────────────────────
    let facebookResult  = null;
    let instagramResult = null;
    const wantsFacebook = publish_to_facebook === true || publish_to_facebook === 'true'; // Feed
    const wantsStory    = publish_to_story === true || publish_to_story === 'true';       // Status (Stories)
    let storyResult = null;

    // Artigos sem imagem geram card com fundo vazio — não publicar no FB/IG (feed nem story).
    if ((wantsFacebook || wantsStory) && !article.image_url) {
      console.log(`[publish/social] artigo sem imagem — pulando FB/IG para "${rewritten.title?.slice(0, 50)}"`);
      facebookResult  = { ok: false, skipped: true, reason: 'sem_imagem' };
      instagramResult = { ok: false, skipped: true, reason: 'sem_imagem' };
      storyResult     = { ok: false, skipped: true, reason: 'sem_imagem' };
    }

    if ((wantsFacebook || wantsStory) && article.image_url && site.facebook_enabled && site.facebook_page_id && site.facebook_page_token) {
      try {
        const { gerarCard, gerarCardComUrl } = require('../utils/card-generator');
        const { publicarFoto, publicarStory: publicarStoryFB } = require('../connectors/facebook');
        const { publicar: publicarInstagram, publicarStory: publicarStoryIG } = require('../connectors/instagram');
        const { decryptToken } = require('../connectors/encrypt');

        const wantsInstagram = site.instagram_enabled && site.instagram_business_account_id;
        const pageToken = decryptToken(site.facebook_page_token);
        const socialConfig = site.social_config || {};

        // Card em URL pública é necessário para: IG feed, story (FB e IG). Senão, só buffer.
        const precisaUrlPublica = wantsStory || (wantsFacebook && wantsInstagram);
        let cardBuffer, cardPublicUrl, cardFpath;
        if (precisaUrlPublica) {
          const r = await gerarCardComUrl({
            chapeu:     rewritten.chapeu || article.chapeu || '',
            titulo:     rewritten.title  || article.title  || '',
            imageUrl:   article.image_url || '',
            cardConfig: socialConfig,
          });
          cardBuffer    = r.buffer;
          cardPublicUrl = r.publicUrl;
          cardFpath     = r.fpath;
        } else {
          cardBuffer = await gerarCard({
            chapeu:     rewritten.chapeu || article.chapeu || '',
            titulo:     rewritten.title  || article.title  || '',
            imageUrl:   article.image_url || '',
            cardConfig: socialConfig,
          });
        }

        // ── FEED ──────────────────────────────────────────────────────────────
        if (wantsFacebook) {
          // Facebook feed
          try {
            const fb = await publicarFoto(
              { facebook_page_id: site.facebook_page_id, facebook_page_token: pageToken },
              cardBuffer,
              { chapeu: rewritten.chapeu, title: rewritten.title, summary: rewritten.summary, post_url: result.post_url, captionConfig: socialConfig }
            );
            facebookResult = { ok: true, post_url: fb.post_url, photo_id: fb.photo_id };
            try {
              await pool.query(
                `UPDATE publications SET facebook_post_id = $1, facebook_post_url = $2
                 WHERE subscriber_id = $3 AND article_id = $4 AND site_id = $5 AND status = 'published'`,
                [fb.photo_id || fb.post_id, fb.post_url, pubSubscriberId, article_id, site_id]
              );
            } catch (e) { console.warn('[publish/fb] grava ID:', e.message); }
          } catch (fbErr) {
            console.error('[publish/fb]', fbErr.message);
            facebookResult = { ok: false, error: fbErr.message };
          }

          // Instagram feed
          if (wantsInstagram && cardPublicUrl) {
            try {
              const ig = await publicarInstagram(
                { instagram_business_account_id: site.instagram_business_account_id, facebook_page_token: pageToken },
                cardPublicUrl,
                { chapeu: rewritten.chapeu, title: rewritten.title, summary: rewritten.summary, post_url: result.post_url }
              );
              instagramResult = { ok: true, post_url: ig.post_url, post_id: ig.post_id };
              try {
                await pool.query(
                  `UPDATE publications SET instagram_post_id = $1, instagram_post_url = $2
                   WHERE subscriber_id = $3 AND article_id = $4 AND site_id = $5 AND status = 'published'`,
                  [ig.post_id, ig.post_url, pubSubscriberId, article_id, site_id]
                );
              } catch (e) { console.warn('[publish/ig] grava ID:', e.message); }
            } catch (igErr) {
              console.error('[publish/ig]', igErr.message);
              instagramResult = { ok: false, error: igErr.message };
            }
          }
        }

        // ── STATUS (Stories) ──────────────────────────────────────────────────
        if (wantsStory && cardPublicUrl) {
          storyResult = {};
          // Facebook story
          try {
            const fbs = await publicarStoryFB({ facebook_page_id: site.facebook_page_id, facebook_page_token: pageToken }, cardPublicUrl);
            storyResult.facebook = { ok: true, post_id: fbs.post_id };
          } catch (e) { console.error('[publish/fb-story]', e.message); storyResult.facebook = { ok: false, error: e.message }; }
          // Instagram story
          if (wantsInstagram) {
            try {
              const igs = await publicarStoryIG({ instagram_business_account_id: site.instagram_business_account_id, facebook_page_token: pageToken }, cardPublicUrl);
              storyResult.instagram = { ok: true, post_id: igs.post_id };
            } catch (e) { console.error('[publish/ig-story]', e.message); storyResult.instagram = { ok: false, error: e.message }; }
          }
        }

        if (cardFpath) { try { require('fs').unlinkSync(cardFpath); } catch {} }

      } catch (err) {
        console.error('[publish/social]', err.message);
        if (wantsFacebook && !facebookResult)  facebookResult  = { ok: false, error: err.message };
        if (wantsFacebook && !instagramResult) instagramResult = { ok: false, error: err.message };
        if (wantsStory && !storyResult)        storyResult     = { ok: false, error: err.message };
      }
    }

    // ── WhatsApp (grupos do portal) — independente do FB/IG ──────────────
    let whatsappResult = null;
    const wantsWhatsApp = publish_to_whatsapp === true || publish_to_whatsapp === 'true';
    if (wantsWhatsApp && await wa.whatsappDisponivel(site)) {
      let waFpath = null;
      try {
        let waCardUrl = null;
        if (article.image_url) {
          const { gerarCardComUrl } = require('../utils/card-generator');
          const r = await gerarCardComUrl({
            chapeu:     rewritten.chapeu || article.chapeu || '',
            titulo:     rewritten.title  || article.title  || '',
            imageUrl:   article.image_url,
            cardConfig: site.social_config || {},
          });
          waCardUrl = r.publicUrl; waFpath = r.fpath;
        }
        const r = await wa.publicarNosGrupos(site, {
          chapeu:  rewritten.chapeu || article.chapeu,
          titulo:  rewritten.title  || article.title,
          resumo:  rewritten.summary,
          postUrl: result.post_url,
          cardUrl: waCardUrl,
        });
        whatsappResult = { ok: r.ok > 0, enviados: r.ok, falhas: r.falhas, total: r.total };
      } catch (e) {
        console.error('[publish/whatsapp]', e.message);
        whatsappResult = { ok: false, error: e.message };
      } finally {
        if (waFpath) { try { require('fs').unlinkSync(waFpath); } catch {} }
      }
    }

    res.json({
      success: true,
      post_url: result.post_url,
      post_id: result.post_id,
      facebook:  facebookResult,
      instagram: instagramResult,
      story:     storyResult,
      whatsapp:  whatsappResult,
    });
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
          image_base64, image_mime, image_name,
          fonte_url, fonte_nome,
          publish_to_facebook, publish_to_story, publish_to_whatsapp } = req.body || {};

  if (!site_id || !titulo || !corpo) {
    return res.status(400).json({ error: 'site_id, titulo e corpo são obrigatórios.' });
  }

  try {
    // Busca o site
    const siteBase = `
      SELECT ss.id, ss.subscriber_id, COALESCE(ss.ai_prompt, sc.ai_prompt) AS ai_prompt, ss.default_category_id,
             COALESCE(sc.name, ss.name)                       AS name,
             COALESCE(sc.platform, ss.platform)               AS platform,
             COALESCE(sc.site_url, ss.site_url)               AS site_url,
             COALESCE(sc.wp_username, ss.wp_username)         AS wp_username,
             COALESCE(sc.wp_app_password, ss.wp_app_password) AS wp_app_password,
             COALESCE(sc.xixo_api_key, ss.xixo_api_key)       AS xixo_api_key,
             COALESCE(sc.blogger_blog_id, ss.blogger_blog_id) AS blogger_blog_id,
             COALESCE(sc.blogger_access_token, ss.blogger_access_token)   AS blogger_access_token,
             COALESCE(sc.blogger_refresh_token, ss.blogger_refresh_token) AS blogger_refresh_token,
             COALESCE(sc.webhook_url, ss.webhook_url)         AS webhook_url,
             COALESCE(sc.webhook_secret, ss.webhook_secret)   AS webhook_secret,
             COALESCE(sc.post_format, ss.post_format)         AS post_format,
             sc.facebook_enabled, sc.facebook_page_id, sc.facebook_page_token,
             sc.instagram_enabled, sc.instagram_business_account_id, sc.instagram_username,
             sc.social_config,
             sc.id AS catalog_id, COALESCE(sc.whatsapp_enabled, false) AS whatsapp_enabled, sc.evolution_instance
      FROM subscriber_sites ss
      LEFT JOIN sites_catalog sc ON sc.id = ss.site_id
      WHERE ss.id = $1 AND ss.active = true`;
    const siteQuery  = req.subscriber.is_admin ? siteBase : siteBase + ' AND ss.subscriber_id = $2';
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
      image_base64:   image_base64   || null,
      image_mime:     image_mime     || null,
      image_name:     image_name     || null,
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

    // ── Publicação no Facebook + Instagram (opcional) ─────────────────────────
    let facebookResultManual  = null;
    let instagramResultManual = null;
    let storyResultManual     = null;
    const wantsFacebookManual = publish_to_facebook === true || publish_to_facebook === 'true'; // Feed
    const wantsStoryManual    = publish_to_story === true || publish_to_story === 'true';        // Status

    // Se a imagem não subiu pro WP (image_url vazio, ex: site sem senha de aplicação válida)
    // mas temos o base64 em memória, hospeda temporariamente p/ o card das redes poder usá-la.
    if ((wantsFacebookManual || wantsStoryManual) && !article.image_url && image_base64) {
      try {
        const { resolveImageBuffer, criarTempImagemPublica } = require('../connectors/wordpress');
        const img = await resolveImageBuffer({ image_base64, image_mime, image_name });
        const tempUrl = img && criarTempImagemPublica(img);
        if (tempUrl) {
          article.image_url = tempUrl;
          console.log(`[manual/social] imagem via base64 hospedada p/ card: ${tempUrl}`);
        }
      } catch (e) {
        console.warn(`[manual/social] não foi possível hospedar imagem do base64: ${e.message}`);
      }
    }

    // Artigos sem imagem geram card com fundo vazio — não publicar no FB/IG (feed nem story).
    if ((wantsFacebookManual || wantsStoryManual) && !article.image_url) {
      console.log(`[manual/social] artigo sem imagem — pulando FB/IG para "${rewritten.title?.slice(0, 50)}"`);
      facebookResultManual  = { ok: false, skipped: true, reason: 'sem_imagem' };
      instagramResultManual = { ok: false, skipped: true, reason: 'sem_imagem' };
      storyResultManual     = { ok: false, skipped: true, reason: 'sem_imagem' };
    }

    if ((wantsFacebookManual || wantsStoryManual) && article.image_url && site.facebook_enabled && site.facebook_page_id && site.facebook_page_token) {
      try {
        const { gerarCard, gerarCardComUrl } = require('../utils/card-generator');
        const { publicarFoto, publicarStory: publicarStoryFB } = require('../connectors/facebook');
        const { publicar: publicarInstagram, publicarStory: publicarStoryIG } = require('../connectors/instagram');
        const { decryptToken } = require('../connectors/encrypt');

        const wantsInstagram = site.instagram_enabled && site.instagram_business_account_id;
        const pageToken = decryptToken(site.facebook_page_token);
        const socialConfigManual = site.social_config || {};
        const pubSubscriberId = site.subscriber_id || req.subscriber.id;

        const precisaUrlPublica = wantsStoryManual || (wantsFacebookManual && wantsInstagram);
        let cardBuffer, cardPublicUrl, cardFpath;
        if (precisaUrlPublica) {
          const r = await gerarCardComUrl({
            chapeu:     rewritten.chapeu || '',
            titulo:     rewritten.title  || '',
            imageUrl:   article.image_url || '',
            cardConfig: socialConfigManual,
          });
          cardBuffer    = r.buffer;
          cardPublicUrl = r.publicUrl;
          cardFpath     = r.fpath;
        } else {
          cardBuffer = await gerarCard({
            chapeu:     rewritten.chapeu || '',
            titulo:     rewritten.title  || '',
            imageUrl:   article.image_url || '',
            cardConfig: socialConfigManual,
          });
        }

        // ── FEED ──────────────────────────────────────────────────────────────
        if (wantsFacebookManual) {
          try {
            const fb = await publicarFoto(
              { facebook_page_id: site.facebook_page_id, facebook_page_token: pageToken },
              cardBuffer,
              { chapeu: rewritten.chapeu, title: rewritten.title, summary: rewritten.summary, post_url: result.post_url, captionConfig: socialConfigManual }
            );
            facebookResultManual = { ok: true, post_url: fb.post_url, photo_id: fb.photo_id };
            try {
              await pool.query(
                `UPDATE publications SET facebook_post_id = $1, facebook_post_url = $2
                 WHERE subscriber_id = $3 AND site_id = $4 AND external_post_id = $5`,
                [fb.photo_id || fb.post_id, fb.post_url, pubSubscriberId, site_id, result.post_id]
              );
            } catch (e) { console.warn('[manual/fb] grava ID:', e.message); }
          } catch (fbErr) {
            console.error('[manual/fb]', fbErr.message);
            facebookResultManual = { ok: false, error: fbErr.message };
          }

          if (wantsInstagram && cardPublicUrl) {
            try {
              const ig = await publicarInstagram(
                { instagram_business_account_id: site.instagram_business_account_id, facebook_page_token: pageToken },
                cardPublicUrl,
                { chapeu: rewritten.chapeu, title: rewritten.title, summary: rewritten.summary, post_url: result.post_url }
              );
              instagramResultManual = { ok: true, post_url: ig.post_url, post_id: ig.post_id };
              try {
                await pool.query(
                  `UPDATE publications SET instagram_post_id = $1, instagram_post_url = $2
                   WHERE subscriber_id = $3 AND site_id = $4 AND external_post_id = $5`,
                  [ig.post_id, ig.post_url, pubSubscriberId, site_id, result.post_id]
                );
              } catch (e) { console.warn('[manual/ig] grava ID:', e.message); }
            } catch (igErr) {
              console.error('[manual/ig]', igErr.message);
              instagramResultManual = { ok: false, error: igErr.message };
            }
          }
        }

        // ── STATUS (Stories) ──────────────────────────────────────────────────
        if (wantsStoryManual && cardPublicUrl) {
          storyResultManual = {};
          try {
            const fbs = await publicarStoryFB({ facebook_page_id: site.facebook_page_id, facebook_page_token: pageToken }, cardPublicUrl);
            storyResultManual.facebook = { ok: true, post_id: fbs.post_id };
          } catch (e) { console.error('[manual/fb-story]', e.message); storyResultManual.facebook = { ok: false, error: e.message }; }
          if (wantsInstagram) {
            try {
              const igs = await publicarStoryIG({ instagram_business_account_id: site.instagram_business_account_id, facebook_page_token: pageToken }, cardPublicUrl);
              storyResultManual.instagram = { ok: true, post_id: igs.post_id };
            } catch (e) { console.error('[manual/ig-story]', e.message); storyResultManual.instagram = { ok: false, error: e.message }; }
          }
        }

        if (cardFpath) { try { require('fs').unlinkSync(cardFpath); } catch {} }

      } catch (err) {
        console.error('[manual/social]', err.message);
        if (wantsFacebookManual && !facebookResultManual)  facebookResultManual  = { ok: false, error: err.message };
        if (wantsFacebookManual && !instagramResultManual) instagramResultManual = { ok: false, error: err.message };
        if (wantsStoryManual && !storyResultManual)        storyResultManual     = { ok: false, error: err.message };
      }
    }

    // ── WhatsApp (grupos do portal) — independente do FB/IG ──────────────
    let whatsappResultManual = null;
    const wantsWhatsAppManual = publish_to_whatsapp === true || publish_to_whatsapp === 'true';
    if (wantsWhatsAppManual && await wa.whatsappDisponivel(site)) {
      let waFpath = null;
      try {
        let waCardUrl = null;
        if (article.image_url) {
          const { gerarCardComUrl } = require('../utils/card-generator');
          const r = await gerarCardComUrl({
            chapeu:     rewritten.chapeu || '',
            titulo:     rewritten.title  || '',
            imageUrl:   article.image_url,
            cardConfig: site.social_config || {},
          });
          waCardUrl = r.publicUrl; waFpath = r.fpath;
        }
        const r = await wa.publicarNosGrupos(site, {
          chapeu:  rewritten.chapeu,
          titulo:  rewritten.title,
          resumo:  rewritten.summary,
          postUrl: result.post_url,
          cardUrl: waCardUrl,
        });
        whatsappResultManual = { ok: r.ok > 0, enviados: r.ok, falhas: r.falhas, total: r.total };
      } catch (e) {
        console.error('[manual/whatsapp]', e.message);
        whatsappResultManual = { ok: false, error: e.message };
      } finally {
        if (waFpath) { try { require('fs').unlinkSync(waFpath); } catch {} }
      }
    }

    res.json({
      success:   true,
      post_url:  result.post_url,
      post_id:   result.post_id,
      facebook:  facebookResultManual,
      instagram: instagramResultManual,
      story:     storyResultManual,
      whatsapp:  whatsappResultManual,
    });
  } catch (err) {
    const status = err.response?.status;
    const wpMsg  = err.response?.data?.message || err.response?.data?.error || JSON.stringify(err.response?.data);
    console.error(`[publish/manual] status=${status || 'rede'}`, wpMsg || err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
