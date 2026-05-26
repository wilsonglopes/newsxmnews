# 🗺️ Mapa Completo do Sistema XIXO News

> **Leia este arquivo ANTES de qualquer alteração no sistema.**  
> Última atualização: 2026-05-26 | Commit: `3465fbd`

---

## 1. ARQUIVOS CRÍTICOS

| Arquivo | Responsabilidade |
|---|---|
| `backend/server.js` | API REST principal, roteamento, middleware JWT, scraping on-demand |
| `backend/autopub.js` | Worker de autopublicação — producer (coleta) + consumer (publica) |
| `backend/ia.js` | Reescrita via IA (DeepSeek) — prompt, chunking, sanitização |
| `backend/connectors/wordpress.js` | 4 funções de publicação WP (ver seção 2) |
| `backend/connectors/blogger.js` | Publicação no Blogger — OAuth2 + refresh token |
| `backend/connectors/webhooks.js` | Publicação via webhook genérico |
| `backend/scrapers/full-content.js` | Extração de conteúdo completo + imagem destacada |
| `backend/scrapers/rss.js` | Leitura de feeds RSS |
| `backend/scrapers/sitemap.js` | Leitura de Google News Sitemap |
| `backend/utils/card-generator.js` | Geração de card 1080×1080 SVG→PNG (Facebook/Instagram) |
| `backend/utils/image-proxy.js` | Proxy de imagem — verifica ALLOWED_HOSTS |
| `backend/utils/cf-proxy.js` | Cloudflare Worker proxy (sc.gov.br e domínios bloqueados na Oracle) |
| `backend/db/connection.js` | Pool PostgreSQL |
| `backend/db/schema.sql` | Schema do banco (**pode estar desatualizado** — checar information_schema) |
| `portal-publisher/portal-publisher.php` | **Plugin WP XMNews Publisher** — local canônico, nunca criar cópia |
| `frontend/subscriber/admin.html` | Painel admin do assinante |
| `backend/sources.json` | Lista de fontes ativas — deleções DEVEM ser commitadas localmente |
| `backend/settings.json` | Configurações globais do sistema |

---

## 2. CAMINHOS DE PUBLICAÇÃO — São 4, independentes

> ⚠️ **REGRA VITAL:** Qualquer mudança de comportamento (imagem, corpo, tags, etc.)
> deve ser aplicada nos **4 caminhos**. Eles NÃO compartilham código entre si.

### Caminho 1 — `publishViaPlugin()` — `wordpress.js`
- **Quando:** site tem `xixo_api_key` configurada (modo preferencial)
- **Como:** POST `/wp-json/xmn/v1/publish` com payload JSON + chave no header
- **Imagem:** plugin faz `download_url()` + `set_post_thumbnail()` internamente
- **`wp_app_password` NÃO é usado aqui** — foi revogado; plugin gerencia imagens
- **`post_format`:** `editorial` = imagem no corpo + featured_media; `standard` = só featured_media

### Caminho 2 — `publishToWordPress()` — `wordpress.js`
- **Quando:** site sem `xixo_api_key` (legado/fallback)
- **Como:** WP REST API nativa via `wp_app_password`
- **Imagem:** backend baixa e sobe via `uploadImageToWP()` (multipart/form-data)

### Caminho 3 — `publishToBlogger()` — `blogger.js`
- **Quando:** site tem `blogger_blog_id`
- **Como:** Google Blogger API v3 com OAuth2; auto-refresh de token se 401
- **Imagem:** injetada no HTML do conteúdo com `<img src="...">`

### Caminho 4 — `publishViaWebhook()` — `webhooks.js`
- **Quando:** site tem `webhook_url`
- **Como:** POST genérico com payload definido pelo cliente

---

## 3. REGRAS OBRIGATÓRIAS PARA TODOS OS CAMINHOS

### 3.1 — Limpeza do corpo (`bodyLimpo`) — OBRIGATÓRIO
```javascript
const bodyLimpo = (rewritten.body || '')
  .replace(/<figure\b[^>]*>[\s\S]*?<\/figure>/gi, '')
  .replace(/<img\b[^>]*\/?>/gi, '');
```
**Por quê:** Imagens embutidas no HTML raspado (ex: "Leia Mais" da CNN Brasil) ficam visíveis
como thumbnails de outros artigos dentro do post publicado.

Status por caminho:
- `publishViaPlugin` ✅ (implementado em 3465fbd)
- `publishToWordPress` ✅
- `publishToBlogger` ✅ (implementado em 411de8e)
- `publishViaWebhook` — verificar ao alterar corpo

