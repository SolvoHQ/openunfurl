# OpenUnfurl

**Anonymous link-preview / unfurl API. No signup. No API key. One GET request.**

Give it a URL, get back the page's title, description, image, favicon, and Open
Graph / Twitter Card metadata as JSON. No account, no token, no rate-limit
email — just a single GET.

Live: **https://openunfurl.vercel.app**

## curl

```sh
curl "https://openunfurl.vercel.app/api/unfurl?url=https://github.com/SolvoHQ"
```

## JavaScript

```js
const base = "https://openunfurl.vercel.app";
const r = await fetch(
  base + "/api/unfurl?url=" + encodeURIComponent("https://example.com")
);
const meta = await r.json(); // { title, description, image, favicon, ... }
```

## Response shape

```json
{
  "url": "https://github.com/SolvoHQ",
  "resolvedUrl": "https://github.com/SolvoHQ",
  "title": "SolvoHQ",
  "description": "SolvoHQ has 37 repositories available. Follow their code on GitHub.",
  "image": "https://avatars.githubusercontent.com/u/269872106?s=280&v=4",
  "siteName": "GitHub",
  "type": "profile",
  "favicon": "https://github.githubassets.com/favicons/favicon.png",
  "oembed": null,
  "fetchedAt": "2026-05-17T01:02:35.484Z",
  "engine": "static-html-v0.1",
  "note": "v0.1 parses static HTML only — no JS/SPA render"
}
```

Any missing field is `null`. Errors return JSON with an `error` key and an
appropriate HTTP status (`400` bad/blocked/missing URL, `422` fetch failed,
`429` rate limited, `405` wrong method).

## Limitations (v0.1)

**v0.1 parses static HTML only** — no headless browser, no JS-rendered SPAs.
If a site renders its `<meta>` tags client-side, you'll get the static
fallback only. A headless-render tier is future work.

It also applies an SSRF guard (rejects localhost / private / reserved IP
ranges) and a best-effort per-instance IP rate limit.

## Self-host — it's one zero-dependency file

The entire API is a single zero-dependency Node serverless function:
[`api/unfurl.js`](api/unfurl.js). No `npm install`, no `cheerio`/`jsdom`.
Deploy the folder to Vercel (zero-config `/api` detection) or drop the handler
into any Node serverless runtime.

```sh
git clone https://github.com/SolvoHQ/openunfurl
cd openunfurl
npx vercel --prod
```

## License

MIT — see [LICENSE](LICENSE).
