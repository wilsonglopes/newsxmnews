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
      `SELECT a.id, a.external_url, a.body, a.image_url,
              so.section_selector AS content_selector,
              so.slug AS source_slug, so.category,
              so.extract_body_image
       FROM articles a
       LEFT JOIN sources so ON so.id = a.source_id
       WHERE a.id = $1`,
      [req.params.id]
    );
    const article = rows[0];
    if (!article) return res.status(404).json({ error: 'Artigo não encontrado.' });

    const bodyText = (article.body || '').replace(/<[^>]*>/g, '').trim();

    // Se já tem conteúdo suficiente E imagem de boa qualidade, retorna direto
    // Considera boa qualidade: URL sem indicação de dimensão pequena no path
    // Regex com delimitador para não confundir width=128 com width=1280
    // Limiar de 800 chars: snippet de RSS (~300-600 chars) sempre gera re-scraping para buscar
    // o artigo completo. Apenas artigos com corpo substancial (texto de artigo real) são cacheados.
    const imagemPequena = (() => {
      if (!article.image_url) return false;
      const m = article.image_url.match(/[,/?&]width=(\d+)/i);
      return m ? parseInt(m[1]) < 280 : false;
    })();
    if (bodyText.length >= 800 && article.image_url && !imagemPequena) {
      return res.json({ id: article.id, body: article.body, image_url: article.image_url, cached: true });
    }

    // Busca conteúdo completo e imagem via scraping da página do artigo
    const source = {
      content_selector:   article.content_selector || null,
      url:                article.external_url,
      category:           article.category,
      extract_body_image: article.extract_body_image || false,
    };
    const { body, image_url } = await fetchFullContent(article.external_url, source);

    // Persiste body e/ou image_url no banco conforme o que foi encontrado
    const novoBody   = body      || article.body      || null;
    const novaImagem = image_url || article.image_url || null;

    if (body || image_url) {
      await pool.query(
        'UPDATE articles SET body = $1, image_url = $2 WHERE id = $3',
        [novoBody, novaImagem, article.id]
      );
    }

    res.json({ id: article.id, body: novoBody || '', image_url: novaImagem, cached: false });
  } catch (err) {
    console.error('[articles/full-content]', err.message);
    res.status(500).json({ error: 'Não foi possível buscar o conteúdo completo.' });
  }
});

module.exports = router;
