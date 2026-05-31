'use strict';
require('dotenv').config();
const pool = require('./db/connection');

(async () => {
  try {
    await pool.query('ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS plan_value DECIMAL(10,2) DEFAULT 0');
    await pool.query('ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS gemini_key TEXT');
    await pool.query('ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS is_readonly BOOLEAN DEFAULT false');

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

    // ── Catálogo central de sites ─────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sites_catalog (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name            TEXT NOT NULL,
        platform        VARCHAR(30) NOT NULL DEFAULT 'wordpress',
        site_url        TEXT,
        xixo_api_key    TEXT,
        wp_username     TEXT,
        wp_app_password TEXT,
        blogger_blog_id TEXT,
        blogger_access_token  TEXT,
        blogger_refresh_token TEXT,
        webhook_url     TEXT,
        webhook_secret  TEXT,
        post_format     VARCHAR(20) DEFAULT 'editorial',
        active          BOOLEAN DEFAULT true,
        created_at      TIMESTAMPTZ DEFAULT now()
      )
    `);
    await pool.query(`
      ALTER TABLE subscriber_sites
        ADD COLUMN IF NOT EXISTS site_id UUID REFERENCES sites_catalog(id)
    `);

    // Migra dados existentes: para cada URL única, cria uma entrada no catálogo
    const { rows: pendentes } = await pool.query(
      `SELECT * FROM subscriber_sites WHERE site_id IS NULL ORDER BY created_at ASC`
    );
    if (pendentes.length) {
      // Agrupa por URL normalizada
      const porUrl = {};
      for (const s of pendentes) {
        const chave = (s.site_url || '').toLowerCase().replace(/\/$/, '') || `sem-url-${s.id}`;
        if (!porUrl[chave]) porUrl[chave] = [];
        porUrl[chave].push(s);
      }
      for (const grupo of Object.values(porUrl)) {
        // Prefere o registro com mais credenciais
        const melhor = grupo.sort((a, b) => {
          if (a.xixo_api_key && !b.xixo_api_key) return -1;
          if (!a.xixo_api_key && b.xixo_api_key) return 1;
          if (a.wp_username && !b.wp_username) return -1;
          if (!a.wp_username && b.wp_username) return 1;
          return 0;
        })[0];
        const { rows: cat } = await pool.query(
          `INSERT INTO sites_catalog
             (name, platform, site_url, xixo_api_key, wp_username, wp_app_password,
              blogger_blog_id, blogger_access_token, blogger_refresh_token,
              webhook_url, webhook_secret, post_format)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           RETURNING id`,
          [
            melhor.name || 'Site sem nome',
            melhor.platform || 'wordpress',
            melhor.site_url || null,
            melhor.xixo_api_key || null,
            melhor.wp_username || null,
            melhor.wp_app_password || null,
            melhor.blogger_blog_id || null,
            melhor.blogger_access_token || null,
            melhor.blogger_refresh_token || null,
            melhor.webhook_url || null,
            melhor.webhook_secret || null,
            melhor.post_format || 'editorial',
          ]
        );
        const catalogId = cat[0].id;
        for (const s of grupo) {
          await pool.query(
            `UPDATE subscriber_sites SET site_id = $1 WHERE id = $2`,
            [catalogId, s.id]
          );
        }
      }
      console.log(`Migração: ${Object.keys(porUrl).length} site(s) criados no catálogo.`);
    }

    const r = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name IN ('subscribers','subscriber_sites','publications','autopub_log','sources','sites_catalog')
        AND column_name IN ('plan_value','gemini_key','auto_publish','rewritten_chapeu','featured_image_selector','site_id')
    `);
    console.log('Colunas OK:', r.rows.map(x => x.column_name).join(', '));
    await pool.end();
    process.exit(0);
  } catch (e) {
    console.error('ERRO:', e.message);
    process.exit(1);
  }
})();
