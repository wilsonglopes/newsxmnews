'use strict';

/**
 * Monitor de saúde do sistema XIXO News
 * ═══════════════════════════════════════
 *
 * Verificações automáticas registradas no server.js:
 *   • A cada 2h — alerta se houver problema
 *   • Diariamente às 7h — resumo geral (mesmo sem problema)
 *
 * O que verifica:
 *   1. Fontes ativas sem artigos nas últimas 6h
 *   2. Fontes com erro registrado no banco
 *   3. Fontes com >70% de artigos sem imagem (24h)
 *   4. Saúde do banco de dados (ping simples)
 *   5. Estatísticas gerais (artigos/hora, publicações/dia)
 *
 * Configuração necessária no .env:
 *   TELEGRAM_TOKEN    = token do bot Telegram
 *   MONITOR_CHAT_ID   = seu chat_id pessoal (obter via @userinfobot)
 *
 * Como obter MONITOR_CHAT_ID:
 *   1. Abra o Telegram e procure @userinfobot
 *   2. Envie /start — ele retorna seu ID numérico
 *   3. Coloque esse número no .env: MONITOR_CHAT_ID=123456789
 */

const pool    = require('./db/connection');
const sources = require('./sources.json');
const { notifyAdmin } = require('./utils/telegram-notify');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// ─── Configuração ──────────────────────────────────────────────────────────────
const HORAS_SEM_ARTIGO = 6;   // após N horas sem artigos → alerta vermelho
const MIN_ARTIGOS_IMG  = 5;   // fonte precisa de pelo menos N artigos pra entrar no check de imagem
const PERC_SEM_IMAGEM  = 0.7; // acima de 70% sem imagem → alerta

// ─── Monitor de disco (proativo) ──────────────────────────────────────────────
const DISCO_ALERTA      = 80; // % de uso → alerta no Telegram
const DISCO_CRITICO     = 90; // % de uso → auto-limpeza emergencial + alerta
const DISCO_THROTTLE_MS = 6 * 60 * 60 * 1000; // não repetir alerta de "alto" em menos de 6h
let _ultimoAlertaDiscoTs = 0; // estado em memória p/ evitar spam

// ─── Helpers ──────────────────────────────────────────────────────────────────

function horaBRT() {
  return new Date().toLocaleString('pt-BR', {
    timeZone:  'America/Sao_Paulo',
    day:       '2-digit',
    month:     '2-digit',
    year:      'numeric',
    hour:      '2-digit',
    minute:    '2-digit',
  });
}

// ─── Verificações individuais ─────────────────────────────────────────────────

/** Retorna fontes ativas sem artigos nas últimas HORAS_SEM_ARTIGO horas */
async function fontesSemArtigos() {
  const { rows } = await pool.query(`
    SELECT s.slug AS source_slug
    FROM   articles a
    JOIN   sources s ON s.id = a.source_id
    WHERE  a.fetched_at > NOW() - INTERVAL '${HORAS_SEM_ARTIGO} hours'
    GROUP  BY s.slug
  `);
  const comArtigos = new Set(rows.map(r => r.source_slug));

  // Só avalia fontes que a coleta já registrou alguma vez (evita falso-positivo no startup)
  const { rows: fontesBD } = await pool.query(`
    SELECT slug
    FROM   sources
    WHERE  active = true
      AND  last_fetched_at IS NOT NULL
      AND  last_fetched_at < NOW() - INTERVAL '30 minutes'
  `);
  const slugsJaColetados = new Set(fontesBD.map(r => r.slug));

  return sources.filter(s =>
    s.active &&
    slugsJaColetados.has(s.slug) &&
    !comArtigos.has(s.slug)
  );
}

/** Retorna fontes com erro recente registrado */
async function fontesComErro() {
  const { rows } = await pool.query(`
    SELECT slug, last_error, last_fetched_at
    FROM   sources
    WHERE  last_error IS NOT NULL
      AND  last_fetched_at > NOW() - INTERVAL '${HORAS_SEM_ARTIGO} hours'
    ORDER  BY last_fetched_at DESC
    LIMIT  8
  `);
  return rows;
}

