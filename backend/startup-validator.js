'use strict';

/**
 * Validação de configuração no startup do servidor.
 *
 * Roda ANTES de iniciar scraping/cron/autopub.
 * Não bloqueia o processo — apenas loga warnings/erros claros no PM2.
 *
 * Verifica:
 *   1. sources.json — slugs duplicados, URLs inválidas, linkFilter inválido
 *   2. Fontes scraping sem itemSelector (usa fallback genérico)
 *   3. Fontes tipo 'api' sem api_field_map
 *   4. [async, não-bloqueante] HTTP HEAD nas URLs de RSS ativas
 */

const path = require('path');
const fs   = require('fs');

// ─── Validação síncrona (roda no require) ─────────────────────────────────────

/**
 * Valida sources.json e retorna { erros, avisos }.
 * @param {Array} [sourcesArray] - Se omitido, lê sources.json do disco
 */
function validateSources(sourcesArray) {
  let sources;

  if (sourcesArray) {
    sources = sourcesArray;
  } else {
    try {
      sources = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'sources.json'), 'utf8')
      );
    } catch (e) {
      console.error('[VALIDATOR] ❌ FATAL: sources.json ilegível ou JSON inválido:', e.message);
      return { erros: [e.message], avisos: [] };
    }
  }

  const erros  = [];
  const avisos = [];
  const slugMap = new Map(); // slug → name (detectar duplicatas)

  for (const source of sources) {
    const tag = `[${source.slug || source.name || '?'}]`;

    // ── Slug ───────────────────────────────────────────────────────────────────
    if (!source.slug) {
      erros.push(`${tag} fonte sem slug definido`);
    } else if (slugMap.has(source.slug)) {
      erros.push(`${tag} slug duplicado — colide com "${slugMap.get(source.slug)}"`);
    } else {
      slugMap.set(source.slug, source.name || '?');
    }

    // Fontes inativas: só verificamos duplicata de slug
    if (!source.active) continue;

    // ── URL ────────────────────────────────────────────────────────────────────
    if (!source.url) {
      erros.push(`${tag} ativo mas sem URL configurada`);
      continue; // sem URL não dá pra fazer mais verificações
    }
    try {
      new URL(source.url);
    } catch {
      erros.push(`${tag} URL inválida: "${source.url}"`);
    }

    // ── linkFilter (deve ser regex válida) ────────────────────────────────────
    const lf = source.scraping?.linkFilter;
    if (lf) {
      try {
        new RegExp(lf);
      } catch (e) {
        erros.push(`${tag} linkFilter inválido: "${lf}" — ${e.message}`);
      }

      // Aviso: linkFilter muito curto pode ser ambíguo (ex: "/noticia/\\d+" sem domínio)
      if (lf.length < 10 && !lf.includes('\\')) {
        avisos.push(`${tag} linkFilter muito curto (\`${lf}\`) — pode aceitar URLs de outros domínios`);
      }
    }

    // ── Scraping sem itemSelector ──────────────────────────────────────────────
    if (source.type === 'scraping' && !source.scraping?.itemSelector) {
      avisos.push(`${tag} type=scraping sem itemSelector — usa fallback genérico (pode coletar lixo)`);
    }

    // ── API sem mapeamento de campos ───────────────────────────────────────────
    if (source.type === 'api' && !source.api_field_map) {
      avisos.push(`${tag} type=api sem api_field_map — campos podem não ser mapeados corretamente`);
    }

    // ── Headless scraping: Puppeteer necessário ───────────────────────────────
    if (source.headless && source.type === 'scraping') {
      avisos.push(`${tag} headless=true + scraping — Puppeteer deve estar instalado no servidor`);
    }

    // ── Sitemap sem campo de data → artigos podem vir sem data ────────────────
    if (source.type === 'sitemap' && !source.sitemap_date_field) {
      // Só info, não crítico
    }
  }

  // ── Imprimir resultado ────────────────────────────────────────────────────────
  const nAtivas = sources.filter(s => s.active).length;
  const nTotal  = sources.length;

  if (erros.length || avisos.length) {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║  XIXO Validator — sources.json               ║');
    console.log('╚══════════════════════════════════════════════╝');
    if (erros.length) {
      console.error('  ERROS (precisam ser corrigidos):');
      erros.forEach(e => console.error(`    ❌ ${e}`));
    }
    if (avisos.length) {
      console.warn('  AVISOS (revisar se houver problema):');
      avisos.forEach(a => console.warn(`    ⚠️  ${a}`));
    }
    console.log(`  ─────────────────────────────────────────────`);
    console.log(`  ${nAtivas}/${nTotal} fontes ativas | ${erros.length} erro(s) | ${avisos.length} aviso(s)`);
    console.log('');
  } else {
    console.log(`[VALIDATOR] ✅ sources.json OK — ${nAtivas}/${nTotal} fontes ativas, nenhum problema.`);
  }

  return { erros, avisos };
}

// ─── Verificação async de URLs (não-bloqueante) ───────────────────────────────

/**
 * Faz HTTP HEAD nas URLs das fontes RSS ativas para detectar URLs quebradas.
 * Roda setImmediate após startup — não bloqueia nada.
 * Loga warnings no PM2 para qualquer URL com 4xx/5xx ou timeout.
 *
 * @param {Array} sources - Array de sources (já carregado)
 */
async function checkUrlsAsync(sources) {
  const axios = require('axios');

  // Só RSS direto: scraping e headless têm seu próprio mecanismo de retry
  const alvos = (sources || []).filter(s =>
    s.active && (s.type === 'rss' || s.type === 'sitemap') && !s.headless
  );

  if (!alvos.length) return;

  console.log(`[VALIDATOR-URL] Verificando ${alvos.length} URL(s) de RSS/sitemap...`);
  const problemas = [];

  for (const source of alvos) {
    try {
      const resp = await axios.head(source.url, {
        timeout:        6000,
        headers:        { 'User-Agent': 'XMNews-Validator/1.0' },
        validateStatus: () => true,  // não lança em 4xx/5xx
        maxRedirects:   3,
      });
      if (resp.status >= 400) {
        problemas.push({ slug: source.slug, url: source.url, status: resp.status });
        console.warn(`[VALIDATOR-URL] ⚠️  ${source.name} → HTTP ${resp.status} (${source.url})`);
      }
    } catch (e) {
      const code = e.code || 'TIMEOUT';
      problemas.push({ slug: source.slug, url: source.url, status: code });
      console.warn(`[VALIDATOR-URL] ⚠️  ${source.name} → ${code} (${source.url})`);
    }
  }

  if (problemas.length === 0) {
    console.log(`[VALIDATOR-URL] ✅ Todas as ${alvos.length} URLs respondem normalmente.`);
  } else {
    console.warn(`[VALIDATOR-URL] ${problemas.length} URL(s) com problema — verifique os logs acima.`);
  }

  return problemas;
}

module.exports = { validateSources, checkUrlsAsync };
