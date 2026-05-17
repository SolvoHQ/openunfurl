# OpenUnfurl

**A zero-signup link-unfurl / link-preview API. No account, no API key — one GET request.**

Give it any public URL, get back clean preview metadata (title, description,
image, siteName, favicon, Open Graph / Twitter Card, oembed) as JSON. Built so
autonomous AI agents can use it as a tool — an agent has no human to do a signup.

Live: **https://openunfurl.vercel.app**

## Quick start

```sh
curl "https://openunfurl.vercel.app/api/unfurl?url=https://github.com"
```

Sample response:

```json
{
  "url": "https://github.com",
  "resolvedUrl": "https://github.com/",
  "title": "GitHub · Build and ship software on a single, collaborative platform",
  "description": "Join the world's most widely adopted, AI-powered developer platform where millions of developers, businesses, and the largest open source community build software that advances humanity.",
  "image": "https://github.githubassets.com/assets/campaign-social-031d6161fa10.png",
  "siteName": "GitHub",
  "type": "object",
  "favicon": "https://github.githubassets.com/favicons/favicon.svg",
  "oembed": null,
  "fetchedAt": "2026-05-17T00:00:00.000Z",
  "engine": "static-html-v0.1",
  "note": "v0.1 parses static HTML only — no JS/SPA render"
}
```

Any missing field is `null`. Errors return JSON with an `error` key and an
appropriate HTTP status (`400` bad/blocked/missing URL, `422` fetch failed,
`429` rate limited, `405` wrong method).

## JavaScript

```js
const base = "https://openunfurl.vercel.app";
const r = await fetch(
  base + "/api/unfurl?url=" + encodeURIComponent("https://example.com")
);
const meta = await r.json(); // { title, description, image, favicon, ... }
```

## Use as an MCP tool (AI agents / Claude / Cursor / LLM clients)

OpenUnfurl is also a remote [MCP](https://modelcontextprotocol.io) server, so an
agent can call it as a tool with **no signup, no API key, no OAuth**.

- Endpoint: **`https://openunfurl.vercel.app/api/mcp`**
- Transport: **Streamable HTTP, stateless** (POST JSON-RPC 2.0, single
  `application/json` response — no sessions, no SSE)
- Exposes exactly one tool: **`unfurl`** — input `{ "url": "https://example.com" }`,
  returns the same preview JSON as the REST endpoint (also as `structuredContent`)

Drop this into any MCP client config (Claude Desktop, Cursor, or any client that
speaks the Streamable HTTP transport):

```json
{ "mcpServers": { "openunfurl": { "url": "https://openunfurl.vercel.app/api/mcp" } } }
```

Quick smoke test:

```sh
curl -s -X POST https://openunfurl.vercel.app/api/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"unfurl","arguments":{"url":"https://example.com"}}}'
```

Over MCP, an upstream error comes back as a tool result with `isError: true`.

## Why

Managed link-preview alternatives — Microlink, OpenGraph.io, LinkPreview.net,
Unfurl.io, LinkPeek — all gate even their free tier behind a signup and/or an
API key. OpenUnfurl does not: it's a single anonymous GET (or one MCP
`tools/call`). That's especially useful to autonomous agents, which have no
human in the loop to complete a signup or paste in a key.

## Limitations

- **v0.1 parses static HTML only** — no headless browser, no JS-rendered SPAs.
  If a site renders its `<meta>` tags client-side you get the static fallback.
- **Best-effort per-instance IP rate limit** — a soft abuse brake, not a
  guarantee (serverless instances are ephemeral and not shared).
- **SSRF-guarded** — rejects localhost / private / reserved IP ranges.
- **MIT licensed and self-hostable** — see below.

## Self-host — it's zero-dependency files

The entire API is two single zero-dependency Node serverless functions:
[`api/unfurl.js`](api/unfurl.js) (REST) and [`api/mcp.js`](api/mcp.js) (remote
MCP). No `npm install`, no `cheerio`/`jsdom`. Deploy the folder to Vercel
(zero-config `/api` detection) or drop the handlers into any Node serverless
runtime.

```sh
git clone https://github.com/SolvoHQ/openunfurl
cd openunfurl
npx vercel --prod
```

## License

MIT — see [LICENSE](LICENSE).
