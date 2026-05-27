# 🗺️ Mapa Completo do Sistema XIXO News

> **Leia este arquivo ANTES de qualquer alteração no sistema.**  
> Última atualização: 2026-05-26 | Commit: `ab3a463`

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
| `backend/routes/publish.js` | Rotas POST /api/publish e /api/publish/manual (publicação manual + FB/IG) |
| `backend/scrapers/full-content.js` | Extração de conteúdo completo + imagem destacada |
| `backend/utils/card-generator.js` | Geração de card 1080×1080 SVG→PNG (Facebook/Instagram) |
| `backend/utils/image-proxy.js` | Proxy de imagem — verifica ALLOWED_HOSTS |
| `backend/utils/cf-proxy.js` | Cloudflare Worker proxy (sc.gov.br e bloqueados na Oracle) |
| `backend/telegram.js` | Bot Telegram — reporters; também publica no FB/IG |
| `portal-publisher/portal-publisher.php` | **Plugin WP XMNews Publisher** — local canônico, nunca criar cópia |
| `frontend/subscriber/admin.html` | Painel admin do assinante |
| `backend/sources.json` | Lista de fontes ativas — deleções DEVEM ser commitadas localmente |
| `backend/settings.json` | **NÃO está no git** — runtime do servidor; deploy nunca sobrescreve |
| `backend/settings.json.example` | Referência com valores padrão — este sim está no git |

---

## 2. CAMINHOS DE PUBLICAÇÃO — São 4, independentes

> ⚠️ **REGRA VITAL:** Qualquer mudança de comportamento (imagem, corpo, tags, FB/IG)
> deve ser aplicada nos **4 caminhos**. Eles NÃO compartilham código entre si.

### Caminho 1 — `publishViaPlugin()` — `wordpress.js`
- **Quando:** site tem `xixo_api_key` (modo preferencial)
- **Como:** POST `/wp-json/xmn/v1/publish` + chave no header
- **Timeout:** **120s** — plugin precisa de tempo para download_url() + sideload de imagens grandes
- **`wp_app_password` NÃO é usado aqui** — foi revogado; plugin gerencia imagens
- **`post_format`:** `editorial` = imagem no corpo + featured_media; `standard` = só featured_media

### Caminho 2 — `publishToWordPress()` — `wordpress.js`
- **Quando:** site sem `xixo_api_key` (legado/fallback)
- **Como:** WP REST API nativa via `wp_app_password`
- **Imagem:** backend baixa e sobe via `uploadImageToWP()` (multipart/form-data)

### Caminho 3 — `publishToBlogger()` — `blogger.js`
- **Quando:** site tem `blogger_blog_id`
- **Como:** Google Blogger API v3 + OAuth2; auto-refresh se 401
- **Imagem:** injetada no HTML com `<img src="...">`

### Caminho 4 — `publishViaWebhook()` — `webhooks.js`
- **Quando:** site tem `webhook_url`
- **Como:** POST genérico com payload do cliente

---

## 3. REGRAS OBRIGATÓRIAS PARA TODOS OS CAMINHOS

### 3.1 — Limpeza do corpo (`bodyLimpo`) — OBRIGATÓRIO
```javascript
const bodyLimpo = (rewritten.body || '')
  .replace(/<figure\b[^>]*>[\s\S]*?<\/figure>/gi, '')
  .replace(/<img\b[^>]*\/?>/gi, '');
```
Por quê: imagens embutidas no HTML raspado (seção "Leia Mais" etc.) ficam como thumbnails estranhos no post.

Status: publishViaPlugin ✅ | publishToWordPress ✅ | publishToBlogger ✅ | webhooks — verificar

### 3.2 — FB/IG só publicam com imagem — OBRIGATÓRIO (5 pontos)
```javascript
// autopub.js — querPostarFB
&& !!artigo.image_url

// routes/publish.js — wantsFacebook / wantsFacebookManual
&& article.image_url

// telegram.js — publicar() e proximaEtapaAposCategoria()
imageUrl && ...
```
Por quê: artigos sem imagem (ex: Assembleia Legislativa) geram card com fundo vazio.

### 3.3 — Dois caminhos de reescrita — `autopub.js` E `ia.js`
São independentes. Qualquer mudança de prompt vai nos DOIS.

