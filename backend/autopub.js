'use strict';

const axios  = require('axios');
const https  = require('https');
const path   = require('path');
const fs     = require('fs');
const pool   = require('./db/connection');
const { publishToWordPress } = require('./connectors/wordpress');
const { publishToBlogger }   = require('./connectors/blogger');
const { publishViaWebhook }  = require('./connectors/webhook');
const { fetchFullContent }   = require('./scrapers/full-content');
const { decryptToken }       = require('./connectors/encrypt');

const HTTPS_AGENT = new https.Agent({ rejectUnauthorized: false });

let _rodando     = false;    // mutex simples — evita execuções sobrepostas
let _ultimaRodada = null;   // timestamp da última execução bem-sucedida

// Chamado a cada minuto pelo cron — decide se é hora de rodar
async function verificarERotar() {
  const settings = lerSettings();
  if (settings.autopub_enabled === false) return;

  const intervaloMs = (settings.autopub_interval_minutos || 15) * 60 * 1000;
  const agora = Date.now();

  if (_ultimaRodada && agora - _ultimaRodada < intervaloMs) return; // ainda não chegou a hora

  _ultimaRodada = agora;
  rodarAutopub().catch(e => console.error('[AUTOPUB] Erro inesperado:', e.message));
}

function lerSettings() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf8')); } catch { return {}; }
}

// ── Helpers de texto (replicados de routes/ia.js para uso interno) ────────────

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

function extrairJSON(texto) {
  if (!texto) return null;
  let r = null;
  try { r = JSON.parse(texto.trim()); } catch {}
  if (!r) { try { const m = texto.match(/\{[\s\S]*\}/); if (m) r = JSON.parse(m[0]); } catch {} }
  if (!r) { try { const m = texto.match(/```(?:json)?\s*([\s\S]*?)\s*```/); if (m) r = JSON.parse(m[1]); } catch {} }
  return r;
}

// ── Chamada genérica à IA (Gemini ou DeepSeek) ────────────────────────────────

