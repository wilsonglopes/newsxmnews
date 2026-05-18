'use strict';

const sharp  = require('sharp');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const axios  = require('axios');

const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'xmnews-facebook.png');
const UPLOADS_DIR   = path.join(__dirname, '..', 'public', 'uploads', 'cards');

// Garante que o diretório existe
try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch {}

// Coordenadas do template (1080×1080)
const CARD = {
  width:  1080,
  height: 1080,
  fotoArea:    { x: 0, y: 0, w: 1080, h: 615 },  // área da foto (transparente no template)
  chapeuBox:   { x: 61, y: 674, w: 356, h: 71, centerX: 239, centerY: 709 },
  resumoArea:  { x: 70, y: 790, w: 940, h: 260 },// área do texto resumo
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Quebra texto em linhas baseado em largura máxima (aproximação por chars)
function quebrarLinhas(texto, maxCharsPorLinha, maxLinhas) {
  const palavras = (texto || '').replace(/\s+/g, ' ').trim().split(' ');
  const linhas = [];
  let linhaAtual = '';
  for (const p of palavras) {
    const tentativa = linhaAtual ? `${linhaAtual} ${p}` : p;
    if (tentativa.length <= maxCharsPorLinha) {
      linhaAtual = tentativa;
    } else {
      if (linhaAtual) linhas.push(linhaAtual);
      linhaAtual = p;
      if (linhas.length >= maxLinhas - 1) break;
    }
  }
  if (linhaAtual && linhas.length < maxLinhas) linhas.push(linhaAtual);
  // Se truncou, adiciona "..." na última
  if (linhas.length === maxLinhas) {
    const ultima = linhas[maxLinhas - 1];
    if (ultima.length > maxCharsPorLinha - 3) {
      linhas[maxLinhas - 1] = ultima.substring(0, maxCharsPorLinha - 3).trim() + '...';
    } else {
      linhas[maxLinhas - 1] = ultima + '...';
    }
  }
  return linhas;
}

// SVG dos textos (chapéu + resumo)
function montarSvgTextos(chapeu, resumo) {
  const chapeuTexto = escapeXml((chapeu || '').toUpperCase());
  const linhasResumo = quebrarLinhas(resumo || '', 42, 4);
  const lineHeight = 56;
  const resumoY0 = CARD.resumoArea.y + 30;

  const tspans = linhasResumo
    .map((l, i) => `<tspan x="${CARD.resumoArea.x}" dy="${i === 0 ? 0 : lineHeight}">${escapeXml(l)}</tspan>`)
    .join('');

  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg width="${CARD.width}" height="${CARD.height}" xmlns="http://www.w3.org/2000/svg">
  <style>
    .chapeu { font-family: 'Montserrat', 'DejaVu Sans', sans-serif; font-weight: 700; font-size: 32px; fill: #ffffff; letter-spacing: 1px; }
    .resumo { font-family: 'Open Sans', 'DejaVu Sans', sans-serif; font-weight: 400; font-size: 40px; fill: #ffffff; }
  </style>
  <text x="${CARD.chapeuBox.centerX}" y="${CARD.chapeuBox.centerY + 11}" class="chapeu" text-anchor="middle">${chapeuTexto}</text>
  <text class="resumo" y="${resumoY0}">${tspans}</text>
</svg>`);
}

// Baixa imagem da URL — Wikimedia exige UA identificável; outros aceitam UA vazio
async function baixarImagem(url) {
  const isWikimedia = /wikimedia|wikipedia/i.test(url);
  const headers = isWikimedia
    ? { 'User-Agent': 'XIXO-News-Bot/1.0 (contato: wilsonglopes@gmail.com)' }
    : { 'User-Agent': '' };
  const r = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 20000,
    headers,
    maxRedirects: 5,
  });
  return Buffer.from(r.data);
}

// ─── Gerador principal ──────────────────────────────────────────────────────

async function gerarCard({ chapeu, resumo, imageUrl }) {
  // 1) Baixa foto e ajusta pra área da foto
  let fotoBuffer;
  try {
    const original = await baixarImagem(imageUrl);
    fotoBuffer = await sharp(original)
      .resize(CARD.fotoArea.w, CARD.fotoArea.h, { fit: 'cover', position: 'centre' })
      .toBuffer();
  } catch (err) {
    // Sem foto → fundo cinza
    fotoBuffer = await sharp({
      create: { width: CARD.fotoArea.w, height: CARD.fotoArea.h, channels: 3, background: '#1e293b' },
    }).png().toBuffer();
  }

  // 2) Cria canvas 1080x1080 com a foto no topo
  const canvas = await sharp({
    create: { width: CARD.width, height: CARD.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: fotoBuffer, top: 0, left: 0 }])
    .png()
    .toBuffer();

  // 3) Sobrepõe template e textos
  const svgTextos = montarSvgTextos(chapeu, resumo);

  const cardFinal = await sharp(canvas)
    .composite([
      { input: TEMPLATE_PATH, top: 0, left: 0 },
      { input: svgTextos,     top: 0, left: 0 },
    ])
    .jpeg({ quality: 92 })
    .toBuffer();

  return cardFinal;
}

// Gera card e SALVA em disco, retornando o caminho relativo e URL pública.
// Use quando precisar de URL acessível externamente (Instagram exige).
async function gerarCardComUrl(payload) {
  const buffer = await gerarCard(payload);
  const id     = crypto.randomBytes(8).toString('hex');
  const fname  = `card-${id}.jpg`;
  const fpath  = path.join(UPLOADS_DIR, fname);
  fs.writeFileSync(fpath, buffer);
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const publicUrl = base ? `${base}/api/uploads/cards/${fname}` : `/api/uploads/cards/${fname}`;
  return { buffer, fname, fpath, publicUrl };
}

// Limpa cards antigos (> 7 dias). Pode ser chamado por cron.
function limparCardsAntigos(diasMax = 7) {
  try {
    const limite = Date.now() - diasMax * 24 * 60 * 60 * 1000;
    const arquivos = fs.readdirSync(UPLOADS_DIR);
    let removidos = 0;
    for (const f of arquivos) {
      const fp = path.join(UPLOADS_DIR, f);
      const stat = fs.statSync(fp);
      if (stat.mtimeMs < limite) {
        fs.unlinkSync(fp);
        removidos++;
      }
    }
    if (removidos) console.log(`[card-generator] ${removidos} cards antigos removidos.`);
  } catch (e) { console.warn('[card-generator] cleanup:', e.message); }
}

module.exports = { gerarCard, gerarCardComUrl, limparCardsAntigos, CARD, UPLOADS_DIR };
