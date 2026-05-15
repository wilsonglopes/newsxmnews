'use strict';

// Download de recursos (imagens) via Puppeteer/Chromium.
// Necessário para fontes protegidas por WAF/TLS fingerprinting (ex: *.sc.gov.br)
// onde axios/node-https são bloqueados (HTTP 403), mas o Chromium passa.

const PUPPETEER_OPTS = {
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  ...(process.env.PUPPETEER_EXECUTABLE_PATH && { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }),
};

async function downloadImageHeadless(url, { timeout = 30000 } = {}) {
  const puppeteer = require('puppeteer');
  let browser;
  try {
    browser = await puppeteer.launch(PUPPETEER_OPTS);
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    const response = await page.goto(url, { waitUntil: 'load', timeout });
    if (!response) throw new Error('Sem resposta do Chromium');
    const status = response.status();
    if (status >= 400) throw new Error(`HTTP ${status}`);

    const buffer      = await response.buffer();
    const contentType = (response.headers()['content-type'] || 'image/jpeg').split(';')[0].trim();
    return { buffer, contentType };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { downloadImageHeadless };
