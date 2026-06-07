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
