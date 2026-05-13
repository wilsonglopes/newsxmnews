# Documentação Completa — Sistema Site XIXO (Painel Editorial)

> Gerado em: 2026-05-10 | Versão de referência: commit `ec3c410`

---

## Índice

1. [Visão Geral do Projeto](#1-visão-geral-do-projeto)
2. [Infraestrutura e Servidores](#2-infraestrutura-e-servidores)
3. [Repositório e Deploy](#3-repositório-e-deploy)
4. [Estrutura de Arquivos](#4-estrutura-de-arquivos)
5. [Banco de Dados — Schema Completo](#5-banco-de-dados--schema-completo)
6. [Variáveis de Ambiente (.env)](#6-variáveis-de-ambiente-env)
7. [Backend — Arquitetura e Rotas](#7-backend--arquitetura-e-rotas)
8. [Módulo de Autopublicação](#8-módulo-de-autopublicação)
9. [Conectores de Publicação](#9-conectores-de-publicação)
10. [Frontend — Painel do Assinante (index.html)](#10-frontend--painel-do-assinante-indexhtml)
11. [Frontend — Painel Admin (admin.html)](#11-frontend--painel-admin-adminhtml)
12. [Plugin WordPress — XIXO Publisher](#12-plugin-wordpress--xixo-publisher)
13. [Sistema de IA](#13-sistema-de-ia)
14. [Autenticação e Segurança](#14-autenticação-e-segurança)
15. [Planos e Assinantes](#15-planos-e-assinantes)
16. [Comandos Operacionais](#16-comandos-operacionais)
17. [Ponto de Restauração Estável](#17-ponto-de-restauração-estável)
18. [Fluxo Completo de Publicação](#18-fluxo-completo-de-publicação)

---

## 1. Visão Geral do Projeto

**Nome interno:** Sistema Site XIXO / Painel Editorial RB24Horas

**O que é:** SaaS editorial multi-tenant para jornais e portais de notícias. Assinantes acessam um painel web que:

1. **Agrega notícias** de dezenas de fontes RSS e por scraping HTML
2. **Reescreve artigos com IA** (Gemini ou DeepSeek) — chapéu, título, resumo, corpo e tags
3. **Publica automaticamente** (ou manualmente) em sites WordPress, Blogger ou via Webhook
4. **Gerencia múltiplos sites** por assinante, com prompts de IA personalizados por site

**URL de produção:** https://news.xmnews.com.br  
**Login admin:** admin@rb24horas.com.br (ver .env para senha)

---

## 2. Infraestrutura e Servidores

### Servidor de Produção (Oracle VPS)

| Item | Valor |
|------|-------|
| Provedor | Oracle Cloud (Always Free) |
| IP público | `146.235.53.61` |
| Usuário SSH | `ubuntu` |
| Chave SSH | `J:\0006- Sistema Site XIXO\ssh-key-2026-04-21.key` |
| Porta da aplicação | `3002` |
| Path da aplicação | `~/xixo/` |
| Processo PM2 | `xixo-news` |

### Banco de Dados (PostgreSQL — local na VPS)

| Item | Valor |
|------|-------|
| Tipo | PostgreSQL 15 (instalado diretamente na VPS, não Docker) |
| Host | `localhost` (na VPS) |
| Porta | `5432` |
| Banco | `rb24horas` |
| Usuário | `rb24user` |
| Senha | `rb24pass2026` |
| Connection string completa | `postgresql://rb24user:rb24pass2026@localhost:5432/rb24horas` |

> **Nota:** O banco está na própria VPS Oracle (não no Supabase). Isso foi uma decisão de custo e latência. O Supabase foi descartado para produção.

### Ambiente de Desenvolvimento (Windows local)

| Item | Valor |
|------|-------|
| Banco local | PostgreSQL via Docker na porta `5434` |
| Connection string local | `postgresql://rb24user:rb24pass@localhost:5434/rb24horas` |
| Porta do servidor | `3000` |
| URL local | `http://localhost:3000` |

### Acesso SSH à VPS

```bash
ssh -i "J:\0006- Sistema Site XIXO\ssh-key-2026-04-21.key" -o StrictHostKeyChecking=no ubuntu@146.235.53.61
```

---

## 3. Repositório e Deploy

### GitHub

| Item | Valor |
|------|-------|
| Repositório | https://github.com/wilsonglopes/newsxmnews |
| Branch principal | `main` |
| Usuário git | `wilsonglopes` |

### Deploy Automático (GitHub Actions)

O deploy ocorre automaticamente a cada `git push origin main` via GitHub Actions.

**Fluxo do deploy:**
1. Push para `main` no GitHub
2. GitHub Actions executa workflow
3. Conecta via SSH na VPS Oracle
4. Executa: `cd ~/xixo && git pull origin main && pm2 restart xixo-news --update-env`

### Deploy Manual (quando Actions falhar)

```bash
ssh -i "J:\0006- Sistema Site XIXO\ssh-key-2026-04-21.key" -o StrictHostKeyChecking=no ubuntu@146.235.53.61 "cd ~/xixo && git pull origin main && pm2 restart xixo-news --update-env"
```

### Comandos PM2 na VPS

```bash
# Ver status do processo
pm2 status xixo-news

# Ver logs em tempo real
pm2 logs xixo-news

# Reiniciar
pm2 restart xixo-news --update-env

# Parar
pm2 stop xixo-news
```

### Fluxo de desenvolvimento

```bash
# 1. Fazer mudanças locais
# 2. Testar em localhost:3000
# 3. Commit e push
git add arquivo.js
git commit -m "feat: descrição da mudança"
git push origin main
# Deploy automático acontece via GitHub Actions
```

---

## 4. Estrutura de Arquivos

```
j:\0006- Sistema Site XIXO\
│
├── DOCUMENTACAO.md              ← Este arquivo
├── README.md                    ← README desatualizado (legado)
│
├── backend/
│   ├── server.js                ← Ponto de entrada. Express + cron + rotas
│   ├── autopub.js               ← Worker de autopublicação automática
│   ├── migrate.js               ← Migrações de banco (roda manualmente)
│   ├── sources.json             ← Lista de fontes de notícias (editável)
│   ├── settings.json            ← Configurações globais do sistema (IA, autopub)
│   ├── package.json             ← Dependências Node.js
│   ├── .env                     ← Credenciais (NÃO commitado no git)
│   ├── .env.example             ← Modelo de variáveis de ambiente
│   │
│   ├── db/
│   │   ├── connection.js        ← Pool de conexão PostgreSQL
│   │   ├── schema.sql           ← Schema completo do banco
│   │   ├── setup.js             ← Setup inicial (cria tabelas + admin + demo)
│   │   └── seed.js              ← Dados de seed opcionais
│   │
│   ├── routes/
│   │   ├── admin.js             ← Rotas do painel admin (protegidas por adminAuth)
│   │   ├── auth.js              ← Login, logout, /me, /profile
│   │   ├── articles.js          ← Listagem de artigos do banco
│   │   ├── publish.js           ← Publicação manual de artigos
│   │   ├── sites.js             ← Sites do assinante logado
│   │   ├── drafts.js            ← Rascunhos
│   │   ├── ia.js                ← Reescrita e categorização com IA
│   │   ├── subscriber-sources.js← Fontes do assinante logado
│   │   └── image-proxy.js       ← Proxy de imagens (hotlink protection)
│   │
│   ├── connectors/
│   │   ├── wordpress.js         ← Publicação WordPress (REST API + Plugin XIXO)
│   │   ├── blogger.js           ← Publicação Blogger (Google OAuth)
│   │   ├── webhook.js           ← Publicação via Webhook genérico
│   │   └── encrypt.js           ← Criptografia AES-256-GCM para tokens
│   │
│   ├── scrapers/
│   │   ├── normalizer.js        ← Normalização de artigos coletados
│   │   ├── full-content.js      ← Extração de conteúdo completo (Readability)
│   │   └── headless-content.js  ← Extração via Puppeteer (sites dinâmicos)
│   │
│   └── middleware/
│       ├── auth.js              ← Middleware JWT para assinantes
│       └── adminAuth.js         ← Middleware JWT com verificação is_admin
│
├── frontend/
│   └── subscriber/
│       ├── index.html           ← Painel do assinante (SPA)
│       ├── admin.html           ← Painel do administrador (SPA)
│       └── login.html           ← Página de login (rota padrão)
│
└── portal-publisher/
    └── portal-publisher.php     ← Plugin WordPress (instalado nos sites dos clientes)
```

---

## 5. Banco de Dados — Schema Completo

### Tabelas

#### `plans` — Planos de assinatura
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| id | UUID PK | Identificador |
| name | VARCHAR(100) UNIQUE | Nome do plano |
| max_sources | INT | Limite de fontes |
| max_publications_per_month | INT | Limite de publicações (NULL = ilimitado) |
| max_sites | INT | Limite de sites cadastrados |
| price_cents | INT | Preço em centavos |
| active | BOOLEAN | Se o plano está disponível |

**Planos padrão:**
- Básico: 5 fontes, 30 pub/mês, 1 site — R$ 97,00
- Profissional: 15 fontes, 100 pub/mês, 2 sites — R$ 197,00
- Premium: ilimitado, 5 sites — R$ 397,00

---

#### `subscribers` — Assinantes e administradores
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| id | UUID PK | Identificador |
| name | VARCHAR(200) | Nome |
| email | VARCHAR(200) UNIQUE | Email de login |
| password_hash | VARCHAR(255) | Senha (bcrypt, 10 rounds) |
| plan_id | UUID FK | Plano contratado |
| plan_expires_at | TIMESTAMPTZ | Vencimento do plano |
| plan_value | DECIMAL(10,2) | Valor personalizado cobrado |
| active | BOOLEAN | Conta ativa |
| is_admin | BOOLEAN | Acesso ao painel admin |
| ai_prompt | TEXT | Prompt padrão para IA |
| gemini_key | TEXT | Campo legado (não usado atualmente) |
| phone | VARCHAR(30) | Telefone |
| address | TEXT | Endereço |
| created_at | TIMESTAMPTZ | Data de cadastro |

---

#### `sources` — Fontes de notícias
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| id | UUID PK | Identificador |
| name | VARCHAR(200) | Nome da fonte |
| slug | VARCHAR(100) UNIQUE | Identificador único (ex: `g1`, `uol`) |
| type | VARCHAR(20) | `rss` ou `scraping` |
| url | TEXT | URL do feed ou página |
| section_selector | TEXT | Seletor CSS do item (scraping) |
| title_selector | TEXT | Seletor do título |
| date_selector | TEXT | Seletor da data |
| link_selector | TEXT | Seletor do link |
| image_selector | TEXT | Seletor da imagem |
| content_selector | TEXT | Seletor do corpo |
| category | VARCHAR(50) | `nacional`, `regional`, `esporte`, `agro`, `governo` |
| active | BOOLEAN | Se está coletando |
| last_fetched_at | TIMESTAMPTZ | Última coleta |
| last_error | TEXT | Último erro registrado |

---

#### `subscriber_sources` — Fontes atribuídas a assinantes
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| subscriber_id | UUID FK | Assinante |
| source_id | UUID FK | Fonte |
| PRIMARY KEY | (subscriber_id, source_id) | Unicidade |

---

#### `articles` — Artigos coletados
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| id | UUID PK | Identificador |
| source_id | UUID FK | Fonte de origem |
| external_url | TEXT UNIQUE | URL original do artigo |
| chapeu | VARCHAR(100) | Chapéu editorial |
| title | TEXT | Título |
| summary | TEXT | Resumo/lead |
| body | TEXT | Corpo HTML completo |
| image_url | TEXT | URL da imagem principal |
| tags | TEXT[] | Tags |
| author | VARCHAR(200) | Autor |
| published_at | TIMESTAMPTZ | Data de publicação |
| fetched_at | TIMESTAMPTZ | Quando foi coletado |

> **Limpeza automática:** Artigos com mais de 2 dias que não foram publicados são excluídos automaticamente (cron a cada hora).

---

#### `subscriber_sites` — Sites cadastrados pelos assinantes
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| id | UUID PK | Identificador |
| subscriber_id | UUID FK | Dono do site |
| name | VARCHAR(200) | Nome amigável |
| platform | VARCHAR(50) | `wordpress`, `blogger`, `webhook` |
| site_url | TEXT | URL base do site |
| wp_username | VARCHAR(200) | Usuário WordPress |
| wp_app_password | TEXT | Application Password (criptografado AES-256) |
| blogger_blog_id | VARCHAR(200) | ID do blog no Blogger |
| blogger_access_token | TEXT | Token OAuth (criptografado) |
| blogger_refresh_token | TEXT | Refresh token OAuth (criptografado) |
| webhook_url | TEXT | URL do webhook |
| webhook_secret | TEXT | Segredo HMAC do webhook |
| ai_prompt | TEXT | Prompt personalizado para este site |
| default_category_id | VARCHAR(100) | Categoria padrão |
| post_format | VARCHAR(20) | `editorial` ou `standard` |
| xixo_api_key | TEXT | Chave do Plugin XIXO instalado no site |
| auto_publish | BOOLEAN | Autopublicação ativa para este site |
| active | BOOLEAN | Site ativo |
| created_at | TIMESTAMPTZ | Data de cadastro |

---

#### `publications` — Histórico de publicações
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| id | UUID PK | Identificador |
| subscriber_id | UUID FK | Assinante publicador |
| article_id | UUID FK | Artigo publicado |
| site_id | UUID FK | Site de destino |
| platform | VARCHAR(50) | Plataforma |
| external_post_id | VARCHAR(200) | ID do post criado |
| external_post_url | TEXT | URL do post publicado |
| rewritten_title | TEXT | Título reescrito pela IA |
| rewritten_body | TEXT | Corpo reescrito |
| rewritten_chapeu | TEXT | Chapéu gerado |
| rewritten_summary | TEXT | Resumo gerado |
| rewritten_tags | TEXT | Tags (string separada por vírgula) |
| status | VARCHAR(20) | `published` ou `error` |
| error_message | TEXT | Mensagem de erro (se houver) |
| published_at | TIMESTAMPTZ | Data/hora da publicação |

---

#### `autopub_rules` — Regras de autopublicação por site
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| site_id | UUID FK | Site de destino |
| source_id | UUID FK | Fonte autorizada a alimentar este site |
| subscriber_id | UUID | Assinante dono |
| PRIMARY KEY | (site_id, source_id) | Unicidade |

> Cada site tem suas próprias regras: quais fontes devem alimentar a autopublicação. Um mesmo assinante pode ter fontes A e B, mas o site X só recebe artigos da fonte A.

---

#### `autopub_log` — Log de processamento da autopublicação
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| article_id | UUID FK | Artigo processado |
| site_id | UUID FK | Site de destino |
| subscriber_id | UUID | Assinante |
| status | VARCHAR(20) | `ok` ou `erro` |
| error_msg | TEXT | Mensagem de erro |
| processed_at | TIMESTAMPTZ | Quando foi processado |
| PRIMARY KEY | (article_id, site_id) | Impede duplicatas |

---

#### `sessions` — Sessões JWT (legado, não usada ativamente)
| Coluna | Tipo | Descrição |
|--------|------|-----------|
| id | UUID PK | — |
| subscriber_id | UUID FK | — |
| token | VARCHAR(255) UNIQUE | — |
| expires_at | TIMESTAMPTZ | — |

---

### Relacionamentos de exclusão em cascata

```
subscribers → subscriber_sources (CASCADE)
subscribers → subscriber_sites   (CASCADE)
subscribers → sessions           (CASCADE)
subscriber_sites → autopub_rules (CASCADE)
subscriber_sites → autopub_log   (CASCADE)
articles         → autopub_log   (CASCADE)

publications → NÃO tem CASCADE (deve ser deletado manualmente antes do subscriber)
```

---

## 6. Variáveis de Ambiente (.env)

Arquivo localizado em `backend/.env`. **Nunca commitar este arquivo no git.**

```env
# WordPress (configuração legada — credenciais movidas para subscriber_sites)
WP_URL=https://rb24horas.com.br
WP_USER=Marcial
WP_PASSWORD=xxxx xxxx xxxx xxxx xxxx xxxx

# IA — Configure ao menos um dos dois
GEMINI_KEY=AIzaSy...               # Google AI Studio → console.cloud.google.com
DEEPSEEK_KEY=sk-...                 # platform.deepseek.com

# Backend
BACKEND_URL=http://localhost:3000   # Em produção: https://news.xmnews.com.br
PORT=3000                           # Em produção: 3002

# Banco de dados
DATABASE_URL=postgresql://rb24user:rb24pass@localhost:5434/rb24horas  # local
# DATABASE_URL=postgresql://rb24user:rb24pass2026@localhost:5432/rb24horas  # VPS

# JWT e Criptografia
JWT_SECRET=...                      # String aleatória longa (>64 chars)
ENCRYPTION_KEY=...                  # Exatamente 32 bytes hex (64 chars hex)

# Sistema
ADMIN_EMAIL=admin@rb24horas.com.br
FETCH_INTERVAL_MINUTES=15
MAX_ARTICLES_PER_SOURCE=20

# Google OAuth (para Blogger)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

> **ENCRYPTION_KEY** é crítica: todas as senhas de Application Password e tokens OAuth dos sites dos clientes são criptografadas com AES-256-GCM usando esta chave. Se a chave for perdida ou trocada, todas as credenciais ficam ilegíveis.

---

## 7. Backend — Arquitetura e Rotas

### Inicialização (`server.js`)

Na inicialização, o servidor:
1. Cria índices no banco (`idx_articles_url`, `idx_articles_date`, `idx_articles_src`)
2. Busca todas as fontes ativas imediatamente
3. Limpa artigos com mais de 2 dias
4. Agenda cron: fontes a cada 15 min, limpeza a cada hora, autopub a cada minuto

### Rotas Públicas (sem autenticação)

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/sources` | Lista fontes com status do cache |
| GET | `/api/feeds` | Todas as notícias em cache |
| GET | `/api/feeds?source=slug` | Notícias de uma fonte |
| GET | `/api/feeds?category=cat` | Notícias por categoria |
| GET | `/api/feeds?since=ISO` | Notícias após data |
| GET | `/api/article?url=...` | Conteúdo completo via scraping |
| GET | `/api/refresh` | Forçar atualização de todas as fontes |
| GET | `/api/refresh?source=slug` | Forçar atualização de uma fonte |
| GET | `/api/settings` | Configurações globais (ia_provider) |
| GET | `/api/proxy-image?url=...` | Proxy de imagens |
| GET | `/api/config` | Config do .env (wpUrl, geminiKey etc.) |

### Rotas Autenticadas — Assinante (JWT)

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/api/auth/login` | Login → retorna JWT |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/auth/me` | Dados do assinante logado |
| PATCH | `/api/auth/profile` | Atualizar nome/telefone/endereço |
| GET | `/api/articles` | Artigos do banco (das fontes do assinante) |
| POST | `/api/publish` | Publicar artigo em um site |
| GET | `/api/sites` | Sites do assinante |
| GET | `/api/drafts` | Rascunhos |
| GET | `/api/subscriber/sources` | Fontes atribuídas ao assinante |
| POST | `/api/ia/rewrite` | Reescrever artigo com IA |
| POST | `/api/ia/categorize` | Categorizar artigo com IA |

### Rotas Admin (JWT com is_admin=true)

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/admin/stats` | Estatísticas gerais |
| GET | `/api/admin/sources` | Todas as fontes |
| POST | `/api/admin/sources` | Criar nova fonte |
| PUT | `/api/admin/sources/:slug` | Editar fonte |
| DELETE | `/api/admin/sources/:slug` | Remover fonte |
| PATCH | `/api/admin/sources/:slug/toggle` | Ativar/desativar fonte |
| PATCH | `/api/admin/sources/:slug/refresh` | Forçar atualização |
| GET | `/api/admin/subscribers` | Todos os assinantes |
| POST | `/api/admin/subscribers` | Criar assinante |
| PUT | `/api/admin/subscribers/:id` | Editar assinante |
| DELETE | `/api/admin/subscribers/:id` | Desativar assinante |
| DELETE | `/api/admin/subscribers/:id/permanente` | Excluir permanentemente |
| GET | `/api/admin/subscribers/:id/sources` | Fontes do assinante |
| POST | `/api/admin/subscribers/:id/sources/:slug` | Atribuir fonte |
| DELETE | `/api/admin/subscribers/:id/sources/:slug` | Remover fonte |
| GET | `/api/admin/subscribers/:id/sites` | Sites do assinante |
| POST | `/api/admin/subscribers/:id/sites` | Criar site |
| PUT | `/api/admin/subscribers/:id/sites/:siteId` | Editar site |
| DELETE | `/api/admin/subscribers/:id/sites/:siteId` | Remover site |
| GET | `/api/admin/all-sites` | Todos os sites de todos os clientes |
| GET | `/api/admin/sites/lookup-by-url?url=` | Buscar site por URL |
| GET | `/api/admin/recent-publications` | Últimas 50 publicações |
| PATCH | `/api/admin/publications/:id` | Atualizar campos rewritten |
| GET | `/api/admin/autopub-log?limit=50` | Log de autopublicação |
| GET | `/api/admin/settings` | Configurações do sistema |
| PUT | `/api/admin/settings` | Atualizar configurações |
| GET | `/api/admin/plans` | Planos disponíveis |
| GET | `/api/admin/financial` | Visão financeira dos clientes |
| GET | `/api/admin/sources-list` | Todas fontes ativas (para UI) |

---

## 8. Módulo de Autopublicação

### Como funciona

O sistema verifica a cada minuto se chegou a hora de rodar uma rodada. O intervalo é configurável pelo admin sem reiniciar o servidor.

**Arquivo:** `backend/autopub.js`

**Fluxo por rodada:**

```
Para cada site com auto_publish=true e assinante ativo:
  1. Busca regras em autopub_rules (quais fontes alimentam este site)
  2. Busca artigos dessas fontes que ainda não estão no autopub_log
  3. Para cada artigo (até max_por_rodada):
     a. Reescreve com IA (chapéu, título, resumo, corpo, tags)
     b. Busca categorias do WordPress via REST API pública
     c. Categoriza automaticamente com IA
     d. Publica (WordPress/Blogger/Webhook)
     e. Registra em publications
     f. Marca em autopub_log como 'ok' ou 'erro'
     g. Pausa 2 segundos (evitar rate limit da IA)
```

### Configurações (`backend/settings.json`)

```json
{
  "ia_provider": "deepseek",
  "autopub_enabled": true,
  "autopub_max_por_rodada": 4,
  "autopub_interval_minutos": 5
}
```

| Campo | Descrição |
|-------|-----------|
| `ia_provider` | `"gemini"` ou `"deepseek"` — vale para todos os assinantes |
| `autopub_enabled` | Liga/desliga toda a autopublicação globalmente |
| `autopub_max_por_rodada` | Máximo de artigos por site por rodada |
| `autopub_interval_minutos` | Intervalo entre rodadas (5, 10, 15, 20, 30, 60, 120) |

> Mudanças em `settings.json` entram em vigor na próxima verificação (máximo 1 minuto) sem precisar reiniciar o servidor.

### Configurar autopublicação para um site (via painel admin)

1. Admin → Clientes → selecionar cliente → Sites
2. Abrir ou criar um site
3. Ativar o toggle "Autopublicação"
4. Selecionar quais fontes alimentarão este site
5. Salvar

### Monitorar

No painel admin: **Configurações → Log de Autopublicação**

Via logs do servidor:
```bash
pm2 logs xixo-news | grep AUTOPUB
```

---

## 9. Conectores de Publicação

### WordPress (`connectors/wordpress.js`)

Dois modos de publicação:

**Modo Plugin XIXO (preferencial):** Se o site tem `xixo_api_key`, usa o plugin instalado no WordPress do cliente via `POST /wp-json/xixo/v1/publish`. Mais robusto, não depende do REST API nativo.

**Modo REST API nativo (fallback):** Usa `wp_username` + `wp_app_password` (descriptografado). Faz:
1. Upload da imagem para biblioteca de mídia
2. Cria/busca tags
3. Publica o post com `status: publish`
4. Define `featured_media` e `categories`

**post_format:**
- `editorial`: Imagem injetada no corpo HTML do post (para temas sem featured image)
- `standard`: Imagem enviada como featured_media (para temas que já exibem)

### Blogger (`connectors/blogger.js`)

Usa Google OAuth2. O `blogger_access_token` é renovado automaticamente via `blogger_refresh_token` quando retorna 401.

**Requer no .env:**
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

### Webhook (`connectors/webhook.js`)

Envia POST JSON com o artigo reescrito para qualquer URL. Se configurado `webhook_secret`, assina o payload com HMAC-SHA256.

**Payload enviado:**
```json
{
  "chapeu": "",
  "title": "",
  "summary": "",
  "body": "",
  "tags": [],
  "image_url": "",
  "source_name": "",
  "source_url": "",
  "published_at": ""
}
```

### Criptografia de Tokens (`connectors/encrypt.js`)

Todas as senhas e tokens OAuth são criptografados com **AES-256-GCM** antes de salvar no banco.

Formato armazenado: `IV(24 chars hex) + AuthTag(32 chars hex) + Ciphertext(hex)`

A chave de criptografia vem de `ENCRYPTION_KEY` no `.env`.

---

## 10. Frontend — Painel do Assinante (`index.html`)

SPA (Single Page Application) servida diretamente pelo Express em `http://servidor/`.

### Funcionalidades

- Login com email/senha
- Visualização de notícias das fontes atribuídas ao assinante
- Filtro por fonte e categoria
- Modal de leitura do artigo (conteúdo completo via scraping)
- Reescrita com IA (botão "Gerar com IA")
  - Seleciona o provedor global (Gemini/DeepSeek) carregado de `/api/settings`
  - Prompt personalizado do site (carregado ao selecionar o site destino)
- Seleção de sites de destino (cards visuais com checkmark)
- Publicação em múltiplos sites simultaneamente
- Histórico de publicações
- Perfil do assinante

### Provedor de IA no frontend

O assinante não escolhe mais o provedor de IA. O sistema:
1. Na carga da página: `fetch('/api/settings')` → armazena `_iaProvider`
2. Usa `_iaProvider` em todas as chamadas `/api/ia/rewrite` e `/api/ia/categorize`

---

## 11. Frontend — Painel Admin (`admin.html`)

Acessível em `/admin.html`. Redireciona para login se não autenticado como admin.

### Seções da sidebar

| Seção | Descrição |
|-------|-----------|
| **Dashboard** | Estatísticas: total de artigos, artigos hoje, assinantes ativos, fontes |
| **Assinantes** | CRUD completo de clientes — nome, email, plano, vencimento, valor, sites, fontes |
| **Fontes** | Gerenciar fontes RSS/scraping — ativar, desativar, editar, forçar atualização |
| **Publicações** | Histórico de todas as publicações de todos os clientes |
| **Publicar** | Admin pode publicar artigos em qualquer site de qualquer cliente |
| **Financeiro** | Visão de clientes com vencimento e valor do plano |
| **Configurações** | Provedor de IA, frequência da autopublicação, artigos por rodada, log |

### Gerenciamento de Assinantes

Para cada assinante, o admin pode:
- Editar dados (nome, email, plano, vencimento, valor, prompt IA)
- Gerenciar fontes atribuídas (checkboxes por fonte)
- Gerenciar sites (WordPress, Blogger, Webhook)
- Ativar/desativar a conta
- **Remover permanentemente** (com confirmação — exclui publications + subscriber em cascata)

### Configurações Globais

Acessível em **Configurações** na sidebar. Três opções em linha:

1. **Provedor de IA:** Gemini (Google) ou DeepSeek — vale para todos
2. **Frequência:** Com que frequência a autopublicação busca artigos novos
3. **Artigos por rodada:** Quantos artigos no máximo são publicados por site a cada rodada

Alterações são salvas em `backend/settings.json` via `PUT /api/admin/settings` e entram em vigor sem reiniciar.

---

## 12. Plugin WordPress — XIXO Publisher

**Arquivo local:** `J:\0006- Sistema Site XIXO\portal-publisher\portal-publisher.php`

**Versão atual:** v1.6.0

O plugin deve ser instalado nos sites WordPress dos clientes que usarem o modo "Plugin XIXO".

### Endpoint exposto pelo plugin

```
POST /wp-json/xixo/v1/publish
Header: X-XIXO-Key: [chave configurada no painel admin]
```

**Payload esperado:**
```json
{
  "title": "",
  "chapeu": "",
  "summary": "",
  "body": "",
  "slug": "",
  "source_url": "",
  "source_name": "",
  "image_url": "",
  "post_format": "editorial|standard",
  "tags": [],
  "category_ids": []
}
```

### Modos do plugin

| Modo | Comportamento |
|------|---------------|
| `editorial` | Injeta `image_url` no corpo do post. Para temas sem featured image. |
| `standard` | Não injeta imagem no corpo. O backend faz upload via REST API e define `featured_media`. |

### Sites usando o plugin

| Site | Modo | Observação |
|------|------|-----------|
| rb24horas.com.br | standard | Plugin v1.1.0, tema Hello Elementor |
| vozesdooraculo.com.br | editorial | Plugin v1.2.0 |
| portalsintonianews.com.br | standard | Plugin v1.1.0 |

### Instalação no WordPress

1. No WordPress admin: Plugins → Adicionar novo → Enviar arquivo
2. Fazer upload do `portal-publisher.php`
3. Ativar o plugin
4. Ir em Configurações → XIXO Publisher → gerar ou definir a chave API
5. Copiar a chave e cadastrá-la no painel admin (campo "Chave do Plugin XIXO")

---

## 13. Sistema de IA

### Provedores suportados

| Provedor | Modelo | Endpoint |
|----------|--------|----------|
| Gemini | gemini-2.5-flash | `generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent` |
| DeepSeek | deepseek-chat | `api.deepseek.com/chat/completions` |

### Onde as chaves ficam

As chaves ficam **exclusivamente no `.env` do servidor**. O frontend nunca tem acesso direto a elas. O provedor ativo é controlado globalmente pelo admin via `settings.json`.

### Operações com IA

**Reescrita (`POST /api/ia/rewrite`):**
- Recebe: título + conteúdo bruto + prompt opcional + provider
- Devolve: `{ chapeu, titulo, resumo, corpo, tags }` em JSON
- O prompt padrão instrui a IA a retornar JSON estruturado com limites editoriais:
  - Chapéu: máx 2 palavras, maiúsculas
  - Título: máx 90 caracteres não-espaço
  - Resumo: frase completa, máx ~160 chars, sempre termina com ponto final

**Categorização (`POST /api/ia/categorize`):**
- Recebe: título, chapéu, tags, corpo (truncado em 600 chars) + lista de categorias do WP com hierarquia
- Devolve: `{ category_ids: [id1, id2] }` — todos os IDs relevantes
- Falha silenciosa: se der erro, retorna `[]` (não bloqueia publicação)

### Prompt personalizado por site

Cada site pode ter um `ai_prompt` personalizado no cadastro. Quando existe, substitui o prompt padrão na reescrita. Útil para portais com perfil editorial diferente (esportivo, político, regional etc.).

---

## 14. Autenticação e Segurança

### JWT

- Algoritmo: HS256
- Expiração: 7 dias
- Secret: `JWT_SECRET` do `.env`
- Payload: `{ id, email, plan_id, is_admin }`

### Middleware de autenticação

- `auth.js`: valida JWT em qualquer rota de assinante
- `adminAuth.js`: valida JWT + exige `is_admin === true`

### Criptografia de credenciais

Todas as credenciais dos sites dos clientes (wp_app_password, blogger tokens) são criptografadas com AES-256-GCM antes de salvar no banco, usando a `ENCRYPTION_KEY` do `.env`.

Formato: `IV(12 bytes) + AuthTag(16 bytes) + Ciphertext` — serializado em hexadecimal.

> **Atenção:** Se a `ENCRYPTION_KEY` for trocada, todos os tokens armazenados ficam ilegíveis. Manter backup desta chave.

### Proxy de imagens

O backend tem um proxy em `/api/proxy-image?url=...` que baixa imagens de sites terceiros contornando a proteção de hotlink. Envia os headers `User-Agent`, `Referer` e `Accept` adequados para cada domínio.

---

## 15. Planos e Assinantes

### Criar um novo assinante (via painel admin)

1. Admin → Clientes → "Novo Cliente"
2. Preencher: nome, email, senha, plano, vencimento, valor mensal
3. Salvar
4. Na sequência: atribuir fontes e cadastrar sites

### Atribuir fontes a um assinante

1. Admin → Clientes → selecionar cliente → aba "Fontes"
2. Marcar as fontes que o cliente tem direito de ver
3. As fontes marcadas aparecem no painel do assinante

### Cadastrar site do assinante

1. Admin → Clientes → selecionar cliente → aba "Sites" → "Novo Site"
2. Escolher plataforma (WordPress/Blogger/Webhook)
3. Preencher credenciais (criptografadas ao salvar)
4. Ativar "Autopublicação" se desejado + selecionar fontes que alimentarão o site

---

## 16. Comandos Operacionais

### Setup inicial (do zero)

```bash
# 1. Clonar o repositório
git clone https://github.com/wilsonglopes/newsxmnews.git xixo
cd xixo

# 2. Instalar dependências
cd backend
npm install

# 3. Criar o .env (copiar .env.example e preencher)
cp .env.example .env
nano .env

# 4. Criar tabelas e dados iniciais
node db/setup.js

# 5. Rodar migrações (adiciona colunas novas)
node migrate.js

# 6. Iniciar o servidor
npm start
# ou com PM2:
pm2 start server.js --name xixo-news
pm2 save
pm2 startup
```

### Desenvolvimento local

```bash
cd backend
npm run dev          # node --watch server.js (reinicia automaticamente)
```

### Migrações após atualizações

Sempre que o schema mudar, rodar:
```bash
node backend/migrate.js
```

### Verificar saúde do sistema

```bash
# VPS — status PM2
pm2 status xixo-news

# Logs ao vivo
pm2 logs xixo-news --lines 100

# Testar API
curl https://news.xmnews.com.br/api/sources
curl https://news.xmnews.com.br/api/settings

# Banco — contar artigos
psql postgresql://rb24user:rb24pass2026@localhost:5432/rb24horas -c "SELECT count(*) FROM articles;"

# Banco — ver últimas publicações automáticas
psql ... -c "SELECT status, error_msg, processed_at FROM autopub_log ORDER BY processed_at DESC LIMIT 20;"
```

### Adicionar nova fonte RSS

Editar `backend/sources.json`:

```json
{
  "name": "Nome do Portal",
  "slug": "slug-unico",
  "type": "rss",
  "url": "https://portal.com.br/feed",
  "active": true,
  "category": "regional"
}
```

Depois: `pm2 restart xixo-news --update-env` (ou o cron atualiza em 15 minutos).

---

## 17. Ponto de Restauração Estável

| Item | Valor |
|------|-------|
| Tag git | `estavel-v1.6.0-validado` |
| Commit | `2df3796` |

**Para restaurar ao ponto estável:**

```bash
git reset --hard estavel-v1.6.0-validado
git push --force origin main
# Na VPS:
ssh ubuntu@146.235.53.61 "cd ~/xixo && git pull origin main --force && pm2 restart xixo-news"
```

---

## 18. Fluxo Completo de Publicação

### Publicação Manual (assinante)

```
Assinante abre index.html
  → Vê artigos das suas fontes (filtrado por subscriber_sources)
  → Clica em artigo
  → Abre modal com conteúdo completo (scraped)
  → Clica "Gerar com IA"
    → Backend chama Gemini/DeepSeek via /api/ia/rewrite
    → Retorna chapéu, título, resumo, corpo, tags
  → Edita se quiser
  → Seleciona sites de destino (cards)
  → Para cada site selecionado:
    → Chama /api/ia/categorize (categoriza automaticamente)
    → Chama /api/publish (publica via WordPress/Blogger/Webhook)
    → Registra em publications
```

### Publicação Automática (autopub)

```
Cron: a cada minuto → verificarERotar()
  → Lê settings.json
  → Se autopub_enabled=false → retorna
  → Se ainda não passou o intervalo → retorna
  → Chama rodarAutopub()
    → Para cada site com auto_publish=true:
      → Busca autopub_rules (fontes deste site)
      → Busca artigos não processados (não estão em autopub_log)
      → Para cada artigo (até max_por_rodada):
        → reescreverArtigo() via IA
        → buscarCategorias() do WordPress (REST API pública, sem auth)
        → categorizarComIA()
        → publishToWordPress() / publishToBlogger() / publishViaWebhook()
        → INSERT publications
        → INSERT autopub_log (status ok ou erro)
        → await 2000ms (rate limit)
```

---

## Dependências principais (package.json)

| Pacote | Uso |
|--------|-----|
| `express` | Framework HTTP |
| `axios` | HTTP client (IA, scraping, publicação) |
| `rss-parser` | Parse de feeds RSS/Atom |
| `cheerio` | Scraping HTML (servidor) |
| `node-cron` | Agendamento de tarefas |
| `pg` | Cliente PostgreSQL |
| `bcrypt` | Hash de senhas |
| `jsonwebtoken` | JWT (autenticação) |
| `dotenv` | Variáveis de ambiente |
| `cors` | CORS headers |
| `googleapis` | OAuth Google (Blogger) |
| `puppeteer` | Scraping de sites dinâmicos (JS) |
| `iconv-lite` | Encoding de texto (feeds com charset especial) |
| `form-data` | Upload de arquivos (imagens WP) |

---

*Documentação gerada em 2026-05-10. Manter atualizada a cada mudança significativa de infraestrutura ou arquitetura.*
