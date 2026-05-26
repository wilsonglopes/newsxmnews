#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# deploy.sh — Deploy padronizado do XIXO News
# ═══════════════════════════════════════════════════════════════════════════════
#
# Uso: bash deploy.sh
#
# O que faz:
#   1. Detecta modificações locais no servidor → stash automático com label
#   2. git pull origin main
#   3. Valida sources.json e settings.json (JSON inválido aborta o deploy)
#   4. pm2 restart xixo-news
#   5. Health check em /api/health (aguarda até 30s)
#   6. Envia resultado via Telegram para o admin
#
# Requisitos: git, pm2, python3, curl
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Configuração ───────────────────────────────────────────────────────────────
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$DIR/backend/.env"
APP_NAME="xixo-news"
BRANCH="main"
MAX_WAIT_HEALTH=30   # segundos aguardando o processo subir

# Porta padrão — sobrescrita pela variável PORT do .env se existir
SERVER_PORT=3000

# ── Cores ──────────────────────────────────────────────────────────────────────
GRN='\033[0;32m'; YLW='\033[0;33m'; RED='\033[0;31m'; CYN='\033[0;36m'; RST='\033[0m'
log()  { printf "${CYN}[%s]${RST} %s\n" "$(date +%H:%M:%S)" "$1"; }
ok()   { printf "${GRN}[%s] ✅ %s${RST}\n" "$(date +%H:%M:%S)" "$1"; }
warn() { printf "${YLW}[%s] ⚠️  %s${RST}\n" "$(date +%H:%M:%S)" "$1"; }
err()  { printf "${RED}[%s] ❌ %s${RST}\n" "$(date +%H:%M:%S)" "$1"; }

# ── Carregar variáveis do .env ─────────────────────────────────────────────────
# Usa grep + sed para ser robusto a valores com '=' (tokens JWT, etc.)
# grep retorna exit 1 quando não encontra — o '|| true' evita que set -e aborte
_env_get() {
  local _val
  _val=$(grep -E "^${1}=" "$ENV_FILE" 2>/dev/null | head -1 | sed "s/^${1}=//" | tr -d "\"'") || true
  printf '%s' "$_val"
}

TELEGRAM_TOKEN=""
MONITOR_CHAT_ID=""
if [ -f "$ENV_FILE" ]; then
  TELEGRAM_TOKEN="$(_env_get TELEGRAM_BOT_TOKEN)"
  MONITOR_CHAT_ID="$(_env_get MONITOR_CHAT_ID)"
  _port="$(_env_get PORT)"
  [ -n "$_port" ] && SERVER_PORT="$_port"
fi

HEALTH_URL="http://localhost:${SERVER_PORT}/api/health"

tg_send() {
  [ -n "$TELEGRAM_TOKEN" ] && [ -n "$MONITOR_CHAT_ID" ] || return 0
  curl -sS "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${MONITOR_CHAT_ID}" \
    --data-urlencode "text=$1" \
    --data-urlencode "parse_mode=Markdown" \
    -o /dev/null 2>&1 || true
}

# ── Início ─────────────────────────────────────────────────────────────────────
cd "$DIR"
log "🚀 Iniciando deploy XIXO News → branch: $BRANCH"
echo ""

# ── 1. Verificar e fazer stash de modificações locais ──────────────────────────
STASH_FEITO=0
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  STASH_LABEL="pre-deploy-$(date +%Y%m%d-%H%M%S)"
  warn "Modificações locais detectadas:"
  git status --short | sed 's/^/    /'
  log "Fazendo stash: '$STASH_LABEL'"
  git stash push -m "$STASH_LABEL"
  STASH_FEITO=1
  echo ""
fi

# ── 2. Git pull ─────────────────────────────────────────────────────────────────
log "📥 git pull origin $BRANCH..."
PULL_OUTPUT=$(git pull origin "$BRANCH" 2>&1)
echo "$PULL_OUTPUT" | sed 's/^/  /'

COMMIT_MSG=$(git log -1 --format='%s (%h)' 2>/dev/null || echo 'commit desconhecido')
ok "Pull concluído: $COMMIT_MSG"
echo ""