### 3.4 — `sentenceCasePtBR()` — apenas para títulos crus de RSS
Não aplicar em títulos já escritos pela IA nem no Telegram.

---

## 4. FLUXO DE IMAGEM

### Autopub
```
full-content.js → deveIgnorarImagem() filtra s.w.org e gravatar
  → Caminho 1: image_url → plugin faz download_url() (timeout 120s)
  → Caminho 2: backend baixa e sobe via uploadImageToWP()
  → Caminho 3: injetada no HTML
```

### Criar Post — fast path (pré-upload OK)
```
POST /api/upload-image → WP media → image_media_id
  → Caminho 1: envia image_media_id → plugin usa direto (sem download)
```

### Criar Post — fallback (base64)
```
image_base64 → temp file em backend/public/uploads/
  → URL: BACKEND_URL + /api/uploads/ + tmpName   ← obrigatório /api/uploads/
  → plugin baixa → deleta após 15 min
```

### ⚠️ nginx
- `/uploads/` → **NÃO funciona** (regex intercepta — 404)
- `/api/uploads/` → **funciona** (`location ^~`)

### `backend/utils/allowed-hosts.js` — proxy de imagens
- **Ao cadastrar nova fonte:** adicionar domínio das imagens no mesmo commit
- **Fontes existentes podem mudar de CDN silenciosamente** — monitorar warnings nos logs:
  ```
  [ALLOWED_HOSTS] ⚠️  agenciabrasil: imagem de "cdn.jsdelivr.net" não está em allowed-hosts.js
  ```
- Sem o domínio na lista: 403 silencioso → modal sem imagem → postagem sem foto

---

## 5. BANCO DE DADOS

| Tabela | O que guarda |
|---|---|
| `subscribers` | Clientes |
| `subscriber_sites` | Sites de cada assinante |
| `sites_catalog` | Catálogo de portais |
| `articles` | Artigos coletados |
| `autopub_queue` | Fila producer/consumer |
| `autopub_rules` | Regras de autopub por site |
| `ai_prompts` | Prompts de IA por portal/assinante |

**COALESCE:** `COALESCE(sc.campo, ss.campo, 'padrão')` — catálogo > assinante > padrão  
**Migrations:** `tryMigrate()` individual; nunca em bloco único  
**Timezone:** `DATE(campo AT TIME ZONE 'America/Sao_Paulo')` — nunca `CURRENT_DATE`

---

## 6. PLUGIN XMNEWS PUBLISHER

- Local canônico: `portal-publisher/portal-publisher.php` — nunca criar cópia
- `wp_app_password` **revogado** — plugin gerencia imagens internamente
- Timeout axios: **120s**
- `category_ids` é **array** — `category_id` singular é ignorado silenciosamente

---

## 7. INFRAESTRUTURA

| Item | Valor |
|---|---|
| Servidor | `ubuntu@146.235.53.61` |
| ❌ IP antigo | `150.230.97.99` — timeout |
| Chave SSH | `/c/Users/Wilson/.ssh/artesapro.key` |
| Deploy | `cd /home/ubuntu/xixo && bash deploy.sh` |
| PM2 | `xixo-news` |
| Porta | **3002** |

**`settings.json`** — no `.gitignore`; deploy nunca sobrescreve; se sumir, deploy.sh recria do `.example`

**Deploy:** git push ANTES → SSH → `bash deploy.sh` → nunca sem autorização do usuário

---

## 8. ✅ CHECKLIST PRÉ-ALTERAÇÃO

- [ ] Qual(is) caminho(s) de publicação este código afeta? → Se corpo/imagem: verificar **4 caminhos**
- [ ] A mudança afeta FB/IG? → Verificar **5 pontos** (autopub.js, publish.js×2, telegram.js×2)
- [ ] A mudança afeta o fluxo de imagem? → autopub, fast path, fallback base64, nginx `/api/uploads/`
- [ ] A mudança afeta reescrita de IA? → **`autopub.js` E `ia.js`** — são independentes
- [ ] Estou adicionando nova fonte? → Adicionar domínio em `image-proxy.js` ALLOWED_HOSTS
- [ ] Estou mexendo no banco? → `tryMigrate()` individual; checar FK antes de DELETE
- [ ] Chamadas HTTP externas? → Sem `User-Agent: Mozilla/5.0`; checar ALLOWED_HOSTS; anti-SSRF
- [ ] Mexendo no plugin PHP? → Somente `portal-publisher/portal-publisher.php`
- [ ] Exige atualização do plugin nos clientes? → Avisar o usuário

