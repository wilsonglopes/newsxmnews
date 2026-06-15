'use strict';

/**
 * 🔄 Auto-update do plugin Portal Publisher (push por botão no admin).
 *
 * - GET  /api/plugin/download            → serve o ZIP do plugin (PHP na RAIZ).
 *                                           URL fixa que o self-update do plugin baixa.
 * - GET  /api/admin/plugin/status        → versão instalada em cada portal.
 * - POST /api/admin/plugin/update-all    → dispara o self-update em todos os portais.
 *
 * REGRA CRÍTICA: o .php vai na RAIZ do zip (sem pasta) — com pasta, o WP diz
 * "arquivo não existe" e a instalação falha. Confirmado pelo Wilson.
 */

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const axios    = require('axios');
const https    = require('https');
const AdmZip   = require('adm-zip');
const pool     = require('../db/connection');
const auth     = require('../middleware/auth');

const HTTPS_AGENT = new https.Agent({ rejectUnauthorized: false });
const PLUGIN_PHP  = path.join(__dirname, '../../portal-publisher/portal-publisher.php');

// Lê a versão declarada no header do PHP
function versaoDoPlugin() {
  try {
    const src = fs.readFileSync(PLUGIN_PHP, 'utf8');
    const m = src.match(/^\s*\*\s*Version:\s*([0-9.]+)/im);
    return m ? m[1] : null;
  } catch { return null; }
}

// Gera o ZIP em memória com o .php na RAIZ
function gerarZip() {
  const zip = new AdmZip();
  zip.addLocalFile(PLUGIN_PHP);           // entra como "portal-publisher.php" na raiz
  return zip.toBuffer();
}

// ── Router PÚBLICO: download do ZIP (o WP de cada portal baixa daqui) ─────────
const publicRouter = express.Router();
publicRouter.get('/download', (req, res) => {
  try {
    const buf = gerarZip();
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', 'attachment; filename="portal-publisher.zip"');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: 'Falha ao gerar o ZIP do plugin: ' + err.message });
  }
});

// ── Router ADMIN: status e update-all ────────────────────────────────────────
const adminRouter = express.Router();
adminRouter.use(auth);
adminRouter.use((req, res, next) => {
  if (!req.subscriber.is_admin) return res.status(403).json({ error: 'Acesso restrito.' });
  next();
});

// Portais que têm o plugin (chave configurada)
async function portaisComPlugin() {
  const { rows } = await pool.query(
    `SELECT id, name, site_url, xixo_api_key
     FROM sites_catalog
     WHERE active = true AND xixo_api_key IS NOT NULL AND site_url IS NOT NULL
     ORDER BY name`
  );
  return rows;
}

// GET /api/admin/plugin/status — versão atual do código + versão de cada portal
adminRouter.get('/status', async (req, res) => {
  const atual = versaoDoPlugin();
  const portais = await portaisComPlugin();
  const resultados = await Promise.all(portais.map(async (p) => {
    const baseUrl = p.site_url.replace(/\/$/, '');
    try {
      const r = await axios.get(`${baseUrl}/wp-json/xmn/v1/status`, {
        timeout: 12000, httpsAgent: HTTPS_AGENT,
        headers: { 'X-XMNews-Key': p.xixo_api_key },
      });
      const v = r.data?.version || null;
      return { id: p.id, name: p.name, versao: v, atualizado: v === atual, online: true };
    } catch (e) {
      // Plugin antigo sem /status, ou site fora — marca como desconhecido
      return { id: p.id, name: p.name, versao: null, atualizado: false, online: false,
               erro: e.response?.status === 404 ? 'plugin antigo (sem /status)' : (e.code || 'sem resposta') };
    }
  }));
  res.json({ versao_atual: atual, portais: resultados });
});

// POST /api/admin/plugin/update-all — dispara self-update em todos os portais
adminRouter.post('/update-all', async (req, res) => {
  const atual = versaoDoPlugin();
  const portais = await portaisComPlugin();
  const resultados = await Promise.all(portais.map(async (p) => {
    const baseUrl = p.site_url.replace(/\/$/, '');
    try {
      const r = await axios.post(`${baseUrl}/wp-json/xmn/v1/self-update`, {}, {
        timeout: 90000, httpsAgent: HTTPS_AGENT,
        headers: { 'Content-Type': 'application/json', 'X-XMNews-Key': p.xixo_api_key },
      });
      if (r.data?.success) return { id: p.id, name: p.name, ok: true };
      return { id: p.id, name: p.name, ok: false, erro: r.data?.error || 'resposta inesperada' };
    } catch (e) {
      const motivo = e.response?.status === 404
        ? 'plugin antigo (sem self-update) — atualizar manual 1x'
        : (e.response?.data?.error || e.code || e.message);
      return { id: p.id, name: p.name, ok: false, erro: motivo };
    }
  }));
  const ok = resultados.filter(r => r.ok).length;
  res.json({ versao_alvo: atual, total: resultados.length, sucesso: ok, resultados });
});

module.exports = { publicRouter, adminRouter };
