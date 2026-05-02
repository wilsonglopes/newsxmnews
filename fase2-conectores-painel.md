# FASE 2 — Conectores de Publicação + Painel do Assinante

A Fase 1 já foi implementada: banco PostgreSQL, autenticação JWT, artigos salvando no banco.

Agora implementar a Fase 2: conectores de publicação (WordPress + Blogger) e o painel web do assinante.

## O que fazer

### 1. Instalar dependências novas
```
npm install googleapis node-fetch form-data
```

### 2. Criar `connectors/wordpress.js`

```javascript
// Publicar artigo no WordPress de um assinante via API REST
async function publishToWordPress(site, rewritten, article) {
  const auth = Buffer.from(`${site.wp_username}:${decryptToken(site.wp_app_password)}`).toString('base64')
  const baseUrl = site.site_url.replace(/\/$/, '')
  const headers = { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' }

  // 1. Processar tags: buscar existentes, criar as que não existem, coletar IDs
  const tagIds = []
  for (const tag of (rewritten.tags || [])) {
    const search = await fetch(`${baseUrl}/wp-json/wp/v2/tags?search=${encodeURIComponent(tag)}`, { headers })
    const found = await search.json()
    if (found.length > 0) {
      tagIds.push(found[0].id)
    } else {
      const created = await fetch(`${baseUrl}/wp-json/wp/v2/tags`, {
        method: 'POST', headers,
        body: JSON.stringify({ name: tag })
      })
      const newTag = await created.json()
      tagIds.push(newTag.id)
    }
  }

  // 2. Upload da imagem destacada se houver
  let featuredMediaId = null
  if (article.image_url) {
    try {
      const imgResponse = await fetch(article.image_url)
      const imgBuffer = await imgResponse.buffer()
      const imgName = article.image_url.split('/').pop().split('?')[0] || 'imagem.jpg'
      const uploadResponse = await fetch(`${baseUrl}/wp-json/wp/v2/media`, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Disposition': `attachment; filename="${imgName}"`, 'Content-Type': 'image/jpeg' },
        body: imgBuffer
      })
      const media = await uploadResponse.json()
      featuredMediaId = media.id
    } catch (e) { /* imagem opcional, ignorar erro */ }
  }

  // 3. Criar o post
  const postBody = {
    title: rewritten.title,
    content: rewritten.body,
    excerpt: rewritten.summary,
    status: 'publish',
    tags: tagIds,
    meta: { chapeu: rewritten.chapeu, fonte_original: article.external_url }
  }
  if (rewritten.category_id) postBody.categories = [rewritten.category_id]
  if (featuredMediaId) postBody.featured_media = featuredMediaId

  const postResponse = await fetch(`${baseUrl}/wp-json/wp/v2/posts`, {
    method: 'POST', headers,
    body: JSON.stringify(postBody)
  })
  const post = await postResponse.json()
  if (!post.id) throw new Error(post.message || 'Erro ao criar post no WordPress')
  return { post_id: String(post.id), post_url: post.link }
}
```

Também implementar `decryptToken(encrypted)` usando AES-256 com a `ENCRYPTION_KEY` do `.env`, e `encryptToken(plain)` para usar ao salvar no banco.

### 3. Criar `connectors/blogger.js`

```javascript
// Publicar artigo no Blogger via Google API v3
async function publishToBlogger(site, rewritten, article) {
  // 1. Tentar renovar access_token se necessário
  //    POST https://oauth2.googleapis.com/token
  //    { client_id, client_secret, refresh_token, grant_type: 'refresh_token' }
  //    Se renovar, salvar novo access_token no banco

  // 2. Montar corpo do post
  //    Blogger não tem upload de mídia — incorporar imagem diretamente no HTML
  let content = ''
  if (article.image_url) {
    content += `<img src="${article.image_url}" alt="${rewritten.title}" style="max-width:100%;height:auto;margin-bottom:1rem;">`
  }
  content += `<p><strong>${rewritten.chapeu}</strong></p>`
  content += rewritten.body

  // 3. Criar o post via Google API
  //    POST https://www.googleapis.com/blogger/v3/blogs/{blogId}/posts/
  //    Authorization: Bearer {access_token}
  const response = await fetch(
    `https://www.googleapis.com/blogger/v3/blogs/${site.blogger_blog_id}/posts/`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${decryptToken(site.blogger_access_token)}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title: rewritten.title,
        content: content,
        labels: rewritten.tags || []
      })
    }
  )
  const post = await response.json()
  if (!post.id) throw new Error(post.error?.message || 'Erro ao criar post no Blogger')
  return { post_id: post.id, post_url: post.url }
}
```

### 4. Criar `connectors/webhook.js`

```javascript
// Publicar via webhook genérico (para outras plataformas)
async function publishViaWebhook(site, rewritten, article) {
  const payload = JSON.stringify({
    chapeu: rewritten.chapeu,
    title: rewritten.title,
    summary: rewritten.summary,
    body: rewritten.body,
    tags: rewritten.tags,
    image_url: article.image_url,
    source_name: article.source_name,
    source_url: article.external_url,
    published_at: article.published_at
  })
  // Assinatura HMAC-SHA256 para o cliente verificar autenticidade
  const crypto = require('crypto')
  const signature = crypto.createHmac('sha256', site.webhook_secret).update(payload).digest('hex')

  const response = await fetch(site.webhook_url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Secret': site.webhook_secret,
      'X-Signature': `sha256=${signature}`
    },
    body: payload
  })
  if (!response.ok) throw new Error(`Webhook retornou ${response.status}`)
  return { post_id: null, post_url: site.site_url }
}
```

### 5. Criar `routes/articles.js`

```
GET /api/articles
  - Requer JWT válido (middleware auth)
  - Busca fontes liberadas para o plano do assinante
  - Filtra artigos dessas fontes
  - Suporta query: ?source=slug&search=texto&period=today|24h|3d&page=1&limit=30
  - Retorna { articles: [...], total, page, pages }

