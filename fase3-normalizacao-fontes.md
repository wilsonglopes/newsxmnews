# FASE 3 — Qualidade da Coleta + Normalização

As Fases 1 e 2 já estão prontas: banco, login, conectores WordPress/Blogger, painel do assinante.

Agora implementar a Fase 3: normalização de artigos e refinamento das fontes.

## O que fazer

### 1. Criar `scrapers/normalizer.js`

Este módulo recebe qualquer artigo cru (vindo de RSS ou scraping) e devolve sempre no mesmo formato limpo.

**Formato de saída obrigatório:**
```json
{
  "external_url": "https://...",
  "chapeu": "POLÍTICA",
  "title": "Título limpo sem HTML",
  "summary": "Resumo em texto puro, máx 300 chars",
  "body": "<p>...</p><p>...</p>",
  "image_url": "https://... ou null",
  "tags": ["tag1", "tag2"],
  "author": "Nome ou null",
  "published_at": "2026-04-13T10:00:00Z ou null"
}
```

**Regras de normalização a implementar:**

1. **Título e resumo**: remover todo HTML, decodificar entidades HTML (`&amp;` → `&`, `&nbsp;` → espaço, etc.), trim, colapsar espaços múltiplos

2. **Corpo (body)**:
   - Manter APENAS estas tags: `<p>`, `<h2>`, `<h3>`, `<strong>`, `<em>`, `<ul>`, `<ol>`, `<li>`, `<blockquote>`
   - Remover completamente: `<script>`, `<style>`, `<iframe>`, `<form>`, `<button>`, `<nav>`, `<header>`, `<footer>`, `<aside>`
   - Remover divs/spans com classes que indiquem publicidade: `ad`, `ads`, `advertisement`, `banner`, `sidebar`, `social`, `share`, `related`, `newsletter`, `subscribe`, `comments`, `tags-lista`
   - Remover parágrafos que comecem com: "Leia também", "Veja mais", "Leia mais", "Confira também", "Assine", "Clique aqui"
   - Remover todos os `<a href>` que apontem para o domínio da fonte original (links internos)
   - Remover atributos de todas as tags que sobrarem, exceto `href` em `<a>` e `src` em `<img>`
   - Colapsar `<br><br>` em `</p><p>`
   - Remover parágrafos vazios ou que tenham só espaços

3. **Chapéu**: derivar assim (em ordem de prioridade):
   - Se RSS tem categoria: converter para maiúsculas (ex: "política" → "POLÍTICA")
   - Se URL tem segmento de seção: `/politica/` → "POLÍTICA", `/economia/` → "ECONOMIA", `/esportes/` → "ESPORTE", `/saude/` → "SAÚDE", `/seguranca/` → "SEGURANÇA", `/educacao/` → "EDUCAÇÃO", `/cultura/` → "CULTURA", `/tecnologia/` → "TECNOLOGIA"
   - Se source.category for "prefeitura" → "PODER PÚBLICO"
   - Se source.category for "governo" → "GOVERNO"
   - Se source.category for "esporte" → "ESPORTE"
   - Se source.category for "agro" → "AGRONEGÓCIO"
   - Default: "NOTÍCIA"

4. **Resumo**: se não vier do RSS, pegar o primeiro parágrafo do body (após normalização), remover HTML, truncar em 300 caracteres, adicionar "..." se truncou

5. **Imagem**: pegar a primeira `<img>` do body ou a imagem do RSS (enclosure/media:content). Remover imagens pequenas (< 100px se tiver width/height no HTML)

6. **Tags**: limpar espaços, remover duplicatas, lowercase, remover tags genéricas ("notícia", "brasil", "news")

7. **Tolerância a falhas**: se qualquer campo falhar na extração, retornar `null` nesse campo — nunca lançar erro que impeça salvar o artigo

### 2. Aplicar o normalizer no fluxo de coleta

No `server.js` (ou nos scrapers), após coletar cada artigo bruto, passar pelo `normalizer.js` antes de salvar no banco. Isso se aplica tanto para RSS quanto para scraping.

### 3. Refinar os seletores das prefeituras

Para CADA prefeitura listada abaixo, fazer o seguinte:
1. Fazer `fetch` do HTML da URL configurada
2. Inspecionar o HTML com cheerio
3. Identificar os seletores CSS reais para: lista de notícias, título, data, link, imagem
4. Atualizar a tabela `sources` no banco com os seletores corretos
5. Testar que pelo menos 3 artigos são extraídos corretamente

Prefeituras para refinar:
- Sombrio SC: `https://sombrio.sc.gov.br/noticias`
- Torres RS: URL da seção de notícias do site oficial
- Arroio do Sal RS: URL da seção de notícias
- Capão da Canoa RS: URL da seção de notícias
- Bal. Passo de Torres SC: URL da seção de notícias
- Bal. Gaivota SC: URL da seção de notícias
- São João do Sul SC: URL da seção de notícias
- Praia Grande SC: URL da seção de notícias
- Jacinto Machado SC: URL da seção de notícias

Para cada uma: se a URL configurada retornar erro 404, tentar `/noticias`, `/comunicacao`, `/imprensa`, `/transparencia/noticias`.

### 4. Implementar busca de conteúdo completo

Muitos RSS entregam só o resumo, não o artigo inteiro. Implementar em `scrapers/full-content.js`:

```javascript
async function fetchFullContent(url, source) {
  // 1. Fazer fetch da URL do artigo
  // 2. Usar cheerio para extrair o corpo usando source.content_selector
  // 3. Se content_selector não definido, tentar seletores genéricos em ordem:
  //    'article', '.post-content', '.entry-content', '.noticia-corpo',
  //    '.conteudo-noticia', 'main p', '.texto-noticia'
  // 4. Passar pelo normalizer
  // 5. Retornar o body normalizado
  // 6. Se falhar, retornar null (manter o resumo do RSS)
}
```

Chamar essa função no endpoint `GET /api/articles/:id/full-content`.

### 5. Implementar detecção de duplicatas

Já feito na Fase 1 (checar `external_url` antes de inserir), mas adicionar também:
- Se dois artigos tiverem títulos com mais de 85% de similaridade (Levenshtein ou simples), do mesmo dia, da mesma fonte → não inserir o segundo
- Usar um índice no banco: `CREATE INDEX IF NOT EXISTS idx_articles_url ON articles(external_url)`
- Adicionar índice de data: `CREATE INDEX IF NOT EXISTS idx_articles_date ON articles(published_at DESC)`

### 6. Melhorar o log de erros por fonte

No `server.js`, quando uma fonte falhar na coleta:
- Salvar o erro na coluna `last_error` da tabela `sources`
- Atualizar `last_fetched_at` mesmo em caso de erro (registrar a tentativa)
- Não deixar o erro de uma fonte parar a coleta das outras (try/catch por fonte)
- Logar no console: `[ERRO] Fonte "Nome" falhou: mensagem do erro`
- Logar sucesso: `[OK] Fonte "Nome": 12 artigos novos coletados`

## O que NÃO mexer
- Tudo que foi implementado nas Fases 1 e 2
- `index.html` original do operador
- Rotas de autenticação e publicação já funcionando
