'use strict';

// Publicação WhatsApp de alto nível — compartilhada por TODAS as ferramentas
// (bot Telegram, Publicar, Criar Post, Autopublicação). Uma lógica, um lugar.
// Envia a matéria + card para os grupos que o portal selecionou na configuração.

const pool = require('../db/connection');
const evo  = require('./evolution');

// Grupos selecionados (ativos) do portal. `catalogId` = sites_catalog.id.
async function buscarGruposAtivos(catalogId) {
  if (!catalogId) return [];
  try {
    const { rows } = await pool.query(
      `SELECT group_jid, nome FROM grupos_whatsapp WHERE catalog_id = $1 AND ativo = true`,
      [catalogId]
    );
    return rows;
  } catch { return []; }
}

// WhatsApp pronto para publicar = habilitado + conectado + tem grupo selecionado.
async function whatsappDisponivel(site) {
  if (!site || !site.whatsapp_enabled || !site.evolution_instance) return false;
  if (!evo.disponivel()) return false;
  const grupos = await buscarGruposAtivos(site.catalog_id);
  return grupos.length > 0;
}

// Legenda da mensagem (formatação leve do WhatsApp: *negrito*).
function montarLegenda({ chapeu, titulo, resumo, postUrl } = {}) {
  const partes = [];
  if (chapeu) partes.push(`*${String(chapeu).toUpperCase()}*`);
  if (titulo) partes.push(`*${titulo}*`);
  if (resumo) partes.push(resumo);
  if (postUrl) partes.push(`\n🔗 ${postUrl}`);
  return partes.join('\n\n');
}

// Publica nos grupos ativos do portal. Com `cardUrl` (URL pública) envia imagem+legenda;
// sem ela, envia só texto. Retorna { ok, falhas, total, info } — `info` é o resumo p/ logar/exibir.
async function publicarNosGrupos(site, { chapeu, titulo, resumo, postUrl, cardUrl } = {}) {
  if (!site || !site.evolution_instance) return { ok: 0, falhas: 0, total: 0, info: '' };
  const grupos = await buscarGruposAtivos(site.catalog_id);
  if (grupos.length === 0) return { ok: 0, falhas: 0, total: 0, info: '💬 WhatsApp: nenhum grupo selecionado.' };

  const legenda = montarLegenda({ chapeu, titulo, resumo, postUrl });
  const nome = site.site_name || site.name || site.evolution_instance;
  let ok = 0, falhas = 0;
  for (const g of grupos) {
    try {
      if (cardUrl) await evo.enviarImagem(site.evolution_instance, g.group_jid, cardUrl, legenda);
      else         await evo.enviarTexto(site.evolution_instance, g.group_jid, legenda);
      ok++;
      console.log(`[WA] ✓ ${nome} → ${g.nome || g.group_jid}`);
    } catch (err) {
      falhas++;
      console.error(`[WA] ✗ ${nome} → ${g.nome || g.group_jid}: ${err.response?.data?.message || err.message}`);
    }
  }
  const info = `💬 WhatsApp: ${ok} enviado(s)${falhas ? `, ${falhas} falha(s)` : ''} de ${grupos.length} grupo(s).`;
  return { ok, falhas, total: grupos.length, info };
}

module.exports = { buscarGruposAtivos, whatsappDisponivel, montarLegenda, publicarNosGrupos };
