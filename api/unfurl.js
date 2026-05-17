'use strict';

// OpenUnfurl v0.1 — anonymous, zero-signup link-unfurl API.
// Single zero-dependency Node serverless function. Static HTML parsing only.

// --- In-memory per-instance best-effort IP rate limiter ---------------------
// NOTE: This is per-instance / best-effort only. Serverless instances are
// ephemeral and not shared, so this is a soft abuse brake, NOT a guarantee.
const RL_WINDOW_SEC = 600;
const RL_MAX = 60;
const rlMap = new Map(); // ip -> number[] (timestamps in ms)

function rateLimit(ip) {
  const now = Date.now();
  const windowMs = RL_WINDOW_SEC * 1000;
  const hits = (rlMap.get(ip) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  rlMap.set(ip, hits);
  if (hits.length > RL_MAX) {
    const oldest = hits[0];
    const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
    return { limited: true, retryAfterSec };
  }
  return { limited: false };
}

// --- SSRF guard -------------------------------------------------------------
function isBlockedHost(hostname) {
  const h = (hostname || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost') return true;
  if (h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '0.0.0.0' || h === '::1') return true;

  // IPv4 literal check
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 0) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}

// --- HTML helpers -----------------------------------------------------------
function decodeEntities(s) {
  if (s == null) return s;
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function firstMatch(re, html) {
  const m = re.exec(html);
  return m ? m[1] : null;
}

// Extract a meta tag's content by matching property|name === key.
function metaContent(html, keys) {
  const wanted = Array.isArray(keys) ? keys : [keys];
  // Match any <meta ...> tag, then inspect attributes order-independently.
  const tagRe = /<meta\b[^>]*>/gi;
  let tag;
  while ((tag = tagRe.exec(html))) {
    const t = tag[0];
    const keyM = /(?:property|name)\s*=\s*["']\s*([^"']+?)\s*["']/i.exec(t);
    if (!keyM) continue;
    const key = keyM[1].toLowerCase();
    if (!wanted.some((w) => w.toLowerCase() === key)) continue;
    const contentM = /content\s*=\s*["']([\s\S]*?)["']/i.exec(t);
    if (contentM) return decodeEntities(contentM[1].trim());
  }
  return null;
}

// Extract a <link> href whose rel matches one of the rel keywords.
function linkHref(html, relKeywords, opts) {
  opts = opts || {};
  const tagRe = /<link\b[^>]*>/gi;
  let tag;
  while ((tag = tagRe.exec(html))) {
    const t = tag[0];
    const relM = /rel\s*=\s*["']([^"']+)["']/i.exec(t);
    if (!relM) continue;
    const rel = relM[1].toLowerCase().trim();
    const matches = relKeywords.some((rk) => rel === rk || rel.split(/\s+/).includes(rk));
    if (!matches) continue;
    if (opts.typeIncludes) {
      const typeM = /type\s*=\s*["']([^"']+)["']/i.exec(t);
      if (!typeM || typeM[1].toLowerCase().indexOf(opts.typeIncludes) === -1) continue;
    }
    const hrefM = /href\s*=\s*["']([^"']+)["']/i.exec(t);
    if (hrefM) return decodeEntities(hrefM[1].trim());
  }
  return null;
}

function resolveUrl(href, base) {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch (e) {
    return href;
  }
}

// --- Handler ----------------------------------------------------------------
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'method not allowed' }));
  }

  const ip = (req.headers['x-forwarded-for'] || 'ip').split(',')[0].trim() || 'ip';

  // Parse query
  let target;
  try {
    if (req.query && req.query.url) {
      target = req.query.url;
    } else {
      const u = new URL(req.url, 'http://x');
      target = u.searchParams.get('url');
    }
  } catch (e) {
    target = null;
  }

  const logHit = (ok, targetHost) => {
    try {
      console.log(
        JSON.stringify({
          evt: 'unfurl_hit',
          target: targetHost || null,
          ip,
          ua: req.headers['user-agent'] || null,
          ok: !!ok,
          ts: Date.now(),
        })
      );
    } catch (e) {
      /* ignore logging errors */
    }
  };

  if (!target) {
    logHit(false, null);
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'missing ?url' }));
  }

  // Rate limit (after we know it's a real request)
  const rl = rateLimit(ip);
  if (rl.limited) {
    logHit(false, null);
    res.statusCode = 429;
    res.setHeader('Retry-After', String(rl.retryAfterSec));
    return res.end(
      JSON.stringify({ error: 'rate limited', retryAfterSec: rl.retryAfterSec })
    );
  }

  // Validate URL + protocol
  let parsed;
  try {
    parsed = new URL(target);
  } catch (e) {
    logHit(false, null);
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'invalid url' }));
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    logHit(false, parsed.hostname || null);
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'blocked host' }));
  }
  if (isBlockedHost(parsed.hostname)) {
    logHit(false, parsed.hostname || null);
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'blocked host' }));
  }

  const targetHost = parsed.hostname;

  // Fetch target with timeout + size cap
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  let resp, html, finalUrl;
  try {
    resp = await fetch(parsed.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; OpenUnfurlBot/0.1; +https://github.com/SolvoHQ/openunfurl)',
        Accept: 'text/html,*/*',
      },
    });
    clearTimeout(timer);
    finalUrl = resp.url || parsed.toString();
    if (!resp.ok) {
      logHit(false, targetHost);
      res.statusCode = 422;
      return res.end(
        JSON.stringify({ error: 'fetch failed', status: resp.status })
      );
    }
    const raw = await resp.text();
    html = raw.length > 1500000 ? raw.slice(0, 1500000) : raw;
  } catch (e) {
    clearTimeout(timer);
    logHit(false, targetHost);
    res.statusCode = 422;
    const msg = e && e.name === 'AbortError' ? 'fetch timeout' : 'fetch failed';
    return res.end(JSON.stringify({ error: msg }));
  }

  // Parse metadata
  const titleTag = decodeEntities(
    (firstMatch(/<title[^>]*>([\s\S]*?)<\/title>/i, html) || '').trim() || null
  );
  const ogTitle = metaContent(html, ['og:title']);
  const twTitle = metaContent(html, ['twitter:title']);
  const ogDesc = metaContent(html, ['og:description']);
  const twDesc = metaContent(html, ['twitter:description']);
  const metaDesc = metaContent(html, ['description']);
  const ogImage = metaContent(html, ['og:image']);
  const twImage = metaContent(html, ['twitter:image']);
  const ogSite = metaContent(html, ['og:site_name']);
  const ogType = metaContent(html, ['og:type']);
  const ogUrl = metaContent(html, ['og:url']);
  metaContent(html, ['twitter:card']);

  const iconHref =
    linkHref(html, ['icon', 'shortcut icon']) ||
    linkHref(html, ['apple-touch-icon']);
  const oembedHref = linkHref(html, ['alternate'], { typeIncludes: 'oembed' });

  const title = ogTitle || twTitle || titleTag || null;
  const description = ogDesc || twDesc || metaDesc || null;
  const imageRaw = ogImage || twImage || null;
  const image = imageRaw ? resolveUrl(imageRaw, finalUrl) : null;
  const favicon = iconHref ? resolveUrl(iconHref, finalUrl) : null;
  const oembed = oembedHref ? resolveUrl(oembedHref, finalUrl) : null;

  logHit(true, targetHost);
  res.statusCode = 200;
  return res.end(
    JSON.stringify({
      url: target,
      resolvedUrl: ogUrl ? resolveUrl(ogUrl, finalUrl) : finalUrl,
      title,
      description,
      image,
      siteName: ogSite || null,
      type: ogType || null,
      favicon,
      oembed,
      fetchedAt: new Date().toISOString(),
      engine: 'static-html-v0.1',
      note: 'v0.1 parses static HTML only — no JS/SPA render',
    })
  );
};
