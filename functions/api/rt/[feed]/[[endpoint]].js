/*
 * Cloudflare Pages Function — GTFS-RT proxy, feeds.json-driven.
 *
 * Route: /api/rt/<feed>/<endpoint>  →  the URL declared at
 *         feeds.json.feeds[<feed>].realtime.<endpoint>.
 *
 * Why dynamic and not a hardcoded per-feed map:
 *   feeds.json is already the single source of truth for per-feed
 *   metadata (bbox, timezone, realtime URLs, etc.). Duplicating the
 *   realtime URLs into a code table here would be a drift surface —
 *   every new RT-capable feed would need two changes across two
 *   repos. Reading feeds.json here keeps the pipeline in charge:
 *   change the manifest, the proxy follows.
 *
 * Trust boundary: feeds.json is produced only by our own pipeline
 *   (ciotlosm/neary-gtfs) and served from our own R2 bucket. The
 *   scheme check below is defense-in-depth against a hypothetical
 *   supply-chain injection.
 *
 * Auth-required upstreams (e.g. api.opentransportdata.swiss) are
 *   normalized to 404 so the client's RtUnavailableError path fires
 *   cleanly instead of surfacing a persistent "HTTP 401" banner.
 */

const FEEDS_URL = 'https://gtfs.n3ary.com/feeds.json';

// Map client-facing endpoint segment → feeds.json realtime field name.
// New endpoint types get a single-line addition here.
const ENDPOINT_FIELD = {
  vehiclePositions: 'vehicle_positions',
  tripUpdates:      'trip_updates',
  serviceAlerts:    'service_alerts',
};

export const onRequestGet = async ({ params }) => {
  const feedId = params.feed;
  const endpointArr = params.endpoint;
  const endpoint = Array.isArray(endpointArr) ? endpointArr[0] : endpointArr;

  const field = ENDPOINT_FIELD[endpoint];
  if (!field) {
    return new Response(`Unknown endpoint: ${endpoint}`, { status: 404 });
  }

  // Fetch feeds.json. Cloudflare's edge cache honors R2's max-age=300
  // header, so most Function invocations are served from cache; new
  // pipeline publishes propagate within 5 min.
  let feeds;
  try {
    const res = await fetch(FEEDS_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    feeds = await res.json();
  } catch (e) {
    return new Response(`feeds.json unreachable: ${e.message}`, { status: 502 });
  }

  const entry = (feeds.feeds ?? []).find((f) => f.id === feedId);
  if (!entry) {
    return new Response(`Unknown feed: ${feedId}`, { status: 404 });
  }
  const upstream = entry.realtime?.[field];
  if (!upstream) {
    return new Response(`Feed "${feedId}" has no ${endpoint} URL configured`, { status: 404 });
  }
  if (!upstream.startsWith('https://')) {
    return new Response(`Refusing non-https upstream: ${upstream}`, { status: 502 });
  }

  // Proxy. Deliberately don't forward client headers — GTFS-RT
  // endpoints don't need caller-supplied auth and passthrough headers
  // can trip upstream WAFs (host mismatch, cf-* headers, etc.).
  let proxied;
  try {
    proxied = await fetch(upstream, { headers: { 'user-agent': 'neary-pages-proxy/1' } });
  } catch (e) {
    return new Response(`Upstream fetch failed: ${e.message}`, { status: 502 });
  }
  if (proxied.status === 401 || proxied.status === 403) {
    return new Response(`Feed "${feedId}" upstream requires auth we can't forward`, { status: 404 });
  }

  return new Response(proxied.body, {
    status: proxied.status,
    headers: {
      'content-type': proxied.headers.get('content-type') ?? 'application/octet-stream',
      'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    },
  });
};