async function chamarIA(provider, systemPrompt, userContent, maxTokens = 4096) {
  if (provider === 'deepseek') {
    const key = process.env.DEEPSEEK_KEY || '';
    if (!key) throw new Error('Chave DeepSeek não configurada.');
    const resp = await axios.post(
      'https://api.deepseek.com/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }],
        max_tokens: maxTokens,
        response_format: { type: 'json_object' }
      },
      { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` }, timeout: 60000 }
    );
    return resp.data?.choices?.[0]?.message?.content || '';
  }

  // Gemini (padrão)
  const key = process.env.GEMINI_KEY || '';
  if (!key) throw new Error('Chave Gemini não configurada.');
  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
    {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userContent }] }],
      generationConfig: { maxOutputTokens: maxTokens }
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
  );
  return resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ── Reescreve artigo com IA ───────────────────────────────────────────────────

async function reescreverArtigo(artigo, aiPrompt, provider) {
  const promptSistema = aiPrompt ||
    `Você é um editor de notícias profissional. Reescreva a matéria abaixo com linguagem jornalística clara e objetiva.
REGRAS OBRIGATÓRIAS:
- O campo "corpo" deve cobrir TODOS os pontos da matéria original com o mesmo nível de detalhe — NÃO resuma, reescreva.
- O corpo deve ter no mínimo o mesmo número de parágrafos do original. Quanto mais longa a matéria, mais longo o corpo.
- Cada parágrafo deve ser envolto em <p>...</p>.
Retorne SOMENTE um JSON com:
{ "chapeu": string(máx 2 palavras em maiúsculas, ex: "ECONOMIA"), "titulo": string(máx 90 caracteres sem contar espaços), "resumo": string(frase completa com sentido, máx ~160 caracteres sem contar espaços — NUNCA termine no meio de uma oração; encerre com ponto final), "corpo": string(HTML com <p>, proporcional ao original), "tags": string[] }.`;

  // Remove HTML e trunca em 6000 chars — aumentado para não cortar artigos longos
  const textoLimpo = (artigo.body || artigo.summary || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 6000);

  if (!textoLimpo && !artigo.title) throw new Error('Artigo sem conteúdo para reescrever.');

  const userContent = `TÍTULO: ${artigo.title}\n\nCONTEÚDO:\n${textoLimpo}`;

  // Tenta chamar a IA; em caso de resposta inválida, faz 1 retry
  let resultado = null;
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    try {
      const textoIA = await chamarIA(provider, promptSistema, userContent);
      resultado = extrairJSON(textoIA);
      if (resultado) break;
      console.warn(`[AUTOPUB] Tentativa ${tentativa}: IA retornou JSON inválido para "${artigo.title.slice(0, 50)}"`);
    } catch (e) {
      if (tentativa === 2) throw e;
      console.warn(`[AUTOPUB] Tentativa ${tentativa} falhou: ${e.message}. Retrying…`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  if (!resultado) throw new Error('IA não retornou JSON válido após 2 tentativas.');

  if (resultado.chapeu) resultado.chapeu = resultado.chapeu.trim().split(/\s+/).slice(0, 2).join(' ').toUpperCase();
  if (resultado.titulo) resultado.titulo = truncarSemEspacos(resultado.titulo, 90);

  return {
    chapeu:       resultado.chapeu  || '',
    title:        resultado.titulo  || resultado.title  || artigo.title,
    summary:      resultado.resumo  || resultado.summary || '',
    body:         resultado.corpo   || resultado.body   || '',
    tags:         resultado.tags    || [],
    category_ids: [],
  };
}

// ── Busca categorias do WordPress ─────────────────────────────────────────────

async function buscarCategorias(site) {
  const baseUrl = (site.site_url || '').replace(/\/$/, '');
  try {
    // Headers vazios — sem User-Agent de browser, que o ModSecurity bloqueia.
    // Credenciais incluídas se disponíveis, mas o endpoint é público no WP.
    const headers = {};
    if (site.wp_username && site.wp_app_password) {
      const password = decryptToken(site.wp_app_password);
      if (password) headers['Authorization'] = `Basic ${Buffer.from(`${site.wp_username}:${password}`).toString('base64')}`;
    }
    const resp = await axios.get(`${baseUrl}/wp-json/wp/v2/categories?per_page=100&orderby=name&order=asc`, {
      timeout:    10000,
      httpsAgent: HTTPS_AGENT,
      headers,
    });
    const cats = Array.isArray(resp.data)
      ? resp.data.map(c => ({ id: c.id, name: c.name, parent: c.parent || null }))
      : [];
    console.log(`[AUTOPUB] categorias "${site.name}": ${cats.length} encontradas`);
    return cats;
  } catch (e) {
    console.warn(`[AUTOPUB] falha ao buscar categorias "${site.name}": ${e.message}`);
    return [];
  }
}

// ── Categoriza artigo com IA ──────────────────────────────────────────────────

async function categorizarComIA(reescrito, cats, provider) {
  if (!cats.length) return [];

  const pais   = cats.filter(c => !c.parent);
  const filhos = cats.filter(c =>  c.parent);
  const paiIds = new Set(pais.map(c => c.id));
  const linhas = [];
  for (const pai of pais) {
    linhas.push(`[ID=${pai.id}] ${pai.name}`);
    for (const filho of filhos.filter(f => f.parent === pai.id))
      linhas.push(`  [ID=${filho.id}] ${filho.name} (subcategoria de: ${pai.name})`);
  }
  for (const orfao of filhos.filter(f => !paiIds.has(f.parent)))
    linhas.push(`[ID=${orfao.id}] ${orfao.name}`);

  const promptSistema = `Você é um editor de notícias. Analise o artigo e selecione as categorias mais adequadas.
Retorne SOMENTE um JSON: { "category_ids": [id1, id2, ...] }
Regras:
- Selecione TODAS as categorias relevantes
- Se menciona cidade/região, inclua pai (estado) E subcategoria (cidade)
- Se aborda múltiplos temas, inclua todas as categorias pertinentes
- Retorne apenas IDs numéricos existentes na lista`;

  const corpoTruncado = (reescrito.body || '').replace(/<[^>]*>/g, '').trim().slice(0, 600);
  const conteudo = `CATEGORIAS:\n${linhas.join('\n')}\n\nARTIGO:\nChapéu: ${reescrito.chapeu}\nTítulo: ${reescrito.title}\nTags: ${(reescrito.tags || []).join(', ')}\nConteúdo: ${corpoTruncado}`;

  try {
    const textoIA  = await chamarIA(provider, promptSistema, conteudo, 256);
    const resultado = extrairJSON(textoIA);
    const ids = Array.isArray(resultado?.category_ids)
      ? resultado.category_ids.map(Number).filter(n => n > 0)
      : [];
    console.log(`[AUTOPUB] categorias IA retornou: [${ids.join(', ')}]`);
    return ids;
  } catch (e) {
    console.warn(`[AUTOPUB] categorizarComIA falhou: ${e.message}`);
    return [];
  }
}

// ── Registra resultado no log ─────────────────────────────────────────────────

async function registrarLog(articleId, siteId, subscriberId, status, errorMsg) {
  try {
    await pool.query(
      `INSERT INTO autopub_log (article_id, site_id, subscriber_id, status, error_msg)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (article_id, site_id)
       DO UPDATE SET status = $4, error_msg = $5, processed_at = now()`,
      [articleId, siteId, subscriberId, status, errorMsg || null]
    );
  } catch (e) { console.error('[autopub] Erro ao registrar log:', e.message); }
}

// ── Rodada principal ──────────────────────────────────────────────────────────

async function rodarAutopub() {
  if (!pool)     return;
  if (_rodando)  { console.log('[AUTOPUB] Rodada anterior ainda em execução, pulando.'); return; }

  const settings = lerSettings();
  if (settings.autopub_enabled === false) return;

  const provider     = settings.ia_provider          || 'gemini';
  const maxPorSite   = settings.autopub_max_por_rodada || 3;

  _rodando = true;
  try {
    const { rows: sites } = await pool.query(`
      SELECT DISTINCT ON (sc.id) ss.id, COALESCE(ss.ai_prompt, sc.ai_prompt) AS ai_prompt, ss.default_category_id,
             s.id AS subscriber_id,
             sc.id AS catalog_id,
             COALESCE(sc.name, ss.name)                       AS name,
             COALESCE(sc.platform, ss.platform)               AS platform,
             COALESCE(sc.site_url, ss.site_url)               AS site_url,
             COALESCE(sc.wp_username, ss.wp_username)         AS wp_username,
             COALESCE(sc.wp_app_password, ss.wp_app_password) AS wp_app_password,
             COALESCE(sc.xixo_api_key, ss.xixo_api_key)       AS xixo_api_key,
             COALESCE(sc.blogger_blog_id, ss.blogger_blog_id) AS blogger_blog_id,
             COALESCE(sc.blogger_access_token, ss.blogger_access_token)   AS blogger_access_token,
             COALESCE(sc.blogger_refresh_token, ss.blogger_refresh_token) AS blogger_refresh_token,
             COALESCE(sc.webhook_url, ss.webhook_url)         AS webhook_url,
             COALESCE(sc.webhook_secret, ss.webhook_secret)   AS webhook_secret,
             COALESCE(sc.post_format, ss.post_format)         AS post_format
      FROM subscriber_sites ss
      JOIN sites_catalog sc ON sc.id = ss.site_id
      JOIN subscribers   s  ON s.id  = ss.subscriber_id
      WHERE ss.active = true AND s.active = true
        AND EXISTS (SELECT 1 FROM autopub_rules ar WHERE ar.catalog_id = sc.id)
      ORDER BY sc.id, ss.created_at
    `);

    if (!sites.length) return;
    console.log(`[AUTOPUB] ${sites.length} site(s) ativo(s).`);

    for (const site of sites) {
      try {
        // Fontes configuradas nas regras de autopub — buscadas pelo catálogo do site
        const catalogId = site.catalog_id;
        if (!catalogId) continue; // site legado sem vínculo ao catálogo, pula
        const { rows: regras } = await pool.query(
          `SELECT source_id, default_category_id FROM autopub_rules WHERE catalog_id = $1`,
          [catalogId]
        );

        if (!regras.length) continue; // site sem fontes configuradas
        const sourceIds = regras.map(r => r.source_id);
        // Mapa sourceId → categoryId fixo (null = usar IA)
        const catPorFonte = Object.fromEntries(
          regras.map(r => [String(r.source_id), r.default_category_id || null])
        );

        // Artigos novos não processados para este site
        // Só processa artigos coletados nas últimas N horas (padrão 2h) — evita publicar notícias antigas
        const maxHoras = settings.autopub_max_horas ?? 2;
        const { rows: artigos } = await pool.query(`
          SELECT a.*,
                 so.name AS source_name,
                 so.content_selector,
                 so.featured_image_selector,
                 so.extract_body_image,
                 so.slug   AS source_slug,
                 so.category AS source_category
          FROM articles a
          JOIN sources so ON so.id = a.source_id
          WHERE a.source_id = ANY($1::uuid[])
            AND a.fetched_at >= NOW() - make_interval(hours => $4::int)
            AND a.id NOT IN (
              SELECT article_id FROM autopub_log WHERE site_id = $2
            )
          ORDER BY a.published_at DESC NULLS LAST, a.fetched_at DESC
          LIMIT $3
        `, [sourceIds, site.id, maxPorSite, maxHoras]);

        if (!artigos.length) continue;
        console.log(`[AUTOPUB] "${site.name}": ${artigos.length} artigo(s) para processar.`);

        const cats = await buscarCategorias(site);

        for (const artigo of artigos) {
          try {
            // 0. Garante conteúdo completo — mesmo pipeline do modal do frontend.
            // Artigos recém-chegados do RSS têm apenas o snippet (200-400 chars).
            // Se o corpo for curto, raspa a página original antes de reescrever.
            const bodyTexto = (artigo.body || '').replace(/<[^>]*>/g, '').trim();
            const imgAntes  = artigo.image_url || null;
            console.log(`[AUTOPUB] "${artigo.title?.slice(0,50)}" — body=${bodyTexto.length}c image_url=${imgAntes || 'null'}`);

            // Imagem é thumbnail WP se tiver -150x150. ou -300x225. no nome
            const isThumbnailWP = (url) => {
              if (!url) return false;
              const mParam = url.match(/[,/?&]width=(\d+)/i);
              if (mParam && parseInt(mParam[1]) < 280) return true;
              const mFile = url.match(/-(\d+)x\d+\.(?:jpe?g|jfif|png|gif|webp|avif)/i);
              return mFile ? parseInt(mFile[1]) < 400 : false;
            };
            if ((bodyTexto.length < 800 || !artigo.image_url || isThumbnailWP(artigo.image_url)) && artigo.external_url) {
              try {
                const sourceConf = {
                  content_selector:        artigo.content_selector        || null,
                  featured_image_selector: artigo.featured_image_selector || null,
                  url:                     artigo.external_url,
                  category:                artigo.source_category         || '',
                  extract_body_image:      artigo.extract_body_image      || false,
                };
                const { body, image_url } = await fetchFullContent(artigo.external_url, sourceConf);
                if (body)      artigo.body      = body;
                if (image_url) artigo.image_url = image_url;
                console.log(`[AUTOPUB] após scraping: body=${((body||'').replace(/<[^>]*>/g,'').trim().length)}c image_url=${artigo.image_url || 'null'}`);
                if (body || image_url) {
                  await pool.query(
                    'UPDATE articles SET body = $1, image_url = $2 WHERE id = $3',
                    [artigo.body, artigo.image_url, artigo.id]
                  );
                }
              } catch (scraperErr) {
                console.warn(`[AUTOPUB] Scraping "${artigo.title?.slice(0,50)}": ${scraperErr.message}`);
              }
            }

            // Pula artigo se ainda ficou sem conteúdo suficiente após scraping
            const bodyFinal = (artigo.body || '').replace(/<[^>]*>/g, '').trim();
            if (bodyFinal.length < 100) {
              console.warn(`[AUTOPUB] Pulando "${artigo.title?.slice(0,50)}" — corpo muito curto (${bodyFinal.length} chars)`);
              await registrarLog(artigo.id, site.id, site.subscriber_id, 'erro', 'Conteúdo insuficiente para publicar');
              continue;
            }

            // 1. Reescreve
            const reescrito = await reescreverArtigo(artigo, site.ai_prompt, provider);

            // 2. Categoriza — usa categoria fixa da regra ou delega à IA
            const catFixa = catPorFonte[String(artigo.source_id)];
            if (catFixa) {
              reescrito.category_ids = [catFixa];
              console.log(`[AUTOPUB] categoria fixa (fonte ${artigo.source_name}): [${catFixa}]`);
            } else {
              reescrito.category_ids = await categorizarComIA(reescrito, cats, provider);
            }

            // 3. Publica
            let resultado;
            switch (site.platform) {
              case 'wordpress': resultado = await publishToWordPress(site, reescrito, artigo); break;
              case 'blogger':   resultado = await publishToBlogger(site, reescrito, artigo);   break;
              case 'webhook':   resultado = await publishViaWebhook(site, reescrito, artigo);  break;
              default: throw new Error(`Plataforma desconhecida: ${site.platform}`);
            }

            // 4. Grava publicação
            const tagsStr = Array.isArray(reescrito.tags) ? reescrito.tags.join(', ') : null;
            const catsStr = reescrito.category_ids?.length
              ? reescrito.category_ids.map(id => cats.find(c => c.id === id)?.name).filter(Boolean).join(', ')
              : null;
            await pool.query(
              `INSERT INTO publications
                 (subscriber_id, article_id, site_id, platform,
                  external_post_id, external_post_url,
                  rewritten_title, rewritten_body,
                  rewritten_chapeu, rewritten_summary, rewritten_tags, rewritten_categories, status)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'published')`,
              [
                site.subscriber_id, artigo.id, site.id, site.platform,
                resultado.post_id, resultado.post_url,
                reescrito.title, reescrito.body,
                reescrito.chapeu || null, reescrito.summary || null, tagsStr, catsStr,
              ]
            );

            await registrarLog(artigo.id, site.id, site.subscriber_id, 'ok', null);
            console.log(`[AUTOPUB] ✓ "${reescrito.title.slice(0, 60)}" → ${site.name}`);

          } catch (err) {
            console.error(`[AUTOPUB] ✗ "${artigo.title.slice(0, 50)}" → ${site.name}: ${err.message}`);
            await registrarLog(artigo.id, site.id, site.subscriber_id, 'erro', err.message);
          }

          // Pausa entre artigos — espaça as publicações para parecer mais natural no site
          await new Promise(r => setTimeout(r, 20000));
        }

      } catch (err) {
        console.error(`[AUTOPUB] Erro no site "${site.name}": ${err.message}`);
      }
    }
  } finally {
    _rodando = false;
    console.log('[AUTOPUB] Rodada concluída.');
  }
}

module.exports = { rodarAutopub, verificarERotar };
