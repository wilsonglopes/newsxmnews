'use strict';

const axios    = require('axios');
const FormData = require('form-data');

const GRAPH = 'https://graph.facebook.com/v19.0';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripHtml(html) {
  return (html || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function montarCaption({ chapeu, title, summary, post_url }) {
  const linhas = [];
  if (chapeu)  linhas.push(`📰 ${chapeu.toUpperCase()}`);
  if (title)   linhas.push(`*${title.trim()}*`);
  if (summary) linhas.push('', stripHtml(summary));
  if (post_url) linhas.push('', `🔗 Leia: ${post_url}`);
  return linhas.join('\n');
}

// ─── Testar conexão / validar token ─────────────────────────────────────────
async function testarConexao({ page_id, page_token }) {
  if (!page_id || !page_token) {
    return { ok: false, error: 'page_id e page_token são obrigatórios.' };
  }
  try {
    const r = await axios.get(`${GRAPH}/${page_id}`, {
      params: { fields: 'id,name,access_token', access_token: page_token },
      timeout: 10000,
    });
    return {
      ok: true,
      page_id: r.data.id,
      page_name: r.data.name,
      message: `Conectado à página: ${r.data.name}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err.response?.data?.error?.message || err.message,
    };
  }
}

// ─── Publicar foto + texto na página ────────────────────────────────────────
// site: objeto com facebook_page_id, facebook_page_token (já descriptografado)
// imageBuffer: Buffer do JPG/PNG gerado (do card-generator)
// article: { chapeu, title, summary, post_url }
async function publicarFoto(site, imageBuffer, article) {
  if (!site.facebook_page_id || !site.facebook_page_token) {
    throw new Error('Página do Facebook não configurada para este site.');
  }

  const caption = montarCaption({
    chapeu:   article.chapeu,
    title:    article.title,
    summary:  article.summary,
    post_url: article.post_url,
  });

  const form = new FormData();
  form.append('source', imageBuffer, { filename: 'card.jpg', contentType: 'image/jpeg' });
  form.append('caption', caption);
  form.append('access_token', site.facebook_page_token);

  try {
    const r = await axios.post(
      `${GRAPH}/${site.facebook_page_id}/photos`,
      form,
      { headers: form.getHeaders(), timeout: 30000, maxContentLength: Infinity, maxBodyLength: Infinity }
    );
    const data = r.data || {};
    // Constrói URL do post (Facebook não retorna URL pronta no /photos)
    const postId = data.post_id || data.id;
    const postUrl = postId ? `https://www.facebook.com/${postId}` : null;
    return {
      ok: true,
      photo_id: data.id,
      post_id:  data.post_id || null,
      post_url: postUrl,
    };
  } catch (err) {
    const fbErr = err.response?.data?.error;
    throw new Error(
      fbErr
        ? `Facebook: ${fbErr.message} (code ${fbErr.code}${fbErr.error_subcode ? '/' + fbErr.error_subcode : ''})`
        : `Facebook: ${err.message}`
    );
  }
}

module.exports = { testarConexao, publicarFoto };
