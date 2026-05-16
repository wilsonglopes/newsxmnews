'use strict';

const axios = require('axios');

// ════════════════════════════════════════════════════════════════════════════
// Busca de imagem em duas fontes (em ordem de preferência):
// 1. Wikimedia Commons — gratuito, sem chave, licenças sempre OK
// 2. Google Custom Search — fallback (precisa GOOGLE_CSE_API_KEY + GOOGLE_CSE_ID)
// ════════════════════════════════════════════════════════════════════════════

const WIKIMEDIA_API = 'https://commons.wikimedia.org/w/api.php';
const GOOGLE_CSE    = 'https://www.googleapis.com/customsearch/v1';

function googleAvailable() {
  return !!(process.env.GOOGLE_CSE_API_KEY && process.env.GOOGLE_CSE_ID);
}

// Considera-se sempre disponível (não precisa chave)
function isAvailable() { return true; }

// ─── Wikimedia Commons ─────────────────────────────────────────────────────
async function buscarWikimedia(query) {
  try {
    const r = await axios.get(WIKIMEDIA_API, {
      timeout: 15000,
      params: {
        action:       'query',
        format:       'json',
        generator:    'search',
        gsrsearch:    query.trim(),
        gsrnamespace: 6,          // namespace de arquivos
        gsrlimit:     8,
        prop:         'imageinfo',
        iiprop:       'url|extmetadata|mime|size',
        iiurlwidth:   1200,        // pede thumb 1200px
      },
      headers: { 'User-Agent': 'XIXO-News-Bot/1.0 (contato: wilsonglopes@gmail.com)' },
    });

    const pages = r.data?.query?.pages || {};
    const items = Object.values(pages);
    if (!items.length) return null;

    // Filtra: só JPG/PNG, com URL válida, dimensão suficiente
    const validas = items
      .filter(p => p.imageinfo?.[0])
      .map(p => p.imageinfo[0])
      .filter(ii => /^image\/(jpeg|png|webp)$/i.test(ii.mime || ''))
      .filter(ii => (ii.width || 0) >= 400);

    if (!validas.length) return null;

    const ii = validas[0];
    const meta = ii.extmetadata || {};
    const artist  = (meta.Artist?.value || '').replace(/<[^>]*>/g, '').trim() || 'Wikimedia Commons';
    const license = (meta.LicenseShortName?.value || meta.License?.value || 'CC').trim();

    return {
      url:        ii.thumburl || ii.url,
      sourcePage: ii.descriptionurl || '',
      sourceSite: 'Wikimedia Commons',
      title:      '',
      credit:     `Foto: ${artist} / Wikimedia Commons (${license})`,
      provider:   'wikimedia',
    };
  } catch (err) {
    console.error('[image-search/wikimedia] Erro:', err.message);
    return null;
  }
}

// ─── Google Custom Search ──────────────────────────────────────────────────
async function buscarGoogle(query) {
  if (!googleAvailable()) return null;
  try {
    const r = await axios.get(GOOGLE_CSE, {
      timeout: 15000,
      params: {
        key:        process.env.GOOGLE_CSE_API_KEY,
        cx:         process.env.GOOGLE_CSE_ID,
        q:          query.trim(),
        searchType: 'image',
        num:        5,
        safe:       'active',
        rights:     'cc_publicdomain,cc_attribute,cc_sharealike',
        imgSize:    'large',
      },
    });

    const items = r.data?.items || [];
    if (!items.length) return null;

    for (const item of items) {
      const url = item.link;
      if (!url || !/^https?:\/\//i.test(url)) continue;
      if (/(?:reuters\.com|gettyimages|apnews|afp\.com|shutterstock|alamy)/i.test(url)) continue;

      return {
        url,
        sourcePage: item.image?.contextLink || '',
        sourceSite: item.displayLink || '',
        title:      item.title || '',
        credit:     `Foto: ${item.displayLink || 'Fonte na internet'}`,
        provider:   'google',
      };
    }
    return null;
  } catch (err) {
    console.error('[image-search/google] Erro:', err.response?.data?.error?.message || err.message);
    return null;
  }
}

// Extrai só palavras com inicial maiúscula (nomes próprios) — fallback
function extrairNomesProprios(q) {
  const palavras = q.split(/\s+/).filter(p => /^[A-ZÁÉÍÓÚÂÊÔÃÕÇ]/.test(p));
  return palavras.join(' ').trim();
}

// ─── Estratégia principal: Wikimedia primeiro, Google fallback ─────────────
async function buscarImagem(query) {
  if (!query || query.trim().length < 3) return null;

  // 1) Wikimedia com query completa
  let wm = await buscarWikimedia(query);
  if (wm) {
    console.log(`[image-search] Wikimedia OK: "${query}" → ${wm.sourcePage}`);
    return wm;
  }

  // 2) Wikimedia só com nomes próprios (se diferente)
  const propios = extrairNomesProprios(query);
  if (propios && propios !== query.trim() && propios.split(/\s+/).length >= 1) {
    wm = await buscarWikimedia(propios);
    if (wm) {
      console.log(`[image-search] Wikimedia OK (fallback nomes): "${propios}" → ${wm.sourcePage}`);
      return wm;
    }
  }

  // 3) Google CSE (se configurado)
  const gg = await buscarGoogle(query);
  if (gg) {
    console.log(`[image-search] Google OK: "${query}" → ${gg.sourcePage}`);
    return gg;
  }

  console.log(`[image-search] Nenhuma fonte encontrou imagem para "${query}"`);
  return null;
}

module.exports = { buscarImagem, isAvailable };