/** Retorna fontes com proporção alta de artigos sem imagem */
async function fontesSemImagem() {
  const { rows } = await pool.query(`
    SELECT
      s.slug AS source_slug,
      COUNT(*)                                         AS total,
      COUNT(*) FILTER (WHERE a.image_url IS NULL)       AS sem_img
    FROM   articles a
    JOIN   sources s ON s.id = a.source_id
    WHERE  a.fetched_at > NOW() - INTERVAL '24 hours'
    GROUP  BY s.slug
    HAVING COUNT(*) >= ${MIN_ARTIGOS_IMG}
       AND (COUNT(*) FILTER (WHERE a.image_url IS NULL))::float / COUNT(*) > ${PERC_SEM_IMAGEM}
    ORDER  BY sem_img DESC
    LIMIT  5
  `);
  return rows;
}

/** Estatísticas gerais do sistema */
async function estatisticas() {
  const [artRows, pubRows, queueRows] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE fetched_at > NOW() - INTERVAL '1 hour')   AS ultima_hora,
        COUNT(*) FILTER (WHERE fetched_at > NOW() - INTERVAL '24 hours') AS ultimas_24h
      FROM articles
    `),
    pool.query(`
      SELECT COUNT(*) AS total
      FROM   publications
      WHERE  created_at > NOW() - INTERVAL '24 hours'
    `).catch(() => ({ rows: [{ total: '?' }] })),
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending')    AS pendentes,
        COUNT(*) FILTER (WHERE status = 'processing') AS processando,
        COUNT(*) FILTER (WHERE status = 'failed')     AS falhas
      FROM autopub_queue
      WHERE created_at > NOW() - INTERVAL '24 hours'
    `).catch(() => ({ rows: [{ pendentes: '?', processando: '?', falhas: '?' }] })),
  ]);

  return {
    artigos: {
      ultima_hora:  parseInt(artRows.rows[0].ultima_hora)  || 0,
      ultimas_24h:  parseInt(artRows.rows[0].ultimas_24h)  || 0,
    },
    publicacoes_24h: parseInt(pubRows.rows[0].total) || 0,
    fila: queueRows.rows[0],
  };
}

// ─── Verificação principal ────────────────────────────────────────────────────

/**
 * Executa todas as verificações e envia alerta Telegram se houver problema.
 *
 * @param {boolean} [forceSummary=false]
 *   Se true, envia resumo completo mesmo quando tudo está OK.
 *   Usado pelo cron diário das 7h para confirmar que o monitor está funcionando.
 */
async function verificarSaude(forceSummary = false) {
  if (!process.env.MONITOR_CHAT_ID) return; // não configurado

  try {
    const linhas      = [];
    const problemas   = [];

    // ── 1. Fontes sem artigos ──────────────────────────────────────────────────
    const semArtigos = await fontesSemArtigos();
    if (semArtigos.length > 0) {
      problemas.push('sem_artigos');
      linhas.push(`🔴 *${semArtigos.length} fonte(s) sem artigos nas últimas ${HORAS_SEM_ARTIGO}h:*`);
      semArtigos.slice(0, 8).forEach(s => linhas.push(`  • ${s.name} (\`${s.slug}\`)`));
      if (semArtigos.length > 8) linhas.push(`  _...e mais ${semArtigos.length - 8} fontes_`);
      linhas.push('');
    }

    // ── 2. Fontes com erro ────────────────────────────────────────────────────
    const comErro = await fontesComErro();
    if (comErro.length > 0) {
      problemas.push('erros');
      linhas.push(`⚠️ *${comErro.length} fonte(s) com erro:*`);
      comErro.forEach(r => {
        const msg = (r.last_error || '').replace(/\n/g, ' ').slice(0, 90);
        linhas.push(`  • \`${r.slug}\`: ${msg}`);
      });
      linhas.push('');
    }

    // ── 3. Fontes sem imagem ──────────────────────────────────────────────────
    const semImg = await fontesSemImagem();
    if (semImg.length > 0) {
      problemas.push('sem_imagem');
      linhas.push(`🖼 *Fontes com >${Math.round(PERC_SEM_IMAGEM * 100)}% artigos sem imagem (24h):*`);
      semImg.forEach(r => {
        const pct = Math.round((r.sem_img / r.total) * 100);
        linhas.push(`  • \`${r.source_slug}\`: ${r.sem_img}/${r.total} sem imagem (${pct}%)`);
      });
      linhas.push('');
    }

    // ── 4. Estatísticas ───────────────────────────────────────────────────────
    const stats = await estatisticas();
    const nAtivas = sources.filter(s => s.active).length;

    // Alerta se taxa de coleta caiu muito (menos de 5 artigos/hora com 80+ fontes ativas)
    if (stats.artigos.ultima_hora < 5 && nAtivas > 20) {
      problemas.push('coleta_baixa');
      linhas.push(`📉 *Coleta baixa: apenas ${stats.artigos.ultima_hora} artigos na última hora*\n`);
    }

    // ── 5. Falhas na fila de autopub ─────────────────────────────────────────
    const falhasFila = parseInt(stats.fila.falhas) || 0;
    if (falhasFila > 0) {
      problemas.push('fila_falhas');
      linhas.push(`🚫 *${falhasFila} falha(s) na fila de autopub (24h)*\n`);
    }

    // ── Montar mensagem ───────────────────────────────────────────────────────
    if (problemas.length === 0 && !forceSummary) {
      console.log('[MONITOR] ✅ Saúde OK — sem alertas nesta rodada.');
      return;
    }

    const header = problemas.length === 0
      ? `✅ *Monitor XIXO — tudo OK*`
      : `🔔 *Monitor XIXO — ${problemas.length} problema(s)*`;

    const rodape = [
      `_${horaBRT()}_`,
      `📰 ${stats.artigos.ultima_hora}/h | ${stats.artigos.ultimas_24h}/24h`,
      `📤 ${stats.publicacoes_24h} pub/24h`,
      `🗂 ${nAtivas} fontes ativas`,
    ].join(' · ');

    const mensagem = [header, '', ...linhas, rodape].join('\n');
    await notifyAdmin(mensagem);

    if (problemas.length > 0) {
      console.log(`[MONITOR] Alerta enviado: ${problemas.join(', ')}.`);
    } else {
      console.log('[MONITOR] Resumo diário enviado.');
    }

  } catch (e) {
    console.error('[MONITOR] Erro ao verificar saúde:', e.message);
  }
}

