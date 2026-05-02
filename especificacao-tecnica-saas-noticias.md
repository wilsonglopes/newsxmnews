# Especificação Técnica — Plataforma SaaS de Distribuição de Notícias

## Visão Geral do Produto

Plataforma SaaS onde o operador capta notícias de múltiplas fontes, normaliza tudo num formato editorial único, e vende acesso a assinantes (portais, blogs) que escolhem, reescrevem com IA no próprio estilo e publicam diretamente nos seus sites.

---

## O Que Já Existe (não recriar)

- `index.html` — painel editorial funcional com:
  - Tela de configurações (WordPress + Anthropic API Key)
  - Lista de rascunhos do WordPress
  - Reescrita com IA (chapéu, título, resumo, corpo, tags, categoria)
  - Publicação via API REST do WordPress
  - Upload de imagem, modal de confirmação, toasts

- `backend/server.js` — motor de coleta funcionando com:
  - Leitura de RSS via `rss-parser`
  - Scraping básico via `cheerio`
  - Cache em memória com TTL de 15 minutos
  - `sources.json` com fontes configuradas

---

## O Que Precisa Ser Construído

### Visão geral dos novos módulos:

```
/plataforma
  /backend
    server.js          ← já existe, expandir
    sources.json       ← já existe, refinar
    /db
      schema.sql       ← novo: esquema do banco PostgreSQL
      seed.js          ← novo: dados iniciais
    /routes
      auth.js          ← novo: login, cadastro, sessão
      articles.js      ← novo: listagem filtrada por plano
      publish.js       ← novo: conector WordPress + Blogger
      admin.js         ← novo: gestão de assinantes e fontes
    /connectors
      wordpress.js     ← novo: publicação via API REST WP
      blogger.js       ← novo: publicação via Google API
      webhook.js       ← novo: publicação via webhook genérico
    /scrapers
      rss.js           ← já existe, mover para cá
      scraping.js      ← já existe, mover + refinar por fonte
      normalizer.js    ← novo: normaliza qualquer formato no padrão editorial
  /frontend
    index.html         ← já existe (painel do operador, manter)
    /subscriber
      index.html       ← novo: painel do assinante
      login.html       ← novo: tela de login
    /admin
      index.html       ← novo: painel do operador/admin
```

---

## 1. Banco de Dados (PostgreSQL)

### Tabelas necessárias

