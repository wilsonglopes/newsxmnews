'use strict';
require('dotenv').config();
const pool = require('./db/connection');

(async () => {
  try {
    await pool.query('ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS plan_value DECIMAL(10,2) DEFAULT 0');
    await pool.query('ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS gemini_key TEXT');
    const r = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='subscribers' AND column_name IN ('plan_value','gemini_key')");
    console.log('Colunas OK:', r.rows.map(x => x.column_name).join(', '));
    await pool.end();
    process.exit(0);
  } catch (e) {
    console.error('ERRO:', e.message);
    process.exit(1);
  }
})();