### 3.2 — Dois caminhos de reescrita de IA — `autopub.js` E `ia.js`
São **independentes**. Qualquer mudança de prompt vai nos DOIS arquivos.
- `autopub.js` → artigos em lote (autopublicação automática)
- `ia.js` → "Criar Post" manual

### 3.3 — `sentenceCasePtBR()` — apenas para títulos crus de RSS
- **Não aplicar** em títulos já escritos pela IA
- **Não aplicar** no Telegram (IA já processou o título como instrução)

---

## 4. FLUXO DE IMAGEM — Por contexto

### Autopub (coleta automática)
```
fonte → full-content.js → extrairImagemDestacada()
  → deveIgnorarImagem() filtra: s.w.org (emoji CDN) e gravatar.com
  → article.image_url = URL da imagem
  → Caminho 1: passa image_url → plugin faz download_url()
  → Caminho 2: backend baixa e sobe via uploadImageToWP()
  → Caminho 3: injetada no HTML
```

### Criar Post — pré-upload OK (fast path)
```
frontend → POST /api/upload-image → WP REST API → retorna media_id
  → article.image_media_id = id na biblioteca WP
  → Caminho 1: envia image_media_id → plugin usa diretamente (sem download)
```

### Criar Post — pré-upload falhou (fallback base64)
```
frontend → envia image_base64 + image_mime + image_name
  → Caminho 1: cria temp file em PUBLIC_UPLOADS_DIR (backend/public/uploads/)
  → imageUrlParaPlugin = BACKEND_URL + /api/uploads/ + tmpName
  → plugin baixa da URL temporária → backend deleta após 15 min
```

### ⚠️ nginx — regra crítica
- `/uploads/` → **NÃO funciona** (regex de extensões tem prioridade — 404)
- `/api/uploads/` → **funciona** (tem `location ^~ /api/uploads/`)
- **Sempre usar `/api/uploads/` para temp files**

### `image-proxy.js` — ALLOWED_HOSTS
- Ao cadastrar nova fonte: adicionar domínio das imagens em `ALLOWED_HOSTS`
- Sem isso: 403 ao servir imagens da fonte

---

## 5. BANCO DE DADOS

### Tabelas principais
| Tabela | O que guarda |
|---|---|
| `subscribers` | Clientes (assinantes) |
| `subscriber_sites` | Sites de cada assinante (WP, Blogger, webhook) |
| `sites_catalog` | Catálogo de portais (fontes configuradas para autopub) |
| `articles` | Artigos coletados |
| `autopub_queue` | Fila producer/consumer (PostgreSQL LISTEN/NOTIFY) |
| `autopub_rules` | Regras de autopub por site (categoria fixa por fonte) |
| `ai_prompts` | Prompts de IA por portal/assinante |

### Hierarquia COALESCE (catálogo > assinante > padrão)
```sql
COALESCE(sc.campo, ss.campo, 'valor_padrão')
```
`post_format`, `ai_prompt`, flags Facebook/Instagram seguem essa hierarquia.

### Migrations defensivas
- Nunca num único try/catch — usar `tryMigrate()` individual
- `schema.sql` pode estar desatualizado — consultar `information_schema` antes de DELETE com FK
- Timezone SQL: usar `DATE(campo AT TIME ZONE 'America/Sao_Paulo')` — nunca `CURRENT_DATE` ou `now()-24h`

---

## 6. PLUGIN XMNEWS PUBLISHER

- **Local canônico:** `portal-publisher/portal-publisher.php`
- **Nunca criar cópia na raiz** — editar sempre no local canônico
- **`wp_app_password` foi revogado** — plugin gerencia imagens internamente
- **Versão atual:** v2.1.0+

### Payload enviado pelo backend
```json
{
  "title": "...",
  "chapeu": "...",
  "summary": "...",
  "body": "<body sem <img> nem <figure>>",
  "slug": "...",
  "source_url": "...",
  "source_name": "...",
  "image_url": "URL para plugin baixar OU URL temp para fallback",
  "image_media_id": 0,
  "post_format": "editorial | standard",
  "tags": [],
  "category_ids": []
}
```

> ⚠️ `category_ids` é **array**, nunca `category_id` singular — WP REST API ignora o singular.

---

## 7. INFRAESTRUTURA

| Item | Valor |
|---|---|
| Servidor | Oracle VPS — `ubuntu@146.235.53.61` |
| ❌ IP antigo | `150.230.97.99` — timeout, não usar |
| Chave SSH | `/c/Users/Wilson/.ssh/artesapro.key` |
| Deploy | SSH → `cd /home/ubuntu/xixo && bash deploy.sh` |
| PM2 app | `xixo-news` |
| Porta backend | **3002** (nunca 3000) |
| CF Worker | Para sc.gov.br e domínios bloqueados na Oracle Cloud |