```sql
-- Planos de assinatura
CREATE TABLE plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,           -- "Básico", "Profissional", "Premium"
  max_sources INT NOT NULL,             -- 5, 15, 0 (0 = ilimitado)
  max_publications_per_month INT,       -- 30, 100, null (null = ilimitado)
  max_sites INT NOT NULL DEFAULT 1,     -- quantos sites pode conectar
  price_cents INT NOT NULL,             -- preço em centavos
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Assinantes
CREATE TABLE subscribers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  email VARCHAR(200) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  plan_id UUID REFERENCES plans(id),
  plan_expires_at TIMESTAMPTZ,
  active BOOLEAN DEFAULT true,
  ai_prompt TEXT,                       -- prompt personalizado do estilo do site deles
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Fontes de notícias disponíveis
CREATE TABLE sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,           -- "Metrópoles", "Pref. Sombrio"
  slug VARCHAR(100) UNIQUE NOT NULL,
  type VARCHAR(20) NOT NULL,            -- "rss" | "scraping"
  url TEXT NOT NULL,                    -- URL da seção de notícias
  section_selector TEXT,                -- seletor CSS da seção de notícias (para scraping)
  title_selector TEXT,                  -- seletor CSS do título
  date_selector TEXT,                   -- seletor CSS da data
  link_selector TEXT,                   -- seletor CSS do link
  image_selector TEXT,                  -- seletor CSS da imagem
  content_selector TEXT,                -- seletor CSS do corpo do artigo
  category VARCHAR(50),                 -- "nacional", "regional", "esporte", "governo", "prefeitura"
  active BOOLEAN DEFAULT true,
  last_fetched_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Relação: quais fontes cada assinante tem acesso
CREATE TABLE subscriber_sources (
  subscriber_id UUID REFERENCES subscribers(id) ON DELETE CASCADE,
  source_id UUID REFERENCES sources(id) ON DELETE CASCADE,
  PRIMARY KEY (subscriber_id, source_id)
);

-- Artigos coletados e normalizados
CREATE TABLE articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID REFERENCES sources(id),
  external_url TEXT UNIQUE NOT NULL,    -- URL original do artigo
  chapeu VARCHAR(100),                  -- ex: "POLÍTICA", "ECONOMIA"
  title TEXT NOT NULL,
  summary TEXT,
  body TEXT,                            -- HTML do corpo completo
  image_url TEXT,
  tags TEXT[],
  author VARCHAR(200),
  published_at TIMESTAMPTZ,
  fetched_at TIMESTAMPTZ DEFAULT now(),
  raw_html TEXT                         -- HTML bruto original (para reprocessar se necessário)
);

-- Sites dos assinantes (onde vão publicar)
CREATE TABLE subscriber_sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id UUID REFERENCES subscribers(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,           -- nome do site (ex: "Meu Blog")
  platform VARCHAR(50) NOT NULL,        -- "wordpress" | "blogger" | "webhook"
  site_url TEXT NOT NULL,               -- URL base do site
  -- WordPress
  wp_username VARCHAR(200),
  wp_app_password TEXT,                 -- Application Password criptografado
  -- Blogger
  blogger_blog_id VARCHAR(200),
  blogger_access_token TEXT,            -- OAuth token criptografado
  blogger_refresh_token TEXT,
  -- Webhook genérico
  webhook_url TEXT,
  webhook_secret TEXT,
  -- Config comum
  ai_prompt TEXT,                       -- prompt do estilo deste site específico
  default_category_id VARCHAR(100),
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Publicações realizadas (histórico)
CREATE TABLE publications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id UUID REFERENCES subscribers(id),
  article_id UUID REFERENCES articles(id),
  site_id UUID REFERENCES subscriber_sites(id),
  platform VARCHAR(50) NOT NULL,
  external_post_id VARCHAR(200),        -- ID do post no WP/Blogger
  external_post_url TEXT,               -- URL do post publicado
  rewritten_title TEXT,
  rewritten_body TEXT,
  status VARCHAR(20) DEFAULT 'published', -- "published" | "failed"
  error_message TEXT,
  published_at TIMESTAMPTZ DEFAULT now()
);

-- Sessões de login
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id UUID REFERENCES subscribers(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

---

## 2. Normalização de Artigos

### Formato padrão de saída (independente da fonte)

Todo artigo coletado — seja RSS, scraping de prefeitura, ou portal nacional — deve ser normalizado para este formato antes de salvar no banco:

```json
{
  "external_url": "https://fonte.com.br/noticia/slug",
  "chapeu": "POLÍTICA",
  "title": "Título limpo sem HTML",
  "summary": "Primeiro parágrafo ou descrição do RSS, sem HTML, máx 300 chars",
  "body": "<p>Parágrafo 1...</p><p>Parágrafo 2...</p>",
  "image_url": "https://...",
  "tags": ["tag1", "tag2"],
  "author": "Nome do autor ou null",
  "published_at": "2026-04-13T10:00:00Z"
}
```

### Regras de normalização (`normalizer.js`)

```
1. Remover todo HTML do título e resumo (texto puro)
2. No corpo: manter apenas <p>, <h2>, <h3>, <strong>, <em>, <ul>, <li>, <blockquote>
3. Remover: scripts, iframes, divs de publicidade, botões de compartilhamento,
   banners, "Leia também:", "Veja mais:", seções de comentários
4. Remover links internos do portal de origem (ex: "Clique aqui para ler mais no Metrópoles")
5. Remover créditos de imagem embutidos no texto
6. Converter listas HTML malformadas em <ul><li> corretos
7. Normalizar aspas tipográficas para " e '
8. Remover espaços duplos, quebras de linha excessivas
9. Se o corpo vier vazio do RSS, tentar buscar o artigo completo via URL
10. Chapéu: derivar da categoria do RSS ou da seção do site (ex: /politica → "POLÍTICA")
```

### Configuração por fonte no `sources.json` / tabela `sources`

Para sites que precisam de scraping, definir os seletores CSS específicos:

```json
{
  "name": "Prefeitura de Sombrio",
  "slug": "pref-sombrio",
  "type": "scraping",
  "url": "https://sombrio.sc.gov.br/noticias",
  "section_selector": ".noticias-lista, .lista-noticias, article",
  "title_selector": "h2, h3, .titulo",
  "date_selector": ".data, time, .publicado-em",
  "link_selector": "a",
  "image_selector": "img",
  "content_selector": ".conteudo, .texto, .noticia-corpo, article p",
  "category": "prefeitura"
}
```

**IMPORTANTE:** Antes de finalizar os seletores de cada prefeitura, o Claude Code deve:
1. Fazer uma requisição HTTP para o site da prefeitura
2. Inspecionar o HTML retornado
3. Identificar os seletores reais corretos
4. Testar que os seletores capturam título, data e link corretamente

---

## 3. Backend — Novas Rotas

### `routes/auth.js`

```
POST /api/auth/login
  body: { email, password }
  response: { token, subscriber: { id, name, plan, sites } }