/** Relatório diário completo (roda às 7h) */
async function relatorioDiario() {
  await verificarSaude(true);
}

// Lê o % de uso da partição raiz
async function usoDiscoRaiz() {
  const { stdout } = await execAsync("df -P / | awk 'NR==2{print $5}' | tr -d '%'");
  return parseInt(String(stdout).trim(), 10);
}

/**
 * Monitor de disco proativo. Roda com frequência (cron a cada 1h no server.js).
 *   • >= 90% (crítico): auto-limpeza emergencial de perfis Puppeteer + alerta
 *   • 80–89%: alerta no Telegram (com throttle de 6h p/ não spammar)
 *   • < 80%: silencioso (só loga)
 */
async function verificarDisco() {
  if (!process.env.MONITOR_CHAT_ID) return;
  try {
    let uso = await usoDiscoRaiz();
    if (isNaN(uso)) { console.warn('[MONITOR/disco] não foi possível ler o uso do disco'); return; }
    console.log(`[MONITOR/disco] uso da raiz: ${uso}%`);

    if (uso < DISCO_ALERTA) { _ultimoAlertaDiscoTs = 0; return; } // normalizou — reseta throttle

    let acao = '';
    const critico = uso >= DISCO_CRITICO;

    if (critico) {
      // Auto-limpeza emergencial via script ROOT (sudo NOPASSWD) — limpa perfis
      // puppeteer_dev_chrome_profile-* (o rm como 'ubuntu' falhava por permissão).
      // Fallback: tenta o find direto se o script não existir.
      try {
        await execAsync("sudo /usr/local/bin/cleanup-chromium.sh 2>/dev/null || find /tmp/snap-private-tmp/snap.chromium/tmp/ -maxdepth 1 -type d -name 'puppeteer_dev_chrome_profile-*' -mmin +20 2>/dev/null | xargs -r rm -rf 2>/dev/null");
        const novo = await usoDiscoRaiz();
        acao = `\n🧹 Limpeza emergencial executada → disco agora em *${novo}%*`;
        if (novo < DISCO_ALERTA) {
          // resolveu sozinho — avisa uma vez e não spamma
          await notifyAdmin([`✅ *Disco normalizado após limpeza automática*`, `Estava em ${uso}%, agora ${novo}%.`, `_${horaBRT()}_`].join('\n'));
          console.log(`[MONITOR/disco] limpeza resolveu: ${uso}% → ${novo}%`);
          _ultimoAlertaDiscoTs = Date.now();
          return;
        }
        uso = novo;
      } catch (e) {
        acao = `\n⚠️ Falha na limpeza emergencial: ${e.message}`;
      }
    } else {
      // 80-89% — throttle para não repetir em menos de 6h
      if (Date.now() - _ultimoAlertaDiscoTs < DISCO_THROTTLE_MS) return;
    }

    const emoji = critico ? '🆘' : '⚠️';
    const nivel = critico ? 'CRÍTICO' : 'ALTO';
    const msg = [
      `${emoji} *Disco ${nivel}: ${uso}% usado* (servidor XIXO)`,
      acao,
      `_${horaBRT()}_`,
    ].filter(Boolean).join('\n');
    await notifyAdmin(msg);
    _ultimoAlertaDiscoTs = Date.now();
    console.log(`[MONITOR/disco] alerta enviado (${uso}%, ${nivel})`);
  } catch (e) {
    console.error('[MONITOR/disco] erro:', e.message);
  }
}

