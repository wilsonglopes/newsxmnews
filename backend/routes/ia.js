'use strict';

const express = require('express');
const axios   = require('axios');
const auth    = require('../middleware/auth');
const router  = express.Router();

router.use(auth);

function truncarSemEspacos(str, maxChars) {
  if (!str) return str;
  let count = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] !== ' ') count++;
    if (count > maxChars) {
      const pos = str.lastIndexOf(' ', i);
      return (pos > 0 ? str.slice(0, pos) : str.slice(0, i)).trimEnd();
    }
  }
  return str;
}

// Extrai JSON da resposta em texto livre da IA
function extrairJSON(texto) {
  if (!texto) return null;
  let resultado = null;
  try { resultado = JSON.parse(texto.trim()); } catch {}
  if (!resultado) { try { const m = texto.match(/\{[\s\S]*\}/); if (m) resultado = JSON.parse(m[0]); } catch {} }
  if (!resultado) { try { const m = texto.match(/```(?:json)?\s*([\s\S]*?)\s*```/); if (m) resultado = JSON.parse(m[1]); } catch {} }
  return resultado;
}

// Aplica limites editoriais ao resultado da IA
function aplicarLimites(resultado) {
  if (resultado.chapeu) {
    resultado.chapeu = resultado.chapeu.trim().split(/\s+/).slice(0, 2).join(' ').toUpperCase();
  }
  if (resultado.titulo) {
    resultado.titulo = truncarSemEspacos(resultado.titulo, 90);
  }
  if (resultado.resumo) {
    resultado.resumo = resultado.resumo.trim();
  }
  return resultado;
}

// POST /api/ia/rewrite
// Body: { title, content, ai_prompt?, provider? }
// provider: 'gemini' (padrão) | 'deepseek'
// Chaves lidas do .env — nunca expostas ao frontend
router.post('/rewrite', async (req, res) => {
  const { title = '', content = '', ai_prompt = '', provider = 'gemini' } = req.body;
  if (!content && !title) return res.status(400).json({ error: 'Forneça title ou content.' });

  const textoOriginal = content.replace(/<[^>]*>/g, '').trim();
  const nParas = (content.match(/<p[\s>]/gi) || []).length || Math.max(3, Math.ceil(textoOriginal.length / 400));

  const promptSistema = ai_prompt ||
    `Você é um editor de notícias profissional. Reescreva a matéria abaixo com linguagem jornalística clara e objetiva.
Retorne SOMENTE um JSON com:
{ "chapeu": string(máx 2 palavras em maiúsculas, ex: "ECONOMIA" ou "ECONOMIA DO BRASIL"), "titulo": string(máx 90 caracteres sem contar espaços), "resumo": string(frase completa com sentido, máx ~160 caracteres sem contar espaços — NUNCA termine no meio de uma oração; se necessário, use uma frase mais curta mas sempre encerre com ponto final), "corpo": string(HTML com <p> — OBRIGATÓRIO: mantenha extensão proporcional ao original; cubra TODOS os pontos e detalhes presentes no texto; use no mínimo ${nParas} parágrafos; NÃO comprima nem resuma em excesso), "tags": string[] }.`;

  try {
    let textoIA = '';

    if (provider === 'deepseek') {
      // ── DeepSeek (API compatível com OpenAI) ──────────────────────────────────
      const deepseekKey = process.env.DEEPSEEK_KEY || '';
      if (!deepseekKey) return res.status(503).json({ error: 'Chave DeepSeek não configurada no servidor.' });

      const resp = await axios.post(
        'https://api.deepseek.com/chat/completions',
        {
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: promptSistema },
            { role: 'user',   content: `TÍTULO: ${title}\n\nCONTEÚDO:\n${content}` }
          ],
          max_tokens: 4096,
          response_format: { type: 'json_object' }
        },
        {
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${deepseekKey}` },
          timeout: 60000
        }
      );
      textoIA = resp.data?.choices?.[0]?.message?.content || '';
    } else {
      // ── Gemini ────────────────────────────────────────────────────────────────
      const geminiKey = process.env.GEMINI_KEY || '';
      if (!geminiKey) return res.status(503).json({ error: 'Chave Gemini não configurada no servidor.' });

      const resp = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
        {
          system_instruction: { parts: [{ text: promptSistema }] },
          contents: [{ role: 'user', parts: [{ text: `TÍTULO: ${title}\n\nCONTEÚDO:\n${content}` }] }],
          generationConfig: { maxOutputTokens: 4096 }
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
      );
      textoIA = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }

    if (!textoIA) return res.status(502).json({ error: 'Resposta vazia da IA.' });

    const resultado = extrairJSON(textoIA);
    if (!resultado) return res.status(502).json({ error: 'Não foi possível interpretar a resposta da IA.' });

    res.json(aplicarLimites(resultado));
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    console.error(`[ia/rewrite][${provider}]`, msg);
    res.status(502).json({ error: msg });
  }
});

// POST /api/ia/categorize
// Body: { title, chapeu, tags, corpo, categories: [{id, name, parent}], provider? }
// Retorna { category_ids: [id1, id2, ...] } — falha silenciosa (retorna [] em caso de erro)
router.post('/categorize', async (req, res) => {
  const { title = '', chapeu = '', tags = '', corpo = '', categories = [], provider = 'gemini' } = req.body;
  if (!categories.length) return res.json({ category_ids: [] });
  if (!title && !chapeu && !corpo) return res.json({ category_ids: [] });

  // Monta lista hierárquica de categorias para o prompt
  const pais   = categories.filter(c => !c.parent);
  const filhos = categories.filter(c => c.parent);
  const paiIds = new Set(pais.map(c => c.id));
  const linhas = [];
  for (const pai of pais) {
    linhas.push(`[ID=${pai.id}] ${pai.name}`);
    for (const filho of filhos.filter(f => f.parent === pai.id)) {
      linhas.push(`  [ID=${filho.id}] ${filho.name} (subcategoria de: ${pai.name})`);
    }
  }
  for (const orfao of filhos.filter(f => !paiIds.has(f.parent))) {
    linhas.push(`[ID=${orfao.id}] ${orfao.name}`);
  }

  const listaCats       = linhas.join('\n');
  const corpoTruncado   = corpo.replace(/<[^>]*>/g, '').trim().slice(0, 600);
  const promptSistema   = `Você é um editor de notícias. Analise o artigo e selecione as categorias mais adequadas da lista fornecida.
Retorne SOMENTE um JSON no formato: { "category_ids": [id1, id2, ...] }

Regras:
- Selecione TODAS as categorias relevantes (pode ser mais de uma)
- Se a notícia menciona uma cidade/região específica, inclua TANTO a categoria pai (estado/região) QUANTO a subcategoria (cidade)
- Se o artigo aborda múltiplos temas (ex: saúde + localização), inclua categorias de todos os temas relevantes
- Se nenhuma categoria for exata, escolha a mais próxima semanticamente
- Retorne apenas IDs numéricos existentes na lista`;
  const conteudoArtigo = `CATEGORIAS DISPONÍVEIS:\n${listaCats}\n\nARTIGO:\nChapéu: ${chapeu}\nTítulo: ${title}\nTags: ${tags}\nConteúdo: ${corpoTruncado}`;

  try {
    let textoIA = '';

    if (provider === 'deepseek') {
      const deepseekKey = process.env.DEEPSEEK_KEY || '';
      if (!deepseekKey) return res.json({ category_ids: [] });

      const resp = await axios.post(
        'https://api.deepseek.com/chat/completions',
        {
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: promptSistema },
            { role: 'user',   content: conteudoArtigo }
          ],
          max_tokens: 256,
          response_format: { type: 'json_object' }
        },
        {
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DEEPSEEK_KEY}` },
          timeout: 30000
        }
      );
      textoIA = resp.data?.choices?.[0]?.message?.content || '';
    } else {
      const geminiKey = process.env.GEMINI_KEY || '';
      if (!geminiKey) return res.json({ category_ids: [] });

      const resp = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
        {
          system_instruction: { parts: [{ text: promptSistema }] },
          contents: [{ role: 'user', parts: [{ text: conteudoArtigo }] }],
          generationConfig: { maxOutputTokens: 256 }
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
      );
      textoIA = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }

    if (!textoIA) return res.json({ category_ids: [] });
    const resultado = extrairJSON(textoIA);
    const ids = Array.isArray(resultado?.category_ids)
      ? resultado.category_ids.map(Number).filter(n => n > 0)
      : [];
    res.json({ category_ids: ids });
  } catch (err) {
    console.error(`[ia/categorize][${provider}]`, err.response?.data?.error?.message || err.message);
    res.json({ category_ids: [] });
  }
});

