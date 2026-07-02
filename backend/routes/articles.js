'use strict';

const express             = require('express');
const pool                = require('../db/connection');
const auth                = require('../middleware/auth');
const { fetchFullContent } = require('../scrapers/full-content');

const router = express.Router();

// Migração idempotente — garante coluna extract_body_image
pool.query(`
  DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name='sources' AND column_name='extract_body_image'
    ) THEN
      ALTER TABLE sources ADD COLUMN extract_body_image BOOLEAN DEFAULT false;
    END IF;
  END $$;
`).catch(e => console.error('[articles] migration extract_body_image:', e.message));

// Migração idempotente — garante colunas rewritten_chapeu, rewritten_summary, rewritten_tags em publications
pool.query(`
  DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name='publications' AND column_name='rewritten_chapeu'
    ) THEN
      ALTER TABLE publications ADD COLUMN rewritten_chapeu TEXT;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name='publications' AND column_name='rewritten_summary'
    ) THEN
      ALTER TABLE publications ADD COLUMN rewritten_summary TEXT;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name='publications' AND column_name='rewritten_tags'
    ) THEN
      ALTER TABLE publications ADD COLUMN rewritten_tags TEXT;
    END IF;
  END $$;
`).catch(e => console.error('[articles] migration publications columns:', e.message));

// Migração idempotente — coluna 'unavailable' (artigo removido/404 na fonte)
pool.query(`
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='articles' AND column_name='unavailable')
      THEN ALTER TABLE articles ADD COLUMN unavailable BOOLEAN DEFAULT false; END IF;
  END $$;
`).catch(e => console.error('[articles] migration unavailable:', e.message));

// Todas as rotas requerem JWT
router.use(auth);

// ── GET /api/articles ─────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { source, search, period, page = 1, limit = 30 } = req.query;
  const offset = (Math.max(1, Number(page)) - 1) * Number(limit);

  try {
    const conditions = ['1=1'];
    const params     = [];
    let   p          = 1;

    // Esconde artigos marcados como removidos na fonte (404) — não polui a lista
    conditions.push('COALESCE(a.unavailable, false) = false');

    // Filtra por fontes do assinante (ignora admin — admin vê tudo)
    if (!req.subscriber.is_admin) {
      conditions.push(`so.id IN (
        SELECT source_id FROM subscriber_sources WHERE subscriber_id = $${p++}
      )`);
      params.push(req.subscriber.id);
    }

    // Filtro de fonte
    if (source) {
      conditions.push(`so.slug = $${p++}`);
      params.push(source);
    }

    // Filtro de busca
    if (search) {
      conditions.push(`(a.title ILIKE $${p++} OR a.summary ILIKE $${p})`);
      params.push(`%${search}%`, `%${search}%`);
      p++;
    }

    // Filtro de período
    if (period) {
      const mapPeriod = { today: '1 day', '24h': '24 hours', '3d': '3 days' };
      const interval  = mapPeriod[period];
      if (interval) {
        conditions.push(`a.published_at >= now() - interval '${interval}'`);
      }
    }

    const where = conditions.join(' AND ');

    const countRes = await pool.query(
      `SELECT COUNT(*) FROM articles a
       JOIN sources so ON so.id = a.source_id
       WHERE ${where}`,
      params
    );
    const total = parseInt(countRes.rows[0].count, 10);

    const rows = await pool.query(
      `SELECT a.id, a.title, a.chapeu, a.summary, a.image_url, a.published_at,
              a.external_url, a.tags,
              so.name AS source_name, so.slug AS source_slug, so.category
       FROM articles a
       JOIN sources so ON so.id = a.source_id
       WHERE ${where}
       ORDER BY a.published_at DESC
       LIMIT $${p++} OFFSET $${p}`,
      [...params, Number(limit), offset]
    );

    res.json({
      articles: rows.rows,
      total,
      page:  Number(page),
      pages: Math.ceil(total / Number(limit))
    });
  } catch (err) {
    console.error('[articles/list]', err.message);
    res.status(500).json({ error: 'Erro ao buscar artigos.' });
  }
});

// ── GET /api/articles/:id ─────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.*, so.name AS source_name, so.slug AS source_slug, so.category
       FROM articles a
       JOIN sources so ON so.id = a.source_id
       WHERE a.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Artigo não encontrado.' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[articles/get]', err.message);
    res.status(500).json({ error: 'Erro ao buscar artigo.' });
  }
});

