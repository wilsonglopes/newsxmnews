'use strict';

/**
 * scrapers/normalizer.js
 * Recebe qualquer artigo cru (RSS ou scraping) e devolve sempre no mesmo formato limpo.
 */

const cheerio = require('cheerio');

// ─── Decodificação de entidades HTML ─────────────────────────────────────────
function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g,       (_, c) => String.fromCharCode(parseInt(c, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// Remove HTML e decodifica entidades; colapsa espaços múltiplos
function stripHtml(str) {
  if (!str) return '';
  return decodeEntities(str.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Derivação do chapéu ──────────────────────────────────────────────────────
const URL_SEGMENT_MAP = {
  politica:       'POLÍTICA',
  economia:       'ECONOMIA',
  esportes:       'ESPORTE',
  esporte:        'ESPORTE',
  saude:          'SAÚDE',
  seguranca:      'SEGURANÇA',
  educacao:       'EDUCAÇÃO',
  cultura:        'CULTURA',
  tecnologia:     'TECNOLOGIA',
  ciencia:        'CIÊNCIA',
  policial:       'POLICIAL',
  cidades:        'CIDADES',
  entretenimento: 'ENTRETENIMENTO',
  agropecuaria:   'AGRONEGÓCIO',
  internacional:  'INTERNACIONAL',
};

const CATEGORY_MAP = {
  prefeitura: 'PODER PÚBLICO',
  governo:    'GOVERNO',
  esporte:    'ESPORTE',
  agro:       'AGRONEGÓCIO',
};

function derivarChapeu(rssCategories, url, sourceCategory) {
  // 1. Categoria do RSS
  if (Array.isArray(rssCategories) && rssCategories.length > 0) {
    const cat = String(rssCategories[0] || '').trim();
    if (cat) return cat.toUpperCase();
  }

  // 2. Segmento da URL
  if (url) {
    try {
      const pathname = new URL(url).pathname.toLowerCase();
      const segments = pathname.split('/').filter(Boolean);
      for (const seg of segments) {
        // Normaliza hífens e acentos simples
        const clean = seg.replace(/-/g, '').replace(/[áàãâ]/g, 'a').replace(/[éê]/g, 'e').replace(/[íî]/g, 'i').replace(/[óõô]/g, 'o').replace(/[úû]/g, 'u').replace(/ç/g, 'c');
        if (URL_SEGMENT_MAP[clean]) return URL_SEGMENT_MAP[clean];
        if (URL_SEGMENT_MAP[seg])   return URL_SEGMENT_MAP[seg];
      }
    } catch { /* URL inválida */ }
  }

  // 3. Categoria da fonte
  if (sourceCategory && CATEGORY_MAP[sourceCategory]) {
    return CATEGORY_MAP[sourceCategory];
  }

  return 'NOTÍCIA';
}

// ─── Normalização do corpo HTML ───────────────────────────────────────────────
const ALLOWED_TAGS   = new Set(['p', 'h2', 'h3', 'strong', 'em', 'ul', 'ol', 'li', 'blockquote', 'a', 'img']);
const REMOVE_TAGS    = new Set(['script', 'style', 'iframe', 'form', 'button', 'nav', 'header', 'footer', 'aside', 'svg']);
const AD_PATTERNS    = [
  'ad', 'ads', 'advertisement', 'banner', 'sidebar', 'social', 'share',
  'related', 'newsletter', 'subscribe', 'comments', 'tags-lista',
  'publicidade', 'anuncio', 'patrocinado', 'sponsored', 'popup'
];
const SKIP_PREFIXES  = [
  'leia também', 'veja mais', 'leia mais', 'confira também',
  'assine', 'clique aqui', 'acesse também', 'veja também', 'leia a matéria',
  // Rodapés de RSS WordPress
  'o post ', 'the post ',
  // Créditos de imagem (ex: "Imagem: Magnific", "Foto: João Silva")
  'imagem:', 'foto:', 'crédito:', 'credito:', 'fotografia:',
];

function isAdClass(cls) {
  const c = cls.toLowerCase();
  // Usa \b (word boundary) para não confundir 'ad' dentro de 'readability' ou 'uploads'
  return AD_PATTERNS.some(p => {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('\\b' + escaped + '\\b', 'i').test(c);
  });
}

function normalizeBody(html, sourceUrl) {
  if (!html) return '';
  try {
    const $ = cheerio.load(html, { decodeEntities: false });

    // Remove elementos proibidos
    REMOVE_TAGS.forEach(tag => $(tag).remove());

    // Remove divs/spans/sections com classes de publicidade
    $('div, span, section, figure').each((_, el) => {
      const cls = $(el).attr('class') || '';
      const id  = $(el).attr('id')    || '';
      if (isAdClass(cls) || isAdClass(id)) $(el).remove();
    });

    // Remove links internos (aponta para o mesmo domínio da fonte)
    if (sourceUrl) {
      try {
        const sourceDomain = new URL(sourceUrl).hostname;
        $('a[href]').each((_, el) => {
          try {
            const href = $(el).attr('href') || '';
            if (href.startsWith('/') || new URL(href).hostname === sourceDomain) {
              $(el).replaceWith($(el).html() || $(el).text());
            }
          } catch { /* URL relativa — manter */ }
        });
      } catch { /* sourceUrl inválida */ }
    }

    // Remove parágrafos com frases de cross-link
    $('p').each((_, el) => {
      const txt = $(el).text().toLowerCase().trim();
      if (SKIP_PREFIXES.some(pf => txt.startsWith(pf))) $(el).remove();
    });

    // Converte data-src/data-lazy-src → src em <img> antes de remover atributos
    // (sites com lazy loading não preenchem src até o JS executar)
    $('img').each((_, el) => {
      const tag$ = $(el);
      const src = tag$.attr('src') || '';
      if (!src || src.startsWith('data:')) {
        const ds = tag$.attr('data-src') || tag$.attr('data-lazy-src') || tag$.attr('data-original') || tag$.attr('data-img-url') || '';
        if (ds) tag$.attr('src', ds);
      }
    });

    // Remove imagens que são ícones/vetores SVG (ex: breadcrumb icons do Lance)
    // e logotipos (ex: LOGO-OFICIAL da Agência Esporte)
    $('img').each((_, el) => {
      const src = $(el).attr('src') || '';
      if (!src) { $(el).remove(); return; }
      // Ícones SVG referenciados via <img> (ex: CDN do Lance retorna .svg)
      if (src.match(/\.svg($|[?/])/i)) { $(el).remove(); return; }
      // Logotipos pelo nome do arquivo
      const filename = src.split('/').pop() || '';
      if (filename.match(/logo/i)) { $(el).remove(); return; }
    });

    // Remove atributos, exceto href em <a> e src em <img>
    $('*').each((_, el) => {
      const tag = (el.tagName || '').toLowerCase();
      const attribs = el.attribs ? Object.keys(el.attribs) : [];
      attribs.forEach(attr => {
        if (tag === 'a'   && attr === 'href') return;
        if (tag === 'img' && attr === 'src')  return;
        $(el).removeAttr(attr);
      });
    });

    // Substitui <br><br> por quebra de parágrafo
    let html2 = $.html('body').replace(/<body[^>]*>|<\/body>/gi, '');
    html2 = html2.replace(/<br\s*\/?>\s*<br\s*\/?>/gi, '</p><p>');

    // Reprocessa após limpeza
    const $2 = cheerio.load(html2, { decodeEntities: false });

    // Remove parágrafos vazios
    $2('p').each((_, el) => {
      if ($2(el).text().trim() === '') $2(el).remove();
    });

    // Remove tags não permitidas mas mantém o conteúdo textual.
    // Itera em ordem reversa (de dentro para fora) para que elementos filhos
    // sejam desempacotados antes dos pais — garante que nós inseridos por
    // replaceWith() não precisem de re-processamento.
    const allEls = $2('*').toArray().reverse();
    allEls.forEach(el => {
      const tag = (el.tagName || '').toLowerCase();
      if (!ALLOWED_TAGS.has(tag) && tag !== 'html' && tag !== 'body' && tag !== 'head') {
        $2(el).replaceWith($2(el).html() || $2(el).text());
      }
    });

    // Garante largura total e responsividade em todas as imagens do corpo
    $2('img').each((_, el) => {
      $2(el).attr('style', 'max-width:100%;width:100%;height:auto;display:block;margin:1rem auto;');
    });

    return ($2.html('body') || '')
      .replace(/<body[^>]*>|<\/body>/gi, '')
      .trim();
  } catch {
    return html; // tolerância a falhas
  }
}

// ─── Extração de imagem ───────────────────────────────────────────────────────

// Imagens que NUNCA devem virar imagem destacada do artigo.
// Caso real (11/06): WordPress converte emoji do texto em <img src="s.w.org/.../72x72/26a0.png">
// → virava image_url → featured errada no WP e card sem foto no FB/IG.
function imagemIndesejadaNoCorpo(src, classAttr = '') {
  if (/s\.w\.org\/images\/core\/emoji\//i.test(src)) return true; // CDN de emojis do WordPress
  if (/\/emojis?\//i.test(src))                      return true; // outros CDNs de emoji
  if (/wp-smiley|emoji/i.test(classAttr))            return true; // classe padrão do WP para emoji
  if (/\.svg(\?|$)/i.test(src))                      return true; // ícones vetoriais
  if (/gravatar\.com/i.test(src))                    return true; // avatares de autor
  if (/\/(1x1|pixel|spacer|blank)\.(png|gif)/i.test(src)) return true; // pixels de tracking
  return false;
}

function extractFirstImage(html) {
  if (!html) return null;
  try {
    const $ = cheerio.load(html);
    let found = null;
    $('img').each((_, el) => {
      const src    = $(el).attr('src') || '';
      const cls    = $(el).attr('class') || '';
      const width  = parseInt($(el).attr('width')  || '0', 10);
      const height = parseInt($(el).attr('height') || '0', 10);
      if (width  > 0 && width  < 100) return;
      if (height > 0 && height < 100) return;
      if (imagemIndesejadaNoCorpo(src, cls)) return;
      if (src && (src.startsWith('http') || src.startsWith('//'))) {
        found = src;
        return false; // break
      }
    });
    return found;
  } catch { return null; }
}

// ─── Normalização de tags ─────────────────────────────────────────────────────
const GENERIC_TAGS = new Set(['notícia', 'noticia', 'brasil', 'news', 'noticias', 'notícias', '']);

function normalizeTags(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(
    raw.map(t => String(t || '').toLowerCase().trim()).filter(t => !GENERIC_TAGS.has(t))
  )];
}

// ─── Função principal ─────────────────────────────────────────────────────────
/**
 * Normaliza um artigo cru no formato padrão.
 * @param {object} raw     - Artigo bruto (RSS ou scraping)
 * @param {object} source  - Config da fonte (category, url, slug)
 * @returns {object}       - Artigo normalizado
 */
function normalizeArticle(raw, source) {
  try {
    const url = raw.url || raw.external_url || '';

    // Título
    let title = '';
    try { title = stripHtml(raw.title || '').slice(0, 500); } catch { title = ''; }

    // Corpo
    // Usa content:encoded como fonte primária. Se vazio (ex: RSS Wix), usa contentSnippet/description
    // como fallback — garante pelo menos os parágrafos que o RSS fornece, mesmo que truncados.
    let body = '';
    try {
      let rawHtml = raw.content || raw.body || '';
      if (!rawHtml && raw.contentSnippet) {
        // contentSnippet é texto puro (sem HTML) — envolve em <p> para o normalizer processar
        rawHtml = '<p>' + raw.contentSnippet + '</p>';
      }
      body = normalizeBody(rawHtml, url);
    } catch { body = raw.content || raw.body || ''; }

    // Resumo
    let summary = null;
    try {
      const rawSummary = raw.summary || raw.contentSnippet || '';
      if (rawSummary && rawSummary.length > 10) {
        summary = stripHtml(rawSummary);
      } else if (body) {
        const $b = cheerio.load(body);
        summary = $b('p').first().text().trim();
      }
      // Sem truncagem — o summary deve ser completo para alimentar a IA corretamente
      if (!summary) summary = null;
    } catch { summary = null; }

    // Chapéu
    let chapeu = 'NOTÍCIA';
    try { chapeu = derivarChapeu(raw.categories || [], url, source?.category); } catch { chapeu = 'NOTÍCIA'; }

    // Imagem
    let image_url = null;
    try { image_url = raw.image || raw.image_url || extractFirstImage(body) || null; } catch { image_url = null; }

    // Tags
    let tags = [];
    try { tags = normalizeTags(raw.tags || raw.categories || []); } catch { tags = []; }

    // Autor
    let author = null;
    try {
      const rawAuthor = raw.author || raw.creator || null;
      if (rawAuthor) author = stripHtml(String(rawAuthor)).slice(0, 200) || null;
    } catch { author = null; }

    // Data de publicação
    let published_at = null;
    try {
      const rawDate = raw.published_at || raw.isoDate || raw.pubDate || null;
      if (rawDate) {
        const d = new Date(rawDate);
        published_at = isNaN(d.getTime()) ? null : d.toISOString();
      }
    } catch { published_at = null; }

    return { external_url: url, chapeu, title, summary, body, image_url, tags, author, published_at };

  } catch {
    // Fallback de tolerância total
    return {
      external_url: raw.url || raw.external_url || '',
      chapeu:       'NOTÍCIA',
      title:        String(raw.title || '').slice(0, 500),
      summary:      null,
      body:         null,
      image_url:    null,
      tags:         [],
      author:       null,
      published_at: null,
    };
  }
}

module.exports = { normalizeArticle, stripHtml, normalizeBody };