---

## 9. ✅ CHECKLIST PRÉ-DEPLOY

- [ ] `git push origin main` feito?
- [ ] Mudanças em `sources.json` commitadas localmente?
- [ ] Migrations testadas?
- [ ] Variáveis de `.env` adicionadas ao servidor?
- [ ] Plugin atualizado nos clientes (se necessário)?
- [ ] **Usuário autorizou o deploy explicitamente?**

---

## 10. ⚠️ ERROS HISTÓRICOS — Para nunca repetir

| # | Erro | O que aconteceu | Lição |
|---|---|---|---|
| 1 | `wp_app_password` em publishViaPlugin | Ficou ativo meses após ser revogado; 401 em todo autopub | Plugin gerencia imagens; não duplicar responsabilidade |
| 2 | `<img>` de "Leia Mais" no corpo | Raspado passava sem limpeza; thumbnails estranhos no post | `bodyLimpo` obrigatório nos 4 caminhos |
| 3 | Temp file em `/uploads/` | nginx regex interceptava; 404 sempre | Usar `/api/uploads/` com `location ^~` |
| 4 | `image_media_id` não enviado ao plugin | Plugin re-baixava imagem já uploadada | Sempre passar `image_media_id` no payload |
| 5 | SSH no IP errado | `150.230.97.99` — timeout | IP correto: `146.235.53.61` |
| 6 | Deploy sem push | Servidor diz "Already up to date" silenciosamente | Push ANTES do deploy, sempre |
| 7 | `category_id` singular | WP REST API ignora; post vai sem categoria | Sempre `category_ids` (array) |
| 8 | `sentenceCasePtBR` no Telegram | Títulos já processados pela IA ficavam errados | Só em títulos crus de RSS |
| 9 | Emoji CDN como featured image | `s.w.org/images/core/emoji/` selecionado | `deveIgnorarImagem()` filtra |
| 10 | sources.json deletado na UI | `git pull` sobrescrevia no deploy | Deleções permanentes = commitar localmente |
| 11 | schema.sql desatualizado + DELETE FK | Cascade não declarada; migrations falhavam | `information_schema`; `tryMigrate()` |
| 12 | Porta 3000 em vez de 3002 | Requisição nunca chegava | Sempre porta 3002 |
| 13 | `fetch()` sem `r.ok` | 4xx/5xx silenciosos; UI mostrava sucesso falso | `if (!r.ok) throw new Error(...)` |
| 14 | `User-Agent: Mozilla/5.0` em Node.js | ModSecurity retornava 406 | Headers `{}` em chamadas server-to-server WP |
| 15 | Timeout 60s no publishViaPlugin | Plugin leva >60s com imagens grandes; ERROR falso | Timeout é 120s |
| 16 | FB/IG sem imagem | Card com fundo vazio publicado | Verificar `image_url` — 5 pontos no código |
| 17 | settings.json versionado | Deploy sobrescrevia; autopub desligava | settings.json no `.gitignore` |
| 18 | ERROR no histórico ≠ falha real | Timeout → ERROR, mas post existe no WP | Antes de investigar: checar se post existe |
| 19 | CDN de fonte mudou silenciosamente | Agência Brasil migrou para `cdn.jsdelivr.net`; imagens bloqueadas por dias sem erro explícito | Monitorar `[ALLOWED_HOSTS] ⚠️` nos logs; arquivo correto: `allowed-hosts.js` |
| 20 | `sources.json` sobrescrito no deploy | Estava no git; fontes adicionadas/desativadas pelo painel eram perdidas a cada deploy (stash nunca restaurado) | `sources.json` no `.gitignore`; `sources.default.json` como seed; deploy cria do default se não existir |
| 21 | `needsCFProxy` duplo ponto | `CF_PROXY_DOMAINS = ['.sc.gov.br']` com ponto inicial → `h.endsWith('.' + '.sc.gov.br')` = `h.endsWith('..sc.gov.br')` → nunca casa → todos os artigos RSS de municípios sc.gov.br ficavam sem imagem | Domínios em `CF_PROXY_DOMAINS` sem ponto inicial: `['sc.gov.br']`; mesma convenção de `allowed-hosts.js` |
