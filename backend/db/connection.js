'use strict';

const { Pool } = require('pg');

// SSL só é necessário para conexões remotas (Supabase, RDS, etc.)
// Para PostgreSQL local (Docker) não usa SSL
const isLocal = (process.env.DATABASE_URL || '').includes('localhost') ||
                (process.env.DATABASE_URL || '').includes('127.0.0.1');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('[DB] Erro inesperado no pool:', err.message);
});

module.exports = pool;