POST /api/auth/logout
  header: Authorization: Bearer {token}

GET /api/auth/me
  header: Authorization: Bearer {token}
  response: { subscriber completo com plano e sites }
```

### `routes/articles.js`

```
GET /api/articles
  header: Authorization: Bearer {token}
  query: ?source=slug&search=texto&period=today|24h|3d&page=1&limit=30
  — retorna só artigos das fontes do plano do assinante
  response: { articles: [...], total, page, pages }

GET /api/articles/:id
  — artigo completo com body HTML

GET /api/articles/:id/full-content
  — se body veio incompleto do RSS, busca o artigo completo na URL original
```

### `routes/publish.js`

```
POST /api/publish
  header: Authorization: Bearer {token}
  body: {
    article_id: "uuid",
    site_id: "uuid",
    rewritten: {
      chapeu: "...",
      title: "...",
      summary: "...",
      body: "...",
      tags: [...],
      category_id: "..."
    }
  }
  — detecta a plataforma do site e chama o conector correto
  response: { success, post_url, post_id }
```

### `routes/admin.js` (operador)

```
GET  /api/admin/subscribers       — listar assinantes
POST /api/admin/subscribers       — criar assinante
PUT  /api/admin/subscribers/:id   — editar (trocar plano, etc.)

GET  /api/admin/sources           — listar fontes
POST /api/admin/sources           — adicionar fonte
PUT  /api/admin/sources/:id       — editar fonte (seletores, URL, etc.)
DELETE /api/admin/sources/:id     — desativar fonte

