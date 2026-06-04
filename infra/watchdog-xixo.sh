#!/bin/bash
# watchdog-xixo.sh — auto-recuperação do XIXO. Roda a cada 2min via cron.
# Vigia /api/health; se degradado por N checagens seguidas, age e avisa no Telegram.
set -uo pipefail
HEALTH_URL="http://localhost:3002/api/health"
STATE=/home/ubuntu/.xixo-watchdog-fails
COOLDOWN=/home/ubuntu/.xixo-watchdog-cooldown
LOG=/home/ubuntu/xixo-watchdog.log
ENV=/home/ubuntu/xixo/backend/.env
MAX_FAILS=3          # 3 falhas x 2min = ~6min de problema antes de agir
COOLDOWN_MIN=15      # nao reiniciar de novo em menos de 15min
DATE=$(TZ=America/Sao_Paulo date +%Y-%m-%d_%H:%M)

tg() {
  local TGT CID
  TGT=$(grep -E "^TELEGRAM_BOT_TOKEN=" "$ENV" 2>/dev/null | head -1 | sed "s/^[^=]*=//" | tr -d "\"'")
  CID=$(grep -E "^MONITOR_CHAT_ID=" "$ENV" 2>/dev/null | head -1 | sed "s/^[^=]*=//" | tr -d "\"'")
  [ -n "$TGT" ] && [ -n "$CID" ] || return 0
  curl -sS "https://api.telegram.org/bot${TGT}/sendMessage" --data-urlencode "chat_id=${CID}" --data-urlencode "text=$1" --data-urlencode "parse_mode=Markdown" -o /dev/null 2>&1 || true
}

RESP=$(curl -sS --max-time 12 "$HEALTH_URL" 2>/dev/null || echo "")
STATUS=$(echo "$RESP" | grep -o "\"status\":\"[^\"]*\"" | cut -d"\"" -f4)
DB=$(echo "$RESP" | grep -o "\"db\":\"[^\"]*\"" | cut -d"\"" -f4)

if [ "$STATUS" = "ok" ]; then
  echo 0 > "$STATE"
  exit 0
fi

FAILS=$(cat "$STATE" 2>/dev/null || echo 0)
FAILS=$((FAILS + 1))
echo "$FAILS" > "$STATE"
echo "[$DATE] health=${STATUS:-sem_resposta} db=${DB:-?} fails=$FAILS" >> "$LOG"
[ "$FAILS" -lt "$MAX_FAILS" ] && exit 0

# Cooldown: evita loop de restart
if [ -f "$COOLDOWN" ]; then
  AGE=$(( ( $(date +%s) - $(stat -c %Y "$COOLDOWN") ) / 60 ))
  if [ "$AGE" -lt "$COOLDOWN_MIN" ]; then
    echo "[$DATE] em cooldown (${AGE}min) - nao reinicia" >> "$LOG"
    exit 0
  fi
fi

echo "[$DATE] AGINDO - status=$STATUS db=$DB" >> "$LOG"
ACOES=""
# Disco cheio? limpeza emergencial primeiro
USO=$(df -P / | awk "NR==2{print \$5}" | tr -d "%")
if [ "${USO:-0}" -ge 85 ]; then
  find /tmp/snap-private-tmp/snap.chromium/tmp/ -maxdepth 1 -type d -mmin +30 2>/dev/null | xargs -r rm -rf 2>/dev/null
  ACOES="${ACOES}"$'\n'"limpeza de disco (estava ${USO}%)"
fi
# Banco com problema? reinicia PostgreSQL
if [ "$DB" != "ok" ]; then
  sudo systemctl restart postgresql 2>/dev/null && ACOES="${ACOES}"$'\n'"PostgreSQL reiniciado"
  sleep 6
fi
# Reinicia o servico
pm2 restart xixo-news --update-env >/dev/null 2>&1 && ACOES="${ACOES}"$'\n'"servico xixo-news reiniciado"
touch "$COOLDOWN"
echo 0 > "$STATE"
sleep 8

# Verifica recuperacao
RESP2=$(curl -sS --max-time 12 "$HEALTH_URL" 2>/dev/null || echo "")
STATUS2=$(echo "$RESP2" | grep -o "\"status\":\"[^\"]*\"" | cut -d"\"" -f4)
if [ "$STATUS2" = "ok" ]; then
  tg "🛟 *Auto-recuperacao XIXO* - sistema estava com problema (status=$STATUS, db=$DB) e foi recuperado automaticamente.${ACOES}"$'\n'"✅ Agora: OK"$'\n'"_${DATE}_"
  echo "[$DATE] RECUPERADO" >> "$LOG"
else
  tg "🆘 *XIXO travado - recuperacao automatica FALHOU*"$'\n'"status=$STATUS db=$DB apos acoes ainda: ${STATUS2:-sem_resposta}${ACOES}"$'\n'"⚠️ Precisa de atencao manual."$'\n'"_${DATE}_"
  echo "[$DATE] FALHA na recuperacao (ainda $STATUS2)" >> "$LOG"
fi
