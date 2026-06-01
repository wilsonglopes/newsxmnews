'use strict';

const TelegramBot            = require('node-telegram-bot-api');
const axios                  = require('axios');
const FormData               = require('form-data');
const https                  = require('https');
const pool                   = require('./db/connection');
const { publishToWordPress } = require('./connectors/wordpress');
const { gerarCard, gerarCardComUrl } = require('./utils/card-generator');
const { publicarFoto }       = require('./connectors/facebook');
const { publicar: publicarInstagram } = require('./connectors/instagram');
const { decryptToken }       = require('./connectors/encrypt');

const HTTPS_AGENT = new https.Agent({ rejectUnauthorized: false });

// ─── Sentence case inteligente ────────────────────────────────────────────────
// Converte para sentence case preservando:
//   - Siglas em MAIÚSCULO (PRF, EUA, SC, COVID-19, SP-001)
//   - Nomes próprios: a IA é instruída a mantê-los com inicial maiúscula;
//     aqui apenas forçamos minúsculo nas stopwords e confiamos no restante.
//   - Primeira palavra: sempre com inicial maiúscula.

const STOPWORDS_PT = new Set([
  'o','a','os','as','um','uma','uns','umas',
  'de','do','da','dos','das','em','no','na','nos','nas',
  'por','pela','pelo','pelas','pelos',
  'com','para','que','e','ou','mas','se',
  'ao','à','aos','às','até','após','ante','sobre',
  'sob','entre','sem','contra','desde','durante','como',
]);

/**
 * Aplica sentence case ao título preservando siglas e nomes próprios.
 * Sigla: token ≥2 chars, todo em maiúsculo (ex: PRF, EUA, COVID-19).
 * Nome próprio: a IA é instruída a retornar sentence case; aqui confiamos
 * na capitalização que ela usou para palavras que não são stopwords.
 */
function sentenceCasePtBR(titulo) {
  if (!titulo) return '';
  const tokens = titulo.split(/(\s+)/);
  let isFirst = true;
  return tokens.map(tok => {
    if (/^\s+$/.test(tok)) return tok; // preserva espaços

    // Sigla: ≥2 chars, tudo maiúsculo, contém ao menos uma letra
    if (tok.length >= 2 && tok === tok.toUpperCase() && /[A-ZÁÉÍÓÚÀÂÊÔÃÕÇÜÝ]/.test(tok)) {
      if (isFirst) isFirst = false;
      return tok;
    }

    if (isFirst) {
      isFirst = false;
      // Primeira palavra: força inicial maiúscula, restante como a IA enviou
      return tok.charAt(0).toUpperCase() + tok.slice(1);
    }

    // Stopwords do português: sempre minúsculo no meio da frase
    if (STOPWORDS_PT.has(tok.toLowerCase())) return tok.toLowerCase();

    // Demais palavras: respeita o que a IA retornou
    // (IA é instruída a usar sentence case → palavras comuns virão em minúsculo;
    //  nomes próprios virão com inicial maiúscula → mantidos aqui)
    return tok;
  }).join('');
}

// ─── Sessões (em memória) ─────────────────────────────────────────────────────
/*
  Estrutura da sessão (single-portal):
  {
    texts[], imageUrls[], createdAt,      ← acumulação
    step,                                 ← 'acumulando' | 'escolhendo_site'
                                          | 'escolhendo_categoria' | 'escolhendo_fb'
                                          | 'confirmando'
    sites[],                              ← sites disponíveis (carregados ao "gere")
    selectedSite,                         ← site escolhido (objeto)
    pendingArticle,                       ← artigo gerado aguardando confirmação
    categorias[],                         ← cache categorias WP do site escolhido
    catOffset,                            ← paginação
    publishToFacebook,                    ← bool (definido após pergunta de FB)
  }
*/
const sessoes = new Map();
const GATILHOS   = /\b(gere|gerar|publica|publicar|gera)\b/i;
const CATS_POR_PAG = 8;
const SESSAO_TTL = 4 * 60 * 60 * 1000;

