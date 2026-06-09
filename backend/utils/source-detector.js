'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');

// Detecção automática de fonte RSS para o cadastro self-service no painel.
// Fase 1: só RSS. A coleta de teste em si é feita pelo buscarRSS do server (injetado
// no endpoint) — aqui só descobrimos a URL do feed e sugerimos os metadados.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Anti-SSRF: mesmo padrão do /api/article (server.js). Bloqueia IPs internos/loopback.
const PRIVATE_IP_RE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1|0\.0\.0\.0)/i;

const CATEGORIAS_VALIDAS = ['nacional', 'regional', 'esporte', 'governo', 'prefeitura', 'agro', 'policial', 'judicial', 'geral'];

function urlSegura(u) {
  try {
    const url = new URL(u);
    if (!/^https?:$/.test(url.protocol)) return null;
    if (PRIVATE_IP_RE.test(url.hostname)) return null;
    return url;
  } catch { return null; }
}

function hostSemWww(u) {
  try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return ''; }
}

// kebab-case sem acento, igual ao espírito das regras do startup-validator.
function slugify(texto) {
  return (texto || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // remove acentos
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.(com|net|org|gov|br|info)\b/g, ' ')      // tira TLDs se vier domínio
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'fonte';
}

// Monta a lista ordenada de URLs candidatas a feed: a própria URL, os feeds
// declarados no HTML (autodiscovery) e os caminhos convencionais do domínio.
async function descobrirFeedCandidatos(entradaUrl) {
  const url = urlSegura(entradaUrl);
  if (!url) return [];

  const candidatos = new Set();
  candidatos.add(url.href);                       // a própria URL pode já ser um feed

  const origin = `${url.protocol}//${url.host}`;
  const comuns = ['/feed/', '/feed', '/rss', '/rss.xml', '/feed.xml', '/index.xml', '/?feed=rss2', '/atom.xml'];

  // Autodiscovery: <link rel="alternate" type="application/rss+xml" href="...">
  try {
    const resp = await axios.get(url.href, {
      timeout: 12000,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*' },
      responseType: 'text',
      maxRedirects: 5,
      validateStatus: s => s >= 200 && s < 400,
    });
    const ct = String(resp.headers['content-type'] || '');
    // Se já veio um feed (xml), não precisa procurar mais nada.
    if (/xml|rss|atom/i.test(ct) || /^\s*<\?xml|<rss|<feed/i.test(resp.data)) {
      return [url.href];
    }
    const $ = cheerio.load(resp.data);
    $('link[rel="alternate"]').each((_, el) => {
      const type = ($(el).attr('type') || '').toLowerCase();
      const href = $(el).attr('href');
      if (!href) return;
      if (type.includes('rss') || type.includes('atom') || type.includes('xml')) {
        try { candidatos.add(new URL(href, origin).href); } catch { /* ignora href inválido */ }
      }
    });
  } catch { /* sem HTML acessível: segue só com os caminhos comuns */ }

  for (const p of comuns) candidatos.add(origin + p);
  return [...candidatos];
}

// Sugere {name, slug, category} via DeepSeek a partir do domínio + amostra de títulos.
// Degradação graciosa: qualquer falha cai no fallback determinístico.
async function sugerirMetadados({ url, sampleTitles = [] }) {
  const host = hostSemWww(url);
  const fallback = {
    name: host.split('.')[0].replace(/^\w/, c => c.toUpperCase()) || 'Nova fonte',
    slug: slugify(host),
    category: 'regional',
  };

  const key = process.env.DEEPSEEK_KEY || '';
  if (!key || !sampleTitles.length) return fallback;

  try {
    const sys = `Você cataloga fontes de notícias para um agregador brasileiro.
Dado o domínio do site e alguns títulos recentes, retorne SOMENTE um JSON:
{ "name": string (nome curto e legível do portal), "category": string }.
A "category" DEVE ser uma destas: ${CATEGORIAS_VALIDAS.join(', ')}.
Use "prefeitura"/"governo" para sites oficiais, "esporte" para esportivos, "nacional" para grandes portais nacionais, "regional" para portais locais/estaduais, senão "geral".`;
    const userContent = `DOMÍNIO: ${host}\nTÍTULOS:\n- ${sampleTitles.slice(0, 6).join('\n- ')}`;
    const resp = await axios.post(
      'https://api.deepseek.com/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [{ role: 'system', content: sys }, { role: 'user', content: userContent }],
        max_tokens: 200,
        response_format: { type: 'json_object' },
      },
      { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` }, timeout: 20000 }
    );
    const obj = JSON.parse(resp.data?.choices?.[0]?.message?.content || '{}');
    const category = CATEGORIAS_VALIDAS.includes(obj.category) ? obj.category : fallback.category;
    const name = (typeof obj.name === 'string' && obj.name.trim()) ? obj.name.trim().slice(0, 60) : fallback.name;
    return { name, slug: slugify(name), category };
  } catch (e) {
    console.warn('[source-detector] metadados IA falharam, usando fallback:', e.response?.data?.error?.message || e.message);
    return fallback;
  }
}

module.exports = {
  urlSegura,
  hostSemWww,
  slugify,
  descobrirFeedCandidatos,
  sugerirMetadados,
  CATEGORIAS_VALIDAS,
};
