'use strict';

/**
 * Script de configuração inicial do banco de dados.
 * - Cria as tabelas (schema.sql)
 * - Insere os dados iniciais (planos + fontes)
 * - Cria um assinante de teste
 *
 * Uso: node backend/db/setup.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs      = require('fs');
const path    = require('path');
const bcrypt  = require('bcrypt');
const pool    = require('./connection');
const sources = require('../sources.json');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

async function setup() {
  const client = await pool.connect();

  try {
    // ── 1. Criar tabelas ───────────────────────────────────────────────────
    console.log('Criando tabelas...');
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    await client.query(schema);
    console.log('✔ Tabelas criadas (ou já existiam).');

    await client.query('BEGIN');

    // ── 2. Planos ──────────────────────────────────────────────────────────
    console.log('Inserindo planos...');
    await client.query(`
      INSERT INTO plans (name, max_sources, max_publications_per_month, max_sites, price_cents)
      VALUES
        ('Básico',        5,    30,    1, 9700),
        ('Profissional',  15,   100,   2, 19700),
        ('Premium',       0,    NULL,  5, 39700)
      ON CONFLICT (name) DO NOTHING
    `);

    // ── 3. Fontes ──────────────────────────────────────────────────────────
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
          category = EXCLUDED.category
      `, [
        s.name, s.slug, s.type, s.url,
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

    // ── 4. Admin (Wilson) ─────────────────────────────────────────────────
    console.log('Criando usuário admin...');

    const { rows: premiumRows } = await client.query(
      "SELECT id FROM plans WHERE name = 'Premium' LIMIT 1"
    );
    const premiumId = premiumRows[0]?.id;

    const adminEmail    = process.env.ADMIN_EMAIL    || 'wilson@admin.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    const adminHash     = await bcrypt.hash(adminPassword, 10);

    await client.query(`
      INSERT INTO subscribers (name, email, password_hash, plan_id, plan_expires_at, active, is_admin)
      VALUES ($1, $2, $3, $4, now() + interval '10 years', true, true)
      ON CONFLICT (email) DO UPDATE SET
        is_admin        = true,
        plan_id         = EXCLUDED.plan_id,
        active          = true
    `, ['Wilson (Admin)', adminEmail, adminHash, premiumId]);

    // ── 5. Assinante de demonstração ───────────────────────────────────────
    console.log('Criando assinante de demonstração...');

    const { rows: proRows } = await client.query(
      "SELECT id FROM plans WHERE name = 'Profissional' LIMIT 1"
    );
    const proId = proRows[0]?.id;

    const demoHash = await bcrypt.hash('demo123', 10);

    await client.query(`
      INSERT INTO subscribers (name, email, password_hash, plan_id, plan_expires_at, active, is_admin)
      VALUES ($1, $2, $3, $4, now() + interval '1 year', true, false)
      ON CONFLICT (email) DO NOTHING
    `, ['Demo Jornal', 'demo@noticias.com', demoHash, proId]);

    await client.query('COMMIT');

    console.log('\n✔ Setup concluído!');
    console.log('──────────────────────────────────────');
    console.log('  Admin criado:');
    console.log('  Email : ' + adminEmail);
    console.log('  Senha : ' + adminPassword);
    console.log('  Admin : SIM');
    console.log('');
    console.log('  Demo criado:');
    console.log('  Email : demo@noticias.com');
    console.log('  Senha : demo123');
    console.log('  Plano : Profissional');
    console.log('──────────────────────────────────────');

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('✘ Erro no setup:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

setup();