function getSessao(chatId) {
  if (!sessoes.has(chatId)) {
    sessoes.set(chatId, {
      texts: [], imageUrls: [], createdAt: Date.now(),
      step: 'acumulando',
      sites: [], selectedSite: null, pendingArticle: null,
      categorias: [], catOffset: 0,
      publishToFacebook: false,
    });
  }
  return sessoes.get(chatId);
}

function limparSessao(chatId) { sessoes.delete(chatId); }

setInterval(() => {
  const agora = Date.now();
  for (const [id, s] of sessoes) {
    if (agora - s.createdAt > SESSAO_TTL) sessoes.delete(id);
  }
}, 60 * 60 * 1000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extrairJSON(texto) {
  const m = texto.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function resumoSessao(s) {
  const p = [];
  if (s.texts.length)     p.push(`${s.texts.length} texto(s)/áudio(s)`);
  if (s.imageUrls.length) p.push(`${s.imageUrls.length} foto(s)`);
  return p.length ? `Cobertura atual: ${p.join(', ')}.` : 'Cobertura vazia.';
}

function stripHtml(html) {
  return (html || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// ─── WordPress (categorias) ──────────────────────────────────────────────────

async function buscarCategorias(site) {
  const base = (site.site_url || '').replace(/\/$/, '');
  try {
    const r = await axios.get(`${base}/wp-json/wp/v2/categories?per_page=100&orderby=count&order=desc`, {
      timeout: 10000, httpsAgent: HTTPS_AGENT, headers: {},
    });
    return (r.data || []).map(c => ({ id: c.id, name: c.name }));
  } catch {
    return [];
  }
}

// ─── IA ───────────────────────────────────────────────────────────────────────

async function transcreverAudio(buffer, mimeType) {
  const key = process.env.OPENAI_KEY || '';
  if (!key) throw new Error('Chave OpenAI não configurada. Por favor, envie o texto digitado.');

  const form = new FormData();
  form.append('file', buffer, { filename: 'audio.ogg', contentType: mimeType || 'audio/ogg' });
  form.append('model', 'whisper-1');
  form.append('language', 'pt');

  const resp = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
    headers: { Authorization: `Bearer ${key}`, ...form.getHeaders() },
    timeout: 60000,
  });
  return resp.data?.text?.trim() || '';
}

async function gerarArtigo(briefing, aiPrompt) {
  const sys = aiPrompt ||
    `Você é um jornalista profissional. Com base no briefing (textos, transcrições de áudio, descrições de fotos), escreva um artigo jornalístico completo.
Retorne SOMENTE um JSON:
{ "chapeu": string(EXATAMENTE 1 palavra MAIÚSCULA autossuficiente como categoria, ex: "ECONOMIA", "POLÍTICA", "ESPORTES", "INDÚSTRIA", "SAÚDE". NUNCA use frases truncadas como "INDÚSTRIA DE"), "titulo": string(máx 90 chars, use sentence case: apenas a primeira palavra com inicial maiúscula; nomes próprios de pessoas, cidades e organizações mantêm inicial maiúscula; siglas ficam em MAIÚSCULO COMPLETO como PRF, EUA, SC, COVID), "resumo": string(uma frase única curta e completa, máx 130 chars, OBRIGATORIAMENTE terminando com ponto final), "corpo": string(HTML ≥4 parágrafos em <p>), "tags": string[] }`;

  const resp = await axios.post('https://api.deepseek.com/chat/completions',
    { model: 'deepseek-chat', messages: [{ role: 'system', content: sys }, { role: 'user', content: `BRIEFING:\n${briefing}` }], max_tokens: 4096, response_format: { type: 'json_object' } },
    { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_KEY}` }, timeout: 60000 });
  const txt = resp.data?.choices?.[0]?.message?.content || '';

  if (!txt) throw new Error('Resposta vazia da IA.');
  const resultado = extrairJSON(txt);
  if (!resultado) throw new Error('IA não retornou JSON válido.');
  const titulo = (resultado.titulo || resultado.title || '').trim();
  return {
    title: titulo,
    chapeu: resultado.chapeu || '',
    summary: resultado.resumo || resultado.summary || '', body: resultado.corpo || resultado.body || '',
    tags: resultado.tags || [], category_ids: [],
  };
}

// ─── Banco ────────────────────────────────────────────────────────────────────

async function buscarReporter(chatId) {
  const { rows } = await pool.query(
    `SELECT id, name, ai_prompt FROM subscribers WHERE telegram_chat_id = $1 AND active = true`,
    [chatId]
  );
  return rows[0] || null;
}

async function buscarSites(subscriberId) {
  const { rows } = await pool.query(
    `SELECT ss.id, COALESCE(ss.ai_prompt, sc.ai_prompt) AS ai_prompt, ss.default_category_id,
            COALESCE(sc.name,            ss.name)             AS site_name,
            COALESCE(sc.site_url,        ss.site_url)         AS site_url,
            COALESCE(sc.platform,        ss.platform)         AS platform,
            COALESCE(sc.xixo_api_key,    ss.xixo_api_key)     AS xixo_api_key,
            COALESCE(sc.wp_username,     ss.wp_username)      AS wp_username,
            COALESCE(sc.wp_app_password, ss.wp_app_password)  AS wp_app_password,
            COALESCE(sc.post_format,     ss.post_format)      AS post_format,
            COALESCE(sc.facebook_enabled, false)              AS facebook_enabled,
            sc.facebook_page_id, sc.facebook_page_token,
            COALESCE(sc.instagram_enabled, false)             AS instagram_enabled,
            sc.instagram_business_account_id, sc.instagram_username,
            sc.social_config
     FROM subscriber_sites ss
     LEFT JOIN sites_catalog sc ON sc.id = ss.site_id
     WHERE ss.subscriber_id = $1 AND ss.active = true`,
    [subscriberId]
  );
  return rows;
}

// ─── Teclados inline ──────────────────────────────────────────────────────────

function teclado_sites(sites) {
  const buttons = sites.map(s => ([{
    text: `${s.site_name}${s.facebook_enabled ? ' 📘' : ''}`,
    callback_data: `s:${s.id}`,
  }]));
  buttons.push([{ text: '❌ Cancelar', callback_data: 'cancel' }]);
  return { inline_keyboard: buttons };
}

function teclado_categorias(cats, offset) {
  const pagina  = cats.slice(offset, offset + CATS_POR_PAG);
  const buttons = pagina.map(c => [{ text: c.name, callback_data: `c:${c.id}` }]);
  const nav = [];
  if (offset > 0)                          nav.push({ text: '⬅ Anterior', callback_data: `cm:${offset - CATS_POR_PAG}` });
  if (offset + CATS_POR_PAG < cats.length) nav.push({ text: 'Próximas ➡', callback_data: `cm:${offset + CATS_POR_PAG}` });
  if (nav.length) buttons.push(nav);
  buttons.push([{ text: '— Sem categoria —', callback_data: 'c:0' }]);
  buttons.push([{ text: '❌ Cancelar', callback_data: 'cancel' }]);
  return { inline_keyboard: buttons };
}

function teclado_facebook() {
  return {
    inline_keyboard: [
      [
        { text: '📘 Sim, postar no Facebook', callback_data: 'fb:1' },
        { text: '🚫 Não, só no site',          callback_data: 'fb:0' },
      ],
      [{ text: '❌ Cancelar', callback_data: 'cancel' }],
    ],
  };
}

function teclado_confirmacao() {
  return {
    inline_keyboard: [[
      { text: '✅ Publicar', callback_data: 'pub' },
      { text: '❌ Cancelar', callback_data: 'cancel' },
    ]],
  };
}

function textoPrevia(artigo) {
  const corpo = stripHtml(artigo.body).substring(0, 300);
  return `*${artigo.title}*\n\n_${artigo.summary}_\n\n${corpo}${corpo.length >= 300 ? '...' : ''}`;
}

// ─── Fluxo principal ──────────────────────────────────────────────────────────

async function processarMensagem(bot, msg) {
  const chatId = msg.chat.id;
  try {
    const reporter = await buscarReporter(chatId);
    if (!reporter) {
      return bot.sendMessage(chatId,
        'Seu Telegram não está vinculado a nenhuma conta.\nUse /start para ver seu ID e peça ao administrador para ativar.'
      );
    }

    const s = getSessao(chatId);

    // ── Gatilho de geração ────────────────────────────────────────────────────
    if (msg.text && GATILHOS.test(msg.text)) {
      if (!s.texts.length && !s.imageUrls.length) {
        return bot.sendMessage(chatId, 'Nenhum conteúdo acumulado. Envie textos, áudios ou fotos antes de gerar.');
      }

      const sites = await buscarSites(reporter.id);
      if (!sites.length) {
        return bot.sendMessage(chatId, 'Você não tem nenhum site configurado. Contate o administrador.');
      }
      s.sites = sites;

      // Se só tem 1 site, pula seleção
      if (sites.length === 1) {
        s.selectedSite = sites[0];
        return await gerarEPedirCategoria(bot, chatId, s, reporter);
      }

      s.step = 'escolhendo_site';
      return bot.sendMessage(chatId, '📰 Em qual portal deseja publicar?', {
        reply_markup: teclado_sites(sites)
      });
    }

    // ── Foto ──────────────────────────────────────────────────────────────────
    if (msg.photo) {
      const foto     = msg.photo[msg.photo.length - 1];
      const fileInfo = await bot.getFile(foto.file_id);
      s.imageUrls.push(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`);
      if (msg.caption?.trim()) s.texts.push(`[Legenda]: ${msg.caption.trim()}`);
      return bot.sendMessage(chatId, `Foto salva. ${resumoSessao(s)}\n\nQuando terminar, envie "gere".`);
    }

    // ── Áudio / voz ───────────────────────────────────────────────────────────
    if (msg.voice || msg.audio) {
      const file     = msg.voice || msg.audio;
      const fileInfo = await bot.getFile(file.file_id);
      const fileUrl  = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
      await bot.sendMessage(chatId, 'Transcrevendo áudio...');
      const buf         = Buffer.from((await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 30000 })).data);
      const transcricao = await transcreverAudio(buf, file.mime_type || 'audio/ogg');
      if (!transcricao) return bot.sendMessage(chatId, 'Não consegui transcrever o áudio. Tente novamente.');
      s.texts.push(`[Áudio]: ${transcricao}`);
      const preview = transcricao.length > 200 ? transcricao.substring(0, 200) + '...' : transcricao;
      return bot.sendMessage(chatId, `Áudio transcrito:\n"${preview}"\n\n${resumoSessao(s)}\n\nQuando terminar, envie "gere".`);
    }

    // ── Texto ─────────────────────────────────────────────────────────────────
    if (msg.text) {
      s.texts.push(msg.text.trim());
      return bot.sendMessage(chatId, `Texto recebido. ${resumoSessao(s)}\n\nQuando terminar, envie "gere".`);
    }

    bot.sendMessage(chatId, 'Tipo de mensagem não suportado. Envie texto, foto ou áudio.');

  } catch (err) {
    console.error('[TELEGRAM] Erro:', err.message);
    bot.sendMessage(chatId, `Erro: ${err.message}`);
  }
}

