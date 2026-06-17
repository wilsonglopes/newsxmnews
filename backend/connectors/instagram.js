'use strict';

const axios = require('axios');
const { gerarHashtags } = require('./hashtags');

const GRAPH = 'https://graph.facebook.com/v19.0';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripHtml(html) {
  return (html || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function montarCaption({ chapeu, title, summary, post_url, hashtags }) {
  // Caption do Instagram: texto puro, sem markdown.
  // Limit Instagram: 2200 chars.
  const linhas = [];
  if (chapeu) linhas.push(`📰 ${chapeu.toUpperCase()}`);
  if (title)  linhas.push('', title.trim());
  if (summary) {
    linhas.push('');
    const resumo = stripHtml(summary);
    linhas.push(resumo);
  }
  if (post_url) {
    linhas.push('', `🔗 Leia a matéria completa em:`);
    linhas.push(post_url);
  }
  if (hashtags) linhas.push('', hashtags.trim());
  return linhas.join('\n').substring(0, 2200);
}

// ─── Verifica se um post foi realmente publicado (apesar de erro de rate limit) ─
// Quando media_publish retorna code 4 (Application request limit reached), a Meta
// às vezes JÁ publicou — só a resposta veio com erro. Aqui confirmamos consultando
// as mídias recentes da conta e comparando o início da legenda.
// Retorna { post_id, post_url } se encontrou; null caso contrário.
async function verificarPublicacaoRecente(igId, token, captionEsperada) {
  if (!captionEsperada) return null;
  try {
    const r = await axios.get(`${GRAPH}/${igId}/media`, {
      params: { fields: 'id,caption,timestamp,permalink', limit: 5, access_token: token },
      timeout: 12000,
    });
    const agora = Date.now();
    // Compara os primeiros 60 chars (sem espaços) da legenda — robusto a recortes
    const norm = s => (s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const alvo = norm(captionEsperada);
    for (const m of r.data?.data || []) {
      const ts = new Date(m.timestamp).getTime();
      if (isNaN(ts) || (agora - ts) > 6 * 60 * 1000) continue; // só posts dos últimos 6 min
      if (norm(m.caption) === alvo) {
        return { post_id: m.id, post_url: m.permalink || null };
      }
    }
  } catch (e) {
    console.warn('[instagram/verificar]', e.response?.data?.error?.message || e.message);
  }
  return null;
}

// É erro de rate limit / transitório da Graph API? (publicação pode ter ocorrido)
function ehRateLimit(fbErr) {
  if (!fbErr) return false;
  return fbErr.code === 4 || fbErr.code === 17 || fbErr.code === 32 || fbErr.code === 613;
}

// ─── Detectar IG Business Account vinculado a uma Page ──────────────────────
// Usa o Page Token. Retorna { id, username } ou null se não tem IG conectado.
async function descobrirIgBusinessAccount({ page_id, page_token }) {
  try {
    const r = await axios.get(`${GRAPH}/${page_id}`, {
      params: {
        fields: 'instagram_business_account{id,username}',
        access_token: page_token,
      },
      timeout: 10000,
    });
    const ig = r.data?.instagram_business_account;
    return ig ? { id: ig.id, username: ig.username } : null;
  } catch (err) {
    console.warn('[instagram/discover]', err.response?.data?.error?.message || err.message);
    return null;
  }
}

// ─── Publicar foto + texto no Instagram ─────────────────────────────────────
// site: { instagram_business_account_id, facebook_page_token (decrypted) }
// imagePublicUrl: URL HTTPS pública (acessível pela Meta) da imagem do card
// article: { chapeu, title, summary, post_url }
async function publicar(site, imagePublicUrl, article) {
  if (!site.instagram_business_account_id) {
    throw new Error('Instagram Business Account não configurado para este site.');
  }
  if (!site.facebook_page_token) {
    throw new Error('Page Access Token ausente.');
  }
  if (!imagePublicUrl || !/^https:\/\//.test(imagePublicUrl)) {
    throw new Error('Instagram exige imagem em URL HTTPS pública.');
  }

  const igId   = site.instagram_business_account_id;
  const token  = site.facebook_page_token;
  // Hashtags por IA (mesmo helper do Facebook → cache garante as mesmas tags nas 2 redes).
  const hashtags = await gerarHashtags({ title: article.title, summary: article.summary });
  const caption = montarCaption({ ...article, hashtags });

  // Etapa 1: cria container de mídia
  let creationId;
  try {
    const r = await axios.post(`${GRAPH}/${igId}/media`, null, {
      params: { image_url: imagePublicUrl, caption, access_token: token },
      timeout: 30000,
    });
    creationId = r.data.id;
    if (!creationId) throw new Error('IG não retornou creation_id.');
  } catch (err) {
    const fbErr = err.response?.data?.error;
    throw new Error(fbErr ? `IG/media: ${fbErr.message} (code ${fbErr.code})` : `IG/media: ${err.message}`);
  }

  // Etapa 1.5: aguarda container estar pronto (Instagram precisa processar a imagem)
  // Sem isso: code 9007 "Media ID is not available" pois o container ainda não está FINISHED
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const s = await axios.get(`${GRAPH}/${creationId}`, {
        params: { fields: 'status_code', access_token: token },
        timeout: 10000,
      });
      const sc = s.data?.status_code;
      if (sc === 'FINISHED') break;
      if (sc === 'ERROR' || sc === 'EXPIRED') throw new Error(`IG container inválido: ${sc}`);
    } catch (err) {
      if (err.message.startsWith('IG container')) throw err;
    }
  }

  // Etapa 2: publica o container
  let mediaId;
  try {
    const r = await axios.post(`${GRAPH}/${igId}/media_publish`, null, {
      params: { creation_id: creationId, access_token: token },
      timeout: 30000,
    });
    mediaId = r.data.id;
  } catch (err) {
    const fbErr = err.response?.data?.error;
    // Rate limit (code 4 etc.): a Meta pode ter publicado mesmo retornando erro.
    // Verifica antes de declarar falha — evita falso negativo e republicação duplicada.
    if (ehRateLimit(fbErr)) {
      await new Promise(r => setTimeout(r, 6000));
      const achou = await verificarPublicacaoRecente(igId, token, caption);
      if (achou) {
        console.warn(`[instagram] code ${fbErr.code} no publish, mas post CONFIRMADO no IG: ${achou.post_id}`);
        return { ok: true, post_id: achou.post_id, post_url: achou.post_url, rate_limited: true };
      }
    }
    throw new Error(fbErr ? `IG/publish: ${fbErr.message} (code ${fbErr.code})` : `IG/publish: ${err.message}`);
  }

  // Tenta pegar o permalink (URL pública do post)
  let post_url = null;
  try {
    const r = await axios.get(`${GRAPH}/${mediaId}`, {
      params: { fields: 'permalink', access_token: token },
      timeout: 10000,
    });
    post_url = r.data?.permalink || null;
  } catch { /* opcional, ignora */ }

  return { ok: true, post_id: mediaId, post_url };
}

// ─── Publicar imagem no STORY do Instagram ──────────────────────────────────
// site: { instagram_business_account_id, facebook_page_token (decrypted) }
// imagePublicUrl: URL HTTPS pública do card (mesmo do feed)
// Story não tem caption nem link clicável via API — só a imagem.
async function publicarStory(site, imagePublicUrl) {
  if (!site.instagram_business_account_id) {
    throw new Error('Instagram Business Account não configurado para este site.');
  }
  if (!site.facebook_page_token) {
    throw new Error('Page Access Token ausente.');
  }
  if (!imagePublicUrl || !/^https:\/\//.test(imagePublicUrl)) {
    throw new Error('Instagram exige imagem em URL HTTPS pública.');
  }

  const igId  = site.instagram_business_account_id;
  const token = site.facebook_page_token;

  // Etapa 1: container de mídia do tipo STORIES
  let creationId;
  try {
    const r = await axios.post(`${GRAPH}/${igId}/media`, null, {
      params: { image_url: imagePublicUrl, media_type: 'STORIES', access_token: token },
      timeout: 30000,
    });
    creationId = r.data.id;
    if (!creationId) throw new Error('IG não retornou creation_id (story).');
  } catch (err) {
    const fbErr = err.response?.data?.error;
    throw new Error(fbErr ? `IG/story-media: ${fbErr.message} (code ${fbErr.code})` : `IG/story-media: ${err.message}`);
  }

  // Etapa 1.5: aguarda o container ficar FINISHED (mesmo polling do feed)
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const s = await axios.get(`${GRAPH}/${creationId}`, {
        params: { fields: 'status_code', access_token: token },
        timeout: 10000,
      });
      const sc = s.data?.status_code;
      if (sc === 'FINISHED') break;
      if (sc === 'ERROR' || sc === 'EXPIRED') throw new Error(`IG story container inválido: ${sc}`);
    } catch (err) {
      if (err.message.startsWith('IG story container')) throw err;
    }
  }

  // Etapa 2: publica
  try {
    const r = await axios.post(`${GRAPH}/${igId}/media_publish`, null, {
      params: { creation_id: creationId, access_token: token },
      timeout: 30000,
    });
    return { ok: true, post_id: r.data.id };
  } catch (err) {
    const fbErr = err.response?.data?.error;
    throw new Error(fbErr ? `IG/story-publish: ${fbErr.message} (code ${fbErr.code})` : `IG/story-publish: ${err.message}`);
  }
}

module.exports = { descobrirIgBusinessAccount, publicar, publicarStory };
