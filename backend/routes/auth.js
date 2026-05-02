'use strict';

const express = require('express');
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const pool    = require('../db/connection');
const auth    = require('../middleware/auth');

const router = express.Router();

const JWT_EXPIRES = '7d';

// ── POST /api/auth/login ───────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
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

    // Gera JWT
    const payload = {
      id:       subscriber.id,
      email:    subscriber.email,
      plan_id:  subscriber.plan_id,
      is_admin: subscriber.is_admin || false,
    };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: JWT_EXPIRES });

    res.json({
      token,
      subscriber: {
        id:       subscriber.id,
        name:     subscriber.name,
        email:    subscriber.email,
        ai_prompt: subscriber.ai_prompt,
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

module.exports = router;
