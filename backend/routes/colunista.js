'use strict';

/**
 * ✍️ Ferramenta de Colunistas — feature isolada e aditiva.
 *
 * Conta de colunista (criada pelo admin) já vem amarrada a portal + categoria.
 * O colunista escreve a matéria num editor rico (chapéu, título, subtítulo,
 * capa, corpo com imagens inline) e publica direto no portal certo — sem IA,
 * sem escolher nada. Modo "rascunho" envia como draft no WP para o admin revisar.
 *
 * Nada do fluxo existente é alterado: rotas próprias, publica chamando o plugin
 * diretamente (preservando as imagens do corpo, que o conector normal removeria).
 */

const express = require('express');
const axios   = require('axios');
const https   = require('https');
const FormData = require('form-data');
const pool    = require('../db/connection');
const auth    = require('../middleware/auth');
const { decryptToken } = require('../connectors/encrypt');

const router = express.Router();
const HTTPS_AGENT = new https.Agent({ rejectUnauthorized: false });

// ── Migration idempotente (no load do módulo) ────────────────────────────────
pool.query(`
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='subscribers' AND column_name='is_colunista')
      THEN ALTER TABLE subscribers ADD COLUMN is_colunista BOOLEAN DEFAULT false; END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='subscribers' AND column_name='coluna_site_id')
      THEN ALTER TABLE subscribers ADD COLUMN coluna_site_id UUID; END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='subscribers' AND column_name='coluna_category_id')
      THEN ALTER TABLE subscribers ADD COLUMN coluna_category_id INTEGER; END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='subscribers' AND column_name='coluna_autor')
      THEN ALTER TABLE subscribers ADD COLUMN coluna_autor VARCHAR(200); END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='subscribers' AND column_name='coluna_auto_publish')
      THEN ALTER TABLE subscribers ADD COLUMN coluna_auto_publish BOOLEAN DEFAULT false; END IF;
  END $$;
`).catch(e => console.error('[colunista] migration:', e.message));

router.use(auth);

// Acesso: colunista OU admin (admin também pode escrever como colunista)
router.use((req, res, next) => {
  if (req.subscriber.is_colunista || req.subscriber.is_admin) return next();
  return res.status(403).json({ error: 'Acesso restrito a colunistas.' });
});

// Carrega o vínculo do colunista + credenciais do portal
async function carregarVinculo(subscriberId) {
  const { rows } = await pool.query(
    `SELECT s.coluna_site_id, s.coluna_category_id, s.coluna_autor, s.coluna_auto_publish,
            s.name AS subscriber_name,
            c.id AS site_id, c.name AS site_name, c.site_url, c.post_format,
            c.xixo_api_key, c.wp_username, c.wp_app_password
     FROM subscribers s
     LEFT JOIN sites_catalog c ON c.id = s.coluna_site_id
     WHERE s.id = $1`,
    [subscriberId]
  );
  return rows[0] || null;
}