/**
 * Saúde de TODAS as fontes ativas — para o painel admin.
 * Retorna por fonte: status (ok/sem_coleta/sem_artigos/erro/bloqueado), última coleta,
 * artigos 1h/24h, % sem imagem e o erro recente (se houver).
 */
async function saudeDasFontes() {
  const { rows } = await pool.query(`
    SELECT
      s.slug, s.name, s.last_fetched_at, s.last_error,
      COUNT(a.id) FILTER (WHERE a.fetched_at > NOW() - INTERVAL '24 hours') AS art_24h,
      COUNT(a.id) FILTER (WHERE a.fetched_at > NOW() - INTERVAL '1 hour')   AS art_1h,
      COUNT(a.id) FILTER (WHERE a.fetched_at > NOW() - INTERVAL '24 hours' AND a.image_url IS NULL) AS sem_img_24h
    FROM   sources s
    LEFT JOIN articles a ON a.source_id = s.id
    WHERE  s.active = true
    GROUP  BY s.id, s.slug, s.name, s.last_fetched_at, s.last_error
    ORDER  BY s.name
  `);

  const agora = Date.now();
  return rows.map(r => {
    const art24  = parseInt(r.art_24h)     || 0;
    const art1   = parseInt(r.art_1h)      || 0;
    const semImg = parseInt(r.sem_img_24h) || 0;
    const ultColeta = r.last_fetched_at ? new Date(r.last_fetched_at).getTime() : null;
    const horasSemColeta = ultColeta ? (agora - ultColeta) / 3600000 : null;
    const erro = (r.last_error || '').trim();
    const erroRecente = !!erro && ultColeta && horasSemColeta < 24;
    const ehCloudflare = /cloudflare|cf-mitigated|just a moment|challenge|\b403\b/i.test(erro);

    // A fonte ESTÁ funcionando se trouxe artigos nas últimas 24h — nesse caso um
    // last_error é só um tropeço pontual (ex: 1 página falhou, mas o RSS coletou).
    // Só é 'erro'/'bloqueado' de verdade quando NÃO coletou nada (art24 === 0).
    let status = 'ok';
    if (art24 > 0) {
      status = erroRecente ? 'atencao' : 'ok';   // coletou, mas teve erro pontual → atenção (amarelo)
    } else if (erroRecente && ehCloudflare) {
      status = 'bloqueado';
    } else if (erroRecente) {
      status = 'erro';
    } else if (horasSemColeta === null || horasSemColeta > HORAS_SEM_ARTIGO) {
      status = 'sem_coleta';
    } else {
      status = 'sem_artigos';
    }

    return {
      slug: r.slug,
      name: r.name,
      status,
      last_fetched_at: r.last_fetched_at,
      horas_sem_coleta: horasSemColeta !== null ? Math.round(horasSemColeta * 10) / 10 : null,
      art_1h: art1,
      art_24h: art24,
      pct_sem_img: art24 > 0 ? Math.round((semImg / art24) * 100) : 0,
      last_error: erroRecente ? erro.replace(/\s+/g, ' ').slice(0, 200) : null,
    };
  });
}

module.exports = { verificarSaude, relatorioDiario, verificarDisco, saudeDasFontes };
