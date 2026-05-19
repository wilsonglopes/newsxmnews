// Worker: xixo-sc-proxy
// Proxy para conteúdo bloqueado na Oracle Cloud.
// Variável de ambiente obrigatória: PROXY_TOKEN (string secreta qualquer)

// Sufixos permitidos (subdomínios incluídos)
const ALLOWED_SUFFIXES = ['sc.gov.br'];
// Domínios exatos permitidos
const ALLOWED_EXACT    = ['midiamax.com.br'];

function isAllowed(hostname) {
  return ALLOWED_EXACT.includes(hostname) ||
         ALLOWED_SUFFIXES.some(s => hostname === s || hostname.endsWith('.' + s));
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'X-Proxy-Token',
        },
      });
    }

    // Auth
    const token = request.headers.get('X-Proxy-Token');
    if (!env.PROXY_TOKEN || token !== env.PROXY_TOKEN) {
      return new Response('Unauthorized', { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const url = searchParams.get('url');
    if (!url) return new Response('Missing url', { status: 400 });

    let parsed;
    try { parsed = new URL(url); } catch {
      return new Response('Invalid URL', { status: 400 });
    }
    if (!isAllowed(parsed.hostname)) {
      return new Response('Domain not allowed', { status: 403 });
    }

    // Fetch via rede da Cloudflare (IP diferente do Oracle Cloud)
    let upstream;
    try {
      upstream = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Language': 'pt-BR,pt;q=0.9',
          'Referer': parsed.origin + '/',
        },
        redirect: 'follow',
      });
    } catch (e) {
      return new Response('Fetch failed: ' + e.message, { status: 502 });
    }

    const headers = new Headers(upstream.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Cache-Control', 'public, max-age=3600');

    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  },
};
