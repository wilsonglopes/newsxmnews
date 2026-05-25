'use strict';

/**
 * Domínios permitidos para o proxy de imagens (segurança — evita SSRF).
 *
 * ⚠️  REGRA: sempre que adicionar uma nova fonte, verificar se o domínio das
 * imagens está aqui. Sem isso o proxy retorna 403 e os artigos ficam sem imagem.
 *
 * Para testar se um domínio já está coberto:
 *   const { isAllowed } = require('./utils/allowed-hosts');
 *   isAllowed('https://exemplo.com.br/foto.jpg') // → true/false
 */
const ALLOWED_HOSTS = [
  // ── Portais nacionais ────────────────────────────────────────────────────────
  'nsctotal.com.br',
  'metropoles.com', 'metroimg.com',
  'cnnbrasil.com.br',
  'jovempan.com.br', 'jpimg.com.br',
  'ebc.com.br',
  'agenciaesporte.com.br',
  'ndmais.com.br',
  'portalc1.com.br',
  'danuzionews.com',
  'enfoquesc.com.br',
  'portaldoagronegocio.com.br',
  'jarbasvieira.com',
  'sommaior.com.br',
  'brasilparalelo.com.br',
  'lance.com.br', 'lncimg.lance.com.br',

  // ── Globo / G1 / O Globo ─────────────────────────────────────────────────────
  'glbimg.com', 'oglobo.globo.com', 'g1.globo.com',
  'oglobo.com', 's3.glbimg.com', 'i.s3.glbimg.com',

  // ── Poder Legislativo Federal ────────────────────────────────────────────────
  'senado.leg.br',
  'camara.leg.br',

  // ── Assembleias legislativas estaduais ──────────────────────────────────────
  'alesc.sc.gov.br',
  'al.rs.gov.br',

  // ── Portais regionais do Acre ────────────────────────────────────────────────
  'folhadoacre.com.br',
  'ecosdanoticia.net',
  'contilnetnoticias.com.br',
  'agazetadoacre.com',
  'portalacre.com.br',
  'nahoradanoticia.com.br',

  // ── Governos estaduais e prefeituras ────────────────────────────────────────
  // Cobre todos os subdomínios: criciuma.sc.gov.br, turvo.sc.gov.br, etc.
  'rs.gov.br',
  'sc.gov.br',
  'ac.gov.br',
  'al.ac.leg.br',    // Assembleia Legislativa do Acre
  'sp.gov.br',
  'atende.net',      // Portal de prefeituras Atende.Net

  // ── Governo Federal (Plone CMS — PRF, ministérios) ──────────────────────────
  'www.gov.br',

  // ── Tribunais ────────────────────────────────────────────────────────────────
  'tjac.jus.br', 'www.tjac.jus.br',

  // ── Clubes de futebol ────────────────────────────────────────────────────────
  'static.internacional.com.br',

  // ── WordPress / Wix CDNs ─────────────────────────────────────────────────────
  'static.wixstatic.com',
  'wp.com', 'i0.wp.com', 'i1.wp.com', 'i2.wp.com',

  // ── Portais regionais (RS) ───────────────────────────────────────────────────
  'ocruzeironoticias.com.br',
  'agorars.com', 'uploads.agorars.com',
  'correiodopovo.com.br',
  'osul.com.br',
];

/**
 * Verifica se uma URL (ou hostname) está na lista de domínios permitidos.
 * Suporta subdomínios: se 'sc.gov.br' está na lista, 'criciuma.sc.gov.br' passa.
 *
 * @param {string} urlOrHost - URL completa (https://...) ou hostname
 * @returns {boolean}
 */
function isAllowed(urlOrHost) {
  if (!urlOrHost) return false;
  let host;
  try {
    host = urlOrHost.includes('://') ? new URL(urlOrHost).hostname : urlOrHost;
  } catch { return false; }
  const normalized = host.replace(/^www\./, '').toLowerCase();
  return ALLOWED_HOSTS.some(h => normalized === h || normalized.endsWith('.' + h));
}

/**
 * Retorna o hostname não-autorizado, ou null se for permitido.
 * Útil para logs de warning.
 *
 * @param {string} url
 * @returns {string|null} hostname bloqueado, ou null se ok
 */
function blockedHost(url) {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h)) ? null : host;
  } catch { return null; }
}

module.exports = { ALLOWED_HOSTS, isAllowed, blockedHost };
