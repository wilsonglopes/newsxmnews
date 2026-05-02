'use strict';

/**
 * Diagnóstico de imagens por fonte
 * Pega o primeiro artigo de cada fonte scraping no banco e testa a extração de imagem
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const axios   = require('axios');
const cheerio = require('cheerio');
const https   = require('https');
const pool    = require('./connection');

const UA     = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36';
const AGENT  = new https.Agent({ rejectUnauthorized: false });

const SCRAPING_SOURCES = [
  'pref-sombrio', 'pref-torres', 'pref-arroiodosal',
  'pref-capaodacanoa', 'govrs', 'alesc', 'alers'
];

async function inspecionarUrl(url, slug) {
  try {
    const resp = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': UA },
      httpsAgent: AGENT,
    });
    const $ = cheerio.load(resp.data);

    const resultados = {
      slug,
      url,
      og_image:      $('meta[property="og:image"]').attr('content') || null,
      twitter_image: $('meta[name="twitter:image"]').attr('content') || null,
      imgs_no_artigo: [],
      imgs_com_classe: [],
      figuras: [],
    };

    // og:image
    if (resultados.og_image) {
      resultados.og_image = resultados.og_image.substring(0, 100);
    }

    // Imagens dentro de article / .content / main
    $('article img, .content img, main img, .noticia img, .post img').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src') || '';
      const cls = $(el).attr('class') || '';
      const w   = $(el).attr('width') || '?';
      const h   = $(el).attr('height') || '?';
      if (src && src.startsWith('http') && !src.match(/logo|icon|avatar/i)) {
        resultados.imgs_no_artigo.push({ src: src.substring(0, 100), cls, w, h });
      }
    });

    // Imagens com classes interessantes
    $('img[class*="thumb"], img[class*="featured"], img[class*="destaque"], img[class*="principal"], img[class*="post-img"], img[class*="attachment"], img.wp-post-image').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || '';
      const cls = $(el).attr('class') || '';
      if (src && !src.match(/logo|icon/i)) {
        resultados.imgs_com_classe.push({ src: src.substring(0, 100), cls: cls.substring(0, 80) });
      }
    });

    // Figuras
    $('figure img, .elementor-widget-image img').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || '';
      if (src && src.startsWith('http')) {
        resultados.figuras.push(src.substring(0, 100));
      }
    });

    return resultados;
  } catch (e) {
    return { slug, url, erro: e.message };
  }
}

async function main() {
  const client = await pool.connect();

  for (const slug of SCRAPING_SOURCES) {
    // Pega um artigo recente desta fonte com URL válida
    const { rows } = await client.query(`
      SELECT a.title, a.external_url FROM articles a
      JOIN sources s ON s.id = a.source_id
      WHERE s.slug = $1 AND a.external_url IS NOT NULL
      ORDER BY a.published_at DESC LIMIT 1
    `, [slug]);

    if (!rows.length) {
      console.log(`\n[${slug}] Sem artigos no banco.`);
      continue;
    }

    const { title, external_url } = rows[0];
    console.log(`\n${'='.repeat(70)}`);
    console.log(`[${slug}] ${title?.substring(0, 60)}`);
    console.log(`URL: ${external_url}`);

    const info = await inspecionarUrl(external_url, slug);

    if (info.erro) {
      console.log(`  ERRO: ${info.erro}`);
      continue;
    }

    console.log(`  og:image      : ${info.og_image || '❌ NENHUM'}`);
    console.log(`  twitter:image : ${info.twitter_image || '❌ NENHUM'}`);
    console.log(`  imgs article  : ${info.imgs_no_artigo.length} encontradas`);
    info.imgs_no_artigo.slice(0, 2).forEach(i =>
      console.log(`    - [${i.w}x${i.h}] class="${i.cls}" ${i.src}`)
    );
    console.log(`  imgs c/classe : ${info.imgs_com_classe.length} encontradas`);
    info.imgs_com_classe.slice(0, 2).forEach(i =>
      console.log(`    - class="${i.cls}" ${i.src}`)
    );
    console.log(`  figuras       : ${info.figuras.length} encontradas`);
    info.figuras.slice(0, 2).forEach(src => console.log(`    - ${src}`));
  }

  client.release();
  await pool.end();
}

main().catch(console.error);
