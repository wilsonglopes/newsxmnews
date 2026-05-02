'use strict';
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36';
const AGENT = new https.Agent({ rejectUnauthorized: false });

async function get(url) {
  const r = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': UA }, httpsAgent: AGENT });
  return cheerio.load(r.data);
}

async function main() {
  // ── GOVRS ────────────────────────────────────────────────────────────────────
  console.log('\n=== GOVERNO RS: https://estado.rs.gov.br/ultimas-noticias ===');
  const $g = await get('https://estado.rs.gov.br/ultimas-noticias');
  // Tenta encontrar links de artigos individuais
  const links = new Set();
  $g('a[href]').each((_, el) => {
    const href = $g(el).attr('href') || '';
    if (href.match(/\/\d{4}\/\d{2}|\/noticia\/|conteudo\/\d+|upload\/noticias/i)) {
      links.add(href.startsWith('http') ? href : 'https://estado.rs.gov.br' + href);
    }
  });
  console.log('Links de artigos encontrados:', [...links].slice(0, 8));

  // Tenta seletores comuns
  ['article', '.noticia', '.item-noticia', '.news-item', '.card', 'li.noticias', '.box-noticia', '.chamada'].forEach(sel => {
    const found = $g(sel);
    if (found.length > 0) {
      const firstLink = found.first().find('a').attr('href');
      const firstTitle = found.first().find('h1,h2,h3,h4,.titulo').first().text().trim().substring(0,60);
      console.log(`  Seletor "${sel}" (${found.length} itens): "${firstTitle}" -> ${firstLink}`);
    }
  });

  // ── ALERS ────────────────────────────────────────────────────────────────────
  console.log('\n=== ASSEMBLEIA RS: https://ww4.al.rs.gov.br/noticias ===');
  const $a = await get('https://ww4.al.rs.gov.br/noticias');
  // Links de artigos
  const alLinks = new Set();
  $a('a[href]').each((_, el) => {
    const href = $a(el).attr('href') || '';
    if (href.match(/\/noticia\/\d+|\/noticias\/\d+/)) {
      alLinks.add(href.startsWith('http') ? href : 'https://ww4.al.rs.gov.br' + href);
    }
  });
  console.log('Links de noticias encontrados:', [...alLinks].slice(0, 8));

  ['article', '.noticia', '.item-noticia', '.card', 'li', '.noticias-item', '.list-item'].forEach(sel => {
    const found = $a(sel);
    if (found.length > 2 && found.length < 50) {
      const firstLink = found.first().find('a[href*="noticia"]').attr('href');
      const firstTitle = found.first().find('h1,h2,h3,h4,.titulo').first().text().trim().substring(0,60);
      if (firstTitle) console.log(`  Seletor "${sel}" (${found.length} itens): "${firstTitle}" -> ${firstLink}`);
    }
  });

  // Mostra estrutura dos primeiros links de notícia encontrados
  if (alLinks.size > 0) {
    const notUrl = [...alLinks][0];
    console.log('\nInspecionando artigo ALERS:', notUrl);
    const $n = await get(notUrl);
    console.log('  og:image:', $n('meta[property="og:image"]').attr('content') || 'NENHUM');
    $n('img').each((_, el) => {
      const src = $n(el).attr('src') || '';
      const cls = $n(el).attr('class') || '';
      if (src && !src.match(/logo|icon|sprite|flag/i) && src.startsWith('http')) {
        console.log(`  img class="${cls.substring(0,50)}" -> ${src.substring(0,100)}`);
      }
    });
  }
}

main().catch(console.error);
