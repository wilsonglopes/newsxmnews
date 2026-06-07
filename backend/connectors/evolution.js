'use strict';

// Integração com a Evolution API (WhatsApp via Baileys).
// Instalação compartilhada na porta 8080 — o XIXO cria instâncias com prefixo `xixo-`,
// isoladas das do outro sistema (Candidatos). Fala só pela API HTTP (não toca no banco do Evolution).

const axios = require('axios');

const BASE = () => (process.env.EVOLUTION_API_URL || 'http://localhost:8080').replace(/\/$/, '');
const KEY  = () => process.env.EVOLUTION_API_KEY || '';
const headers = () => ({ apikey: KEY(), 'Content-Type': 'application/json' });

function disponivel() {
  return !!KEY() && !!process.env.EVOLUTION_API_URL;
}

// Nome de instância do XIXO a partir do id do site (prefixo evita colisão com Candidatos)
function nomeInstancia(siteId) {
  return `xixo-${String(siteId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`;
}

// Cria a instância (idempotente: se já existe, a Evolution retorna erro 403/409 — tratado pelo chamador)
async function criarInstancia(nome) {
  const r = await axios.post(`${BASE()}/instance/create`, {
    instanceName: nome,
    qrcode:       true,
    integration:  'WHATSAPP-BAILEYS',
  }, { headers: headers(), timeout: 15000 });
  return r.data;
}

// QR code (base64) para o painel exibir. Cria a conexão se necessário.
async function obterQRCode(instancia) {
  const r = await axios.get(`${BASE()}/instance/connect/${instancia}`, { headers: headers(), timeout: 15000 });
  return r.data?.base64 || r.data?.qrcode?.base64 || null;
}

// Status: 'open' (conectado) | 'connecting' | 'close' | 'desconhecido' | 'erro'
async function statusConexao(instancia) {
  try {
    const r = await axios.get(`${BASE()}/instance/fetchInstances`, { headers: headers(), timeout: 10000 });
    const lista = r.data || [];
    const inst = lista.find(i => i.name === instancia || i.instance?.instanceName === instancia);
    if (!inst) return 'inexistente';
    return inst.connectionStatus || inst.instance?.state || 'desconhecido';
  } catch {
    return 'erro';
  }
}

// Remove a instância (desconectar/recriar)
async function deletarInstancia(instancia) {
  try {
    await axios.delete(`${BASE()}/instance/logout/${instancia}`, { headers: headers(), timeout: 10000 }).catch(() => {});
    await axios.delete(`${BASE()}/instance/delete/${instancia}`, { headers: headers(), timeout: 10000 });
    return true;
  } catch (e) {
    return false;
  }
}

// Lista grupos do número conectado (fetchAllGroups sincroniza via Baileys — pode levar ~30s)
async function listarGrupos(instancia) {
  const r = await axios.get(`${BASE()}/group/fetchAllGroups/${instancia}?getParticipants=false`, {
    headers: headers(), timeout: 45000,
  });
  return (r.data || []).map(g => ({ jid: g.id, nome: g.subject }));
}

module.exports = {
  disponivel, nomeInstancia, criarInstancia, obterQRCode, statusConexao, deletarInstancia, listarGrupos, BASE, headers,
};
