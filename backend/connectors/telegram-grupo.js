'use strict';

// 📨 Distribuição em GRUPO/CANAL do Telegram — compartilhada por todas as
// ferramentas (bot, Publicar, Criar Post, Autopublicação), igual ao WhatsApp.
// Usa o mesmo bot do sistema (TELEGRAM_BOT_TOKEN). O bot precisa estar no grupo
// (ou ser admin do canal). Config por portal: telegram_grupo_chat_id + enabled.

const axios = require('axios');
const pool  = require('../db/connection');

const API = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

// Migration idempotente (no load do módulo)
pool.query(`
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sites_catalog' AND column_name='telegram_grupo_chat_id')
      THEN ALTER TABLE sites_catalog ADD COLUMN telegram_grupo_chat_id TEXT; END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sites_catalog' AND column_name='telegram_grupo_enabled')
      THEN ALTER TABLE sites_catalog ADD COLUMN telegram_grupo_enabled BOOLEAN DEFAULT false; END IF;
  END $$;
`).catch(e => console.error('[telegram-grupo] migration:', e.message));

// Pronto para publicar = habilitado + tem chat_id + bot configurado
function telegramGrupoDisponivel(site) {
  return !!(site && site.telegram_grupo_enabled && site.telegram_grupo_chat_id && process.env.TELEGRAM_BOT_TOKEN);
}

// Legenda (Telegram aceita texto puro; emojis ajudam na leitura)
function montarLegenda({ chapeu, titulo, resumo, postUrl } = {}) {
  const p = [];
  if (chapeu) p.push(`📰 ${String(chapeu).toUpperCase()}`);
  if (titulo) p.push(titulo);
  if (resumo) p.push(resumo);
  if (postUrl) p.push(`🔗 ${postUrl}`);
  return p.join('\n\n');
}

// Publica no(s) grupo(s) do portal. Aceita vários chat_ids separados por vírgula.
// Com cardUrl: envia foto + legenda (caption máx 1024). Sem: texto (máx 4096).
async function publicarNoGrupo(site, { chapeu, titulo, resumo, postUrl, cardUrl } = {}) {
  if (!telegramGrupoDisponivel(site)) return { ok: 0, falhas: 0, total: 0, info: '' };

  const chatIds = String(site.telegram_grupo_chat_id).split(',').map(s => s.trim()).filter(Boolean);
  if (!chatIds.length) return { ok: 0, falhas: 0, total: 0, info: '📨 Telegram: nenhum grupo configurado.' };

  const legenda = montarLegenda({ chapeu, titulo, resumo, postUrl });
  const base = API();
  let ok = 0, falhas = 0;

  for (const chatId of chatIds) {
    try {
      if (cardUrl) {
        // Caption de foto tem limite de 1024 chars
        await axios.post(`${base}/sendPhoto`, {
          chat_id: chatId, photo: cardUrl, caption: legenda.slice(0, 1024),
        }, { timeout: 25000 });
      } else {
        await axios.post(`${base}/sendMessage`, {
          chat_id: chatId, text: legenda.slice(0, 4096), disable_web_page_preview: false,
        }, { timeout: 15000 });
      }
      ok++;
    } catch (err) {
      falhas++;
      console.error(`[TG-GRUPO] ✗ ${chatId}: ${err.response?.data?.description || err.message}`);
    }
  }
  const info = `📨 Telegram: ${ok} grupo(s)${falhas ? `, ${falhas} falha(s)` : ''} de ${chatIds.length}.`;
  return { ok, falhas, total: chatIds.length, info };
}

module.exports = { telegramGrupoDisponivel, publicarNoGrupo, montarLegenda };
