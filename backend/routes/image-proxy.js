'use strict';

const express = require('express');
const axios   = require('axios');
const router  = express.Router();

// Domínios permitidos para proxy (segurança — evita SSRF)
const ALLOWED_HOSTS = [
  // Portais de notícia
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
  // Globo / G1 / O Globo
  'glbimg.com', 'oglobo.globo.com', 'g1.globo.com',
  'oglobo.com', 's3.glbimg.com', 'i.s3.glbimg.com',
  // Poder Legislativo Federal
  'senado.leg.br',
  'camara.leg.br',
  // Assembleias legislativas
  'alesc.sc.gov.br',
  'al.rs.gov.br',
  // Portais regionais do Acre
  'folhadoacre.com.br',
  'ecosdanoticia.net',
  'contilnetnoticias.com.br',
  'agazetadoacre.com',
  'portalacre.com.br',
  'nahoradanoticia.com.br',
  // Prefeituras (.rs.gov.br, .sc.gov.br, .ac.gov.br, .sp.gov.br, atende.net)
  'rs.gov.br',
  'sc.gov.br',
  'ac.gov.br',   // Rio Branco, Cruzeiro do Sul, e todas as demais prefeituras do Acre
  'al.ac.leg.br', // Assembleia Legislativa do Acre
  'sp.gov.br',   // Prefeituras SP e governo do estado (Praia Grande, etc.)
  'atende.net',
  // WordPress CDNs
  'static.wixstatic.com',
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
  if (!/\.(jpe?g|jfif|png|gif|webp|avif|svg)(\?.*)?$/i.test(parsed.pathname) &&
      !url.includes('wp-content/uploads') &&
      !url.includes('image') && !url.includes('foto') && !url.includes('imag')) {
    // Permissivo: deixa passar — o content-type vai validar
  }

  // Limite máximo de 10 MB para evitar abuso de banda
  const MAX_BYTES = 10 * 1024 * 1024;

  // Domínios com hotlink protection que exigem Referer do próprio site
  const NEEDS_OWN_REFERER = ['sombrio.sc.gov.br'];
  const needsReferer = NEEDS_OWN_REFERER.some(h => parsed.hostname === h || parsed.hostname.endsWith('.' + h));

  try {
    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 8000,
      maxContentLength: MAX_BYTES,
      maxBodyLength:    MAX_BYTES,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        ...(needsReferer ? { 'Referer': `${parsed.origin}/` } : {}),
      },
      maxRedirects: 5,
      validateStatus: s => s >= 200 && s < 300,
    });

    const ct = resp.headers['content-type'] || 'image/jpeg';
    if (!ct.startsWith('image/')) return res.status(415).send('não é imagem');

    // Validação extra de tamanho (defesa em profundidade)
    const buf = Buffer.from(resp.data);
    if (buf.length > MAX_BYTES) return res.status(413).send('imagem muito grande');

    res.set('Content-Type', ct);
    res.set('Content-Length', buf.length);
    res.set('Cache-Control', 'public, max-age=86400'); // cache 24h
    res.set('Access-Control-Allow-Origin', '*');
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(buf);

  } catch (err) {
    console.error('[proxy-image]', err.message);
    const status = err.response?.status || 502;
    res.status(status >= 400 && status < 600 ? status : 502).send('erro ao buscar imagem');
  }
});

module.exports = router;
