'use strict';

const crypto = require('crypto');

const ALGO      = 'aes-256-gcm';
const KEY_HEX   = (process.env.ENCRYPTION_KEY || '').padEnd(64, '0').slice(0, 64);
const KEY_BUF   = Buffer.from(KEY_HEX, 'hex');

function encryptToken(plain) {
  if (!plain) return plain;
  const iv         = crypto.randomBytes(12);
  const cipher     = crypto.createCipheriv(ALGO, KEY_BUF, iv);
  const encrypted  = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag    = cipher.getAuthTag();
  // formato: iv(24)+authTag(32)+ciphertext — tudo hex
  return iv.toString('hex') + authTag.toString('hex') + encrypted.toString('hex');
}

function decryptToken(ciphertext) {
  if (!ciphertext) return ciphertext;
  // Se não tiver o tamanho mínimo assume que não foi criptografado (plain text legado)
  if (ciphertext.length < 56) return ciphertext;
  try {
    const iv        = Buffer.from(ciphertext.slice(0, 24),  'hex');
    const authTag   = Buffer.from(ciphertext.slice(24, 56), 'hex');
    const encrypted = Buffer.from(ciphertext.slice(56),     'hex');
    const decipher  = crypto.createDecipheriv(ALGO, KEY_BUF, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(encrypted) + decipher.final('utf8');
  } catch {
    return ciphertext; // fallback: retorna como está
  }
}

module.exports = { encryptToken, decryptToken };
