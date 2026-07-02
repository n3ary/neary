/*
 * Cloudflare Pages Function — GTFS-RT proxy per feed.
 *
 * Route: /api/rt/<feed>/<endpoint>  → https://<per-feed-host>/<endpoint>
 *
 * Why a Function and not a static _redirects rule?
 *   Pages' `_redirects` file only proxies **within the same site**;
 *   cross-origin proxying (which is what we need for the GTFS-RT
 *   upstreams) is not supported there. A Function does the fetch
 *   server-side, then streams the response back on the same origin,
 *   sidestepping the browser CORS wall that the upstreams don't
 *   solve on their own.
 *
 * Adding a new feed with GTFS-RT support:
 *   drop a line into UPSTREAMS below. The feed also needs
 *   `realtime.vehicle_positions` set in the neary-gtfs feeds.json
 *   so the app dispatches to /api/rt/<feed>/... in the first place.
 */

const UPSTREAMS = {
  'cluj-napoca':     'https://cluj-rt-feed.gtfs.ro',
  'bucuresti-ilfov': 'https://gtfs.tpbi.ro/api/gtfs-rt',
};

export const onRequestGet = async ({ params, request }) => {
  const feed = params.feed;
  const endpoint = Array.isArray(params.endpoint)
    ? params.endpoint.join('/')
    : params.endpoint;

  const base = UPSTREAMS[feed];
  if (!base) {
    return new Response(`Unknown feed: ${feed}`, { status: 404 });
  }

  const upstreamUrl = `${base}/${endpoint}${new URL(request.url).search}`;
  const upstream = await fetch(upstreamUrl, {
    method: 'GET',
    headers: { 'user-agent': 'neary-pages-proxy/1' },
  });

  // Passthrough status + body; enforce no-cache since RT feeds are live.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    },
  });
};
