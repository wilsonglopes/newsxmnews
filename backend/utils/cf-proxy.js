'use strict';

// Proxy via Cloudflare Workers para URLs bloqueadas na Oracle Cloud (*.sc.gov.br).
// Variáveis de ambiente: CF_PROXY_URL e CF_PROXY_TOKEN

const axios = require('axios');
const https = require('https');
const HTTPS_AGENT = new https.Agent({ rejectUnauthorized: false });

function needsCFProxy(url) {
  try { return new URL(url).hostname.endsWith('.sc.gov.br'); }
  catch { return false; }
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
