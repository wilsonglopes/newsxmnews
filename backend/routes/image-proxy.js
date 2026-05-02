'use strict';

const express = require('express');
const axios   = require('axios');
const router  = express.Router();

// Domínios permitidos para proxy (segurança — evita SSRF)
const ALLOWED_HOSTS = [
  'nsctotal.com.br', 'img.nsctotal.com.br',
  'metropoles.com', 'img.metropoles.com',
  'cnnbrasil.com.br',
  'jovempan.com.br',
  'agenciabrasil.ebc.com.br',
  'agenciaesporte.com.br',
  'ndmais.com.br', 'img.ndmais.com.br',
  'portalc1.com.br',
  'danuzionews.com',
  'enfoquesc.com.br',
  'alesc.sc.gov.br',
  'portaldoagronegocio.com.br',
  'sombrio.sc.gov.br',
  'praiagrande.atende.net',
  'jacintomachado.atende.net',
  'jarbasvieira.com',
  'static.wixstatic.com',
  'sommaior.com.br',
  'wp.com', 'i0.wp.com', 'i1.wp.com', 'i2.wp.com',
];

// GET /api/proxy-image?url=<encoded>
router.get('/', async (req, res) => {
  const { url } = req.query;

  if (!url) return res.status(400).send('url obrigatória');

  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).send('url inválida'); }

  // Verifica host permitido
  const host = parsed.hostname.replace(/^www\./, '');
  const allowed = ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h));
  if (!allowed) return res.status(403).send('host não permitido');

  // Só imagens
  if (!/\.(jpe?g|png|gif|webp|avif|svg)(\?.*)?$/i.test(parsed.pathname) &&
      !url.includes('wp-content/uploads') &&
      !url.includes('image') && !url.includes('foto') && !url.includes('imag')) {
    // Permissivo: deixa passar — o content-type vai validar
  }

  try {
    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        // Sem Referer — mascara a origem
      },
      maxRedirects: 5,
    });

    const ct = resp.headers['content-type'] || 'image/jpeg';
    if (!ct.startsWith('image/')) return res.status(415).send('não é imagem');

    res.set('Content-Type', ct);
    res.set('Cache-Control', 'public, max-age=86400'); // cache 24h
    res.set('Access-Control-Allow-Origin', '*');
    res.send(Buffer.from(resp.data));

  } catch (err) {
    console.error('[proxy-image]', err.message);
    res.status(502).send('erro ao buscar imagem');
  }
});

module.exports = router;
