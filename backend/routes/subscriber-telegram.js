'use strict';

const express = require('express');
const pool    = require('../db/connection');
const auth    = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// Caracteres sem ambiguidade (sem 0/O, 1/I/L)
const CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function gerarCodigo() {
  let c = '';
  for (let i = 0; i < 6; i++) c += CHARS[Math.floor(Math.random() * CHARS.length)];
  return c;
}

// POST /api/subscriber/telegram-link — gera código temporário de vinculação
router.post('/telegram-link', async (req, res) => {
  const subscriberId = req.subscriber.id;
  try {
    const code    = gerarCodigo();
    const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutos

    await pool.query(
      `UPDATE subscribers SET telegram_link_code = $1, telegram_link_expires_at = $2 WHERE id = $3`,
      [code, expires, subscriberId]
    );

    // Retorna também o status atual de vinculação
    const { rows } = await pool.query(
      `SELECT telegram_chat_id FROM subscribers WHERE id = $1`,
      [subscriberId]
    );

    res.json({ code, expires_at: expires.toISOString(), already_linked: !!rows[0]?.telegram_chat_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/subscriber/telegram-link — desvincula o Telegram
router.delete('/telegram-link', async (req, res) => {
  try {
    await pool.query(
      `UPDATE subscribers SET telegram_chat_id = NULL, telegram_link_code = NULL, telegram_link_expires_at = NULL WHERE id = $1`,
      [req.subscriber.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/subscriber/telegram-link — retorna status atual
router.get('/telegram-link', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT telegram_chat_id FROM subscribers WHERE id = $1`,
      [req.subscriber.id]
    );
    res.json({ linked: !!rows[0]?.telegram_chat_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