GET  /api/admin/stats             — estatísticas gerais
```

---

## 4. Conectores de Publicação

### `connectors/wordpress.js`

```javascript
async function publishToWordPress(site, article) {
  // 1. Se article.tags existem, criar as tags no WP que ainda não existem
  //    GET /wp-json/wp/v2/tags?search={tag} → se não existe, POST para criar
  // 2. Se category_id fornecido, usar; senão tentar match por nome
  // 3. Se article.image_url existe, fazer upload para a mídia do WP
  //    POST /wp-json/wp/v2/media com a imagem (multipart)
  //    Usar o ID retornado como featured_media
  // 4. Criar o post:
  //    POST /wp-json/wp/v2/posts
  //    {
  //      title: rewritten.title,
  //      content: rewritten.body,
  //      excerpt: rewritten.summary,
  //      status: "publish",
  //      categories: [category_id],
  //      tags: [tag_ids],
  //      featured_media: media_id,
  //      meta: { chapeu: rewritten.chapeu, fonte_original: article.external_url }
  //    }
  // 5. Retornar { post_id, post_url }
}
```

### `connectors/blogger.js`

```javascript
async function publishToBlogger(site, article) {
  // Blogger usa Google API v3
  // Auth: OAuth2 com refresh_token armazenado no banco
  //
  // 1. Verificar se o access_token ainda é válido
  //    Se expirado, usar refresh_token para obter novo:
  //    POST https://oauth2.googleapis.com/token
  //    { client_id, client_secret, refresh_token, grant_type: "refresh_token" }
  //
  // 2. Montar o corpo do post incluindo imagem se houver:
  //    Se image_url existe, incorporar como <img> no início do body
  //    Blogger não tem API de upload de mídia — incorporar a imagem diretamente no HTML
  //
  // 3. Criar o post:
  //    POST https://www.googleapis.com/blogger/v3/blogs/{blogId}/posts/
  //    Authorization: Bearer {access_token}
  //    {
  //      title: rewritten.title,
  //      content: "<p><strong>" + rewritten.chapeu + "</strong></p>" + rewritten.body,
  //      labels: rewritten.tags
  //    }
  //
  // 4. Salvar novo access_token no banco se foi renovado
  // 5. Retornar { post_id, post_url }
}
```

### `connectors/webhook.js`

```javascript
async function publishViaWebhook(site, article) {
  // Para clientes com sites em plataformas não suportadas nativamente
  // O site do cliente precisa ter um endpoint que receba o JSON
  //
  // POST {site.webhook_url}
  // Headers:
  //   Content-Type: application/json
  //   X-Webhook-Secret: {site.webhook_secret}  ← para autenticar
  //   X-Signature: HMAC-SHA256 do body         ← para verificar integridade
  //
  // Body:
  // {
  //   chapeu: "...",
  //   title: "...",
  //   summary: "...",
  //   body: "...",  ← HTML
  //   tags: [...],
  //   image_url: "...",
  //   source_name: "Metrópoles",
  //   source_url: "https://...",
  //   published_at: "ISO8601"
  // }
}
```

---

## 5. Painel do Assinante (`/subscriber/index.html`)

### Tela de login (`login.html`)
- Campo email + senha
- Botão entrar
- Salvar token no `localStorage`
- Redirecionar para `index.html` após login

### Painel principal (`index.html`)

**Header:**
- Nome do site/assinante
- Nome do plano (badge)
- Botão "Configurações" → vai para tela de configuração dos sites
- Botão "Sair"

**Barra de filtros:**
- Dropdown: todas as fontes do plano / por fonte específica
- Busca por texto
- Filtro: Hoje / 24h / 3 dias

**Tabela de artigos:**

| Fonte | Chapéu | Título | Publicado | Ação |
|-------|--------|--------|-----------|------|
| CNN Brasil | POLÍTICA | Título truncado... | Há 2h | [Publicar] |

- Clicar na linha abre modal de leitura
- Modal mostra: chapéu, título, imagem, resumo, body completo, link original
- Botão "Gerar com IA e Publicar" no modal

**Fluxo de publicação no modal:**
1. Assinante clica "Gerar com IA e Publicar"
2. Sistema chama Anthropic API com o prompt personalizado do assinante
3. Mostra campos editáveis: chapéu, título, resumo, corpo, tags
4. Dropdown: "Publicar em qual site?" (lista os sites conectados)
5. Botão "Publicar agora" → chama `POST /api/publish`
6. Mostra link do post publicado

### Tela de configurações do assinante

**Seção: Meus sites**
Para cada site cadastrado, mostrar:
- Nome do site
- Plataforma (WordPress / Blogger / Webhook)
- Status (conectado / erro)
- Botão "Editar" / "Remover"

Botão "Adicionar site" → abre formulário:
```
Nome do site: [____________]
Plataforma:  [WordPress ▾]  ← dropdown: WordPress | Blogger | Webhook