// ─── Etapas do fluxo ────────────────────────────────────────────────────────

async function gerarEPedirCategoria(bot, chatId, s, reporter) {
  const site = s.selectedSite;
  await bot.sendMessage(chatId, `⚙️ Gerando matéria para "${site.site_name}"...`);

  try {
    const aiPrompt = site.ai_prompt || reporter.ai_prompt || '';
    s.pendingArticle = await gerarArtigo(s.texts.join('\n\n'), aiPrompt);
  } catch (err) {
    limparSessao(chatId);
    return bot.sendMessage(chatId, `❌ Falha ao gerar: ${err.message}`);
  }

  // Mostra prévia
  await bot.sendMessage(chatId, textoPrevia(s.pendingArticle), { parse_mode: 'Markdown' });

  // Carrega e pergunta categoria
  s.categorias = await buscarCategorias(site);
  s.catOffset  = 0;
  s.step       = 'escolhendo_categoria';

  if (!s.categorias.length) {
    // Sem categorias — segue direto pro Facebook ou confirmação
    return await proximaEtapaAposCategoria(bot, chatId, s);
  }

  return bot.sendMessage(chatId,
    `🗂 Escolha a categoria para "${site.site_name}":`,
    { reply_markup: teclado_categorias(s.categorias, 0) }
  );
}

