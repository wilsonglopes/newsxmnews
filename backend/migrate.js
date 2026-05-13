'use strict';
require('dotenv').config();
const pool = require('./db/connection');

(async () => {
  try {
    await pool.query('ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS plan_value DECIMAL(10,2) DEFAULT 0');
    await pool.query('ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS gemini_key TEXT');

    // Autopublicação
    await pool.query('ALTER TABLE subscriber_sites ADD COLUMN IF NOT EXISTS auto_publish BOOLEAN DEFAULT false');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS autopub_log (
        article_id    UUID REFERENCES articles(id) ON DELETE CASCADE,
        site_id       UUID REFERENCES subscriber_sites(id) ON DELETE CASCADE,
        subscriber_id UUID,
        status        VARCHAR(20) NOT NULL DEFAULT 'ok',
        error_msg     TEXT,
        processed_at  TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (article_id, site_id)
      )
    `);
    // Regras por fonte: qual fonte alimenta qual site automaticamente
    await pool.query(`
      CREATE TABLE IF NOT EXISTS autopub_rules (
        site_id       UUID REFERENCES subscriber_sites(id) ON DELETE CASCADE,
        source_id     UUID REFERENCES sources(id) ON DELETE CASCADE,
        subscriber_id UUID,
        PRIMARY KEY (site_id, source_id)
      )
    `);

    // Colunas extras de publicação (adicionadas em versão anterior via publish.js)
    await pool.query('ALTER TABLE publications ADD COLUMN IF NOT EXISTS rewritten_chapeu TEXT');
    await pool.query('ALTER TABLE publications ADD COLUMN IF NOT EXISTS rewritten_summary TEXT');
    await pool.query('ALTER TABLE publications ADD COLUMN IF NOT EXISTS rewritten_tags TEXT');
    await pool.query('ALTER TABLE publications ADD COLUMN IF NOT EXISTS rewritten_categories TEXT');

    await pool.query('ALTER TABLE sources ADD COLUMN IF NOT EXISTS featured_image_selector TEXT');

    const r = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name IN ('subscribers','subscriber_sites','publications','autopub_log','sources')
        AND column_name IN ('plan_value','gemini_key','auto_publish','rewritten_chapeu','featured_image_selector')
    `);
    console.log('Colunas OK:', r.rows.map(x => x.column_name).join(', '));
    await pool.end();
    process.exit(0);
  } catch (e) {
    console.error('ERRO:', e.message);
    process.exit(1);
  }
})();
