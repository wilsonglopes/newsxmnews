'use strict';

const TelegramBot            = require('node-telegram-bot-api');
const axios                  = require('axios');
const https                  = require('https');
const pool                   = require('./db/connection');
const { publishToWordPress } = require('./connectors/wordpress');
const { gerarCard }          = require('./utils/card-generator');
const { publicarFoto }       = require('./connectors/facebook');
const { decryptToken }       = require('./connectors/encrypt');

const HTTPS_AGENT = new https.Agent({ rejectUnauthorized: false });

// ─── Sessões (em memória) ─────────────────────────────────────────────────────
/*
  Estrutura da sessão (multi-portal):
  {
    texts[], imageUrls[], createdAt,        ← acumulação
    step,                                   ← 'acumulando' | 'escolhendo_sites'
                                            | 'config_categoria' | 'config_facebook'
                                            | 'confirmando_tudo'
    sites[],                                ← todos os sites do reporter (carregados ao "gere")
    selectedSiteIds: Set,                   ← sites selecionados pelo reporter
    pendingByPortal: {                      ← config gerada por portal
      [siteId]: {
        site,                               ← objeto do site (cache p/ publicar)
        article,                            ← { chapeu, title, summary, body, tags, category_ids }
        categoria,                          ← { id, name } | null
        facebookEnabled,                    ← bool (default true se site.facebook_enabled)
        categorias,                         ← cache das categorias WP do portal
        catOffset,                          ← paginação de categorias
      }
    },
    cursorPortal: siteId | null,            ← qual portal está sendo configurado
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
      sites: [], selectedSiteIds: new Set(),
      pendingByPortal: {},
      cursorPortal: null,
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
            COALESCE(sc.post_format,     ss.post_format)      AS post_format,
            COALESCE(sc.facebook_enabled, false)              AS facebook_enabled,
            sc.facebook_page_id, sc.facebook_page_token
     FROM subscriber_sites ss
     LEFT JOIN sites_catalog sc ON sc.id = ss.site_id
     WHERE ss.subscriber_id = $1 AND ss.active = true`,
    [subscriberId]
  );
  return rows;
}

// ─── Teclados inline ──────────────────────────────────────────────────────────

function teclado_sites_multi(sites, selectedIds) {
  // Cada site: ☑/☐ no início. Botão "Confirmar" no final
  const buttons = sites.map(s => {
    const marcado = selectedIds.has(s.id);
    const marca   = marcado ? '☑' : '☐';
    const fb      = s.facebook_enabled ? ' 📘' : '';
    return [{ text: `${marca} ${s.site_name}${fb}`, callback_data: `toggle:${s.id}` }];
  });
  buttons.push([{ text: '✅ Confirmar seleção', callback_data: 'sites_done' }]);
  buttons.push([{ text: '❌ Cancelar', callback_data: 'cancel' }]);
  return { inline_keyboard: buttons };
}

function teclado_categorias(cats, offset, siteId) {
  const pagina  = cats.slice(offset, offset + CATS_POR_PAG);
  const buttons = pagina.map(c => [{ text: c.name, callback_data: `cat:${siteId}:${c.id}` }]);
  const nav = [];
  if (offset > 0)                          nav.push({ text: '⬅ Anterior', callback_data: `catpg:${siteId}:${offset - CATS_POR_PAG}` });
  if (offset + CATS_POR_PAG < cats.length) nav.push({ text: 'Próximas ➡', callback_data: `catpg:${siteId}:${offset + CATS_POR_PAG}` });
  if (nav.length) buttons.push(nav);
  buttons.push([{ text: '— Sem categoria —', callback_data: `cat:${siteId}:0` }]);
  return { inline_keyboard: buttons };
}

function teclado_facebook(siteId) {
  return {
    inline_keyboard: [[
      { text: '📘 Sim, postar no Facebook', callback_data: `fb:${siteId}:1` },
      { text: '🚫 Não, só WordPress',        callback_data: `fb:${siteId}:0` },
    ]],
  };
}

function teclado_confirmacao_final() {
  return {
    inline_keyboard: [[
      { text: '✅ Publicar tudo', callback_data: 'pub_all' },
      { text: '❌ Cancelar',      callback_data: 'cancel'  },
    ]],
  };
}

function textoPrevia(artigo) {
  const corpo = stripHtml(artigo.body).substring(0, 250);
  return `*${artigo.title}*\n\n_${artigo.summary}_\n\n${corpo}${corpo.length >= 250 ? '...' : ''}`;
}

function escapeMd(s) {
  return String(s || '').replace(/([_*[\]()~`>#+=|{}.!-])/g, '\\$1');
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
      s.pendingByPortal = {};
      s.selectedSiteIds = new Set();

      // Se só tem 1 site, pula a seleção e marca direto
      if (sites.length === 1) {
        s.selectedSiteIds.add(sites[0].id);
        await bot.sendMessage(chatId, `📰 Portal: *${sites[0].site_name}*. Gerando...`, { parse_mode: 'Markdown' });
        return await gerarParaTodosPortais(bot, chatId, s, reporter);
      }

      s.step = 'escolhendo_sites';
      return bot.sendMessage(chatId,
        '📰 Em qual(is) portal(is) deseja publicar?\n_Marque os portais e clique em Confirmar. Portais com 📘 publicam também no Facebook._',
        { parse_mode: 'Markdown', reply_markup: teclado_sites_multi(sites, s.selectedSiteIds) }
      );
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

// ─── Geração: roda IA pra cada portal selecionado ───────────────────────────

async function gerarParaTodosPortais(bot, chatId, s, reporter) {
  const briefing = s.texts.join('\n\n');
  const selecionados = s.sites.filter(site => s.selectedSiteIds.has(site.id));

  for (const site of selecionados) {
    try {
      await bot.sendMessage(chatId, `⚙️ Gerando para *${escapeMd(site.site_name)}*...`, { parse_mode: 'MarkdownV2' });
      const aiPrompt = site.ai_prompt || reporter.ai_prompt || '';
      const article  = await gerarArtigo(briefing, aiPrompt);
      s.pendingByPortal[site.id] = {
        site,
        article,
        categoria: null,
        facebookEnabled: site.facebook_enabled === true, // default: postar se site permite
        categorias: [],
        catOffset: 0,
      };
      await bot.sendMessage(chatId, textoPrevia(article), { parse_mode: 'Markdown' });
    } catch (err) {
      console.error(`[TELEGRAM] Falha ao gerar para ${site.site_name}: ${err.message}`);
      await bot.sendMessage(chatId, `❌ Falha ao gerar para *${site.site_name}*: ${err.message}\n\nEsse portal será removido da publicação.`, { parse_mode: 'Markdown' });
      s.selectedSiteIds.delete(site.id);
    }
  }

  if (!s.selectedSiteIds.size) {
    return bot.sendMessage(chatId, 'Nenhum portal pôde ser processado. Sessão encerrada.');
  }

  // Pega o primeiro portal pra começar a configurar categoria
  return await configurarProximoPortal(bot, chatId, s);
}

// ─── Loop de configuração por portal: categoria → facebook → próximo ────────

async function configurarProximoPortal(bot, chatId, s) {
  // Encontra o próximo portal SEM categoria definida
  const portaisPendentesCat = [...s.selectedSiteIds].filter(id => !s.pendingByPortal[id]?.categoria);
  if (portaisPendentesCat.length > 0) {
    const siteId = portaisPendentesCat[0];
    return await perguntarCategoria(bot, chatId, s, siteId);
  }

  // Todos têm categoria — verifica se algum portal com FB ainda precisa decidir
  const portaisPendentesFB = [...s.selectedSiteIds].filter(id => {
    const p = s.pendingByPortal[id];
    return p?.site?.facebook_enabled && p?.facebookEnabled === undefined;
  });
  if (portaisPendentesFB.length > 0) {
    const siteId = portaisPendentesFB[0];
    return await perguntarFacebook(bot, chatId, s, siteId);
  }

  // Tudo configurado — mostra resumo final
  return await mostrarResumoFinal(bot, chatId, s);
}

async function perguntarCategoria(bot, chatId, s, siteId) {
  const p = s.pendingByPortal[siteId];
  if (!p.categorias.length) {
    p.categorias = await buscarCategorias(p.site);
  }
  s.cursorPortal = siteId;
  s.step = 'config_categoria';

  if (!p.categorias.length) {
    // Sem categorias do WP — segue sem
    p.categoria = { id: 0, name: 'Sem categoria' };
    return await configurarProximoPortal(bot, chatId, s);
  }

  return bot.sendMessage(chatId,
    `🗂 Categoria para *${p.site.site_name}*:`,
    { parse_mode: 'Markdown', reply_markup: teclado_categorias(p.categorias, 0, siteId) }
  );
}

async function perguntarFacebook(bot, chatId, s, siteId) {
  const p = s.pendingByPortal[siteId];
  s.cursorPortal = siteId;
  s.step = 'config_facebook';
  return bot.sendMessage(chatId,
    `📘 Publicar também no Facebook para *${p.site.site_name}*?`,
    { parse_mode: 'Markdown', reply_markup: teclado_facebook(siteId) }
  );
}

async function mostrarResumoFinal(bot, chatId, s) {
  s.step = 'confirmando_tudo';
  const linhas = ['📋 *Tudo pronto:*', ''];
  for (const id of s.selectedSiteIds) {
    const p = s.pendingByPortal[id];
    const cat = p.categoria?.name || 'Sem categoria';
    const fb  = (p.site.facebook_enabled && p.facebookEnabled) ? ' + 📘 Facebook' : '';
    linhas.push(`• ${p.site.site_name} → ${cat}${fb}`);
  }
  linhas.push('', 'Confirma todas as publicações?');
  return bot.sendMessage(chatId, linhas.join('\n'),
    { parse_mode: 'Markdown', reply_markup: teclado_confirmacao_final() });
}

// ─── Publicação ──────────────────────────────────────────────────────────────

async function publicarTudo(bot, chatId, s, reporter) {
  await bot.sendMessage(chatId, '⏳ Publicando em todos os portais...');
  const resultados = [];

  for (const id of s.selectedSiteIds) {
    const p = s.pendingByPortal[id];
    const site = p.site;
    try {
      // Aplica categoria escolhida
      if (p.categoria && p.categoria.id) p.article.category_ids = [p.categoria.id];

      const imageUrl  = s.imageUrls[0] || null;
      const resultado = await publishToWordPress(site, p.article, { external_url: null, image_url: imageUrl });
      const linha = { site: site.site_name, ok: true, url: resultado.post_url };

      // Grava histórico
      try {
        const tagsStr = (p.article.tags || []).join(', ') || null;
        await pool.query(
          `INSERT INTO article_drafts
             (subscriber_id, article_id, chapeu, title, summary, body, tags,
              article_title, article_source, article_image_url, article_external_url, external_post_url)
           VALUES ($1, NULL, $2, $3, $4, $5, $6, '', '📱 Telegram', $7, '', $8)`,
          [
            reporter.id,
            p.article.chapeu || '', p.article.title || '', p.article.summary || '',
            p.article.body || '', tagsStr || '', imageUrl || '', resultado.post_url || '',
          ]
        );
      } catch (dbErr) { console.warn('[TELEGRAM] Falha no histórico:', dbErr.message); }

      // Facebook (se configurado E o reporter marcou)
      if (p.site.facebook_enabled && p.facebookEnabled && p.site.facebook_page_id && p.site.facebook_page_token) {
        try {
          const cardBuffer = await gerarCard({
            chapeu:   p.article.chapeu || '',
            resumo:   p.article.summary || '',
            imageUrl: imageUrl || '',
          });
          const fb = await publicarFoto(
            { facebook_page_id: p.site.facebook_page_id, facebook_page_token: decryptToken(p.site.facebook_page_token) },
            cardBuffer,
            { chapeu: p.article.chapeu, title: p.article.title, summary: p.article.summary, post_url: resultado.post_url }
          );
          linha.fbUrl = fb.post_url;
          console.log(`[TELEGRAM/FB] ✓ ${site.site_name}: ${fb.post_url}`);
        } catch (fbErr) {
          linha.fbError = fbErr.message;
          console.error(`[TELEGRAM/FB] ✗ ${site.site_name}: ${fbErr.message}`);
        }
      }

      resultados.push(linha);
      console.log(`[TELEGRAM] ✓ ${reporter.name} → ${site.site_name}: ${resultado.post_url}`);
    } catch (err) {
      console.error(`[TELEGRAM] ✗ ${site.site_name}: ${err.message}`);
      resultados.push({ site: site.site_name, ok: false, error: err.message });
    }
  }

  // Monta mensagem final
  const linhas = ['📰 *Resultado das publicações:*', ''];
  for (const r of resultados) {
    if (r.ok) {
      linhas.push(`✓ ${r.site}: ${r.url}`);
      if (r.fbUrl)   linhas.push(`  📘 Facebook: ${r.fbUrl}`);
      if (r.fbError) linhas.push(`  📘 Facebook falhou: ${r.fbError}`);
    } else {
      linhas.push(`✗ ${r.site}: ${r.error}`);
    }
  }
  await bot.sendMessage(chatId, linhas.join('\n'), { parse_mode: 'Markdown', disable_web_page_preview: true });
  limparSessao(chatId);
}

// ─── Callbacks ──────────────────────────────────────────────────────────────

async function processarCallback(bot, query) {
  const chatId = query.message.chat.id;
  const data   = query.data;

  await bot.answerCallbackQuery(query.id);

  const reporter = await buscarReporter(chatId);
  if (!reporter) return;

  const s = getSessao(chatId);

  // ── Cancelar (qualquer etapa) ────────────────────────────────────────────
  if (data === 'cancel') {
    limparSessao(chatId);
    return bot.sendMessage(chatId, 'Sessão cancelada. Toda a cobertura foi descartada.');
  }

  // ── Toggle de portal na multi-seleção ────────────────────────────────────
  if (data.startsWith('toggle:')) {
    const siteId = data.slice(7);
    if (s.selectedSiteIds.has(siteId)) s.selectedSiteIds.delete(siteId);
    else                                s.selectedSiteIds.add(siteId);
    try {
      await bot.editMessageReplyMarkup(
        teclado_sites_multi(s.sites, s.selectedSiteIds),
        { chat_id: chatId, message_id: query.message.message_id }
      );
    } catch (e) { /* mensagem talvez antiga */ }
    return;
  }

  // ── Confirmar seleção de sites → gerar artigos ───────────────────────────
  if (data === 'sites_done') {
    if (!s.selectedSiteIds.size) {
      return bot.sendMessage(chatId, 'Selecione ao menos um portal antes de continuar.');
    }
    return await gerarParaTodosPortais(bot, chatId, s, reporter);
  }

  // ── Paginação de categorias ──────────────────────────────────────────────
  if (data.startsWith('catpg:')) {
    const [, siteId, offsetStr] = data.split(':');
    const p = s.pendingByPortal[siteId];
    if (!p) return;
    p.catOffset = parseInt(offsetStr);
    return bot.editMessageReplyMarkup(
      teclado_categorias(p.categorias, p.catOffset, siteId),
      { chat_id: chatId, message_id: query.message.message_id }
    );
  }

  // ── Escolha de categoria ─────────────────────────────────────────────────
  if (data.startsWith('cat:')) {
    const [, siteId, catIdStr] = data.split(':');
    const catId = parseInt(catIdStr) || 0;
    const p = s.pendingByPortal[siteId];
    if (!p) return;
    if (catId === 0) {
      p.categoria = { id: 0, name: 'Sem categoria' };
    } else {
      const cat = p.categorias.find(c => c.id === catId);
      p.categoria = cat || { id: catId, name: `Categoria ${catId}` };
    }
    return await configurarProximoPortal(bot, chatId, s);
  }

  // ── Decisão de Facebook por portal ───────────────────────────────────────
  if (data.startsWith('fb:')) {
    const [, siteId, decisaoStr] = data.split(':');
    const p = s.pendingByPortal[siteId];
    if (!p) return;
    p.facebookEnabled = decisaoStr === '1';
    return await configurarProximoPortal(bot, chatId, s);
  }

  // ── Confirmar publicação geral ───────────────────────────────────────────
  if (data === 'pub_all') {
    return await publicarTudo(bot, chatId, s, reporter);
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