async function proximaEtapaAposCategoria(bot, chatId, s) {
  // Só pergunta sobre FB/IG se o site tem configuração E há imagem (sem imagem o card fica vazio)
  if (s.selectedSite.facebook_enabled && s.selectedSite.facebook_page_id && s.selectedSite.facebook_page_token && s.imageUrls.length > 0) {
    s.step = 'escolhendo_fb';
    const temIG = s.selectedSite.instagram_enabled && s.selectedSite.instagram_business_account_id;
    const igTxt = temIG ? ' + Instagram 📷' : '';
    return bot.sendMessage(chatId,
      `📘 Publicar também no Facebook${igTxt} da página "${s.selectedSite.site_name}"?`,
      { reply_markup: teclado_facebook() }
    );
  }
  return await mostrarConfirmacao(bot, chatId, s);
}

async function mostrarConfirmacao(bot, chatId, s) {
  s.step = 'confirmando';
  const catNome = s.pendingArticle.category_ids?.length
    ? (s.categorias.find(c => c.id === s.pendingArticle.category_ids[0])?.name || 'Categoria escolhida')
    : 'Sem categoria';
  const fbInfo = s.selectedSite.facebook_enabled
    ? (s.publishToFacebook ? '✓ + Facebook 📘' : '(sem Facebook)')
    : '';

  return bot.sendMessage(chatId,
    `📋 Tudo pronto!\n\n*${s.pendingArticle.title}*\n\nSite: ${s.selectedSite.site_name}\nCategoria: ${catNome}\n${fbInfo}\n\nConfirmar publicação?`,
    { parse_mode: 'Markdown', reply_markup: teclado_confirmacao() }
  );
}

