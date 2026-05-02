# FASE 4 — Painel Admin + Sistema de Planos

As Fases 1, 2 e 3 já estão prontas. Agora implementar a Fase 4 final: painel administrativo e controle de planos.

## O que fazer

### 1. Criar `routes/admin.js`

Todas as rotas exigem um middleware de autenticação admin. Implementar verificação via variável de ambiente `ADMIN_EMAIL` — quem fizer login com esse email tem acesso admin.

```
GET  /api/admin/stats
  - Total de assinantes ativos
  - Total de artigos coletados hoje
  - Total de publicações hoje
  - Lista de fontes com erro (last_error não null e last_fetched_at < 1h atrás)

GET  /api/admin/subscribers
  - Lista todos os assinantes com: nome, email, plano, status, data de cadastro, publicações no mês

POST /api/admin/subscribers
  - Criar assinante manualmente
  - Campos: name, email, password, plan_id, plan_expires_at
  - Fazer hash da senha com bcrypt antes de salvar

PUT  /api/admin/subscribers/:id
  - Editar: trocar plano, resetar senha, ativar/desativar
  - Se vier campo password, fazer hash antes de salvar

GET  /api/admin/sources
  - Lista todas as fontes com: nome, tipo, categoria, status, last_fetched_at, last_error, artigos hoje

POST /api/admin/sources
  - Adicionar nova fonte
  - Campos: name, slug, type, url, category, e todos os seletores CSS

PUT  /api/admin/sources/:id
  - Editar qualquer campo da fonte, incluindo seletores CSS
  - Campo active: ativar/desativar

POST /api/admin/sources/:id/fetch-now
  - Forçar coleta imediata de uma fonte específica
  - Retornar quantos artigos novos foram encontrados

GET  /api/admin/plans
  - Listar planos

POST /api/admin/plans
  - Criar plano

PUT  /api/admin/plans/:id
  - Editar plano
```

### 2. Criar `frontend/admin/index.html`

Design igual ao restante do sistema (mesmas variáveis CSS, fontes Playfair Display + IBM Plex Sans).

Login: usar o mesmo `frontend/subscriber/login.html` mas redirecionar para `/admin/` após login.

**Dashboard (tela inicial):**

4 cards de métricas no topo:
- Assinantes ativos (número grande)
- Artigos coletados hoje
- Publicações hoje
- Fontes com erro (número em vermelho se > 0)

**Seção: Fontes com problema** (abaixo dos cards):
- Lista vermelha das fontes que falharam
- Mostra: nome, último erro, última tentativa
- Botão "Testar agora" por fonte → chama `POST /api/admin/sources/:id/fetch-now`

**Menu lateral (ou abas no topo):**
- Dashboard
- Fontes
- Assinantes
- Planos

---

**Tela: Fontes**

Tabela com todas as fontes:
| Nome | Tipo | Categoria | Status | Última coleta | Artigos hoje | Ações |
|------|------|-----------|--------|---------------|--------------|-------|

- Status: badge verde (ok) / vermelho (erro) / cinza (inativo)
- Botão "Editar" → abre formulário lateral ou modal com todos os campos:
  - Nome, Slug, Tipo (RSS/Scraping), URL, Categoria
  - Se Scraping: campos para cada seletor CSS (section, title, date, link, image, content)
  - Botão "Testar seletores" → faz fetch da URL e mostra preview do que seria extraído
  - Ativo/Inativo (toggle)
- Botão "Coletar agora" → força coleta imediata, mostra resultado
- Botão "Adicionar fonte" → mesmo formulário em branco

---

**Tela: Assinantes**

Tabela:
| Nome | Email | Plano | Expira em | Status | Publicações/mês | Ações |
|------|-------|-------|-----------|--------|-----------------|-------|

- Botão "Editar" → modal com:
  - Nome, email
  - Plano (dropdown com os planos cadastrados)
  - Data de expiração do plano
  - Nova senha (opcional — só alterar se preenchido)
  - Ativo/Inativo
  - Fontes liberadas para este assinante (checkboxes com todas as fontes)
- Botão "Novo assinante" → mesmo formulário em branco
- Ao criar assinante: gerar senha aleatória e mostrar na tela (exibir só uma vez)

---

**Tela: Planos**

Tabela simples com os 3 planos.
Botão editar → modal para alterar limites e preço.

### 3. Implementar controle de limites por plano

No `routes/publish.js`, antes de publicar, verificar:

```javascript
// 1. Buscar plano do assinante
// 2. Contar publicações do mês atual na tabela publications
//    WHERE subscriber_id = ? AND published_at >= início do mês
// 3. Se plan.max_publications_per_month não é null
//    E count >= max_publications_per_month
//    → retornar 403: "Limite de publicações do plano atingido"
// 4. Verificar se a fonte do artigo está liberada para o plano do assinante
//    via tabela subscriber_sources
//    → se não está: retornar 403: "Fonte não disponível no seu plano"
```

### 4. Implementar liberação de fontes por plano

Quando assinante é criado ou tem plano alterado pelo admin:
- Plano Básico (max_sources=5): admin escolhe manualmente quais 5 fontes liberar
- Plano Profissional (max_sources=15): admin escolhe 15
- Plano Premium (max_sources=0): liberar todas automaticamente
- Inserir registros na tabela `subscriber_sources`

No painel admin, tela de edição do assinante: mostrar checkboxes com todas as fontes ativas, marcando as que estão liberadas.

### 5. Mostrar contador de uso no painel do assinante

Na tela de configurações do assinante (`frontend/subscriber/index.html`), seção "Meu plano":
- Buscar via `GET /api/auth/me` os dados do plano
- Mostrar: "X de Y publicações usadas este mês"
- Barra de progresso visual
- Se atingiu 80% do limite: aviso amarelo
- Se atingiu 100%: aviso vermelho + botão "Falar sobre upgrade"

### 6. Criar `README.md` completo na raiz do projeto

Documentar:

**Instalação:**
```bash
# 1. Instalar dependências
cd backend && npm install

# 2. Configurar variáveis de ambiente
cp .env.example .env
# Editar .env com suas credenciais

# 3. Criar banco de dados
createdb noticias
psql noticias < db/schema.sql
node db/seed.js

# 4. Rodar o servidor
npm start
# ou em produção:
pm2 start server.js --name noticias
```

**Estrutura de pastas:**
Listar todos os arquivos com uma linha de descrição cada.

**Como adicionar uma nova fonte:**
Passo a passo para adicionar via painel admin ou diretamente no banco.

**Como cadastrar um novo assinante:**
Passo a passo pelo painel admin.

**Como fazer deploy na VPS:**
- Instalar Node.js, PostgreSQL, PM2, Nginx
- Configurar Nginx como proxy reverso
- Configurar SSL com Certbot
- Comandos de deploy

**Variáveis de ambiente:**
Explicar cada variável do `.env`.

## O que NÃO mexer
- Tudo implementado nas Fases 1, 2 e 3
- `index.html` original do operador
- Motor de coleta e normalização