### Fluxo de deploy obrigatório
1. `git push origin main` **PRIMEIRO** (sem push: servidor diz "Already up to date" silenciosamente)
2. SSH → `bash deploy.sh`
3. **Nunca fazer deploy sem o usuário autorizar explicitamente**

---

## 8. ✅ CHECKLIST PRÉ-ALTERAÇÃO

Responder antes de editar qualquer arquivo:

- [ ] **Qual(is) caminho(s) de publicação este código afeta?**
  → Se afeta corpo ou imagem: verificar os **4 caminhos**

- [ ] **A mudança afeta o fluxo de imagem?**
  → Verificar: autopub, Criar Post fast path, Criar Post fallback base64, nginx location `/api/uploads/`

- [ ] **A mudança afeta reescrita de IA?**
  → Verificar **`autopub.js` E `ia.js`** — são independentes

- [ ] **Estou adicionando nova fonte?**
  → Adicionar domínio das imagens em `image-proxy.js` ALLOWED_HOSTS

- [ ] **Estou mexendo no banco?**
  → Usar `tryMigrate()` individual; verificar FK antes de DELETE

- [ ] **Estou mexendo em chamadas HTTP externas?**
  → Evitar `User-Agent: Mozilla/5.0` (ModSecurity 406); checar ALLOWED_HOSTS; validar anti-SSRF

- [ ] **Estou mexendo no plugin PHP?**
  → Editar somente `portal-publisher/portal-publisher.php`; nunca criar cópia

- [ ] **A mudança exige atualização do plugin nos clientes?**
  → Avisar o usuário; clientes precisam reinstalar manualmente

---

## 9. ✅ CHECKLIST PRÉ-DEPLOY

- [ ] `git push origin main` feito?
- [ ] Mudanças em `sources.json` commitadas localmente?
- [ ] Migrations testadas?
- [ ] Variáveis de `.env` adicionadas ao servidor (se necessário)?
- [ ] Plugin atualizado nos clientes (se necessário)?
- [ ] **Usuário autorizou o deploy explicitamente?**

---

## 10. ⚠️ ERROS HISTÓRICOS — Para nunca repetir

| # | Erro | O que aconteceu | Lição |
|---|---|---|---|
| 1 | `wp_app_password` em publishViaPlugin | Bloco ficou ativo meses após ser revogado; 401 em todo autopub | Plugin gerencia imagens; não duplicar responsabilidade |
| 2 | Imagens de "Leia Mais" no corpo | `<img>` do HTML raspado passava sem limpeza para o plugin | `bodyLimpo` obrigatório nos 4 caminhos |
| 3 | Temp file em `/uploads/` | nginx regex interceptava antes do backend; 404 sempre | Usar `/api/uploads/` com `location ^~` |
| 4 | `image_media_id` não enviado ao plugin | Plugin ignorava pré-upload e tentava `download_url()` novamente | Sempre passar `image_media_id` no payload quando disponível |
| 5 | SSH no IP errado | `150.230.97.99` — timeout; correto é `146.235.53.61` | Verificar `~/.ssh/known_hosts` |
| 6 | Deploy sem push | `git pull` no servidor diz "Already up to date" silenciosamente | Push ANTES do deploy, sempre |
| 7 | `category_id` singular | WP REST API ignora; só `category_ids` (array) funciona | Verificar payload do plugin |
| 8 | `sentenceCasePtBR` no Telegram | Títulos já processados pela IA ficavam errados | Aplicar só em títulos crus de RSS |
| 9 | Emoji CDN como imagem destacada | `s.w.org/images/core/emoji/` selecionado como featured image | `deveIgnorarImagem()` filtra esses padrões |
| 10 | sources.json deletado na UI perdido no deploy | `git pull` sobrescreve o arquivo do servidor | Deleções permanentes devem ser commitadas localmente |
| 11 | Schema.sql desatualizado + DELETE FK | Cascade não declarada; migrations falhavam silenciosamente | Consultar `information_schema`; usar `tryMigrate()` |
| 12 | Porta 3000 usada em vez de 3002 | Serviço rodando em 3002; requisição nunca chegava | Sempre usar porta 3002 |
| 13 | `fetch()` sem verificar `r.ok` | 4xx/5xx não lançam exceção; UI mostrava sucesso falso | Sempre checar `if (!r.ok) throw new Error(...)` |
| 14 | `User-Agent: Mozilla/5.0` em Node.js | ModSecurity do servidor retornava 406 | Usar headers `{}` em chamadas server-to-server WP |
