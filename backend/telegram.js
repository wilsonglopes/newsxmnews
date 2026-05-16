'use strict';

const TelegramBot            = require('node-telegram-bot-api');
const axios                  = require('axios');
const https                  = require('https');
const pool                   = require('./db/connection');
const { publishToWordPress } = require('./connectors/wordpress');

const HTTPS_AGENT = new https.Agent({ rejectUnauthorized: false });

// ─── Sessões (em memória) ─────────────────────────────────────────────────────
/*
  Estrutura da sessão:
  {
    texts[], imageUrls[], createdAt,      ← acumulação
    step,                                 ← 'acumulando' | 'escolhendo_site' | 'escolhendo_categoria' | 'confirmando'
    pendingArticle,                       ← artigo gerado aguardando confirmação
    sites[],                              ← sites disponíveis do reporter
    selectedSite,                         ← site escolhido
    categorias[],                         ← categorias do WP
    catOffset,                            ← paginação de categorias
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
      step: 'acumulando', pendingArticle: null,
      sites: [], selectedSite: null,
      categorias: [], catOffset: 0,
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

// ─── WordPress ────────────────────────────────────────────────────────────────

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
  if (!process.env.GEMINI_KEY) throw new Error('Chave Gemini não configurada.');
  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_KEY}`,
    {
      contents: [{
        role: 'user',
        parts: [
          { inline_data: { mime_type: mimeType, data: buffer.toString('base64') } },
          { text: 'Transcreva este áudio com fidelidade. Retorne apenas o texto transcrito, sem comentários.' },
        ],
      }],
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
  );
  return resp.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

async function gerarArtigo(briefing, aiPrompt) {
  const provider = process.env.AI_PROVIDER || 'gemini';
  const sys = aiPrompt ||
    `Você é um jornalista profissional. Com base no briefing (textos, transcrições de áudio, descrições de fotos), escreva um artigo jornalístico completo.
Retorne SOMENTE um JSON:
{ "chapeu": string(máx 2 palavras MAIÚSCULAS), "titulo": string(máx 90 chars), "resumo": string(máx 160 chars, termine com ponto), "corpo": string(HTML ≥4 parágrafos em <p>), "tags": string[] }`;

  let txt = '';
  if (provider === 'deepseek') {
    const r = await axios.post('https://api.deepseek.com/chat/completions',
      { model: 'deepseek-chat', messages: [{ role: 'system', content: sys }, { role: 'user', content: `BRIEFING:\n${briefing}` }], max_tokens: 4096, response_format: { type: 'json_object' } },
      { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_KEY}` }, timeout: 60000 });
    txt = r.data?.choices?.[0]?.message?.content || '';
  } else {
    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_KEY}`,
      { system_instruction: { parts: [{ text: sys }] }, contents: [{ role: 'user', parts: [{ text: `BRIEFING:\n${briefing}` }] }], generationConfig: { maxOutputTokens: 4096 } },
      { headers: { 'Content-Type': 'application/json' }, timeout: 60000 });
    txt = r.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  if (!txt) throw new Error('Resposta vazia da IA.');
  const r = extrairJSON(txt);
  if (!r) throw new Error('IA não retornou JSON válido.');
  return {
    title: r.titulo || r.title || '', chapeu: r.chapeu || '',
    summary: r.resumo || r.summary || '', body: r.corpo || r.body || '',
    tags: r.tags || [], category_ids: [],
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
            COALESCE(sc.post_format,     ss.post_format)      AS post_format
     FROM subscriber_sites ss
     LEFT JOIN sites_catalog sc ON sc.id = ss.site_id
     WHERE ss.subscriber_id = $1 AND ss.active = true`,
    [subscriberId]
  );
  return rows;
}

// ─── Teclados inline ──────────────────────────────────────────────────────────

function teclado_sites(sites) {
  return {
    inline_keyboard: sites.map(s => ([{ text: s.site_name, callback_data: `s:${s.id}` }])),
  };
}

function teclado_categorias(cats, offset) {
  const pagina  = cats.slice(offset, offset + CATS_POR_PAG);
  const buttons = pagina.map(c => [{ text: c.name, callback_data: `c:${c.id}` }]);
  const nav = [];
  if (offset > 0)                          nav.push({ text: '⬅ Anterior', callback_data: `cm:${offset - CATS_POR_PAG}` });
  if (offset + CATS_POR_PAG < cats.length) nav.push({ text: 'Próximas ➡', callback_data: `cm:${offset + CATS_POR_PAG}` });
  if (nav.length) buttons.push(nav);
  buttons.push([{ text: '— Sem categoria —', callback_data: 'c:0' }]);
  return { inline_keyboard: buttons };
}

function teclado_confirmacao() {
  return {
    inline_keyboard: [[
      { text: '✅ Publicar', callback_data: 'pub' },
      { text: '❌ Cancelar', callback_data: 'can' },
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

      await bot.sendMessage(chatId, 'Gerando artigo...');

      const aiPrompt     = reporter.ai_prompt || '';
      s.pendingArticle   = await gerarArtigo(s.texts.join('\n\n'), aiPrompt);
      s.sites            = await buscarSites(reporter.id);

      if (!s.sites.length) {
        return bot.sendMessage(chatId, 'Você não tem nenhum site configurado. Contate o administrador.');
      }

      // Envia prévia
      await bot.sendMessage(chatId, textoPrevia(s.pendingArticle), { parse_mode: 'Markdown' });

      // Se só tem 1 site, pula seleção de site
      if (s.sites.length === 1) {
        s.selectedSite = s.sites[0];
        return await passarParaCategorias(bot, chatId, s);
      }

      s.step = 'escolhendo_site';
      return bot.sendMessage(chatId, 'Onde deseja publicar?', { reply_markup: teclado_sites(s.sites) });
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

async function passarParaCategorias(bot, chatId, s) {
  s.categorias = await buscarCategorias(s.selectedSite);
  s.catOffset  = 0;

  if (!s.categorias.length) {
    // Sem categorias — vai direto para confirmação
    return passarParaConfirmacao(bot, chatId, s, null);
  }

  s.step = 'escolhendo_categoria';
  return bot.sendMessage(chatId,
    `Site: *${s.selectedSite.site_name}*\n\nEscolha a categoria:`,
    { parse_mode: 'Markdown', reply_markup: teclado_categorias(s.categorias, 0) }
  );
}

async function passarParaConfirmacao(bot, chatId, s, categoriaId) {
  if (categoriaId) s.pendingArticle.category_ids = [categoriaId];

  const catNome = categoriaId
    ? (s.categorias.find(c => c.id === categoriaId)?.name || '')
    : 'Sem categoria';

  s.step = 'confirmando';
  return bot.sendMessage(chatId,
    `Tudo pronto!\n\n*${s.pendingArticle.title}*\nSite: ${s.selectedSite.site_name}\nCategoria: ${catNome}\n\nDeseja publicar?`,
    { parse_mode: 'Markdown', reply_markup: teclado_confirmacao() }
  );
}

async function processarCallback(bot, query) {
  const chatId = query.message.chat.id;
  const data   = query.data;

  await bot.answerCallbackQuery(query.id);

  const reporter = await buscarReporter(chatId);
  if (!reporter) return;

  const s = getSessao(chatId);
  if (!s.pendingArticle) return bot.sendMessage(chatId, 'Sessão expirada. Envie "gere" novamente.');

  // ── Escolha de site ───────────────────────────────────────────────────────
  if (data.startsWith('s:')) {
    const siteId = data.slice(2);
    s.selectedSite = s.sites.find(x => x.id === siteId);
    if (!s.selectedSite) return bot.sendMessage(chatId, 'Site não encontrado.');
    return passarParaCategorias(bot, chatId, s);
  }

  // ── Paginação de categorias ───────────────────────────────────────────────
  if (data.startsWith('cm:')) {
    s.catOffset = parseInt(data.slice(3));
    return bot.editMessageReplyMarkup(
      teclado_categorias(s.categorias, s.catOffset),
      { chat_id: chatId, message_id: query.message.message_id }
    );
  }

  // ── Escolha de categoria ──────────────────────────────────────────────────
  if (data.startsWith('c:')) {
    const catId = parseInt(data.slice(2)) || null;
    return passarParaConfirmacao(bot, chatId, s, catId);
  }

  // ── Publicar ──────────────────────────────────────────────────────────────
  if (data === 'pub') {
    await bot.sendMessage(chatId, 'Publicando...');
    try {
      const imageUrl  = s.imageUrls[0] || null;
      const resultado = await publishToWordPress(s.selectedSite, s.pendingArticle, { external_url: null, image_url: imageUrl });

      // Grava no histórico de publicações do reporter
      try {
        const tagsStr = (s.pendingArticle.tags || []).join(', ') || null;
        await pool.query(
          `INSERT INTO article_drafts
             (subscriber_id, article_id, chapeu, title, summary, body, tags,
              article_title, article_source, article_image_url, article_external_url, external_post_url)
           VALUES ($1, NULL, $2, $3, $4, $5, $6, '', '📱 Telegram', $7, '', $8)`,
          [
            reporter.id,
            s.pendingArticle.chapeu   || '',
            s.pendingArticle.title    || '',
            s.pendingArticle.summary  || '',
            s.pendingArticle.body     || '',
            tagsStr || '',
            imageUrl || '',
            resultado.post_url || '',
          ]
        );
      } catch (dbErr) {
        console.warn('[TELEGRAM] Falha ao gravar histórico:', dbErr.message);
      }

      limparSessao(chatId);
      await bot.sendMessage(chatId,
        `Publicado!\n\n${s.pendingArticle.title}\n\n${resultado.post_url || ''}`,
        { parse_mode: 'Markdown' }
      );
      console.log(`[TELEGRAM] Publicado por ${reporter.name}: "${s.pendingArticle.title}" → ${resultado.post_url}`);
    } catch (err) {
      console.error('[TELEGRAM] Erro ao publicar:', err.message);
      bot.sendMessage(chatId, `Erro ao publicar: ${err.message}`);
    }
    return;
  }

  // ── Cancelar ──────────────────────────────────────────────────────────────
  if (data === 'can') {
    limparSessao(chatId);
    return bot.sendMessage(chatId, 'Publicação cancelada. Cobertura descartada.');
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
