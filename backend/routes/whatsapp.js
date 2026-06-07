'use strict';

const express = require('express');
const pool    = require('../db/connection');
const auth    = require('../middleware/auth');
const evo     = require('../connectors/evolution');

const router = express.Router();
router.use(auth);
router.use((req, res, next) => {
  if (!req.subscriber.is_admin) return res.status(403).json({ error: 'Acesso restrito.' });
  next();
});

// Helper: pega o site do catálogo + garante nome de instância
async function getSite(siteId) {
  const { rows } = await pool.query(
    `SELECT id, name, evolution_instance, whatsapp_status, whatsapp_enabled FROM sites_catalog WHERE id = $1`,
    [siteId]
  );
  return rows[0] || null;
}

// ── POST /api/admin/whatsapp/:id/connect ──────────────────────────────────────
// Cria a instância (se ainda não existe) e retorna o QR code (base64) para escanear.
router.post('/:id/connect', async (req, res) => {
  if (!evo.disponivel()) return res.status(503).json({ error: 'Evolution API não configurada no servidor.' });
  try {
    const site = await getSite(req.params.id);
    if (!site) return res.status(404).json({ error: 'Portal não encontrado.' });

    let instancia = site.evolution_instance;
    if (!instancia) {
      instancia = evo.nomeInstancia(site.id);
      // Cria a instância (se já existir, a Evolution dá erro — ignoramos e seguimos pro QR)
      try { await evo.criarInstancia(instancia); } catch (e) {
        const msg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
        if (!/already|exists|in use|403|409/i.test(msg)) {
          console.error('[whatsapp/connect] criar instância:', msg);
        }
      }
      await pool.query(`UPDATE sites_catalog SET evolution_instance = $1, whatsapp_enabled = true WHERE id = $2`, [instancia, site.id]);
    }

    const qr = await evo.obterQRCode(instancia);
    const status = await evo.statusConexao(instancia);
    await pool.query(`UPDATE sites_catalog SET whatsapp_status = $1 WHERE id = $2`, [status, site.id]);

    if (status === 'open') return res.json({ instancia, status, connected: true });
    if (!qr) return res.status(502).json({ error: 'Não foi possível obter o QR code. Tente novamente.' });
    res.json({ instancia, status, qr });
  } catch (err) {
    console.error('[whatsapp/connect]', err.response?.data || err.message);
    res.status(500).json({ error: 'Falha ao conectar: ' + (err.response?.data?.message || err.message) });
  }
});

// ── GET /api/admin/whatsapp/:id/status ────────────────────────────────────────
// Consulta o status atual (usado em polling enquanto o QR está na tela).
router.get('/:id/status', async (req, res) => {
  if (!evo.disponivel()) return res.json({ status: 'indisponivel' });
  try {
    const site = await getSite(req.params.id);
    if (!site) return res.status(404).json({ error: 'Portal não encontrado.' });
    if (!site.evolution_instance) return res.json({ status: 'desconectado' });

    const status = await evo.statusConexao(site.evolution_instance);
    await pool.query(`UPDATE sites_catalog SET whatsapp_status = $1 WHERE id = $2`, [status, site.id]);
    res.json({ status, instancia: site.evolution_instance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/whatsapp/:id/grupos ────────────────────────────────────────
// Lista os grupos do número conectado (via Evolution, pode levar ~30s) marcando
// quais já estão selecionados (ativos) para este portal.
router.get('/:id/grupos', async (req, res) => {
  try {
    const site = await getSite(req.params.id);
    if (!site) return res.status(404).json({ error: 'Portal não encontrado.' });
    if (!site.evolution_instance) return res.status(400).json({ error: 'WhatsApp não conectado.' });

    const grupos = await evo.listarGrupos(site.evolution_instance); // [{ jid, nome }]
    const { rows: salvos } = await pool.query(
      `SELECT group_jid, ativo FROM grupos_whatsapp WHERE catalog_id = $1`, [site.id]
    );
    const ativos = new Map(salvos.map(s => [s.group_jid, s.ativo]));
    res.json(grupos.map(g => ({ jid: g.jid, nome: g.nome || g.jid, ativo: ativos.get(g.jid) === true })));
  } catch (err) {
    console.error('[whatsapp/grupos]', err.response?.data || err.message);
    res.status(500).json({ error: 'Falha ao listar grupos: ' + (err.response?.data?.message || err.message) });
  }
});

// ── POST /api/admin/whatsapp/:id/grupos ───────────────────────────────────────
// Salva a seleção: marca como ativos só os grupos enviados; desativa o resto.
router.post('/:id/grupos', async (req, res) => {
  try {
    const site = await getSite(req.params.id);
    if (!site) return res.status(404).json({ error: 'Portal não encontrado.' });
    const grupos = Array.isArray(req.body.grupos) ? req.body.grupos : []; // [{ jid, nome, ativo }]

    await pool.query(`UPDATE grupos_whatsapp SET ativo = false WHERE catalog_id = $1`, [site.id]);
    for (const g of grupos) {
      if (!g || !g.jid) continue;
      await pool.query(
        `INSERT INTO grupos_whatsapp (catalog_id, group_jid, nome, ativo)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (catalog_id, group_jid) DO UPDATE SET nome = EXCLUDED.nome, ativo = EXCLUDED.ativo`,
        [site.id, g.jid, g.nome || '', g.ativo === true]
      );
    }
    const nAtivos = grupos.filter(g => g.ativo).length;
    res.json({ ok: true, ativos: nAtivos });
  } catch (err) {
    console.error('[whatsapp/grupos-save]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/whatsapp/:id/disconnect ───────────────────────────────────
router.post('/:id/disconnect', async (req, res) => {
  try {
    const site = await getSite(req.params.id);
    if (!site) return res.status(404).json({ error: 'Portal não encontrado.' });
    if (site.evolution_instance) await evo.deletarInstancia(site.evolution_instance);
    await pool.query(
      `UPDATE sites_catalog SET evolution_instance = NULL, whatsapp_status = 'desconectado', whatsapp_enabled = false WHERE id = $1`,
      [site.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[whatsapp/disconnect]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
