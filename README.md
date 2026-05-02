# RB24Horas — Painel Editorial

Sistema editorial standalone para o portal **RB24Horas** (rb24horas.com.br).

---

## Estrutura do Projeto

```
/
  index.html        ← Painel editorial (abrir no browser)
  README.md         ← Este arquivo
  /backend
    server.js       ← Servidor Node.js (proxy RSS + scraping)
    sources.json    ← Lista de fontes de notícias
    package.json    ← Dependências Node.js
```

---

## 1. Painel Editorial (`index.html`)

Abra o arquivo `index.html` diretamente no browser **ou** sirva-o de qualquer servidor estático.

Na primeira abertura, preencha a tela de configurações:

| Campo | Descrição |
|-------|-----------|
| URL do WordPress | Ex: `https://rb24horas.com.br` |
| Usuário WordPress | Nome de usuário (não o e-mail) |
| Application Password | Gerado em: WP Admin → Usuários → Perfil → Application Passwords |
| Anthropic API Key | Chave `sk-ant-...` do console.anthropic.com |
| URL do Backend | Ex: `http://localhost:3000` (deixe em branco para desativar fontes externas) |

As configurações ficam salvas no `localStorage` do browser.

---

## 2. Backend — Agregador de Fontes (`/backend`)

O backend é necessário apenas para o módulo **Fontes Externas** (aba de notícias RSS).
Sem ele, o painel funciona normalmente para rascunhos do WordPress.

### Instalação

```bash
cd backend
npm install
```

### Rodar

```bash
npm start
# ou para desenvolvimento com reload automático:
npm run dev
```

O servidor inicia em `http://localhost:3000`.

### Rotas disponíveis

| Rota | Descrição |
|------|-----------|
| `GET /api/sources` | Lista de fontes com status (ok/erro/pendente) |
| `GET /api/feeds` | Todas as notícias de todas as fontes ativas |
| `GET /api/feeds?source=metropoles` | Notícias de uma fonte específica |
| `GET /api/feeds?category=nacional` | Notícias de uma categoria |
| `GET /api/article?url=https://...` | Conteúdo completo de um artigo |
| `GET /api/refresh` | Forçar atualização de todas as fontes |
| `GET /api/refresh?source=cnnbrasil` | Forçar atualização de uma fonte |

### Cache

As notícias são atualizadas **automaticamente a cada 15 minutos**. O cache fica em memória — reiniciar o servidor limpa o cache, que é recarregado imediatamente.

---

## 3. Hospedar na VPS (junto com o WordPress)

### Opção A — PM2 (recomendado)

```bash
# Instalar PM2 globalmente
npm install -g pm2

# Entrar na pasta do backend
cd /var/www/rb24horas/backend

# Instalar dependências
npm install

# Iniciar com PM2
pm2 start server.js --name rb24horas-backend

# Salvar configuração para reiniciar automaticamente
pm2 save
pm2 startup
```

Acessar em: `http://IP_DO_SERVIDOR:3000` ou via proxy reverso Nginx na porta 80/443.

### Opção B — Proxy Reverso Nginx

Adicione ao arquivo de configuração do Nginx:

```nginx
location /api/ {
    proxy_pass http://localhost:3000/api/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

Assim o backend fica acessível em `https://rb24horas.com.br/api/` sem necessidade de porta.

### Hospedar o index.html

Copie `index.html` para `/var/www/html/editor/` e acesse via `https://rb24horas.com.br/editor/`.

---

## 4. Adicionar ou Remover Fontes

Edite o arquivo `backend/sources.json`. Cada fonte tem este formato:

```json
{
  "name": "Nome da Fonte",
  "slug": "slug-unico",
  "type": "rss",
  "url": "https://exemplo.com.br/feed",
  "active": true,
  "category": "nacional"
}
```

**Categorias disponíveis:** `nacional`, `regional`, `esporte`, `agro`, `governo`, `prefeitura`

**Tipos:**
- `"type": "rss"` — para feeds RSS/Atom padrão
- `"type": "scraping"` — para sites sem RSS (extrai por HTML)

**Para desativar uma fonte** sem remover, use `"active": false`.

Após editar o `sources.json`, reinicie o servidor:
```bash
pm2 restart rb24horas-backend
# ou
npm start
```

---

## 5. Verificar URLs de RSS

Algumas URLs de RSS podem mudar. Para testar se uma URL funciona:

```bash
curl -I https://exemplo.com.br/feed
```

Se retornar `200 OK`, está funcionando. Variações comuns para tentar:
- `/feed`
- `/rss`
- `/rss.xml`
- `/feed/rss`
- `/noticias/feed`
- `/?format=feed&type=rss` (Joomla)

---

## Segurança

- As credenciais do WordPress e da Anthropic ficam **apenas no `localStorage`** do seu browser
- O backend não armazena nem retransmite credenciais
- Use o painel em **dispositivo pessoal e seguro**
- A Application Password do WordPress deve ter permissão mínima de **Editor**
