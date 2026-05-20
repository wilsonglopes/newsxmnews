# RECONSTRUCTION.md — Guia de Reconstrução do Sistema XIXO News

> **Para IAs e humanos:** Este documento contém tudo necessário para recriar o sistema do zero após perda total do servidor. Leia do início ao fim antes de executar qualquer comando.

---

## 1. Visão Geral da Arquitetura

```
[Internet]
    │
    ▼
[Oracle VPS — ubuntu@146.235.53.61]
    ├── nginx (porta 80/443)
    │     ├── news.xmnews.com.br  → proxy :3002  (XIXO News — este sistema)
    │     ├── zm.xmnews.com.br    → proxy :3003  (Zunino Moda)
    │     └── artesapro.com.br    → proxy :3004  (Artesa Pro)
    │
    └── PM2
          ├── xixo-news  (id:1)  → /home/ubuntu/xixo/backend/server.js       :3002
          ├── app-zm     (id:3)  → /home/ubuntu/app-zm/backend/server.js     :3003
          └── app-candidato (id:5) → /home/ubuntu/candidato/backend/server.js :3004

[PostgreSQL] — local na VPS, porta 5432
    └── banco: rb24horas
    └── usuário: rb24user

[GitHub — código-fonte] github.com/wilsonglopes/xixo (privado)
[GitHub — backups]      github.com/wilsonglopes/newsxmnews-backup (privado)
```

---

## 2. Provisionar Novo Servidor (Oracle Cloud)

### 2.1 Criar instância Oracle Free Tier
- Shape: VM.Standard.E2.1.Micro (sempre gratuito) ou superior
- Imagem: Ubuntu 22.04 LTS
- Adicionar chave SSH pública

### 2.2 Configurar firewall (Security List)
Liberar as seguintes portas de entrada:
- TCP 22 (SSH)
- TCP 80 (HTTP)
- TCP 443 (HTTPS)

```bash
# No servidor, liberar portas no iptables do Ubuntu
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

### 2.3 Dependências base
```bash
sudo apt update && sudo apt upgrade -y

# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# PostgreSQL 14+
sudo apt install -y postgresql postgresql-contrib

# nginx
sudo apt install -y nginx

# PM2
sudo npm install -g pm2

# Sharp (dependência de imagens — requer libvips)
sudo apt install -y libvips-dev

# Certbot (SSL Let's Encrypt)
sudo apt install -y certbot python3-certbot-nginx

# Git
sudo apt install -y git
```

---

## 3. Restaurar Banco de Dados

### 3.1 Criar usuário e banco
```bash
sudo -u postgres psql <<'SQL'
CREATE USER rb24user WITH PASSWORD 'SENHA_DO_BACKUP';
CREATE DATABASE rb24horas OWNER rb24user;
GRANT ALL PRIVILEGES ON DATABASE rb24horas TO rb24user;
SQL
```

> **Nota:** A senha está no arquivo `configs/.env` do repositório de backup (`DATABASE_URL=postgresql://rb24user:SENHA@localhost:5432/rb24horas`).

### 3.2 Restaurar dump
```bash
# Copie o arquivo db/backup-latest.dump do repositório de backup para o servidor
pg_restore -U rb24user -d rb24horas --no-password db/backup-latest.dump
```

### 3.3 Verificar
```bash
psql -U rb24user -d rb24horas -c "SELECT COUNT(*) FROM articles;"
psql -U rb24user -d rb24horas -c "SELECT COUNT(*) FROM subscribers;"
psql -U rb24user -d rb24horas -c "SELECT COUNT(*) FROM sites_catalog;"
```

---

## 4. Restaurar Código

### 4.1 Clonar repositório principal
```bash
cd /home/ubuntu
git clone git@github.com:wilsonglopes/xixo.git xixo
cd xixo
npm install --prefix backend
```

### 4.2 Restaurar arquivos de configuração (do backup)
```bash
# Clone o repo de backup
git clone git@github.com:wilsonglopes/newsxmnews-backup.git /home/ubuntu/xixo-backup

# Copiar configs
cp /home/ubuntu/xixo-backup/configs/.env          /home/ubuntu/xixo/backend/.env
cp /home/ubuntu/xixo-backup/configs/sources.json  /home/ubuntu/xixo/backend/sources.json
cp /home/ubuntu/xixo-backup/configs/settings.json /home/ubuntu/xixo/backend/settings.json
```

### 4.3 Criar diretórios de uploads
```bash
mkdir -p /home/ubuntu/xixo/backend/public/uploads/cards
```

---

## 5. Configurar nginx

### 5.1 Virtual host — news.xmnews.com.br
```bash
sudo nano /etc/nginx/sites-available/news.xmnews.com.br
```

