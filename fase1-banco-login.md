# FASE 1 — Banco de dados + Login

O projeto já tem `backend/server.js` funcionando com coleta de RSS e scraping, e `index.html` como painel do operador. Não mexa nesses arquivos.

Preciso que você implemente a Fase 1: banco de dados PostgreSQL + sistema de login.

## O que fazer

### 1. Instalar dependências novas
```
npm install pg bcrypt jsonwebtoken dotenv
```

### 2. Criar o arquivo `.env` na raiz do backend
```
DATABASE_URL=postgresql://user:password@localhost:5432/noticias
PORT=3000
NODE_ENV=development
JWT_SECRET=gerar-uma-string-aleatoria-longa-aqui
ENCRYPTION_KEY=gerar-string-exatamente-32-caracteres
SESSION_EXPIRES_HOURS=168
ADMIN_EMAIL=admin@seusite.com.br
FETCH_INTERVAL_MINUTES=15
MAX_ARTICLES_PER_SOURCE=20
```

### 3. Criar `db/schema.sql` com todas essas tabelas

```sql
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  max_sources INT NOT NULL,
  max_publications_per_month INT,
  max_sites INT NOT NULL DEFAULT 1,
  price_cents INT NOT NULL,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscribers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  email VARCHAR(200) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  plan_id UUID REFERENCES plans(id),
  plan_expires_at TIMESTAMPTZ,
  active BOOLEAN DEFAULT true,
  ai_prompt TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  type VARCHAR(20) NOT NULL,
  url TEXT NOT NULL,
  section_selector TEXT,
  title_selector TEXT,
  date_selector TEXT,
  link_selector TEXT,
  image_selector TEXT,
  content_selector TEXT,
  category VARCHAR(50),
  active BOOLEAN DEFAULT true,
  last_fetched_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriber_sources (
  subscriber_id UUID REFERENCES subscribers(id) ON DELETE CASCADE,
  source_id UUID REFERENCES sources(id) ON DELETE CASCADE,
  PRIMARY KEY (subscriber_id, source_id)
);

CREATE TABLE IF NOT EXISTS articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID REFERENCES sources(id),
  external_url TEXT UNIQUE NOT NULL,
  chapeu VARCHAR(100),
  title TEXT NOT NULL,
  summary TEXT,
  body TEXT,
  image_url TEXT,
  tags TEXT[],
  author VARCHAR(200),
  published_at TIMESTAMPTZ,
  fetched_at TIMESTAMPTZ DEFAULT now(),
  raw_html TEXT
);

CREATE TABLE IF NOT EXISTS subscriber_sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id UUID REFERENCES subscribers(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  platform VARCHAR(50) NOT NULL,
  site_url TEXT NOT NULL,
  wp_username VARCHAR(200),
  wp_app_password TEXT,
  blogger_blog_id VARCHAR(200),
  blogger_access_token TEXT,
  blogger_refresh_token TEXT,
  webhook_url TEXT,
  webhook_secret TEXT,
  ai_prompt TEXT,
  default_category_id VARCHAR(100),
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS publications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id UUID REFERENCES subscribers(id),
  article_id UUID REFERENCES articles(id),
  site_id UUID REFERENCES subscriber_sites(id),
  platform VARCHAR(50) NOT NULL,
  external_post_id VARCHAR(200),
  external_post_url TEXT,
  rewritten_title TEXT,
  rewritten_body TEXT,
  status VARCHAR(20) DEFAULT 'published',
  error_message TEXT,
  published_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id UUID REFERENCES subscribers(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### 4. Criar `db/seed.js` com dados iniciais

Inserir os 3 planos padrão:
- Básico: 5 fontes, 30 publicações/mês, 1 site, R$97 (9700 centavos)
- Profissional: 15 fontes, 100 publicações/mês, 2 sites, R$197 (19700 centavos)
- Premium: 0 fontes (ilimitado), null publicações (ilimitado), 5 sites, R$397 (39700 centavos)

Inserir todas as fontes do `sources.json` existente na tabela `sources`.

### 5. Criar `db/connection.js`

Módulo que exporta o pool de conexão do PostgreSQL usando a variável `DATABASE_URL` do `.env`.

### 6. Migrar artigos do cache em memória para o banco

No `server.js` existente, onde os artigos são salvos em memória (objeto/array de cache), substituir para salvar no banco PostgreSQL tabela `articles`. Antes de inserir, verificar se `external_url` já existe — se existir, ignorar (não duplicar).

### 7. Criar `routes/auth.js`

```
POST /api/auth/login
  - Recebe { email, password }
  - Busca subscriber pelo email
  - Compara senha com bcrypt
  - Gera JWT com { id, email, plan_id } e expira em 7 dias
  - Retorna { token, subscriber: { id, name, email, plan, sites } }

POST /api/auth/logout
  - Header: Authorization: Bearer {token}
  - Invalida o token (pode ser só retornar 200, JWT é stateless)

GET /api/auth/me
  - Header: Authorization: Bearer {token}
  - Retorna dados completos do assinante logado incluindo plano e sites
```

### 8. Criar middleware `middleware/auth.js`

Middleware que valida o JWT em rotas protegidas. Se inválido, retorna 401. Se válido, coloca `req.subscriber` com os dados do assinante.

### 9. Registrar as rotas no `server.js`

Adicionar `require('./routes/auth')` no server existente sem quebrar nada que já funciona.

### 10. Testar tudo

Após implementar, rodar o seed e testar:
- Conectar no banco
- Criar um assinante de teste via SQL direto
- Testar POST /api/auth/login com esse assinante
- Confirmar que artigos coletados pelo motor RSS estão salvando no banco

## O que NÃO mexer
- `index.html` (painel do operador) — não tocar
- Lógica de coleta RSS/scraping que já funciona — só adicionar o save no banco
- `sources.json` — pode ler dele para o seed, mas não remover o arquivo
