'use strict';

const pool             = require('../db/connection');
const { decryptToken, encryptToken } = require('./encrypt');

async function refreshBloggerToken(site) {
  const res  = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID     || '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
      refresh_token: decryptToken(site.blogger_refresh_token),
      grant_type:    'refresh_token'
    })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Falha ao renovar token Blogger');

  // Salva novo access_token no banco
  await pool.query(
    'UPDATE subscriber_sites SET blogger_access_token = $1 WHERE id = $2',
    [encryptToken(data.access_token), site.id]
  );
  return data.access_token;
}

async function publishToBlogger(site, rewritten, article) {
  let accessToken = decryptToken(site.blogger_access_token);

  // Monta o conteúdo HTML
  // Remove <img>/<figure> do corpo — a imagem principal já é injetada explicitamente
  // acima via article.image_url. Sem limpeza, imagens de "Leia Mais" e seções
  // relacionadas da fonte ficam embutidas no post.
  const bodyLimpo = (rewritten.body || '')
    .replace(/<figure\b[^>]*>[\s\S]*?<\/figure>/gi, '')
    .replace(/<img\b[^>]*\/?>/gi, '');

  let content = '';
  if (article.image_url) {
    content += `<img src="${article.image_url}" alt="${(rewritten.title || '').replace(/"/g, '&quot;')}" style="max-width:100%;height:auto;margin-bottom:1rem;">`;
  }
  if (rewritten.chapeu) content += `<p><strong>${rewritten.chapeu}</strong></p>`;
  content += bodyLimpo;

  const tryPublish = async (token) => {
    const res = await fetch(
      `https://www.googleapis.com/blogger/v3/blogs/${site.blogger_blog_id}/posts/`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify({
          title:   rewritten.title,
          content: content,
          labels:  rewritten.tags || []
        })
      }
    );
    return res.json();
  };

  let post = await tryPublish(accessToken);

  // Se 401, tentar renovar e publicar novamente
  if (post.error?.code === 401) {
    accessToken = await refreshBloggerToken(site);
    post = await tryPublish(accessToken);
  }

  if (!post.id) throw new Error(post.error?.message || 'Erro ao criar post no Blogger');
  return { post_id: post.id, post_url: post.url };
}

module.exports = { publishToBlogger };
