/*
 * Cloudflare Pages Function — Tranzy.ai advanced-signal proxy.
 *
 * Route: /api/tranzy/<path>  →  https://api.tranzy.ai/<path>
 *
 * Only exercised when a user provides a Tranzy API key in Settings.
 * The client forwards its own auth header; this proxy is only here
 * to work around Tranzy's CORS gate — no keys are held server-side.
 *
 * Mirrors the old netlify.toml `[[redirects]] /api/tranzy/* → …` rule.
 * See functions/api/rt/[feed]/[[endpoint]].js for the reason we can't
 * do this with a `_redirects` line.
 */

export const onRequest = async ({ params, request }) => {
  const suffix = Array.isArray(params.path)
    ? params.path.join('/')
    : (params.path ?? '');
  const upstreamUrl = `https://api.tranzy.ai/${suffix}${new URL(request.url).search}`;

  const upstream = await fetch(upstreamUrl, {
    method: request.method,
    headers: request.headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
  });

  const headers = new Headers(upstream.headers);
  headers.set('cache-control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  return new Response(upstream.body, { status: upstream.status, headers });
};