// ─── Publicação ──────────────────────────────────────────────────────────────

async function publicar(bot, chatId, s, reporter) {
  await bot.sendMessage(chatId, '⏳ Publicando...');
  const site = s.selectedSite;
  const article = s.pendingArticle;
  const imageUrl  = s.imageUrls[0] || null;

  let resultado;
  try {
    resultado = await publishToWordPress(site, article, { external_url: null, image_url: imageUrl });
  } catch (err) {
    console.error('[TELEGRAM] Erro ao publicar:', err.message);
    return bot.sendMessage(chatId, `❌ Erro ao publicar: ${err.message}`);
  }

  // Grava no histórico
  try {
    const tagsStr = (article.tags || []).join(', ') || null;
    await pool.query(
      `INSERT INTO article_drafts
         (subscriber_id, article_id, chapeu, title, summary, body, tags,
          article_title, article_source, article_image_url, article_external_url, external_post_url)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, '', '📱 Telegram', $7, '', $8)`,
      [
        reporter.id,
        article.chapeu || '', article.title || '', article.summary || '',
        article.body || '', tagsStr || '', imageUrl || '', resultado.post_url || '',
      ]
    );
  } catch (dbErr) { console.warn('[TELEGRAM] histórico:', dbErr.message); }

  // Facebook + Instagram (se reporter aceitou e há imagem)
  // Sem imagem o card fica com fundo vazio — não publicar.
  let fbInfo = '';
  if (!imageUrl && s.publishToFacebook) {
    fbInfo = '\n⚠️ Sem imagem — Facebook/Instagram não publicados.';
  }
  if (s.publishToFacebook && imageUrl && site.facebook_enabled && site.facebook_page_id && site.facebook_page_token) {
    const querPostarIG = site.instagram_enabled && site.instagram_business_account_id;
    const pageToken    = decryptToken(site.facebook_page_token);

    // Gera card; se for postar no IG, salva em disco também (precisa URL pública)
    const socialConfig = site.social_config || {};
    let cardBuffer, cardPublicUrl;
    try {
      if (querPostarIG) {
        const r = await gerarCardComUrl({
          chapeu:     article.chapeu || '',
          titulo:     article.title  || '',
          imageUrl:   imageUrl || '',
          cardConfig: socialConfig,
        });
        cardBuffer    = r.buffer;
        cardPublicUrl = r.publicUrl;
      } else {
        cardBuffer = await gerarCard({
          chapeu:     article.chapeu || '',
          titulo:     article.title  || '',
          imageUrl:   imageUrl || '',
          cardConfig: socialConfig,
        });
      }
    } catch (cardErr) {
      fbInfo = `\n📘 Falha ao gerar card: ${cardErr.message}`;
      cardBuffer = null;
    }

    // Facebook
    if (cardBuffer) {
      try {
        const fb = await publicarFoto(
          { facebook_page_id: site.facebook_page_id, facebook_page_token: pageToken },
          cardBuffer,
          { chapeu: article.chapeu, title: article.title, summary: article.summary, post_url: resultado.post_url, captionConfig: socialConfig }
        );
        fbInfo = `\n📘 Facebook: ${fb.post_url || 'OK'}`;
        console.log(`[TELEGRAM/FB] ✓ ${site.site_name}: ${fb.post_url}`);
      } catch (fbErr) {
        fbInfo = `\n📘 Facebook falhou: ${fbErr.message}`;
        console.error(`[TELEGRAM/FB] ✗ ${site.site_name}: ${fbErr.message}`);
      }
    }

    // Instagram
    if (querPostarIG && cardPublicUrl) {
      try {
        const ig = await publicarInstagram(
          {
            instagram_business_account_id: site.instagram_business_account_id,
            facebook_page_token: pageToken,
          },
          cardPublicUrl,
          { chapeu: article.chapeu, title: article.title, summary: article.summary, post_url: resultado.post_url }
        );
        fbInfo += `\n📷 Instagram: ${ig.post_url || 'OK'}`;
        console.log(`[TELEGRAM/IG] ✓ ${site.site_name}: ${ig.post_url}`);
      } catch (igErr) {
        fbInfo += `\n📷 Instagram falhou: ${igErr.message}`;
        console.error(`[TELEGRAM/IG] ✗ ${site.site_name}: ${igErr.message}`);
      }
    }
  }

  console.log(`[TELEGRAM] ✓ ${reporter.name} → ${site.site_name}: ${resultado.post_url}`);
  limparSessao(chatId);
  return bot.sendMessage(chatId,
    `✅ Publicado!\n\n${article.title}\n\n${resultado.post_url || ''}${fbInfo}`,
    { disable_web_page_preview: false }
  );
}