Conteúdo:
```nginx
server {
    listen 80;
    server_name news.xmnews.com.br;

    # Uploads de cards (DEVE vir antes do location /api/)
    location ^~ /api/uploads/ {
        alias /home/ubuntu/xixo/backend/public/uploads/;
        expires 7d;
        add_header Cache-Control "public";
    }

    location / {
        proxy_pass         http://localhost:3002;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/news.xmnews.com.br /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

> **Para os outros sites (zm, artesapro):** consulte os arquivos em `configs/nginx/` no repositório de backup.

### 5.2 SSL (Let's Encrypt)
```bash
sudo certbot --nginx -d news.xmnews.com.br
# Repita para outros domínios
```

---

## 6. Iniciar Aplicação com PM2

```bash
cd /home/ubuntu/xixo/backend
pm2 start server.js --name xixo-news
pm2 save
pm2 startup  # gera comando — execute o comando que ele mostrar
```

### Verificar
```bash
pm2 status
pm2 logs xixo-news --lines 50
curl -s http://localhost:3002/api/health || echo "Sem rota /health — tentar outra"
```

---

## 7. Configurar Backup Automático no Novo Servidor

```bash
# Clonar repo de backup (se não estiver clonado)
git clone git@github.com:wilsonglopes/newsxmnews-backup.git /home/ubuntu/xixo-backup

# Copiar script de backup
cp /home/ubuntu/xixo/backup-xixo.sh /home/ubuntu/backup-xixo.sh
chmod +x /home/ubuntu/backup-xixo.sh

# Configurar PGPASSWORD para pg_dump sem senha interativa
echo 'rb24user:5432:rb24horas:rb24user:SENHA' >> ~/.pgpass
chmod 600 ~/.pgpass

# Cron diário às 3h BRT (= 6h UTC)
crontab -e
# Adicionar linha:
# 0 6 * * * /home/ubuntu/backup-xixo.sh >> /home/ubuntu/xixo-backup/backup.log 2>&1
```

---

## 8. Variáveis de Ambiente (.env)

O arquivo completo está no repositório de backup em `configs/.env`. Abaixo a lista de todas as variáveis e onde obter cada uma se precisar recriar:

| Variável | Onde obter |
|---|---|
| `DATABASE_URL` | Recriar com nova senha do PostgreSQL |
| `JWT_SECRET` | Gerar: `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | Gerar: `openssl rand -hex 16` (32 chars) |
| `GEMINI_KEY` | Google AI Studio: aistudio.google.com |
| `DEEPSEEK_KEY` | DeepSeek API: platform.deepseek.com |
| `TELEGRAM_BOT_TOKEN` | @BotFather no Telegram |
| `CF_PROXY_URL` | Cloudflare Worker URL (ver memory: project-cf-worker-proxy.md) |
| `CF_PROXY_TOKEN` | Mesmo Worker — secret definido no dashboard CF |
| `PUBLIC_BASE_URL` | `https://news.xmnews.com.br` (fixo) |
| `WP_*` | Credenciais WordPress de cada portal (cadastradas no painel admin) |
| `FB_PAGE_TOKEN_*` | Meta Business — Long-Lived Token via Graph API |

---

## 9. Estrutura de Tabelas do Banco (referência rápida)

As migrations rodam automaticamente no startup do `server.js`. Após restaurar o dump, as tabelas já existem. Se precisar recriar do zero, as migrations estão em `backend/routes/admin.js` (função `initializeDatabase`) e `backend/server.js` (seções `tryMigrate`).

Tabelas principais:
- `articles` — artigos coletados das fontes
- `subscribers` — assinantes (portais clientes)
- `subscriber_sites` — relação assinante × portal
- `sites_catalog` — portais disponíveis (5 ativos)
- `publications` — histórico de publicações no WordPress
- `autopub_rules` — regras de autopublicação por fonte
- `autopub_log` — log de cada rodada de autopublicação
- `autopub_queue` — fila de publicações pendentes

---

## 10. Checklist de Verificação Pós-Restauração

- [ ] PostgreSQL rodando: `sudo systemctl status postgresql`
- [ ] Banco restaurado: `psql -U rb24user -d rb24horas -c "\dt"`
- [ ] `.env` com todas as variáveis preenchidas
- [ ] `npm install` executado em `/home/ubuntu/xixo/backend`
- [ ] PM2 iniciado: `pm2 status` mostra `online`
- [ ] nginx com SSL: `curl -I https://news.xmnews.com.br`
- [ ] Admin abre: `https://news.xmnews.com.br/admin`
- [ ] Login funciona (credenciais estão no banco restaurado)
- [ ] Autopub ativo: verificar cron no PM2 ou setTimeout no server.js
- [ ] Backup configurado: `crontab -l` mostra o job das 3h
- [ ] Teste de card gerado no painel admin

---

## 11. Recuperação Rápida (servidor comprometido mas acessível)

Se o servidor foi invadido mas ainda está acessível:

```bash
# 1. Parar tudo
pm2 stop all

# 2. Fazer dump emergencial do banco
pg_dump -U rb24user -d rb24horas > /tmp/emergency-dump.sql

# 3. Transferir para local
scp -i ~/.ssh/artesapro.key ubuntu@146.235.53.61:/tmp/emergency-dump.sql ./

# 4. Revogar chaves SSH no painel Oracle Cloud

# 5. Criar nova instância e seguir este guia do zero
```

---

*Gerado em: 2026-05-20 — Commit de referência: 1cc23dd*