Se WordPress:
  URL do site:           [https://meusite.com.br]
  Usuário WordPress:     [admin              ]
  Application Password:  [xxxx xxxx xxxx xxxx]

Se Blogger:
  Blog ID:               [1234567890         ]
  [Conectar com Google ▾] ← botão OAuth

Se Webhook:
  URL do webhook:        [https://meusite.com/api/receive]
  Chave secreta:         [minha-chave-secreta]

Prompt de estilo (opcional):
  [Escreva para um público conservador do interior de SC,
   linguagem simples e direta, sem jargões...]

[Salvar site]
```

**Seção: Meu plano**
- Plano atual, validade, publicações usadas no mês
- Fontes disponíveis no plano (lista)

---

## 6. Painel do Admin/Operador (`/admin/index.html`)

Acesso restrito ao operador da plataforma.

**Dashboard:**
- Total de assinantes ativos
- Total de artigos coletados hoje
- Fontes com erro (lista vermelha)
- Publicações realizadas hoje

**Gestão de fontes:**
- Tabela com todas as fontes
- Status (verde/vermelho/amarelo)
- Última coleta, quantidade de artigos hoje
- Botão "Editar" → abre formulário com todos os campos incluindo seletores CSS
- Botão "Testar agora" → força coleta e mostra resultado

**Gestão de assinantes:**
- Lista de assinantes com plano e status
- Botão "Editar" → trocar plano, resetar senha, ativar/desativar

---

## 7. Autenticação e Segurança

- Senhas: hash com `bcrypt` (salt rounds: 12)
- Sessões: JWT com expiração de 7 dias ou token UUID no banco
- Tokens de API (WordPress app password, Blogger OAuth): criptografar com `crypto` (AES-256) antes de salvar no banco
- Variável de ambiente `ENCRYPTION_KEY` para a chave de criptografia
- Rate limiting nas rotas de login (máx 5 tentativas por IP em 15 minutos)
- CORS configurado para aceitar só a origem do painel

---

## 8. Variáveis de Ambiente (`.env`)

```
# Banco de dados
DATABASE_URL=postgresql://user:password@localhost:5432/noticias

# Servidor
PORT=3000
NODE_ENV=production

# Segurança
JWT_SECRET=gerar-string-aleatoria-longa
ENCRYPTION_KEY=gerar-string-32-chars-para-aes256
SESSION_EXPIRES_HOURS=168

# Google OAuth (para Blogger)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://seudominio.com/api/auth/blogger/callback

# Admin
ADMIN_EMAIL=seu@email.com
ADMIN_PASSWORD_HASH=hash-bcrypt-da-senha

# Coleta
FETCH_INTERVAL_MINUTES=15
MAX_ARTICLES_PER_SOURCE=20
```

---

## 9. Infraestrutura Recomendada

**Para começar (baixo custo):**
- VPS: Hetzner CX22 (~R$50/mês) ou DigitalOcean Droplet Basic (~R$60/mês)
- PostgreSQL: mesmo servidor ou Supabase free tier
- Node.js rodando com PM2 (restart automático)
- Nginx como proxy reverso na porta 80/443
- SSL grátis via Certbot (Let's Encrypt)

**Deploy:**
```
/var/www/noticias/
  backend/     ← Node.js (PM2: pm2 start server.js)
  frontend/    ← arquivos estáticos servidos pelo Nginx
```

---

## 10. Ordem de Implementação

### Fase 1 — Base (prioridade máxima)
1. Criar schema do PostgreSQL e conectar no backend existente
2. Migrar artigos do cache em memória para o banco
3. Criar sistema de login (auth.js) com JWT
4. Criar painel do assinante básico (login + lista de artigos)

### Fase 2 — Publicação
5. Implementar conector WordPress (já tem lógica no index.html existente, mover para backend)
6. Implementar conector Blogger com OAuth
7. Implementar rota `POST /api/publish` unificada
8. Adicionar tela de cadastro de sites no painel do assinante

### Fase 3 — Qualidade da coleta
9. Implementar `normalizer.js` com todas as regras de limpeza
10. Refinar seletores CSS por fonte (prefeituras principalmente)
11. Implementar busca de conteúdo completo quando RSS traz só resumo
12. Implementar detecção de artigos duplicados (por URL)

### Fase 4 — Admin e polimento
13. Painel admin com dashboard e gestão de fontes/assinantes
14. Sistema de planos e controle de limites (publicações por mês, fontes por plano)
15. Logs de erro por fonte
16. Notificação por email quando fonte falha por mais de 1 hora

---

## 11. O Que NÃO Fazer Nesta Versão

- Pagamento online automático (cobrar manualmente por PIX/boleto no início)
- App mobile
- Editor de texto rico (WYSIWYG) — textarea simples resolve
- Múltiplos idiomas
- Comentários ou interação social

---

## Observações Finais para o Claude Code

1. **Manter o `index.html` original intacto** — é o painel do operador e continua funcionando
2. **Para o Blogger OAuth**: implementar o fluxo completo de autorização (redirect → callback → salvar tokens)
3. **Para as prefeituras**: acessar cada site antes de definir os seletores — não assumir estrutura
4. **Artigos duplicados**: antes de salvar, verificar se `external_url` já existe no banco
5. **Imagens do Blogger**: como não há upload de mídia, incorporar `<img src="url_original">` no corpo — funciona mas depende da disponibilidade da imagem na fonte
6. **Criptografia dos tokens**: nunca salvar WordPress app passwords ou tokens OAuth em texto puro
7. **O normalizer deve ser tolerante a falhas**: se não conseguir extrair algum campo, salvar null — nunca deixar de salvar o artigo por causa de um campo faltando
