'use strict';

const jwt  = require('jsonwebtoken');
const pool = require('../db/connection');

/**
 * Middleware de autenticação para rotas admin.
 * Verifica JWT + flag is_admin no banco.
 */
module.exports = async function adminAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Token não fornecido.' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.subscriber = payload;

    // Verifica is_admin no banco
    const { rows } = await pool.query(
      'SELECT is_admin FROM subscribers WHERE id = $1 AND active = true',
      [payload.id]
    );

    if (!rows[0] || !rows[0].is_admin) {
      return res.status(403).json({ error: 'Acesso negado. Requer perfil administrador.' });
    }

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido ou expirado.' });
  }
};
