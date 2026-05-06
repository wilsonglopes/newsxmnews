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

// POST /api/ia/rewrite
// Body: { title, content, ai_prompt? }
// Usa GEMINI_KEY do .env (chave do sistema — nunca exposta ao frontend)
router.post('/rewrite', async (req, res) => {
  const geminiKey = process.env.GEMINI_KEY || '';
  if (!geminiKey) return res.status(503).json({ error: 'Chave Gemini não configurada no servidor.' });

  const { title = '', content = '', ai_prompt = '' } = req.body;
  if (!content && !title) return res.status(400).json({ error: 'Forneça title ou content.' });

  const promptSistema = ai_prompt ||
    `Você é um editor de notícias profissional. Reescreva a matéria abaixo com linguagem jornalística clara e objetiva.
Retorne SOMENTE um JSON com:
{ "chapeu": string(máx 2 palavras em maiúsculas, ex: "ECONOMIA" ou "ECONOMIA DO BRASIL"), "titulo": string(máx 90 caracteres sem contar espaços), "resumo": string(máx 160 caracteres sem contar espaços), "corpo": string(HTML com <p>), "tags": string[] }.`;

  try {
    const resp = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
      {
        system_instruction: { parts: [{ text: promptSistema }] },
        contents: [{ role: 'user', parts: [{ text: `TÍTULO: ${title}\n\nCONTEÚDO:\n${content}` }] }],
        generationConfig: { maxOutputTokens: 4096 }
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
    );

    const textoIA = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!textoIA) return res.status(502).json({ error: 'Resposta vazia da IA.' });

    // Extrai JSON da resposta
    let resultado = null;
    try { resultado = JSON.parse(textoIA.trim()); } catch {}
    if (!resultado) { try { const m = textoIA.match(/\{[\s\S]*\}/); if (m) resultado = JSON.parse(m[0]); } catch {} }
    if (!resultado) { try { const m = textoIA.match(/```(?:json)?\s*([\s\S]*?)\s*```/); if (m) resultado = JSON.parse(m[1]); } catch {} }

    if (!resultado) return res.status(502).json({ error: 'Não foi possível interpretar a resposta da IA.' });

    // Aplica limites editoriais
    if (resultado.chapeu) {
      resultado.chapeu = resultado.chapeu.trim().split(/\s+/).slice(0, 2).join(' ').toUpperCase();
    }
    if (resultado.titulo) {
      resultado.titulo = truncarSemEspacos(resultado.titulo, 90);
    }
    if (resultado.resumo) {
      resultado.resumo = truncarSemEspacos(resultado.resumo, 160);
    }

    res.json(resultado);
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    console.error('[ia/rewrite]', msg);
    res.status(502).json({ error: msg });
  }
});

module.exports = router;
