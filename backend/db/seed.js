'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const pool    = require('./connection');
const sources = require('../sources.json');

async function seed() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ── Planos ──────────────────────────────────────────────────────────────
    console.log('Inserindo planos...');
    await client.query(`
      INSERT INTO plans (name, max_sources, max_publications_per_month, max_sites, price_cents)
      VALUES
        ('Básico',        5,    30,    1, 9700),
        ('Profissional',  15,   100,   2, 19700),
        ('Premium',       0,    NULL,  5, 39700)
      ON CONFLICT DO NOTHING
    `);

    // ── Fontes do sources.json ───────────────────────────────────────────────
    console.log(`Inserindo ${sources.length} fontes...`);
    for (const s of sources) {
      const cfg = s.scraping || {};
      await client.query(`
        INSERT INTO sources (
          name, slug, type, url,
          section_selector, title_selector, date_selector,
          link_selector, image_selector, content_selector,
          category, active
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (slug) DO UPDATE SET
          name     = EXCLUDED.name,
          url      = EXCLUDED.url,
          type     = EXCLUDED.type,
          active   = EXCLUDED.active,
          category = EXCLUDED.category,
          section_selector = EXCLUDED.section_selector,
          title_selector   = EXCLUDED.title_selector,
          date_selector    = EXCLUDED.date_selector,
          link_selector    = EXCLUDED.link_selector,
          image_selector   = EXCLUDED.image_selector
      `, [
        s.name,
        s.slug,
        s.type,
        s.url,
        cfg.itemSelector    || null,
        cfg.titleSelector   || null,
        cfg.dateSelector    || null,
        cfg.linkSelector    || null,
        cfg.imageSelector   || null,
        cfg.contentSelector || null,
        s.category || null,
        s.active !== false
      ]);
    }

    await client.query('COMMIT');
    console.log('✔ Seed concluído com sucesso.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('✘ Erro no seed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
