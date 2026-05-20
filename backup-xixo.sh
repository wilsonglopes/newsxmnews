#!/bin/bash
# ============================================================
#  backup-xixo.sh — Backup diário do sistema XIXO News
#  Roda no servidor Oracle VPS como cron job às 3h BRT
#  Destino: repositório privado no GitHub
# ============================================================
set -euo pipefail

# ── Configuração ────────────────────────────────────────────
REPO_DIR="/home/ubuntu/xixo-backup"
APP_DIR="/home/ubuntu/xixo"
PG_DB="rb24horas"
PG_USER="rb24user"
PG_HOST="127.0.0.1"
PG_PASS="rb24pass2026"
BACKUP_DATE=$(TZ="America/Sao_Paulo" date +"%Y-%m-%d_%H-%M")
LOG="$REPO_DIR/backup.log"

# ── Garante que o repo de backup existe ────────────────────
if [ ! -d "$REPO_DIR/.git" ]; then
  echo "[$BACKUP_DATE] ERRO: $REPO_DIR não é um repositório git. Execute o setup primeiro." | tee -a "$LOG"
  exit 1
fi

cd "$REPO_DIR"

echo "" >> "$LOG"
echo "══════════════════════════════════════════" >> "$LOG"
echo "[$BACKUP_DATE] Iniciando backup" >> "$LOG"

# ── 1) Dump do banco PostgreSQL ─────────────────────────────
echo "[$BACKUP_DATE] pg_dump..." >> "$LOG"
mkdir -p db
PGPASSWORD="$PG_PASS" pg_dump -U "$PG_USER" -h "$PG_HOST" -d "$PG_DB" \
  --format=custom \
  --file="db/backup-latest.dump" 2>> "$LOG"

# Mantém os últimos 7 dumps diários nomeados por data
cp "db/backup-latest.dump" "db/backup-${BACKUP_DATE}.dump"
# Remove dumps com mais de 7 dias
find db/ -name "backup-20*.dump" -mtime +7 -delete 2>/dev/null || true

echo "[$BACKUP_DATE] pg_dump OK ($(du -sh db/backup-latest.dump | cut -f1))" >> "$LOG"

# ── 2) Arquivos de configuração ─────────────────────────────
echo "[$BACKUP_DATE] Copiando configs..." >> "$LOG"
mkdir -p configs

# .env (contém todas as chaves — repositório DEVE ser privado)
cp "$APP_DIR/backend/.env"          configs/.env
cp "$APP_DIR/backend/sources.json"  configs/sources.json
cp "$APP_DIR/backend/settings.json" configs/settings.json 2>/dev/null || echo "[$BACKUP_DATE] settings.json não encontrado (ok)" >> "$LOG"

# nginx virtual hosts
mkdir -p configs/nginx
sudo cp /etc/nginx/sites-available/* configs/nginx/ 2>/dev/null || true

echo "[$BACKUP_DATE] Configs OK" >> "$LOG"

# ── 3) Lista de processos PM2 ───────────────────────────────
pm2 list --no-color > configs/pm2-list.txt 2>/dev/null || true
pm2 dump > /dev/null 2>&1 || true
cp /home/ubuntu/.pm2/dump.pm2 configs/pm2-dump.json 2>/dev/null || true

# ── 4) Commit e push ────────────────────────────────────────
echo "[$BACKUP_DATE] Commit e push..." >> "$LOG"

git add -A
git diff --cached --quiet && {
  echo "[$BACKUP_DATE] Nenhuma alteração — skip commit" >> "$LOG"
  exit 0
}

git commit -m "backup: $BACKUP_DATE" >> "$LOG" 2>&1
git push origin main >> "$LOG" 2>&1

echo "[$BACKUP_DATE] Backup concluído com sucesso" >> "$LOG"
