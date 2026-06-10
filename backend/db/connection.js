'use strict';

const { Pool } = require('pg');

// SSL só é necessário para conexões remotas (Supabase, RDS, etc.)
// Para PostgreSQL local (Docker) não usa SSL
const isLocal = (process.env.DATABASE_URL || '').includes('localhost') ||
                (process.env.DATABASE_URL || '').includes('127.0.0.1');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  // Limites explícitos — web + worker da fila + crons compartilham este pool.
  // PostgreSQL local default aceita 100 conexões; 20 deixa folga para psql/backup.
  max: 20,
  idleTimeoutMillis: 30000,       // libera conexão ociosa após 30s
  connectionTimeoutMillis: 10000, // erro claro se esgotar o pool (em vez de travar para sempre)
});

pool.on('error', (err) => {
  console.error('[DB] Erro inesperado no pool:', err.message);
});

module.exports = pool;