// ─── Callbacks ──────────────────────────────────────────────────────────────

async function processarCallback(bot, query) {
  const chatId = query.message.chat.id;
  const data   = query.data;

  await bot.answerCallbackQuery(query.id);

  const reporter = await buscarReporter(chatId);
  if (!reporter) return;

  const s = getSessao(chatId);

  // ── Cancelar ──────────────────────────────────────────────────────────────
  if (data === 'cancel') {
    limparSessao(chatId);
    return bot.sendMessage(chatId, '❌ Cancelado. Sessão descartada.');
  }

  // ── Escolha de site ──────────────────────────────────────────────────────
  if (data.startsWith('s:')) {
    const siteId = data.slice(2);
    const site = s.sites.find(x => x.id === siteId);
    if (!site) return bot.sendMessage(chatId, 'Site não encontrado. Use "gere" novamente.');
    s.selectedSite = site;
    return await gerarEPedirCategoria(bot, chatId, s, reporter);
  }

  // ── Paginação de categorias ──────────────────────────────────────────────
  if (data.startsWith('cm:')) {
    s.catOffset = parseInt(data.slice(3));
    return bot.editMessageReplyMarkup(
      teclado_categorias(s.categorias, s.catOffset),
      { chat_id: chatId, message_id: query.message.message_id }
    );
  }

  // ── Escolha de categoria ─────────────────────────────────────────────────
  if (data.startsWith('c:')) {
    if (!s.pendingArticle) return bot.sendMessage(chatId, 'Sessão sem matéria. Envie "gere" novamente.');
    const catId = parseInt(data.slice(2)) || 0;
    s.pendingArticle.category_ids = catId ? [catId] : [];
    return await proximaEtapaAposCategoria(bot, chatId, s);
  }

  // ── Decisão de Facebook ──────────────────────────────────────────────────
  if (data.startsWith('fb:')) {
    s.publishToFacebook = data === 'fb:1';
    return await mostrarConfirmacao(bot, chatId, s);
  }

  // ── Publicar ──────────────────────────────────────────────────────────────
  if (data === 'pub') {
    return await publicar(bot, chatId, s, reporter);
  }
}

