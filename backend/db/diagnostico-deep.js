'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const axios   = require('axios');
const cheerio = require('cheerio');
const https   = require('https');

const UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36';
const AGENT = new https.Agent({ rejectUnauthorized: false });

async function fetch(url) {
  const r = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': UA }, httpsAgent: AGENT });
  return cheerio.load(r.data);
}

async function main() {
  // ── 1. Sombrio: por que og:image não aparece no modal? ──────────────────────
  console.log('\n=== SOMBRIO ===');
  const $s = await fetch('https://sombrio.sc.gov.br/2026/04/16/parceria-entre-o-citi-e-alunos-sombrienses-produz-bolsas-ecologicamente-corretas/');
  const ogS = $s('meta[property="og:image"]').attr('content');
  console.log('og:image:', ogS || 'NENHUM');
  console.log('Todas as meta og:');
  $s('meta[property^="og:"]').each((_, el) => console.log(' ', $s(el).attr('property'), '=', $s(el).attr('content')?.substring(0,80)));

  // ── 2. Capão da Canoa: investigar estrutura ─────────────────────────────────
  console.log('\n=== CAPÃO DA CANOA ===');
  const $c = await fetch('https://www.capaodacanoa.rs.gov.br/noticia/view/874/segunda-edicao-da-feira-de-pascoa-sabor-e-tradicao-supera-expectativas-e-movimenta-capao-da-canoa');
  console.log('og:image:', $c('meta[property="og:image"]').attr('content') || 'NENHUM');

  // Tenta encontrar imagens em qualquer lugar
  const imgs = [];
  $c('img').each((_, el) => {
    const src = $c(el).attr('src') || $c(el).attr('data-src') || '';
    const cls = ($c(el).attr('class') || '').substring(0, 60);
    const alt = ($c(el).attr('alt') || '').substring(0, 40);
    if (src && !src.match(/logo|icon|flag|brasao|sprite/i)) imgs.push({ src: src.substring(0,100), cls, alt });
  });
  console.log(`Total imgs: ${imgs.length}`);
  imgs.slice(0, 8).forEach(i => console.log(`  [${i.cls}] alt="${i.alt}" -> ${i.src}`));

  // Verifica se há background-image em CSS inline
  const bgs = [];
  $c('[style*="background"]').each((_, el) => {
    const style = $c(el).attr('style') || '';
    const m = style.match(/url\(['"]?(.*?)['"]?\)/);
    if (m) bgs.push({ tag: el.tagName, cls: ($c(el).attr('class') || '').substring(0,60), url: m[1].substring(0,100) });
  });
  console.log(`BG-image em style: ${bgs.length}`);
  bgs.slice(0, 5).forEach(b => console.log(`  <${b.tag}> [${b.cls}] -> ${b.url}`));

  // ── 3. ALERS: investigar estrutura de imagem ─────────────────────────────────
  console.log('\n=== ALERS ===');
  const $al = await fetch('https://ww4.al.rs.gov.br/noticia/343265');
  console.log('og:image:', $al('meta[property="og:image"]').attr('content') || 'NENHUM');
  const alImgs = [];
  $al('img').each((_, el) => {
    const src = $al(el).attr('src') || '';
    if (src && !src.match(/logo|icon|sprite/i)) alImgs.push(src.substring(0,100));
  });
  console.log('Imgs:', alImgs.slice(0,5));
}

main().catch(console.error);
