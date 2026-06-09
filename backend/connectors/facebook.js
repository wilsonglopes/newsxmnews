'use strict';

const axios    = require('axios');
const FormData = require('form-data');
const { gerarHashtags } = require('./hashtags');

const GRAPH = 'https://graph.facebook.com/v19.0';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripHtml(html) {
  return (html || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Decide se vale retentar. Só transitórios REAIS:
//  - code 1  → "An unknown error" / "reduce the amount of data" (instável da Meta)
//  - code 2  → "Service temporarily unavailable"
//  - timeout/erros de rede (ECONNABORTED, ECONNRESET, ETIMEDOUT)
//  - HTTP 5xx
// NÃO retenta rate limits de app/usuário (code 4/17/32/341/368/613): a janela é
// horária, retry rápido só martela a API e piora o bloqueio.
function isTransientFbError(err) {
  const code = err.response?.data?.error?.code;
  if (code === 1 || code === 2) return true;
  const status = err.response?.status;
  if (status >= 500 && status < 600) return true;
  const netCodes = ['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'];
  if (netCodes.includes(err.code)) return true;
  return false;
}

function montarCaption({ chapeu, title, summary, post_url, captionConfig = {} }) {
  const linhas = [];
  if (captionConfig.caption_show_chapeu && chapeu) linhas.push(`📰 ${chapeu.toUpperCase()}`);
  if (title)    linhas.push(`*${title.trim()}*`);
  if (summary)  linhas.push('', stripHtml(summary));
  if (post_url) linhas.push('', `🔗 Leia: ${post_url}`);
  if (captionConfig.caption_hashtags) linhas.push('', captionConfig.caption_hashtags.trim());
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

  // Hashtags dinâmicas geradas por IA a partir do tema. Têm prioridade; se a IA
  // falhar (retorna ''), mantém as hashtags fixas do social_config (retrocompat).
  const hashtagsIA = await gerarHashtags({ title: article.title, summary: article.summary });
  const captionConfig = { ...(article.captionConfig || {}) };
  if (hashtagsIA) captionConfig.caption_hashtags = hashtagsIA;

  const caption = montarCaption({
    chapeu:        article.chapeu,
    title:         article.title,
    summary:       article.summary,
    post_url:      article.post_url,
    captionConfig,
  });

  // Retry com backoff p/ erros transitórios da Meta (até 3 tentativas: 0s, 3s, 8s).
  // O FormData é um stream consumido a cada POST, então é reconstruído por tentativa.
  const MAX_TENTATIVAS = 3;
  const backoff = [0, 3000, 8000];
  let ultimoErro;

  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    if (backoff[tentativa - 1]) await sleep(backoff[tentativa - 1]);

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
      ultimoErro = err;
      if (tentativa < MAX_TENTATIVAS && isTransientFbError(err)) {
        const fbErr = err.response?.data?.error;
        console.warn(`[FB] tentativa ${tentativa}/${MAX_TENTATIVAS} falhou (transitório): ${fbErr ? fbErr.message + ' (code ' + fbErr.code + ')' : err.message} — retentando...`);
        continue;
      }
      break; // erro não-transitório ou última tentativa: desiste
    }
  }

  const fbErr = ultimoErro.response?.data?.error;
  throw new Error(
    fbErr
      ? `Facebook: ${fbErr.message} (code ${fbErr.code}${fbErr.error_subcode ? '/' + fbErr.error_subcode : ''})`
      : `Facebook: ${ultimoErro.message}`
  );
}

// ─── Publicar imagem no STORY (Stories) da Página ───────────────────────────
// Fluxo Page Photo Stories: 1) sobe a foto como NÃO publicada → photo_id
//                           2) POST /{page-id}/photo_stories com o photo_id
// site: { facebook_page_id, facebook_page_token (decrypted) }
// imagePublicUrl: URL HTTPS pública do card (mesmo do feed)
// Story não tem legenda nem link clicável via API — só a imagem.
async function publicarStory(site, imagePublicUrl) {
  if (!site.facebook_page_id || !site.facebook_page_token) {
    throw new Error('Página do Facebook não configurada para este site.');
  }
  if (!imagePublicUrl || !/^https:\/\//.test(imagePublicUrl)) {
    throw new Error('Facebook Story exige imagem em URL HTTPS pública.');
  }

  const pageId = site.facebook_page_id;
  const token  = site.facebook_page_token;

  // Etapa 1: sobe a foto como não publicada (published=false) → photo_id
  let photoId;
  try {
    const r = await axios.post(`${GRAPH}/${pageId}/photos`, null, {
      params: { url: imagePublicUrl, published: false, access_token: token },
      timeout: 30000,
    });
    photoId = r.data?.id;
    if (!photoId) throw new Error('Facebook não retornou photo_id.');
  } catch (err) {
    const fbErr = err.response?.data?.error;
    throw new Error(fbErr ? `FB/story-upload: ${fbErr.message} (code ${fbErr.code})` : `FB/story-upload: ${err.message}`);
  }

  // Etapa 2: cria o story a partir da foto
  try {
    const r = await axios.post(`${GRAPH}/${pageId}/photo_stories`, null, {
      params: { photo_id: photoId, access_token: token },
      timeout: 30000,
    });
    const data = r.data || {};
    return { ok: true, post_id: data.post_id || data.id || photoId };
  } catch (err) {
    const fbErr = err.response?.data?.error;
    throw new Error(fbErr ? `FB/story-publish: ${fbErr.message} (code ${fbErr.code})` : `FB/story-publish: ${err.message}`);
  }
}

module.exports = { testarConexao, publicarFoto, publicarStory };
