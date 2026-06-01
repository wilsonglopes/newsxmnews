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

// ── Helpers ────────────────────────────────────────────────────────────────────

function lerSettings() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf8')); } catch { return {}; }
}

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

// ── Chamada à IA (DeepSeek) ───────────────────────────────────────────────────

async function chamarIA(provider, systemPrompt, userContent, maxTokens = 4096) {
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

// ── Reescreve artigo com IA ───────────────────────────────────────────────────

// Regra inviolável injetada em QUALQUER prompt (customizado ou padrão)
const REGRA_ANTICOPIA = `
REGRA INVIOLÁVEL DE REESCRITA: PROIBIDO copiar frases ou trechos do texto original. Cada frase deve ser completamente reformulada com palavras e estruturas de frases diferentes. Escreva como se você conhecesse os fatos mas nunca tivesse lido o texto original — use seu próprio vocabulário e estilo jornalístico.`;

async function reescreverArtigo(artigo, aiPrompt, provider) {
  const promptBase = aiPrompt ||
    `Você é um editor de notícias profissional. Reescreva a matéria abaixo com linguagem jornalística clara e objetiva.
REGRAS OBRIGATÓRIAS:
- O campo "corpo" deve cobrir TODOS os pontos da matéria original com o mesmo nível de detalhe — NÃO resuma, reescreva.
- O corpo deve ter no mínimo o mesmo número de parágrafos do original. Quanto mais longa a matéria, mais longo o corpo.
- Cada parágrafo deve ser envolto em <p>...</p>.
Retorne SOMENTE um JSON com:
{ "chapeu": string(EXATAMENTE 1 palavra MAIÚSCULA autossuficiente — substantivo único como categoria, ex: "ECONOMIA", "POLÍTICA", "ESPORTES", "INDÚSTRIA", "SAÚDE". NUNCA use frases truncadas como "INDÚSTRIA DE" ou "MINISTÉRIO DA"), "titulo": string(máx 90 caracteres sem contar espaços), "resumo": string(uma frase única curta e completa, máx 130 caracteres, OBRIGATORIAMENTE terminando com ponto final, com sentido completo por si só — NÃO truncar palavra), "corpo": string(HTML com <p>, proporcional ao original), "tags": string[] }.`;

  // Injeta regra anti-cópia em qualquer prompt — customizado ou padrão
  const promptSistema = promptBase + REGRA_ANTICOPIA;

  const textoLimpo = (artigo.body || artigo.summary || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 6000);

  if (!textoLimpo && !artigo.title) throw new Error('Artigo sem conteúdo para reescrever.');

  const userContent = `TÍTULO: ${artigo.title}\n\nCONTEÚDO:\n${textoLimpo}`;

  let resultado = null;
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    try {
      const textoIA = await chamarIA(provider, promptSistema, userContent);
      resultado = extrairJSON(textoIA);
      if (resultado) break;
      console.warn(`[WORKER] Tentativa ${tentativa}: IA retornou JSON inválido para "${artigo.title.slice(0, 50)}"`);
    } catch (e) {
      if (tentativa === 2) throw e;
      console.warn(`[WORKER] Tentativa ${tentativa} falhou: ${e.message}. Retrying…`);
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
    console.log(`[WORKER] categorias "${site.name}": ${cats.length} encontradas`);
    return cats;
  } catch (e) {
    console.warn(`[WORKER] falha ao buscar categorias "${site.name}": ${e.message}`);
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
    const textoIA   = await chamarIA(provider, promptSistema, conteudo, 256);
    const resultado = extrairJSON(textoIA);
    const ids = Array.isArray(resultado?.category_ids)
      ? resultado.category_ids.map(Number).filter(n => n > 0)
      : [];
    console.log(`[WORKER] categorias IA retornou: [${ids.join(', ')}]`);
    return ids;
  } catch (e) {
    console.warn(`[WORKER] categorizarComIA falhou: ${e.message}`);
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
  } catch (e) { console.error('[WORKER] Erro ao registrar log:', e.message); }
}

// ── Producer: detecta artigos novos e enfileira ───────────────────────────────

async function rodarProdutor() {
  if (!pool) return;
  const settings = lerSettings();
  if (settings.autopub_enabled === false) return;

  const maxHoras = settings.autopub_max_horas ?? 2;

  const { rows: sites } = await pool.query(`
    SELECT DISTINCT ON (sc.id)
           ss.id AS site_id, ss.subscriber_id,
           sc.id AS catalog_id,
           COALESCE(sc.name, ss.name)         AS name,
           sc.instagram_enabled
    FROM subscriber_sites ss
    JOIN sites_catalog sc ON sc.id = ss.site_id
    JOIN subscribers   s  ON s.id  = ss.subscriber_id
    WHERE ss.active = true AND s.active = true
      AND COALESCE(sc.autopub_enabled, true) = true
      AND EXISTS (SELECT 1 FROM autopub_rules ar WHERE ar.catalog_id = sc.id)
    ORDER BY sc.id, ss.created_at
  `);

  if (!sites.length) return;

  let total = 0;
  for (const site of sites) {
    try {
      const { rows: regras } = await pool.query(
        `SELECT source_id FROM autopub_rules WHERE catalog_id = $1`,
        [site.catalog_id]
      );
      if (!regras.length) continue;
      const sourceIds = regras.map(r => r.source_id);

      const { rowCount } = await pool.query(`
        INSERT INTO autopub_queue
          (catalog_id, site_id, subscriber_id, source_id, article_id,
           publish_facebook, publish_instagram, default_category_id)
        SELECT $1, $2, $3, a.source_id, a.id,
               COALESCE(ar.facebook_enabled, false),
               $6::boolean,
               ar.default_category_id
        FROM articles a
        JOIN autopub_rules ar ON ar.catalog_id = $1 AND ar.source_id = a.source_id
        WHERE a.source_id = ANY($4::uuid[])
          AND a.fetched_at >= NOW() - make_interval(hours => $5::int)
          AND NOT EXISTS (
            SELECT 1 FROM autopub_log WHERE article_id = a.id AND site_id = $2
          )
        ON CONFLICT (catalog_id, article_id) DO NOTHING
      `, [site.catalog_id, site.site_id, site.subscriber_id, sourceIds, maxHoras, site.instagram_enabled]);

      if (rowCount > 0) {
        console.log(`[PRODUCER] "${site.name}": ${rowCount} artigo(s) enfileirado(s).`);
        total += rowCount;
      }
    } catch (e) {
      console.error(`[PRODUCER] Erro no site "${site.name}": ${e.message}`);
    }
  }
  if (total > 0) console.log(`[PRODUCER] Total enfileirado: ${total}`);
}

// ── Worker: processa 1 item da fila ──────────────────────────────────────────

async function processarProximoItem() {
  if (!pool) return;
  const settings   = lerSettings();
  const maxRetries = settings.worker_max_retries  ?? 3;
  const maxHoras   = settings.queue_max_age_horas ?? 12;

  // Reserva 1 item atomicamente com SELECT ... FOR UPDATE SKIP LOCKED
  const client = await pool.connect();
  let item = null;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      SELECT q.*,
             sc.name AS site_name, sc.platform, sc.site_url,
             sc.ai_prompt AS cat_ai_prompt,
             sc.wp_username AS sc_wp_username, sc.wp_app_password AS sc_wp_app_password,
             sc.xixo_api_key, sc.blogger_blog_id, sc.blogger_access_token, sc.blogger_refresh_token,
             sc.webhook_url, sc.webhook_secret, sc.post_format,
             sc.facebook_enabled AS site_facebook_enabled,
             sc.facebook_page_id, sc.facebook_page_token,
             sc.instagram_enabled AS site_instagram_enabled,
             sc.instagram_business_account_id, sc.instagram_username,
             ss.ai_prompt AS sub_ai_prompt,
             ss.wp_username AS ss_wp_username, ss.wp_app_password AS ss_wp_app_password,
             ss.default_category_id AS ss_default_category_id
      FROM autopub_queue q
      JOIN sites_catalog    sc ON sc.id = q.catalog_id
      JOIN subscriber_sites ss ON ss.id = q.site_id
      WHERE q.status = 'pending'
        AND q.attempts < $1
        AND q.enqueued_at > NOW() - make_interval(hours => $2::int)
        AND COALESCE(sc.autopub_enabled, true) = true
      ORDER BY q.enqueued_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `, [maxRetries, maxHoras]);

    if (!rows.length) { await client.query('ROLLBACK'); return; }
    item = rows[0];
    await client.query(
      `UPDATE autopub_queue SET status = 'processing', attempts = attempts + 1 WHERE id = $1`,
      [item.id]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  // Processa fora da transação
  try {
    await processarItem(item);
    await pool.query(
      `UPDATE autopub_queue SET status = 'done', processed_at = now(), error_message = null WHERE id = $1`,
      [item.id]
    );
    console.log(`[WORKER] ✓ concluído: ${item.site_name} — ${item.id}`);
  } catch (e) {
    // item.attempts é o valor ANTES do "attempts + 1" feito na reserva,
    // por isso comparamos com attempts + 1 (valor real após este ciclo).
    const tentativasFeitas = item.attempts + 1;
    const newStatus = tentativasFeitas >= maxRetries ? 'error' : 'pending';
    await pool.query(
      `UPDATE autopub_queue SET status = $1, error_message = $2, processed_at = now() WHERE id = $3`,
      [newStatus, e.message, item.id]
    );
    console.error(`[WORKER] ✗ ${item.site_name} (tentativa ${tentativasFeitas}/${maxRetries} → ${newStatus}): ${e.message}`);
  }
}

// ── Processa um item da fila (scraping + IA + publicação) ─────────────────────

async function processarItem(item) {
  const settings = lerSettings();
  const provider  = 'deepseek';

  // Monta objeto site compatível com os helpers existentes
  const site = {
    id:                item.site_id,
    catalog_id:        item.catalog_id,
    subscriber_id:     item.subscriber_id,
    name:              item.site_name,
    platform:          item.platform,
    site_url:          item.site_url,
    ai_prompt:         item.sub_ai_prompt || item.cat_ai_prompt,
    wp_username:       item.ss_wp_username || item.sc_wp_username,
    wp_app_password:   item.ss_wp_app_password || item.sc_wp_app_password,
    xixo_api_key:      item.xixo_api_key,
    blogger_blog_id:   item.blogger_blog_id,
    blogger_access_token:  item.blogger_access_token,
    blogger_refresh_token: item.blogger_refresh_token,
    webhook_url:       item.webhook_url,
    webhook_secret:    item.webhook_secret,
    post_format:       item.post_format,
    facebook_enabled:  item.site_facebook_enabled,
    facebook_page_id:  item.facebook_page_id,
    facebook_page_token: item.facebook_page_token,
    instagram_enabled: item.site_instagram_enabled,
    instagram_business_account_id: item.instagram_business_account_id,
    instagram_username: item.instagram_username,
  };

  // Busca artigo com dados da fonte
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
    WHERE a.id = $1
  `, [item.article_id]);
  if (!artigos.length) throw new Error('Artigo não encontrado');
  const artigo = artigos[0];

  // 0. Garante conteúdo completo (mesmo pipeline do frontend)
  const bodyTexto = (artigo.body || '').replace(/<[^>]*>/g, '').trim();
  console.log(`[WORKER] "${artigo.title?.slice(0, 50)}" — body=${bodyTexto.length}c image_url=${artigo.image_url || 'null'}`);

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
      let { body, image_url } = await fetchFullContent(artigo.external_url, sourceConf);

      // Se a 1ª tentativa trouxe corpo mas não imagem, tenta mais vezes com delays crescentes.
      // Comum em matérias recém-publicadas onde o CDN ainda não cacheou og:image
      // ou o servidor da fonte estava sobrecarregado no momento da coleta.
      if (!image_url && artigo.external_url) {
        const retryDelays = [5000, 12000]; // 5s e 12s — dá tempo ao CDN inicializar
        for (const delay of retryDelays) {
          if (image_url) break;
          console.log(`[WORKER] sem imagem, retry em ${delay / 1000}s: ${artigo.title?.slice(0, 50)}`);
          await new Promise(r => setTimeout(r, delay));
          const retry = await fetchFullContent(artigo.external_url, sourceConf);
          if (retry.image_url) image_url = retry.image_url;
          if (!body && retry.body) body = retry.body;
        }
      }

      if (body)      artigo.body      = body;
      if (image_url) artigo.image_url = image_url;
      console.log(`[WORKER] após scraping: body=${((body || '').replace(/<[^>]*>/g, '').trim().length)}c image_url=${artigo.image_url || 'null'}`);
      if (body || image_url) {
        await pool.query(
          'UPDATE articles SET body = $1, image_url = $2 WHERE id = $3',
          [artigo.body, artigo.image_url, artigo.id]
        );
      }
    } catch (scraperErr) {
      console.warn(`[WORKER] Scraping "${artigo.title?.slice(0, 50)}": ${scraperErr.message}`);
    }
  }

  const bodyFinal = (artigo.body || '').replace(/<[^>]*>/g, '').trim();
  if (bodyFinal.length < 100) {
    await registrarLog(artigo.id, site.id, site.subscriber_id, 'erro', 'Conteúdo insuficiente para publicar');
    throw new Error(`Conteúdo insuficiente (${bodyFinal.length} chars)`);
  }

  // 1. Reescreve com IA
  const reescrito = await reescreverArtigo(artigo, site.ai_prompt, provider);

  // 2. Busca categorias e categoriza
  const cats = await buscarCategorias(site);
  const catFixa = item.default_category_id || item.ss_default_category_id;
  if (catFixa) {
    reescrito.category_ids = [catFixa];
    console.log(`[WORKER] categoria fixa: [${catFixa}]`);
  } else {
    reescrito.category_ids = await categorizarComIA(reescrito, cats, provider);
  }

  // 3. Publica no CMS
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

  // 4.1 Publica no Facebook + Instagram (se configurado, habilitado e com imagem)
  // Artigos sem imagem (ex: Assembleia Legislativa) geram card com fundo vazio — não publicar.
  const querPostarFB = site.facebook_enabled
    && item.publish_facebook
    && site.facebook_page_id
    && site.facebook_page_token
    && !!artigo.image_url;

  if (querPostarFB) {
    try {
      const { gerarCard, gerarCardComUrl } = require('./utils/card-generator');
      const { publicarFoto }               = require('./connectors/facebook');
      const { publicar: publicarInstagram } = require('./connectors/instagram');
      const querPostarIG = site.instagram_enabled && site.instagram_business_account_id && item.publish_instagram;
      const pageToken    = decryptToken(site.facebook_page_token);

      const socialConfig = site.social_config || {};
      let cardBuffer, cardPublicUrl, cardFpath;
      if (querPostarIG) {
        const r = await gerarCardComUrl({
          chapeu:     reescrito.chapeu || artigo.chapeu || '',
          titulo:     reescrito.title  || artigo.title  || '',
          imageUrl:   artigo.image_url || '',
          cardConfig: socialConfig,
        });
        cardBuffer    = r.buffer;
        cardPublicUrl = r.publicUrl;
        cardFpath     = r.fpath;
      } else {
        cardBuffer = await gerarCard({
          chapeu:     reescrito.chapeu || artigo.chapeu || '',
          titulo:     reescrito.title  || artigo.title  || '',
          imageUrl:   artigo.image_url || '',
          cardConfig: socialConfig,
        });
      }

      try {
        const fb = await publicarFoto(
          { facebook_page_id: site.facebook_page_id, facebook_page_token: pageToken },
          cardBuffer,
          { chapeu: reescrito.chapeu, title: reescrito.title, summary: reescrito.summary, post_url: resultado.post_url, captionConfig: socialConfig }
        );
        await pool.query(
          `UPDATE publications SET facebook_post_id = $1, facebook_post_url = $2
           WHERE subscriber_id = $3 AND article_id = $4 AND site_id = $5 AND status = 'published'`,
          [fb.photo_id || fb.post_id, fb.post_url, site.subscriber_id, artigo.id, site.id]
        );
        console.log(`[WORKER/FB] ✓ "${reescrito.title.slice(0, 50)}" → ${fb.post_url || 'OK'}`);
      } catch (fbErr) {
        console.error(`[WORKER/FB] ✗ "${reescrito.title.slice(0, 50)}": ${fbErr.message}`);
      }

      if (querPostarIG && cardPublicUrl) {
        try {
          const ig = await publicarInstagram(
            {
              instagram_business_account_id: site.instagram_business_account_id,
              facebook_page_token: pageToken,
            },
            cardPublicUrl,
            { chapeu: reescrito.chapeu, title: reescrito.title, summary: reescrito.summary, post_url: resultado.post_url }
          );
          await pool.query(
            `UPDATE publications SET instagram_post_id = $1, instagram_post_url = $2
             WHERE subscriber_id = $3 AND article_id = $4 AND site_id = $5 AND status = 'published'`,
            [ig.post_id, ig.post_url, site.subscriber_id, artigo.id, site.id]
          );
          console.log(`[WORKER/IG] ✓ "${reescrito.title.slice(0, 50)}" → ${ig.post_url || 'OK'}`);
        } catch (igErr) {
          console.error(`[WORKER/IG] ✗ "${reescrito.title.slice(0, 50)}": ${igErr.message}`);
        }
      }

      if (cardFpath) { try { require('fs').unlinkSync(cardFpath); } catch {} }

    } catch (socialErr) {
      console.error(`[WORKER/SOCIAL] ✗ "${reescrito.title.slice(0, 50)}": ${socialErr.message}`);
    }
  }

  await registrarLog(artigo.id, site.id, site.subscriber_id, 'ok', null);
  console.log(`[WORKER] ✓ "${reescrito.title.slice(0, 60)}" → ${site.name}`);
}

// ── Loop contínuo do worker: 1 item a cada 30s ────────────────────────────────

let _workerAtivo = true;

async function workerLoop() {
  console.log('[WORKER] Iniciado — 1 item a cada 10s.');
  while (_workerAtivo) {
    await new Promise(r => setTimeout(r, 10000));
    if (!_workerAtivo) break;
    const settings = lerSettings();
    if (settings.autopub_enabled === false) continue;
    try {
      await processarProximoItem();
    } catch (e) {
      console.error('[WORKER] Erro inesperado:', e.message);
    }
  }
}

module.exports = { rodarProdutor, workerLoop };
