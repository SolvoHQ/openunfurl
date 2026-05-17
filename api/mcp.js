'use strict';

// OpenUnfurl MCP server — remote, anonymous, zero-signup.
// Single zero-dependency Node serverless function. Implements the MCP
// Streamable HTTP transport in STATELESS JSON mode: every POST gets a single
// application/json JSON-RPC 2.0 response. No sessions, no SSE streaming.
//
// Lets autonomous AI agents call OpenUnfurl as a tool with no account/key —
// an agent has no human to do a signup.

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const UPSTREAM = 'https://openunfurl.vercel.app/api/unfurl?url=';

const SERVER_INFO = { name: 'openunfurl', version: '0.1.0' };

const UNFURL_TOOL = {
  name: 'unfurl',
  description:
    'Return clean link-preview metadata as JSON for any public URL — title, ' +
    'description, image, siteName, type, favicon, oembed and Open Graph / ' +
    'Twitter Card data. No signup, no API key, no rate-limit email: a single ' +
    'anonymous call. Built for autonomous agents that have no human to do a ' +
    'signup. v0.1 parses static HTML only (no JS/SPA render).',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description:
          'The public http(s) URL to unfurl, e.g. "https://example.com".',
      },
    },
    required: ['url'],
    additionalProperties: false,
  },
  annotations: {
    title: 'Unfurl a URL',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

// --- helpers ---------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve) => {
    // Vercel may have already parsed/buffered the body.
    if (req.body !== undefined && req.body !== null) {
      if (typeof req.body === 'string') {
        try {
          resolve(req.body.length ? JSON.parse(req.body) : undefined);
        } catch (e) {
          resolve({ __parseError: true });
        }
        return;
      }
      if (Buffer.isBuffer(req.body)) {
        const s = req.body.toString('utf8');
        try {
          resolve(s.length ? JSON.parse(s) : undefined);
        } catch (e) {
          resolve({ __parseError: true });
        }
        return;
      }
      if (typeof req.body === 'object') {
        resolve(req.body);
        return;
      }
    }
    // Otherwise read the raw stream.
    let data = '';
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      resolve(val);
    };
    try {
      req.on('data', (chunk) => {
        data += chunk;
      });
      req.on('end', () => {
        if (!data.length) return finish(undefined);
        try {
          finish(JSON.parse(data));
        } catch (e) {
          finish({ __parseError: true });
        }
      });
      req.on('error', () => finish({ __parseError: true }));
    } catch (e) {
      finish({ __parseError: true });
    }
  });
}

function jsonRpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: err };
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

// --- handler ---------------------------------------------------------------
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, MCP-Protocol-Version, Accept'
  );
  res.setHeader('MCP-Protocol-Version', DEFAULT_PROTOCOL_VERSION);

  const ip = (req.headers['x-forwarded-for'] || 'ip').split(',')[0].trim() || 'ip';
  const ua = req.headers['user-agent'] || null;

  const logHit = (method) => {
    try {
      console.log(
        JSON.stringify({ evt: 'mcp_hit', method: method || null, ip, ua, ts: Date.now() })
      );
    } catch (e) {
      /* ignore logging errors */
    }
  };

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method === 'GET') {
    logHit('GET');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(
      JSON.stringify({
        server: SERVER_INFO,
        transport: 'streamable-http (stateless JSON mode)',
        endpoint: 'https://openunfurl.vercel.app/api/mcp',
        description:
          'Remote MCP server for OpenUnfurl. POST JSON-RPC 2.0 here. ' +
          'No signup, no API key. One tool: "unfurl".',
        protocolVersion: DEFAULT_PROTOCOL_VERSION,
        howToAdd: {
          mcpServers: {
            openunfurl: {
              type: 'http',
              url: 'https://openunfurl.vercel.app/api/mcp',
            },
          },
        },
      })
    );
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    return res.end(
      JSON.stringify(jsonRpcError(null, -32600, 'method not allowed; use POST'))
    );
  }

  res.setHeader('Content-Type', 'application/json');

  const body = await readBody(req);

  // Parse error
  if (body && body.__parseError) {
    logHit('parse_error');
    res.statusCode = 200;
    return res.end(
      JSON.stringify(jsonRpcError(null, -32700, 'Parse error: invalid JSON'))
    );
  }

  // Validate JSON-RPC envelope
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    logHit('invalid_request');
    res.statusCode = 200;
    return res.end(
      JSON.stringify(
        jsonRpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object')
      )
    );
  }

  const { id, method, params } = body;
  logHit(method);

  if (typeof method !== 'string' || body.jsonrpc !== '2.0') {
    res.statusCode = 200;
    return res.end(
      JSON.stringify(
        jsonRpcError(
          id,
          -32600,
          'Invalid Request: missing jsonrpc:"2.0" or method'
        )
      )
    );
  }

  const isNotification = id === undefined || id === null;

  // notifications/initialized (and any other notification) → 202, no body.
  if (method === 'notifications/initialized' || (isNotification && method.indexOf('notifications/') === 0)) {
    res.statusCode = 202;
    return res.end();
  }

  // initialize
  if (method === 'initialize') {
    const reqProto =
      params && typeof params.protocolVersion === 'string'
        ? params.protocolVersion
        : DEFAULT_PROTOCOL_VERSION;
    res.statusCode = 200;
    return res.end(
      JSON.stringify(
        jsonRpcResult(id, {
          protocolVersion: reqProto,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        })
      )
    );
  }

  // tools/list
  if (method === 'tools/list') {
    res.statusCode = 200;
    return res.end(JSON.stringify(jsonRpcResult(id, { tools: [UNFURL_TOOL] })));
  }

  // tools/call
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};

    if (name !== 'unfurl') {
      res.statusCode = 200;
      return res.end(
        JSON.stringify(
          jsonRpcResult(id, {
            content: [
              {
                type: 'text',
                text:
                  'Unknown tool "' +
                  String(name) +
                  '". This server exposes exactly one tool: "unfurl". ' +
                  'Call tools/list to see its schema.',
              },
            ],
            isError: true,
          })
        )
      );
    }

    const url = args && args.url;
    if (typeof url !== 'string' || !url.trim()) {
      res.statusCode = 200;
      return res.end(
        JSON.stringify(
          jsonRpcResult(id, {
            content: [
              {
                type: 'text',
                text:
                  'Missing required argument "url" (a public http(s) URL ' +
                  'string), e.g. {"url":"https://example.com"}.',
              },
            ],
            isError: true,
          })
        )
      );
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 9000);
      let upstream;
      try {
        upstream = await fetch(UPSTREAM + encodeURIComponent(url), {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
      } finally {
        clearTimeout(timer);
      }
      const text = await upstream.text();
      let result;
      try {
        result = JSON.parse(text);
      } catch (e) {
        result = { error: 'upstream returned non-JSON', raw: text.slice(0, 500) };
      }
      const isError =
        !upstream.ok ||
        (result && typeof result === 'object' && result.error != null);

      res.statusCode = 200;
      return res.end(
        JSON.stringify(
          jsonRpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: result,
            isError: !!isError,
          })
        )
      );
    } catch (e) {
      const msg =
        e && e.name === 'AbortError'
          ? 'unfurl upstream timed out'
          : 'unfurl upstream request failed';
      res.statusCode = 200;
      return res.end(
        JSON.stringify(
          jsonRpcResult(id, {
            content: [{ type: 'text', text: msg }],
            isError: true,
          })
        )
      );
    }
  }

  // Unknown method
  res.statusCode = 200;
  return res.end(
    JSON.stringify(
      jsonRpcError(id, -32601, 'Method not found: ' + String(method))
    )
  );
};