// POST /api/ia/gerar
// Body: { tema, ai_prompt?, provider? }
// Gera artigo do zero a partir de um briefing — sem artigo de entrada
router.post('/gerar', async (req, res) => {
  const { tema = '', ai_prompt = '', provider = 'gemini' } = req.body;
  if (!tema || !tema.trim()) return res.status(400).json({ error: 'Forneça o tema do artigo.' });

  const promptSistema = ai_prompt ||
    `Você é um jornalista profissional. Com base no briefing fornecido, escreva um artigo jornalístico completo, original e informativo.
Retorne SOMENTE um JSON com:
{ "chapeu": string(máx 2 palavras em maiúsculas, ex: "ECONOMIA"), "titulo": string(máx 90 caracteres sem contar espaços), "resumo": string(frase completa com sentido, máx ~160 caracteres sem contar espaços — NUNCA termine no meio de uma oração; encerre com ponto final), "corpo": string(HTML com pelo menos 4 parágrafos em <p>), "tags": string[] }.`;

  try {
    let textoIA = '';

    if (provider === 'deepseek') {
      const deepseekKey = process.env.DEEPSEEK_KEY || '';
      if (!deepseekKey) return res.status(503).json({ error: 'Chave DeepSeek não configurada no servidor.' });
      const resp = await axios.post(
        'https://api.deepseek.com/chat/completions',
        {
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: promptSistema },
            { role: 'user',   content: `BRIEFING DO ARTIGO:\n${tema.trim()}` }
          ],
          max_tokens: 4096,
          response_format: { type: 'json_object' }
        },
        { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${deepseekKey}` }, timeout: 60000 }
      );
      textoIA = resp.data?.choices?.[0]?.message?.content || '';
    } else {
      const geminiKey = process.env.GEMINI_KEY || '';
      if (!geminiKey) return res.status(503).json({ error: 'Chave Gemini não configurada no servidor.' });
      const resp = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
        {
          system_instruction: { parts: [{ text: promptSistema }] },
          contents: [{ role: 'user', parts: [{ text: `BRIEFING DO ARTIGO:\n${tema.trim()}` }] }],
          generationConfig: { maxOutputTokens: 4096 }
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
      );
      textoIA = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }

    if (!textoIA) return res.status(502).json({ error: 'Resposta vazia da IA.' });
    const resultado = extrairJSON(textoIA);
    if (!resultado) return res.status(502).json({ error: 'Não foi possível interpretar a resposta da IA.' });

    res.json(aplicarLimites(resultado));
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    console.error(`[ia/gerar][${provider}]`, msg);
    res.status(502).json({ error: msg });
  }
});

module.exports = router;