// ── GET /api/colunista/me — dados do vínculo p/ a tela ───────────────────────
router.get('/me', async (req, res) => {
  try {
    const v = await carregarVinculo(req.subscriber.id);
    if (!v) return res.status(404).json({ error: 'Vínculo não encontrado.' });
    if (!v.coluna_site_id || !v.site_url) {
      return res.status(400).json({ error: 'Colunista sem portal configurado. Peça ao admin para vincular um site.' });
    }
    // Nome da categoria fixa (via REST pública do WP)
    let categoria_nome = null;
    if (v.coluna_category_id) {
      try {
        const baseUrl = v.site_url.replace(/\/$/, '');
        const r = await axios.get(`${baseUrl}/wp-json/wp/v2/categories/${v.coluna_category_id}`, { timeout: 10000, httpsAgent: HTTPS_AGENT });
        categoria_nome = r.data?.name || null;
      } catch { /* nome é só cosmético */ }
    }
    res.json({
      autor:          v.coluna_autor || v.subscriber_name,
      site_nome:      v.site_name,
      categoria_id:   v.coluna_category_id,
      categoria_nome,
      auto_publish:   v.coluna_auto_publish,
      pode_subir_imagem: !!(v.xixo_api_key || (v.wp_username && v.wp_app_password)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/colunista/upload-imagem — capa ou imagem do corpo → WP ─────────
// Preferência: plugin v2.4.0 (xmn/v1/upload-image, só a chave). Fallback: REST
// nativa do WP (precisa de senha de aplicação). Cada portal usa o que tiver.
router.post('/upload-imagem', async (req, res) => {
  const { image_base64, image_mime, image_name } = req.body || {};
  if (!image_base64 || !image_mime) return res.status(400).json({ error: 'image_base64 e image_mime são obrigatórios.' });
  try {
    const v = await carregarVinculo(req.subscriber.id);
    if (!v?.site_url) return res.status(400).json({ error: 'Portal não configurado.' });
    const baseUrl = v.site_url.replace(/\/$/, '');

    // 1) Via plugin (chave) — dispensa senha de aplicação
    if (v.xixo_api_key) {
      try {
        const r = await axios.post(`${baseUrl}/wp-json/xmn/v1/upload-image`,
          { image_base64, image_mime, image_name },
          { timeout: 40000, httpsAgent: HTTPS_AGENT, maxContentLength: Infinity, maxBodyLength: Infinity,
            headers: { 'Content-Type': 'application/json', 'X-XMNews-Key': v.xixo_api_key } });
        if (r.data?.success && r.data?.image_url) {
          return res.json({ image_url: r.data.image_url, media_id: r.data.media_id });
        }
        // plugin respondeu mas sem sucesso → tenta fallback abaixo
      } catch (e) {
        // 404 = plugin antigo sem o endpoint; outros erros também caem no fallback
        console.warn('[colunista/upload] plugin falhou, tentando REST nativa:', e.response?.status || e.message);
      }
    }

    // 2) Fallback: REST nativa (requer senha de aplicação)
    if (!v.wp_username || !v.wp_app_password) {
      return res.status(400).json({ error: 'Portal sem plugin v2.4.0 nem senha de aplicação — não é possível enviar imagens.' });
    }
    const password = decryptToken(v.wp_app_password);
    const wpAuth   = Buffer.from(`${v.wp_username}:${password}`).toString('base64');
    const buffer   = Buffer.from(image_base64, 'base64');
    const fileName = (image_name || 'imagem.jpg').replace(/[^a-zA-Z0-9._-]/g, '_');
    const form = new FormData();
    form.append('file', buffer, { filename: fileName, contentType: image_mime });
    const up = await axios.post(`${baseUrl}/wp-json/wp/v2/media`, form, {
      timeout: 30000, httpsAgent: HTTPS_AGENT, maxContentLength: Infinity, maxBodyLength: Infinity,
      headers: { 'Authorization': `Basic ${wpAuth}`, 'Accept': 'application/json', ...form.getHeaders() },
    });
    const mediaId  = up.data?.id;
    const imageUrl = up.data?.source_url || up.data?.guid?.rendered;
    if (!mediaId || !imageUrl) return res.status(500).json({ error: 'Upload retornou resposta inválida.' });
    res.json({ image_url: imageUrl, media_id: mediaId });
  } catch (err) {
    const wpMsg = err.response?.data?.error || err.response?.data?.message || err.message;
    console.error('[colunista/upload]', wpMsg);
    res.status(500).json({ error: `Falha no upload: ${wpMsg}` });
  }
});

// ── POST /api/colunista/publicar — publica no portal+categoria FIXOS ─────────
router.post('/publicar', async (req, res) => {
  const { chapeu, title, subtitulo, body, image_url, image_media_id, tags } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'Título é obrigatório.' });
  if (!body || !body.trim())   return res.status(400).json({ error: 'O corpo do artigo está vazio.' });

  try {
    const v = await carregarVinculo(req.subscriber.id);
    if (!v?.site_url)     return res.status(400).json({ error: 'Portal não configurado.' });
    if (!v.xixo_api_key)  return res.status(400).json({ error: 'Portal sem o plugin Publisher configurado (chave ausente).' });

    const baseUrl = v.site_url.replace(/\/$/, '');
    const slugify = (s) => (s || '').toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 100);

    // post_status conforme o modo do colunista (rascunho = admin revisa no WP)
    const postStatus = v.coluna_auto_publish ? 'publish' : 'draft';

    // Corpo vai INTACTO (com as imagens inline) — diferente do fluxo de IA.
    const payload = {
      title:          title.trim(),
      chapeu:         (chapeu || '').trim(),
      summary:        (subtitulo || '').trim(),
      body:           body, // preservado com <img> inline
      slug:           slugify(title),
      image_url:      image_url || '',
      image_media_id: image_media_id || 0,
      post_format:    v.post_format || 'editorial',
      category_ids:   v.coluna_category_id ? [v.coluna_category_id] : [],
      tags:           Array.isArray(tags) ? tags : [],
      post_status:    postStatus,                 // plugin v2.3.0+
      author_name:    v.coluna_autor || null,     // plugin v2.3.0+
      keep_body_images: true,                     // sinaliza intenção (plugin já preserva)
    };

    const r = await axios.post(`${baseUrl}/wp-json/xmn/v1/publish`, payload, {
      timeout: 120000, httpsAgent: HTTPS_AGENT,
      headers: { 'Content-Type': 'application/json', 'X-XMNews-Key': v.xixo_api_key },
    });
    if (!r.data?.success || !r.data?.post_id) {
      throw new Error(r.data?.error || 'Resposta inesperada do plugin.');
    }

    // Registra na tabela publications (rastreio), status reflete rascunho/publicado
    try {
      await pool.query(
        `INSERT INTO publications
           (subscriber_id, site_id, platform, external_post_id, external_post_url,
            rewritten_title, rewritten_body, rewritten_chapeu, rewritten_summary, status)
         VALUES ($1,$2,'wordpress',$3,$4,$5,$6,$7,$8,$9)`,
        [req.subscriber.id, v.site_id, String(r.data.post_id), r.data.post_url,
         title.trim(), body, (chapeu||'').trim(), (subtitulo||'').trim(),
         postStatus === 'draft' ? 'draft' : 'published']
      );
    } catch (e) { console.warn('[colunista] log publication:', e.message); }

    res.json({
      success:  true,
      post_url: r.data.post_url,
      status:   postStatus,
      message:  postStatus === 'draft'
        ? 'Enviado como rascunho — o administrador vai revisar e publicar no WordPress.'
        : 'Publicado com sucesso!',
    });
  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    console.error('[colunista/publicar]', msg);
    res.status(500).json({ error: msg });
  }
});

module.exports = router;
