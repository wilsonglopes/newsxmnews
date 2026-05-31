'use strict';

const express = require('express');
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const pool    = require('../db/connection');
const auth    = require('../middleware/auth');

const router = express.Router();

const JWT_EXPIRES = '7d';

// ── Rate limiting de login (em memória) ───────────────────────────────────────
// Estrutura: Map<ip, { attempts: number, blockedUntil: number|null, firstAttempt: number }>
const loginAttempts = new Map();
const MAX_ATTEMPTS  = 10;        // tentativas antes de bloquear
const WINDOW_MS     = 15 * 60 * 1000; // janela de 15 minutos
const BLOCK_MS      = 15 * 60 * 1000; // bloqueio de 15 minutos

// Limpa entradas antigas a cada hora para não vazar memória
setInterval(() => {
  const agora = Date.now();
  for (const [ip, entry] of loginAttempts) {
    const expirado = entry.blockedUntil
      ? agora > entry.blockedUntil
      : agora - entry.firstAttempt > WINDOW_MS;
    if (expirado) loginAttempts.delete(ip);
  }
}, 60 * 60 * 1000);

function verificarRateLimit(req, res) {
  const ip   = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const agora = Date.now();
  const entry = loginAttempts.get(ip) || { attempts: 0, blockedUntil: null, firstAttempt: agora };

  // Ainda bloqueado?
  if (entry.blockedUntil && agora < entry.blockedUntil) {
    const restanteSeg = Math.ceil((entry.blockedUntil - agora) / 1000);
    res.status(429).json({ error: `Muitas tentativas. Aguarde ${restanteSeg}s para tentar novamente.` });
    return false;
  }

  // Janela expirou — reinicia contagem
  if (agora - entry.firstAttempt > WINDOW_MS) {
    loginAttempts.set(ip, { attempts: 1, blockedUntil: null, firstAttempt: agora });
    return true;
  }

  // Incrementa tentativa
  entry.attempts += 1;
  if (entry.attempts >= MAX_ATTEMPTS) {
    entry.blockedUntil = agora + BLOCK_MS;
    console.warn(`[auth] IP bloqueado por brute-force: ${ip} (${entry.attempts} tentativas)`);
  }
  loginAttempts.set(ip, entry);
  return true;
}

// ── POST /api/auth/login ───────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  if (!verificarRateLimit(req, res)) return;

  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Email e senha são obrigatórios.' });
  }

  try {
    // Busca assinante pelo email
    const { rows } = await pool.query(
      `SELECT s.*, s.is_admin, p.name AS plan_name, p.max_sources, p.max_publications_per_month, p.max_sites
       FROM subscribers s
       LEFT JOIN plans p ON p.id = s.plan_id
       WHERE s.email = $1 AND s.active = true`,
      [email.toLowerCase().trim()]
    );

    const subscriber = rows[0];
    if (!subscriber) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    // Verifica senha
    const senhaOk = await bcrypt.compare(password, subscriber.password_hash);
    if (!senhaOk) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    // Busca sites do assinante
    const { rows: sites } = await pool.query(
      `SELECT id, name, platform, site_url, active FROM subscriber_sites
       WHERE subscriber_id = $1 AND active = true`,
      [subscriber.id]
    );

    // Login bem-sucedido — limpa contador de tentativas do IP
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    loginAttempts.delete(ip);

    // Gera JWT
    const payload = {
      id:          subscriber.id,
      email:       subscriber.email,
      plan_id:     subscriber.plan_id,
      is_admin:    subscriber.is_admin || false,
      is_readonly: subscriber.is_readonly || false,
    };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: JWT_EXPIRES });

    res.json({
      token,
      subscriber: {
        id:       subscriber.id,
        name:     subscriber.name,
        email:    subscriber.email,
        ai_prompt: subscriber.ai_prompt,
        is_admin:    subscriber.is_admin || false,
        is_readonly: subscriber.is_readonly || false,
        plan: {
          id:                        subscriber.plan_id,
          name:                      subscriber.plan_name,
          max_sources:               subscriber.max_sources,
          max_publications_per_month: subscriber.max_publications_per_month,
          max_sites:                 subscriber.max_sites
        },
        plan_expires_at: subscriber.plan_expires_at,
        plan_value: subscriber.plan_value,
        gemini_key: subscriber.gemini_key,
        sites
      }
    });
  } catch (err) {
    console.error('[auth/login]', err.message);
    res.status(500).json({ error: 'Erro interno ao autenticar.' });
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
router.post('/logout', auth, (req, res) => {
  // JWT é stateless — apenas confirmamos o logout no cliente
  res.json({ ok: true, message: 'Logout realizado.' });
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
router.get('/me', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.name, s.email, s.ai_prompt, s.plan_expires_at, s.active,
              s.phone, s.address,
              p.id AS plan_id, p.name AS plan_name,
              p.max_sources, p.max_publications_per_month, p.max_sites
       FROM subscribers s
       LEFT JOIN plans p ON p.id = s.plan_id
       WHERE s.id = $1`,
      [req.subscriber.id]
    );

    const subscriber = rows[0];
    if (!subscriber) {
      return res.status(404).json({ error: 'Assinante não encontrado.' });
    }

    const { rows: sites } = await pool.query(
      `SELECT id, name, platform, site_url, active FROM subscriber_sites
       WHERE subscriber_id = $1 AND active = true`,
      [subscriber.id]
    );

    res.json({
      id:        subscriber.id,
      name:      subscriber.name,
      email:     subscriber.email,
      phone:     subscriber.phone,
      address:   subscriber.address,
      ai_prompt: subscriber.ai_prompt,
      active:    subscriber.active,
      plan: {
        id:                        subscriber.plan_id,
        name:                      subscriber.plan_name,
        max_sources:               subscriber.max_sources,
        max_publications_per_month: subscriber.max_publications_per_month,
        max_sites:                 subscriber.max_sites
      },
      plan_expires_at: subscriber.plan_expires_at,
      sites
    });
  } catch (err) {
    console.error('[auth/me]', err.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ── PATCH /api/auth/profile — atualiza nome, telefone, endereço ───────────────
router.patch('/profile', auth, async (req, res) => {
  const { name, phone, address } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nome é obrigatório.' });
  try {
    // Garante que as colunas existam (migration idempotente)
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='subscribers' AND column_name='phone')
          THEN ALTER TABLE subscribers ADD COLUMN phone VARCHAR(30); END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='subscribers' AND column_name='address')
          THEN ALTER TABLE subscribers ADD COLUMN address TEXT; END IF;
      END $$;
    `);
    await pool.query(
      `UPDATE subscribers SET name=$1, phone=$2, address=$3 WHERE id=$4`,
      [name.trim(), phone?.trim() || null, address?.trim() || null, req.subscriber.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[auth/profile]', err.message);
    res.status(500).json({ error: 'Erro ao salvar perfil.' });
  }
});

module.exports = router;
