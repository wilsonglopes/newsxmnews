'use strict';

/**
 * 📺 Vídeos do YouTube — coleta via RSS público e rotação de slots por portal.
 *
 * Como funciona:
 *   - Cada portal (sites_catalog) pode ter N canais do YouTube cadastrados
 *   - Cron horário: lê o RSS público de cada canal (sem API key, sem cota)
 *       https://www.youtube.com/feeds/videos.xml?channel_id=UC...
 *   - Rotação: monta pool com os vídeos mais recentes e sorteia 4 slots,
 *     evitando repetir a mesma seleção da rodada anterior
 *   - Fase 2 (pendente): empurrar a seleção para o WP via plugin (shortcode)
 *
 * Tudo aditivo — nenhum fluxo existente é tocado.
 */

const axios     = require('axios');
const RSSParser = require('rss-parser');
const pool      = require('./db/connection');

const rss = new RSSParser({ timeout: 15000 });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Quantos slots cada portal exibe e quantos vídeos recentes POR CANAL entram no pool.
// 3 slots = 1 linha no site (4 quebrava em 2 linhas — pedido do Wilson 12/06).
// Pool por canal (e não global) garante que canais que postam pouco também apareçam.
const SLOTS               = 3;
const RECENTES_POR_CANAL  = 3;

// ─── Migrations (idempotentes, individuais — padrão tryMigrate) ───────────────
async function tryMigrate(sql, label) {
  try { await pool.query(sql); }
  catch (e) { console.error(`[youtube] migration ${label}:`, e.message); }
}

async function migrar() {
  await tryMigrate(`
    CREATE TABLE IF NOT EXISTS youtube_channels (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      catalog_id  UUID REFERENCES sites_catalog(id) ON DELETE CASCADE,
      channel_id  VARCHAR(40) NOT NULL,
      name        VARCHAR(200),
      active      BOOLEAN DEFAULT true,
      created_at  TIMESTAMPTZ DEFAULT now(),
      UNIQUE (catalog_id, channel_id)
    )`, 'youtube_channels');

  await tryMigrate(`
    CREATE TABLE IF NOT EXISTS youtube_videos (
      video_id     VARCHAR(20) PRIMARY KEY,
      channel_id   VARCHAR(40) NOT NULL,
      title        TEXT,
      published_at TIMESTAMPTZ,
      fetched_at   TIMESTAMPTZ DEFAULT now()
    )`, 'youtube_videos');

  await tryMigrate(`
    CREATE TABLE IF NOT EXISTS youtube_selection (
      catalog_id  UUID PRIMARY KEY REFERENCES sites_catalog(id) ON DELETE CASCADE,
      videos      JSONB NOT NULL DEFAULT '[]',
      updated_at  TIMESTAMPTZ DEFAULT now()
    )`, 'youtube_selection');

  await tryMigrate(`
    CREATE INDEX IF NOT EXISTS idx_yt_videos_channel
    ON youtube_videos (channel_id, published_at DESC)`, 'idx_yt_videos_channel');
}

