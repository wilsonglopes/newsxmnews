-- ============================================================
--  Schema — RB24Horas / Painel Editorial
--  Execute: psql -d noticias -f db/schema.sql
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Planos ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plans (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      VARCHAR(100) NOT NULL UNIQUE,
  max_sources               INT NOT NULL,
  max_publications_per_month INT,
  max_sites                 INT NOT NULL DEFAULT 1,
  price_cents               INT NOT NULL,
  active                    BOOLEAN DEFAULT true,
  created_at                TIMESTAMPTZ DEFAULT now()
);

-- ── Assinantes ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscribers (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             VARCHAR(200) NOT NULL,
  email            VARCHAR(200) UNIQUE NOT NULL,
  password_hash    VARCHAR(255) NOT NULL,
  plan_id          UUID REFERENCES plans(id),
  plan_expires_at  TIMESTAMPTZ,
  active           BOOLEAN DEFAULT true,
  is_admin         BOOLEAN DEFAULT false,
  ai_prompt        TEXT,
  created_at       TIMESTAMPTZ DEFAULT now()
);

-- Migração: garante coluna is_admin em instalações anteriores
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='subscribers' AND column_name='is_admin'
  ) THEN
    ALTER TABLE subscribers ADD COLUMN is_admin BOOLEAN DEFAULT false;
  END IF;
END $$;

-- ── Fontes de notícias ────────────────────────────────────
CREATE TABLE IF NOT EXISTS sources (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              VARCHAR(200) NOT NULL,
  slug              VARCHAR(100) UNIQUE NOT NULL,
  type              VARCHAR(20) NOT NULL,
  url               TEXT NOT NULL,
  section_selector  TEXT,
  title_selector    TEXT,
  date_selector     TEXT,
  link_selector     TEXT,
  image_selector    TEXT,
  content_selector  TEXT,
  category          VARCHAR(50),
  active            BOOLEAN DEFAULT true,
  last_fetched_at   TIMESTAMPTZ,
  last_error        TEXT,
  created_at        TIMESTAMPTZ DEFAULT now()
);

-- ── Fontes por assinante ──────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriber_sources (
  subscriber_id UUID REFERENCES subscribers(id) ON DELETE CASCADE,
  source_id     UUID REFERENCES sources(id) ON DELETE CASCADE,
  PRIMARY KEY (subscriber_id, source_id)
);

-- ── Artigos coletados ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS articles (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id    UUID REFERENCES sources(id),
  external_url TEXT UNIQUE NOT NULL,
  chapeu       VARCHAR(100),
  title        TEXT NOT NULL,
  summary      TEXT,
  body         TEXT,
  image_url    TEXT,
  tags         TEXT[],
  author       VARCHAR(200),
  published_at TIMESTAMPTZ,
  fetched_at   TIMESTAMPTZ DEFAULT now(),
  raw_html     TEXT
);

-- ── Sites dos assinantes ──────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriber_sites (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id         UUID REFERENCES subscribers(id) ON DELETE CASCADE,
  name                  VARCHAR(200) NOT NULL,
  platform              VARCHAR(50) NOT NULL,
  site_url              TEXT NOT NULL,
  wp_username           VARCHAR(200),
  wp_app_password       TEXT,
  blogger_blog_id       VARCHAR(200),
  blogger_access_token  TEXT,
  blogger_refresh_token TEXT,
  webhook_url           TEXT,
  webhook_secret        TEXT,
  ai_prompt             TEXT,
  default_category_id   VARCHAR(100),
  active                BOOLEAN DEFAULT true,
  created_at            TIMESTAMPTZ DEFAULT now()
);

-- ── Publicações ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS publications (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id    UUID REFERENCES subscribers(id),
  article_id       UUID REFERENCES articles(id),
  site_id          UUID REFERENCES subscriber_sites(id),
  platform         VARCHAR(50) NOT NULL,
  external_post_id VARCHAR(200),
  external_post_url TEXT,
  rewritten_title  TEXT,
  rewritten_body   TEXT,
  status           VARCHAR(20) DEFAULT 'published',
  error_message    TEXT,
  published_at     TIMESTAMPTZ DEFAULT now()
);

-- Migração: plan_value (valor personalizado por cliente)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='subscribers' AND column_name='plan_value')
  THEN ALTER TABLE subscribers ADD COLUMN plan_value DECIMAL(10,2) DEFAULT 0;
  END IF;
END $$;

-- Migração: gemini_key (chave IA gerenciada pelo admin)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='subscribers' AND column_name='gemini_key')
  THEN ALTER TABLE subscribers ADD COLUMN gemini_key TEXT;
  END IF;
END $$;

-- ── Sessões JWT ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id UUID REFERENCES subscribers(id) ON DELETE CASCADE,
  token         VARCHAR(255) UNIQUE NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
);
