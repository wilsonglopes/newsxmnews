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

// Coordenadas do template (1600×2000 — proporção 4:5, otimizado para Instagram)
const CARD = {
  width:  1600,
  height: 2000,
  fotoArea:    { x: 0, y: 0, w: 1600, h: 1195 },                                  // área da foto (transparente no template)
  chapeuBox:   { x: 77, y: 1274, w: 657, h: 127, centerX: 405, centerY: 1337 },   // caixa laranja
  resumoArea:  { x: 90, y: 1450, w: 1420, h: 530 },                               // área do texto resumo
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

// Extrai apenas a primeira frase completa (até o primeiro . ! ?) de um texto.
// Garante que o card sempre termine com pontuação final, sem reticências.
function primeiraFrase(texto) {
  const t = (texto || '').trim();
  if (!t) return '';
  // Match: até o primeiro pontuação de fim de frase
  const m = t.match(/^[^.!?]+[.!?]/);
  if (m && m[0].length >= 40) return m[0].trim();
  // Se a primeira frase é muito curta (<40 chars), pega até 2 frases
  const m2 = t.match(/^[^.!?]+[.!?][^.!?]+[.!?]/);
  if (m2) return m2[0].trim();
  // Caso extremo: texto sem pontuação, adiciona ponto
  return t.replace(/[,;:\-]?$/, '') + '.';
}

// Quebra texto em linhas. Se passar de maxLinhas, corta a última palavra inteira
// e termina com ponto final (sem reticências) pra dar sensação de fechamento.
function quebrarLinhas(texto, maxCharsPorLinha, maxLinhas) {
  const palavras = (texto || '').replace(/\s+/g, ' ').trim().split(' ');
  const linhas = [];
  let linhaAtual = '';
  let estouroNaUltima = false;
  for (const p of palavras) {
    const tentativa = linhaAtual ? `${linhaAtual} ${p}` : p;
    if (tentativa.length <= maxCharsPorLinha) {
      linhaAtual = tentativa;
    } else {
      if (linhaAtual) linhas.push(linhaAtual);
      linhaAtual = p;
      if (linhas.length >= maxLinhas) { estouroNaUltima = true; break; }
    }
  }
  if (linhaAtual && linhas.length < maxLinhas) linhas.push(linhaAtual);

  // Se a IA mandou texto maior que cabe, garante que termina com pontuação final
  if (estouroNaUltima) {
    let ult = linhas[linhas.length - 1];
    if (!/[.!?]$/.test(ult)) ult = ult.replace(/[,;:\-]?$/, '') + '.';
    linhas[linhas.length - 1] = ult;
  }
  return linhas;
}

// SVG dos textos (chapéu + título)
function montarSvgTextos(chapeu, titulo) {
  // Chapéu: pega só a primeira palavra (1 palavra MAIÚSCULA, evita "INDÚSTRIA DE" etc)
  const chapeuRaw = (chapeu || '').trim();
  // Pega primeira palavra substantiva ignorando preposições/artigos curtos
  const palavras = chapeuRaw.split(/\s+/);
  let chapeuFinal = palavras[0] || '';
  // Se a primeira palavra é uma preposição/artigo, tenta a segunda
  if (/^(DA|DO|DE|DAS|DOS|EM|NO|NA|COM|PARA|POR|A|O)$/i.test(chapeuFinal) && palavras[1]) {
    chapeuFinal = palavras[1];
  }
  const chapeuTexto = escapeXml(chapeuFinal.toUpperCase());

  // 42 chars/linha (margem de segurança para fontes mais largas em pt-BR); 6 linhas de capacidade
  const linhasTitulo = quebrarLinhas(titulo || '', 42, 6);
  const lineHeight = 80;
  const resumoY0 = CARD.resumoArea.y + 50;

  // Justificação: todas as linhas EXCETO a última recebem textLength=resumoArea.w
  // com lengthAdjust='spacing' (estica APENAS os espaços entre palavras — não distorce as letras)
  const lastIdx = linhasTitulo.length - 1;
  const tspans = linhasTitulo
    .map((l, i) => {
      const palavrasLinha = l.trim().split(/\s+/);
      const ehUltima = i === lastIdx;
      // Não justifica: última linha; linhas com 1 palavra só; linhas muito curtas (< 60% da largura)
      const podeJustificar = !ehUltima && palavrasLinha.length > 1 && l.length >= 28;
      const attrs = podeJustificar
        ? `textLength="${CARD.resumoArea.w}" lengthAdjust="spacing"`
        : '';
      return `<tspan x="${CARD.resumoArea.x}" dy="${i === 0 ? 0 : lineHeight}" ${attrs}>${escapeXml(l)}</tspan>`;
    })
    .join('');

  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg width="${CARD.width}" height="${CARD.height}" xmlns="http://www.w3.org/2000/svg">
  <style>
    .chapeu { font-family: 'Montserrat', 'DejaVu Sans', sans-serif; font-weight: 700; font-size: 58px; fill: #ffffff; letter-spacing: 2px; }
    .resumo { font-family: 'Open Sans', 'DejaVu Sans', sans-serif; font-weight: 400; font-size: 60px; fill: #ffffff; }
  </style>
  <text x="${CARD.chapeuBox.centerX}" y="${CARD.chapeuBox.centerY + 20}" class="chapeu" text-anchor="middle">${chapeuTexto}</text>
  <text class="resumo" y="${resumoY0}">${tspans}</text>
</svg>`);
}

const UA_BOT     = 'XIXO-News-Bot/1.0 (contato: wilsonglopes@gmail.com)';
const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Baixa imagem — tenta primeiro com UA de bot, depois com UA de browser se falhar
async function baixarImagem(url) {
  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    throw new Error(`URL de imagem inválida: "${url}"`);
  }

  const tentativas = [
    { 'User-Agent': UA_BOT },
    { 'User-Agent': UA_BROWSER },
    { 'User-Agent': UA_BROWSER, 'Referer': new URL(url).origin + '/' },
  ];

  let lastErr;
  for (const headers of tentativas) {
    try {
      const r = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 20000,
        headers,
        maxRedirects: 5,
      });
      const ct = r.headers['content-type'] || '';
      // Telegram retorna application/octet-stream pra fotos do bot; aceita e deixa Sharp validar
      const ctOk = ct.startsWith('image/') || ct === 'application/octet-stream' || ct === '';
      if (!ctOk) throw new Error(`Resposta não é imagem: ${ct}`);
      const buf = Buffer.from(r.data);
      if (buf.length < 1000) throw new Error(`Imagem muito pequena (${buf.length} bytes) — provavelmente bloqueada`);
      return buf;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// ─── Gerador principal ──────────────────────────────────────────────────────

async function gerarCard({ chapeu, titulo, imageUrl }) {
  // 1) Baixa foto e ajusta pra área da foto
  let fotoBuffer;
  try {
    const original = await baixarImagem(imageUrl);
    fotoBuffer = await sharp(original)
      .resize(CARD.fotoArea.w, CARD.fotoArea.h, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: 95 })
      .toBuffer();
  } catch (err) {
    console.warn(`[card-generator] falha ao baixar imagem "${imageUrl}": ${err.message}`);
    // Fallback: gradiente azul-escuro (melhor visual que cinza sólido)
    fotoBuffer = await sharp({
      create: { width: CARD.fotoArea.w, height: CARD.fotoArea.h, channels: 3, background: '#0f172a' },
    })
      .composite([{
        input: Buffer.from(
          `<svg width="${CARD.fotoArea.w}" height="${CARD.fotoArea.h}" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="#1e3a5f"/>
                <stop offset="100%" stop-color="#0f172a"/>
              </linearGradient>
            </defs>
            <rect width="100%" height="100%" fill="url(#g)"/>
          </svg>`
        ),
        top: 0, left: 0,
      }])
      .png()
      .toBuffer();
  }

  // 2) Cria canvas 1080x1080 com a foto no topo
  const canvas = await sharp({
    create: { width: CARD.width, height: CARD.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: fotoBuffer, top: 0, left: 0 }])
    .png()
    .toBuffer();

  // 3) Sobrepõe template e textos
  const svgTextos = montarSvgTextos(chapeu, titulo);

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