// ─── Inicialização ────────────────────────────────────────────────────────────

function iniciarBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log('[TELEGRAM] TELEGRAM_BOT_TOKEN não configurado — bot desativado.');
    return null;
  }

  const bot = new TelegramBot(token, { polling: true });

  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id,
      `Olá! Seu ID do Telegram é:\n\n${msg.chat.id}\n\nInforme esse número ao administrador para vincular sua conta.`
    );
  });

  bot.onText(/\/cancelar/, (msg) => {
    limparSessao(msg.chat.id);
    bot.sendMessage(msg.chat.id, 'Cobertura cancelada. Tudo apagado.');
  });

  bot.onText(/\/vincular(?:\s+(\S+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const codigo = (match[1] || '').trim().toUpperCase();
    if (!codigo) {
      return bot.sendMessage(chatId, 'Use: /vincular CODIGO\n\nO código é gerado no painel do sistema → aba Configurações → seção Telegram.');
    }
    try {
      const { rows } = await pool.query(
        `SELECT id, name FROM subscribers
         WHERE telegram_link_code = $1
           AND telegram_link_expires_at > NOW()
           AND active = true`,
        [codigo]
      );
      if (!rows.length) {
        return bot.sendMessage(chatId, '❌ Código inválido ou expirado.\n\nGere um novo código no painel → Configurações → Telegram.');
      }
      const sub = rows[0];
      await pool.query(
        `UPDATE subscribers
         SET telegram_chat_id = $1, telegram_link_code = NULL, telegram_link_expires_at = NULL
         WHERE id = $2`,
        [chatId, sub.id]
      );
      bot.sendMessage(chatId, `✅ Conta vinculada com sucesso!\n\nOlá, *${sub.name}*! Agora pode enviar textos, fotos e áudios para coberturas. Use "gere" quando quiser publicar.`, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('[TELEGRAM] /vincular erro:', err.message);
      bot.sendMessage(chatId, 'Erro ao vincular. Tente novamente.');
    }
  });

  bot.onText(/\/status/, (msg) => {
    const s = sessoes.get(msg.chat.id);
    bot.sendMessage(msg.chat.id, s ? resumoSessao(s) : 'Nenhuma cobertura em andamento.');
  });

  bot.on('message', (msg) => {
    if (msg.text?.startsWith('/')) return;
    processarMensagem(bot, msg).catch(err =>
      console.error('[TELEGRAM] Erro não tratado:', err.message)
    );
  });

  bot.on('callback_query', (query) => {
    processarCallback(bot, query).catch(err =>
      console.error('[TELEGRAM] Callback error:', err.message)
    );
  });

  bot.on('polling_error', (err) => console.error('[TELEGRAM] Polling error:', err.message));

  console.log('[TELEGRAM] Bot iniciado (polling).');
  return bot;
}

module.exports = { iniciarBot };