GET /api/articles/:id
  - Retorna artigo completo com body HTML

GET /api/articles/:id/full-content
  - Se body do artigo estiver vazio ou muito curto (< 200 chars),
    fazer fetch da external_url, extrair o conteúdo principal e retornar
```

### 6. Criar `routes/publish.js`

```
POST /api/publish
  - Requer JWT válido
  - Recebe { article_id, site_id, rewritten: { chapeu, title, summary, body, tags, category_id } }
  - Busca o site pelo site_id, confirma que pertence ao assinante logado
  - Detecta platform: "wordpress" | "blogger" | "webhook"
  - Chama o conector correto
  - Salva na tabela publications
  - Retorna { success: true, post_url, post_id }

POST /api/sites
  - Requer JWT válido
  - Cadastrar novo site do assinante
  - Criptografar wp_app_password ou blogger tokens antes de salvar

GET /api/sites
  - Requer JWT válido
  - Listar sites do assinante logado

DELETE /api/sites/:id
  - Requer JWT válido
  - Remover site (confirmar que pertence ao assinante)
```

### 7. Criar o painel do assinante em `frontend/subscriber/`

Criar dois arquivos HTML:

#### `login.html`
- Design igual ao `index.html` existente (mesmas cores, fontes, variáveis CSS)
- Formulário: campo email, campo senha, botão "Entrar"
- Ao submeter: POST /api/auth/login
- Se sucesso: salvar token no localStorage e redirecionar para index.html
- Se erro: mostrar mensagem "Email ou senha incorretos"

#### `index.html` (painel do assinante)
- Verificar token no localStorage ao carregar — se não tiver, redirecionar para login.html
- Header: nome do assinante, badge do plano, botão "Configurações", botão "Sair"

**Aba principal — Lista de artigos:**
- Barra de filtros: dropdown de fontes, campo de busca, filtro de período (Hoje/24h/3 dias)
- Botão "Atualizar"
- Tabela com colunas: Fonte (badge colorido por categoria), Chapéu, Título (truncado 80 chars), Publicado (tempo relativo), Ações
- Cores dos badges por categoria: vermelho=nacional, verde=regional, azul=governo, laranja=esporte, cinza=prefeitura
- Clicar na linha abre modal de leitura

**Modal de leitura:**
- Mostra: chapéu, título, imagem, resumo, corpo completo, link "Ver original ↗"
- Botão "✦ Gerar com IA e Publicar" (destaque, vermelho)
- Ao clicar: chamar Anthropic API com o prompt personalizado do assinante
  - A Anthropic API key vem de uma config salva no localStorage do assinante
  - Mostrar loading "Reescrevendo..."
- Após gerar: mostrar campos editáveis (chapéu, título, resumo, corpo, tags)
- Dropdown "Publicar em qual site?" com os sites conectados do assinante
- Botão "Publicar agora" → POST /api/publish
- Após publicar: mostrar link do post publicado

**Aba configurações:**
- Seção "Minha chave de IA": campo para Anthropic API Key (salva no localStorage)
- Seção "Meus sites": lista os sites cadastrados com plataforma e status
- Botão "Adicionar site" → formulário:
  ```
  Nome do site: [__________]
  Plataforma: [WordPress ▾]  (WordPress | Blogger | Webhook)

  Se WordPress:
    URL do site, Usuário, Application Password

  Se Blogger:
    Blog ID, botão "Conectar com Google"

  Se Webhook:
    URL do webhook, Chave secreta

  Prompt de estilo (opcional):
    [textarea para personalizar o tom da IA]

  [Salvar site]
  ```
- Seção "Meu plano": plano atual, publicações usadas no mês, fontes disponíveis

### 8. Registrar as novas rotas no `server.js`

Adicionar sem quebrar o que já funciona:
```javascript
app.use('/api/articles', require('./routes/articles'))
app.use('/api/publish', require('./routes/publish'))
app.use('/api/sites', require('./routes/publish')) // sites está em publish.js
```

## O que NÃO mexer
- `index.html` original (painel do operador)
- Motor de coleta RSS/scraping
- Banco e autenticação da Fase 1
