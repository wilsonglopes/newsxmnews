'use strict';

// Store efêmero de prévias da matéria (Telegram). Token → { artigo, expira }.
// Vive em memória; some no reinício (link expira, gera-se de novo). Sem banco.

const crypto = require('crypto');

const store = new Map();
const TTL = 30 * 60 * 1000; // 30 minutos

/** Cria/atualiza uma prévia e retorna o token. Se reusar o token, atualiza o conteúdo. */
function criar(artigo, tokenExistente = null) {
  const token = tokenExistente || crypto.randomBytes(8).toString('hex');
  store.set(token, { artigo, expira: Date.now() + TTL });
  return token;
}

/** Retorna o artigo da prévia ou null se inexistente/expirada. */
function obter(token) {
  const e = store.get(token);
  if (!e) return null;
  if (Date.now() > e.expira) { store.delete(token); return null; }
  return e.artigo;
}

// Limpeza periódica das prévias expiradas
setInterval(() => {
  const agora = Date.now();
  for (const [t, e] of store) if (agora > e.expira) store.delete(t);
}, 10 * 60 * 1000).unref?.();

module.exports = { criar, obter };