# ── 2.5 Restaurar settings.json do stash (configuração de runtime do servidor) ─
# settings.json não é versionado — cada servidor mantém sua própria versão.
# Se havia um stash, restaura o settings.json de lá para não perder as configurações
# do painel (autopub on/off, intervalo, etc.) que o usuário definiu.
if [ "$STASH_FEITO" = "1" ]; then
  if git show stash@{0}:backend/settings.json &>/dev/null; then
    git checkout stash@{0} -- backend/settings.json 2>/dev/null && \
      ok "settings.json restaurado do stash (configurações do servidor preservadas)" || \
      warn "Não foi possível restaurar settings.json do stash"
  fi
  git stash drop 2>/dev/null || true
fi
echo ""

# ── 3. Validar arquivos de configuração ────────────────────────────────────────
log "🔍 Validando arquivos de configuração..."
JSON_PROBLEMS=0

for f in "backend/sources.json" "backend/settings.json"; do
  if [ -f "$DIR/$f" ]; then
    if python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$DIR/$f" 2>/dev/null; then
      NFONTES=""
      if [[ "$f" == *"sources"* ]]; then
        NFONTES=" ($(python3 -c "import json; d=json.load(open('$DIR/$f')); print(sum(1 for s in d if s.get('active')))" 2>/dev/null || echo '?') ativas)"
      fi
      ok "$f válido${NFONTES}"
    else
      err "$f contém JSON INVÁLIDO — deploy abortado"
      tg_send "❌ *Deploy abortado* — \`$f\` contém JSON inválido%0ACommit: $COMMIT_MSG"
      exit 1
    fi
  fi
done
echo ""

# ── 4. Reiniciar PM2 ──────────────────────────────────────────────────────────
log "🔄 Reiniciando $APP_NAME via PM2..."
pm2 restart "$APP_NAME" --update-env 2>&1 | tail -3 | sed 's/^/  /'
echo ""

# ── 5. Health check ──────────────────────────────────────────────────────────
log "⏳ Aguardando processo subir (máx ${MAX_WAIT_HEALTH}s)..."
ELAPSED=0
HTTP_CODE="000"

while [ "$HTTP_CODE" != "200" ] && [ $ELAPSED -lt $MAX_WAIT_HEALTH ]; do
  sleep 3
  ELAPSED=$((ELAPSED + 3))
  HTTP_CODE=$(curl -sS -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null || echo "000")
  [ "$HTTP_CODE" != "200" ] && log "  aguardando... (${ELAPSED}s, HTTP $HTTP_CODE)"
done

if [ "$HTTP_CODE" = "200" ]; then
  HEALTH_JSON=$(curl -sS "$HEALTH_URL" 2>/dev/null || echo '{}')
  DB_STATUS=$(python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('db','?'))" <<< "$HEALTH_JSON" 2>/dev/null || echo '?')
  ART_1H=$(python3    -c "import json,sys; d=json.load(sys.stdin); print(d.get('articles',{}).get('last_1h','?'))" <<< "$HEALTH_JSON" 2>/dev/null || echo '?')
  ART_24H=$(python3   -c "import json,sys; d=json.load(sys.stdin); print(d.get('articles',{}).get('last_24h','?'))" <<< "$HEALTH_JSON" 2>/dev/null || echo '?')
  COM_ERRO=$(python3  -c "import json,sys; d=json.load(sys.stdin); print(d.get('sources',{}).get('com_erro','?'))"  <<< "$HEALTH_JSON" 2>/dev/null || echo '?')

  ok "Health check OK em ${ELAPSED}s"
  echo "  DB: $DB_STATUS | artigos/1h: $ART_1H | /24h: $ART_24H | fontes com erro: $COM_ERRO"
  echo ""
  ok "🎉 Deploy concluído com sucesso!"

  tg_send "✅ *Deploy OK* — $(date '+%d/%m %H:%M')
$COMMIT_MSG
DB: $DB_STATUS | artigos/1h: $ART_1H | fontes com erro: $COM_ERRO"

else
  err "Health check FALHOU após ${ELAPSED}s (HTTP $HTTP_CODE)"
  echo ""
  echo "── Últimas 20 linhas de log PM2 ──────────────────────────────────────────────"
  pm2 logs "$APP_NAME" --lines 20 --nostream 2>/dev/null || true
  echo "──────────────────────────────────────────────────────────────────────────────"

  tg_send "❌ *Deploy com problema*
Health check retornou HTTP $HTTP_CODE após ${ELAPSED}s
Commit: $COMMIT_MSG
Verifique: \`pm2 logs xixo-news --lines 30\`"
  exit 1
fi