// ── GET /api/articles/:id/full-content ────────────────────────────────────────
router.get('/:id/full-content', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.external_url, a.body, a.image_url, a.source_id,
              so.content_selector, so.featured_image_selector,
              so.slug AS source_slug, so.category,
              so.extract_body_image
       FROM articles a
       LEFT JOIN sources so ON so.id = a.source_id
       WHERE a.id = $1`,
      [req.params.id]
    );
    const article = rows[0];
    if (!article) return res.status(404).json({ error: 'Artigo não encontrado.' });

    // Fallback: se source_id não está vinculado, busca a fonte pelo domínio da URL do artigo
    if (!article.source_id && article.external_url) {
      try {
        const { protocol, hostname } = new URL(article.external_url);
        const origin = `${protocol}//${hostname}`;
        const { rows: srcRows } = await pool.query(
          `SELECT id, content_selector, featured_image_selector, extract_body_image, slug, category
           FROM sources WHERE url ILIKE $1 LIMIT 1`,
          [origin + '%']
        );
        if (srcRows[0]) {
          article.content_selector        = srcRows[0].content_selector;
          article.featured_image_selector  = srcRows[0].featured_image_selector;
          article.extract_body_image       = srcRows[0].extract_body_image;
          article.source_slug              = srcRows[0].slug;
          article.category                 = srcRows[0].category;
          // Corrige source_id para próximas chamadas (fire-and-forget)
          pool.query('UPDATE articles SET source_id = $1 WHERE id = $2 AND source_id IS NULL',
            [srcRows[0].id, article.id]).catch(() => {});
        }
      } catch { /* URL inválida ou fonte não encontrada */ }
    }

    const bodyText = (article.body || '').replace(/<[^>]*>/g, '').trim();
    const forceRefresh = req.query.force === '1' || req.query.force === 'true';

    // Retorna cache se conteúdo já é substancial — exceto quando force=1 (botão Recarregar)
    if (!forceRefresh) {
      const imagemPequena = (() => {
        if (!article.image_url) return false;
        const mParam = article.image_url.match(/[,/?&]width=(\d+)/i);
        if (mParam && parseInt(mParam[1]) < 280) return true;
        const mFile = article.image_url.match(/-(\d+)x\d+\.(?:jpe?g|jfif|png|gif|webp|avif)/i);
        if (mFile && parseInt(mFile[1]) < 400) return true;
        return false;
      })();
      if (bodyText.length >= 800 && article.image_url && !imagemPequena) {
        return res.json({ id: article.id, body: article.body, image_url: article.image_url, cached: true });
      }
    }

    // Busca conteúdo completo e imagem via scraping da página do artigo
    const source = {
      content_selector:        article.content_selector        || null,
      featured_image_selector: article.featured_image_selector || null,
      url:                     article.external_url,
      category:                article.category,
      extract_body_image:      article.extract_body_image      || false,
    };
    const { body, image_url, published_at } = await fetchFullContent(article.external_url, source);

    // Detecção de artigo removido na fonte: se não raspou corpo E o do banco é curto,
    // confere o status HTTP. 404/410 = a fonte tirou do ar → marca como indisponível.
    const raspadoVazio = (body || '').replace(/<[^>]*>/g, '').trim().length < 100;
    if (raspadoVazio && bodyText.length < 300 && article.external_url) {
      try {
        const axios = require('axios');
        const https = require('https');
        const resp = await axios.get(article.external_url, {
          timeout: 12000, maxRedirects: 5, validateStatus: () => true,
          httpsAgent: new https.Agent({ rejectUnauthorized: false }),
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36' },
        });
        if (resp.status === 404 || resp.status === 410) {
          pool.query('UPDATE articles SET unavailable = true WHERE id = $1', [article.id]).catch(() => {});
          console.log(`[full-content] artigo removido na fonte (${resp.status}): ${article.external_url}`);
          return res.json({ id: article.id, body: article.body || '', image_url: article.image_url, removed: true });
        }
      } catch { /* rede instável — não marca, tenta de novo numa próxima */ }
    }

    // Persiste body e/ou image_url no banco conforme o que foi encontrado.
    // Se o body existente já é substancial (600+ chars) e o novo é menor, preserva o existente.
    // Isso evita substituir um body limpo do RSS por conteúdo pior do scraping da página.
    const newBodyLen = (body || '').replace(/<[^>]*>/g, '').trim().length;
    const novoBody = (bodyText.length >= 600 && newBodyLen < bodyText.length * 0.7)
      ? article.body
      : (body || article.body || null);
    const novaImagem = image_url || article.image_url || null;

    if (body || image_url || published_at) {
      const sets = ['body = $1', 'image_url = $2'];
      const vals = [novoBody, novaImagem];
      // Atualiza published_at apenas se encontramos uma data válida da página
      // (corrige artigos de listing sem data que receberam now() como fallback)
      if (published_at) {
        sets.push(`published_at = $${vals.length + 1}`);
        vals.push(new Date(published_at));
      }
      vals.push(article.id);
      await pool.query(
        `UPDATE articles SET ${sets.join(', ')} WHERE id = $${vals.length}`,
        vals
      );
    }

    res.json({ id: article.id, body: novoBody || '', image_url: novaImagem, cached: false });
  } catch (err) {
    console.error('[articles/full-content]', err.message);
    res.status(500).json({ error: 'Não foi possível buscar o conteúdo completo.' });
  }
});

module.exports = router;
