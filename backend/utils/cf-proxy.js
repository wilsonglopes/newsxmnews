'use strict';

// Proxy via Cloudflare Workers para URLs bloqueadas na Oracle Cloud (*.sc.gov.br).
// Variáveis de ambiente: CF_PROXY_URL e CF_PROXY_TOKEN

const axios = require('axios');
const https = require('https');
const HTTPS_AGENT = new https.Agent({ rejectUnauthorized: false });

// Domínios sem ponto inicial — mesma convenção de allowed-hosts.js
// Bug anterior: '.sc.gov.br' + '.' + d gerava '..sc.gov.br' que nunca casava
const CF_PROXY_DOMAINS = ['sc.gov.br', 'midiamax.com.br'];

function needsCFProxy(url) {
  try {
    const h = new URL(url).hostname;
    return CF_PROXY_DOMAINS.some(d => h === d || h.endsWith('.' + d));
  } catch { return false; }
}

function isAvailable() {
  return !!(process.env.CF_PROXY_URL && process.env.CF_PROXY_TOKEN);
}

async function fetchViaCFProxy(url, axiosOpts = {}) {
  const proxyUrl = `${process.env.CF_PROXY_URL}?url=${encodeURIComponent(url)}`;
  return axios.get(proxyUrl, {
    ...axiosOpts,
    headers: { 'X-Proxy-Token': process.env.CF_PROXY_TOKEN, ...(axiosOpts.headers || {}) },
    httpsAgent: HTTPS_AGENT,
  });
}

module.exports = { needsCFProxy, isAvailable, fetchViaCFProxy };