// ─── Resolução de canal: URL/@handle → channel_id (UC…) ──────────────────────
// Aceita: UC direto | youtube.com/channel/UC… | youtube.com/@handle | /c/ | /user/
async function resolverChannelId(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Informe a URL ou o ID do canal.');

  // ID UC direto
  const direto = raw.match(/^(UC[\w-]{22})$/);
  if (direto) return direto[1];

  // URL com /channel/UC…
  const urlCanal = raw.match(/youtube\.com\/channel\/(UC[\w-]{22})/i);
  if (urlCanal) return urlCanal[1];

  // @handle, /c/nome, /user/nome → busca channelId no HTML da página do canal
  let url = raw;
  if (!/^https?:\/\//i.test(url)) {
    url = raw.startsWith('@') ? `https://www.youtube.com/${raw}` : `https://www.youtube.com/@${raw}`;
  }
  const r = await axios.get(url, {
    timeout: 15000,
    headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9' },
    maxRedirects: 5,
  });
  const html = String(r.data || '');
  // Ordem importa: "channelId" genérico pode ser de canal RELACIONADO (testado:
  // @JovemPanNews retornava "Morning Show"). externalId/og:url/canonical são
  // sempre do canal da própria página.
  const m = html.match(/"externalId":"(UC[\w-]{22})"/) ||
            html.match(/property="og:url" content="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/) ||
            html.match(/rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/) ||
            html.match(/"browseId":"(UC[\w-]{22})"/) ||
            html.match(/"channelId":"(UC[\w-]{22})"/);
  if (!m) throw new Error('Não foi possível identificar o channel_id — confira a URL do canal.');
  return m[1];
}

// ─── Coleta: RSS público do canal → upsert em youtube_videos ─────────────────
async function coletarCanal(channelId) {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const r = await axios.get(feedUrl, { timeout: 15000, headers: { 'User-Agent': UA } });
  const feed = await rss.parseString(r.data);

  let novos = 0;
  for (const item of feed.items || []) {
    // id vem como "yt:video:VIDEOID"; fallback pelo link watch?v=
    const videoId = (item.id || '').split(':').pop() ||
                    (item.link || '').match(/[?&]v=([\w-]{11})/)?.[1];
    if (!videoId || videoId.length !== 11) continue;

    const res = await pool.query(
      `INSERT INTO youtube_videos (video_id, channel_id, title, published_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (video_id) DO UPDATE SET title = EXCLUDED.title
       RETURNING (xmax = 0) AS inserted`,
      [videoId, channelId, (item.title || '').slice(0, 500), item.isoDate || null]
    );
    if (res.rows[0]?.inserted) novos++;
  }
  return { total: (feed.items || []).length, novos, canalNome: feed.title || channelId };
}

async function coletarTodos() {
  const { rows: canais } = await pool.query(
    `SELECT DISTINCT channel_id FROM youtube_channels WHERE active = true`
  );
  let totalNovos = 0;
  for (const c of canais) {
    try {
      const r = await coletarCanal(c.channel_id);
      totalNovos += r.novos;
      if (r.novos > 0) console.log(`[youtube] ${r.canalNome}: ${r.novos} vídeo(s) novo(s)`);
    } catch (e) {
      console.warn(`[youtube] falha ao coletar ${c.channel_id}: ${e.message}`);
    }
  }
  return { canais: canais.length, novos: totalNovos };
}

// ─── Rotação: sorteia SLOTS vídeos do pool mais recente de cada portal ────────
function embaralhar(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function rotacionarPortal(catalogId) {
  // Pool: os N vídeos mais recentes DE CADA canal ativo (não global) —
  // canal que posta muito não domina; canal que posta pouco também aparece.
  const { rows: pool_ } = await pool.query(
    `SELECT video_id, title, channel_id, published_at, channel_name FROM (
       SELECT v.video_id, v.title, v.channel_id, v.published_at, c.name AS channel_name,
              ROW_NUMBER() OVER (PARTITION BY v.channel_id ORDER BY v.published_at DESC NULLS LAST) AS rn
       FROM youtube_videos v
       JOIN youtube_channels c ON c.channel_id = v.channel_id AND c.catalog_id = $1 AND c.active = true
     ) t WHERE rn <= $2`,
    [catalogId, RECENTES_POR_CANAL]
  );
  if (!pool_.length) return null; // sem vídeos → mantém o que estiver no site

  // Seleção anterior (para evitar repetir o mesmo conjunto quando possível)
  const { rows: prevRows } = await pool.query(
    `SELECT videos FROM youtube_selection WHERE catalog_id = $1`, [catalogId]
  );
  const prevIds = new Set((prevRows[0]?.videos || []).map(v => v.video_id));

  // Sorteia priorizando: (1) vídeos fora da seleção anterior, (2) diversidade de canais
  const candidatos = [
    ...embaralhar(pool_.filter(v => !prevIds.has(v.video_id))),
    ...embaralhar(pool_.filter(v =>  prevIds.has(v.video_id))),
  ];
  const sorteados     = [];
  const canaisUsados  = new Set();
  for (const v of candidatos) { // 1ª passada: um vídeo por canal
    if (sorteados.length >= SLOTS) break;
    if (canaisUsados.has(v.channel_id)) continue;
    sorteados.push(v); canaisUsados.add(v.channel_id);
  }
  for (const v of candidatos) { // 2ª passada: completa se houver menos canais que slots
    if (sorteados.length >= SLOTS) break;
    if (!sorteados.includes(v)) sorteados.push(v);
  }
  const escolhidos = sorteados.map(v => ({
    video_id:     v.video_id,
    title:        v.title,
    channel_name: v.channel_name,
    published_at: v.published_at,
    embed_url:    `https://www.youtube.com/embed/${v.video_id}`,
    thumbnail:    `https://i.ytimg.com/vi/${v.video_id}/hqdefault.jpg`,
  }));

  await pool.query(
    `INSERT INTO youtube_selection (catalog_id, videos, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (catalog_id) DO UPDATE SET videos = $2, updated_at = now()`,
    [catalogId, JSON.stringify(escolhidos)]
  );
  return escolhidos;
}

// ─── Push: envia a seleção rotacionada para o WordPress do portal ─────────────
// Plugin Portal Publisher v2.2.0+ — endpoint xmn/v1/videos guarda em wp_option
// e o shortcode [portal_videos] renderiza localmente (sem depender do nosso uptime).
const https = require('https');
const HTTPS_AGENT = new https.Agent({ rejectUnauthorized: false });

async function pushParaSite(catalogId, videos) {
  const { rows } = await pool.query(
    `SELECT name, site_url, xixo_api_key FROM sites_catalog WHERE id = $1 AND active = true`,
    [catalogId]
  );
  const site = rows[0];
  if (!site?.site_url || !site?.xixo_api_key) return { pushed: false, motivo: 'site sem URL ou chave do plugin' };

  const baseUrl = site.site_url.replace(/\/$/, '');
  const r = await axios.post(`${baseUrl}/wp-json/xmn/v1/videos`, { videos }, {
    timeout: 20000,
    httpsAgent: HTTPS_AGENT,
    headers: { 'Content-Type': 'application/json', 'X-XMNews-Key': site.xixo_api_key },
  });
  if (!r.data?.success) throw new Error(r.data?.error || 'resposta inesperada do plugin');
  console.log(`[youtube] ✓ ${videos.length} vídeos enviados para ${site.name}`);
  return { pushed: true, site: site.name };
}

async function rotacionarTodos() {
  const { rows: portais } = await pool.query(
    `SELECT DISTINCT catalog_id FROM youtube_channels WHERE active = true AND catalog_id IS NOT NULL`
  );
  let ok = 0;
  for (const p of portais) {
    try {
      const sel = await rotacionarPortal(p.catalog_id);
      if (sel) {
        ok++;
        // Push é best-effort: plugin antigo (sem /videos) ou site fora do ar não param a rodada
        try { await pushParaSite(p.catalog_id, sel); }
        catch (e) { console.warn(`[youtube] push falhou para ${p.catalog_id}: ${e.message}`); }
      }
    } catch (e) {
      console.warn(`[youtube] rotação falhou para ${p.catalog_id}: ${e.message}`);
    }
  }
  return { portais: portais.length, rotacionados: ok };
}

// ─── Rodada completa (cron horário chama isto) ────────────────────────────────
let rodando = false; // mutex — evita rodadas sobrepostas
async function rodada() {
  if (rodando) { console.log('[youtube] rodada anterior ainda em andamento — pulando'); return; }
  rodando = true;
  try {
    const c = await coletarTodos();
    const r = await rotacionarTodos();
    if (c.canais > 0) {
      console.log(`[youtube] rodada: ${c.canais} canais, ${c.novos} vídeos novos, ${r.rotacionados}/${r.portais} portais rotacionados`);
    }
  } catch (e) {
    console.error('[youtube] rodada falhou:', e.message);
  } finally {
    rodando = false;
  }
}

module.exports = { migrar, resolverChannelId, coletarCanal, coletarTodos, rotacionarPortal, rotacionarTodos, pushParaSite, rodada, SLOTS };
