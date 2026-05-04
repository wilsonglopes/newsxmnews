'use strict';

const express = require('express');
const axios   = require('axios');
const auth    = require('../middleware/auth');
const router  = express.Router();

router.use(auth);

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
Retorne SOMENTE um JSON com: { "chapeu": string(máx 60 chars), "titulo": string, "resumo": string(máx 200 chars), "corpo": string(HTML com <p>), "tags": string[] }.`;

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

    res.json(resultado);
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    console.error('[ia/rewrite]', msg);
    res.status(502).json({ error: msg });
  }
});

module.exports = router;
