'use strict';

const axios = require('axios');

// Geração de hashtags por IA (DeepSeek) para legendas de Facebook/Instagram.
//
// Princípios:
//  - DEGRADAÇÃO GRACIOSA: qualquer falha (sem key, timeout, JSON inválido) retorna
//    string vazia. Nunca lança — hashtag é cosmético, não pode derrubar a publicação.
//  - CACHE por artigo: Facebook e Instagram do mesmo post chamam isto com segundos de
//    diferença. O cache garante UMA chamada efetiva à IA e hashtags IDÊNTICAS nas 2 redes.

const CACHE = new Map();              // chave → { tags: string, ts: number }
const TTL_MS   = 10 * 60 * 1000;      // 10 min cobre o intervalo entre FB e IG do mesmo post
const MAX_ITENS = 500;                // limpa entradas velhas se crescer demais

function chaveCache(title, summary) {
  return `${(title || '').trim()}|${(summary || '').trim()}`.toLowerCase();
}

function limparCacheSeGrande() {
  if (CACHE.size <= MAX_ITENS) return;
  const agora = Date.now();
  for (const [k, v] of CACHE) {
    if (agora - v.ts > TTL_MS) CACHE.delete(k);
  }
}

// Normaliza uma lista crua da IA numa string "#A #B #C": garante #, remove espaços
// internos, descarta vazios/duplicatas e limita a quantidade.
function normalizarHashtags(lista, maxTags = 7) {
  if (!Array.isArray(lista)) return '';
  const vistas = new Set();
  const out = [];
  for (let tag of lista) {
    if (typeof tag !== 'string') continue;
    // remove tudo que não for letra/número (mantém acentos), tira espaços internos
    tag = tag.replace(/[#\s]/g, '').replace(/[^\p{L}\p{N}]/gu, '');
    if (!tag) continue;
    const lower = tag.toLowerCase();
    if (vistas.has(lower)) continue;
    vistas.add(lower);
    out.push('#' + tag);
    if (out.length >= maxTags) break;
  }
  return out.join(' ');
}

function parseHashtagsJSON(texto) {
  if (!texto) return '';
  let obj;
  try {
    obj = JSON.parse(texto);
  } catch {
    // fallback: tenta extrair o array do JSON malformado
    const m = texto.match(/\[[\s\S]*\]/);
    if (!m) return '';
    try { obj = { hashtags: JSON.parse(m[0]) }; } catch { return ''; }
  }
  return normalizarHashtags(obj.hashtags || obj.tags || []);
}

const SYSTEM_PROMPT = `Você gera hashtags para o Instagram e Facebook de um portal de notícias brasileiro.
Retorne SOMENTE um JSON: { "hashtags": string[] } com 5 a 7 hashtags relevantes ao tema da notícia.
Regras:
- Em português do Brasil, cada uma começando com # e SEM espaços (ex: "#PolíticaSC", "#EleiçÕes2026" → "#Eleicoes2026").
- Misture 2-3 amplas (a editoria/tema) com 2-4 específicas (lugar, pessoa, instituição ou evento citados na matéria).
- Use CamelCase para legibilidade quando a hashtag tiver mais de uma palavra.
- NÃO use hashtags genéricas e repetitivas como #noticia #news #brasil #urgente; foque no conteúdo real.`;

/**
 * Gera hashtags relevantes ao tema da notícia. Retorna "#A #B #C" ou '' (nunca lança).
 * @param {{title?:string, summary?:string}} artigo
 * @returns {Promise<string>}
 */
async function gerarHashtags({ title, summary } = {}) {
  const key = process.env.DEEPSEEK_KEY || '';
  if (!key) return '';
  if (!title && !summary) return '';

  const ck = chaveCache(title, summary);
  const hit = CACHE.get(ck);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.tags;

  let tags = '';
  try {
    const userContent = `TÍTULO: ${title || ''}\n\nRESUMO: ${summary || ''}`;
    const resp = await axios.post(
      'https://api.deepseek.com/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        max_tokens: 256,
        response_format: { type: 'json_object' },
      },
      { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` }, timeout: 20000 }
    );
    tags = parseHashtagsJSON(resp.data?.choices?.[0]?.message?.content || '');
  } catch (e) {
    console.warn('[hashtags] geração falhou (segue sem hashtags):', e.response?.data?.error?.message || e.message);
    tags = '';
  }

  limparCacheSeGrande();
  CACHE.set(ck, { tags, ts: Date.now() });
  return tags;
}

module.exports = { gerarHashtags, normalizarHashtags, parseHashtagsJSON };
