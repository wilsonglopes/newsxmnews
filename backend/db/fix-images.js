'use strict';

/**
 * db/fix-images.js
 * Script retroativo: busca og:image para artigos que estão no banco sem image_url.
 * Roda uma vez. Uso: node backend/db/fix-images.js
 *
 * Processa em lotes para não sobrecarregar os servidores externos.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const pool    = require('./connection');
const { fetchFullContent } = require('../scrapers/full-content');

const LOTE       = 5;   // requisições paralelas por vez
const DELAY_MS   = 800; // pausa entre lotes (ms)
const LIMITE     = 500; // máximo de artigos a processar por execução

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  console.log('=== fix-images.js — buscando imagens para artigos sem image_url ===\n');

  // Busca artigos sem imagem, priorizando os mais recentes
  const { rows: artigos } = await pool.query(
    `SELECT id, external_url FROM articles
     WHERE image_url IS NULL
       AND external_url IS NOT NULL
       AND external_url != ''
     ORDER BY published_at DESC NULLS LAST
     LIMIT $1`,
    [LIMITE]
  );

  console.log(`Artigos sem imagem encontrados: ${artigos.length}\n`);

  let atualizados = 0;
  let falhas      = 0;

  for (let i = 0; i < artigos.length; i += LOTE) {
    const lote = artigos.slice(i, i + LOTE);

    await Promise.all(lote.map(async (art) => {
      try {
        const { image_url } = await fetchFullContent(art.external_url, {});
        if (image_url) {
          await pool.query('UPDATE articles SET image_url = $1 WHERE id = $2', [image_url, art.id]);
          atualizados++;
          process.stdout.write('.');
        } else {
          falhas++;
          process.stdout.write('x');
        }
      } catch {
        falhas++;
        process.stdout.write('!');
      }
    }));

    // Pausa entre lotes
    if (i + LOTE < artigos.length) await sleep(DELAY_MS);
  }

  console.log(`\n\n=== Concluído ===`);
  console.log(`Imagens encontradas e salvas: ${atualizados}`);
  console.log(`Artigos sem imagem disponível: ${falhas}`);
  console.log(`Total processado: ${artigos.length}`);

  await pool.end();
  process.exit(0);
})().catch(err => {
  console.error('Erro fatal:', err.message);
  process.exit(1);
});
