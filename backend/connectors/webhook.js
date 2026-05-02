'use strict';

const crypto = require('crypto');

async function publishViaWebhook(site, rewritten, article) {
  const payload = JSON.stringify({
    chapeu:       rewritten.chapeu    || '',
    title:        rewritten.title     || '',
    summary:      rewritten.summary   || '',
    body:         rewritten.body      || '',
    tags:         rewritten.tags      || [],
    image_url:    article.image_url   || null,
    source_name:  article.source_name || null,
    source_url:   article.external_url,
    published_at: article.published_at
  });

  const signature = site.webhook_secret
    ? crypto.createHmac('sha256', site.webhook_secret).update(payload).digest('hex')
    : '';

  const res = await fetch(site.webhook_url, {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      ...(site.webhook_secret && {
        'X-Webhook-Secret': site.webhook_secret,
        'X-Signature':      `sha256=${signature}`
      })
    },
    body: payload
  });

  if (!res.ok) throw new Error(`Webhook retornou ${res.status}: ${await res.text().catch(() => '')}`);
  return { post_id: null, post_url: site.site_url };
}

module.exports = { publishViaWebhook };
