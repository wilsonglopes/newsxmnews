'use strict';

const express = require('express');
const { notifyAdmin } = require('../utils/telegram-notify');

const router = express.Router();

// Rate limit simples em memória: máx 3 envios por IP a cada 10 min (anti-spam)
const envios = new Map(); // ip -> [timestamps]
const JANELA_MS = 10 * 60 * 1000;
const MAX_ENVIOS = 3;

setInterval(() => {
  const agora = Date.now();
  for (const [ip, ts] of envios) {
    const recentes = ts.filter(t => agora - t < JANELA_MS);
    if (recentes.length) envios.set(ip, recentes); else envios.delete(ip);
  }
}, JANELA_MS);

// POST /api/contato — recebe formulário da landing e envia ao Telegram do admin
router.post('/', async (req, res) => {
  const { nome, email, telefone, portal, mensagem, website } = req.body || {};

  // Honeypot: campo "website" é invisível no form; se vier preenchido, é bot
  if (website) return res.json({ ok: true }); // finge sucesso e ignora

  if (!nome || !nome.trim()) return res.status(400).json({ error: 'Informe seu nome.' });
  if (!email && !telefone)   return res.status(400).json({ error: 'Informe e-mail ou telefone para contato.' });

  // Rate limit por IP
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'desconhecido';
  const agora = Date.now();
  const lista = (envios.get(ip) || []).filter(t => agora - t < JANELA_MS);
  if (lista.length >= MAX_ENVIOS) {
    return res.status(429).json({ error: 'Muitos envios. Tente novamente em alguns minutos.' });
  }
  lista.push(agora);
  envios.set(ip, lista);

  // Monta a mensagem para o Telegram (plain text — sem Markdown para evitar quebra)
  const linhas = [
    '🔔 NOVO CONTATO — scatto.site',
    '',
    `👤 Nome: ${nome.trim()}`,
    email    ? `✉️ E-mail: ${String(email).trim()}`     : null,
    telefone ? `📱 Telefone: ${String(telefone).trim()}` : null,
    portal   ? `🌐 Portal: ${String(portal).trim()}`     : null,
    mensagem ? `\n💬 Mensagem:\n${String(mensagem).trim()}` : null,
  ].filter(Boolean).join('\n');

  try {
    await notifyAdmin(linhas, { parse_mode: undefined });
    res.json({ ok: true });
  } catch (err) {
    console.error('[contato]', err.message);
    // Mesmo se o Telegram falhar, não expõe erro ao visitante
    res.json({ ok: true });
  }
});

module.exports = router;
