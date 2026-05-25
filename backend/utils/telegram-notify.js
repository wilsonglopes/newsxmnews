'use strict';

/**
 * Helper de notificação Telegram para o admin/operador do sistema.
 *
 * Uso:
 *   const { notifyAdmin } = require('./utils/telegram-notify');
 *   await notifyAdmin('⚠️ Fonte *Criciúma* sem artigos há 6h');
 *
 * Requer no .env:
 *   TELEGRAM_TOKEN=<token do bot>
 *   MONITOR_CHAT_ID=<chat_id do admin — obter via @userinfobot no Telegram>
 *
 * Nunca lança exceção — falha silenciosamente com log de warning.
 */

const axios = require('axios');

/**
 * Envia mensagem para o chat do admin.
 * Suporta Markdown (negrito com *texto*, código com `backtick`).
 *
 * @param {string} text    - Mensagem (máx 4096 chars; truncada automaticamente)
 * @param {object} [opts]  - Opções extras para a API sendMessage
 */
async function notifyAdmin(text, opts = {}) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.MONITOR_CHAT_ID;

  if (!token || !chatId) return; // monitor não configurado — ignora silenciosamente

  try {
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        chat_id:    chatId,
        text:       String(text).slice(0, 4096),
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        ...opts,
      },
      { timeout: 10000 }
    );
  } catch (e) {
    // Não propagamos o erro — notificação é best-effort
    console.warn('[NOTIFY] Falha ao enviar alerta Telegram:', e.message);
  }
}

/**
 * Versão segura para mensagens que podem conter caracteres especiais do Markdown.
 * Escapa os caracteres que quebram o parse_mode Markdown v1.
 *
 * @param {string} text
 */
async function notifyAdminEscaped(text) {
  // Markdown v1 do Telegram: escapar apenas [ ] ( ) ~ > # + - = | { } . !
  // mas esses raramente causam problema; o maior risco é ` e *
  // Usamos parse_mode omitido (plain text) para máxima segurança
  await notifyAdmin(text, { parse_mode: undefined });
}

module.exports = { notifyAdmin, notifyAdminEscaped };
