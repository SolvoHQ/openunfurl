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
    'Fetch clean link-preview metadata (title, description, image, siteName, ' +
    'favicon, oembed) for any public URL. No signup, no API key. Static-HTML ' +
    'parse only (no JS/SPA render).',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The http(s) URL to unfurl',
      },
    },
    required: ['url'],
  },
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
    destructiveHint: false,
    idempotentHint: true,
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

function toolResult(text, structuredContent, isError) {
  const r = { content: [{ type: 'text', text }], isError: !!isError };
  if (structuredContent !== undefined) r.structuredContent = structuredContent;
  return r;
}

async function callUnfurl(url) {
  try {
    const r = await fetch(UPSTREAM + encodeURIComponent(url), {
      headers: { Accept: 'application/json' },
    });
    let j;
    try {
      j = await r.json();
    } catch (e) {
      const txt = '{"error":"upstream returned non-JSON"}';
      j = JSON.parse(txt);
    }
    const isError =
      !r.ok || (j && typeof j === 'object' && j.error != null);
    return toolResult(JSON.stringify(j, null, 2), j, isError);
  } catch (e) {
    return toolResult(
      'unfurl upstream request failed: ' + (e && e.message ? e.message : 'error'),
      undefined,
      true
    );
  }
}

// Process a single JSON-RPC message. Returns:
//  - a JSON-RPC response object (for requests), or
//  - null (for notifications — no response).
async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return jsonRpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object');
  }

  const { id, method } = msg;
  const params = msg.params;
  const isNotification = id === undefined || id === null;

  if (typeof method !== 'string') {
    if (isNotification) return null;
    return jsonRpcError(id, -32600, 'Invalid Request: missing method');
  }

  // Any notifications/* message → no response (handled as HTTP 202 by caller).
  if (method.indexOf('notifications/') === 0) {
    return null;
  }

  if (method === 'initialize') {
    const reqProto =
      params && typeof params.protocolVersion === 'string'
        ? params.protocolVersion
        : DEFAULT_PROTOCOL_VERSION;
    return jsonRpcResult(id, {
      protocolVersion: reqProto,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }

  if (method === 'ping') {
    return jsonRpcResult(id, {});
  }

  if (method === 'tools/list') {
    return jsonRpcResult(id, { tools: [UNFURL_TOOL] });
  }

  if (method === 'tools/call') {
    if (!params || typeof params !== 'object') {
      return jsonRpcError(id, -32602, 'Invalid params: expected an object');
    }
    const name = params.name;
    const args = params.arguments || {};

    if (name !== 'unfurl') {
      return jsonRpcResult(
        id,
        toolResult(
          'Unknown tool "' +
            String(name) +
            '". This server exposes exactly one tool: "unfurl". ' +
            'Call tools/list to see its schema.',
          undefined,
          true
        )
      );
    }

    const url = args && args.url;
    if (typeof url !== 'string' || !url.trim()) {
      return jsonRpcResult(
        id,
        toolResult(
          'Missing required argument "url" (a non-empty http(s) URL string), ' +
            'e.g. {"url":"https://example.com"}.',
          undefined,
          true
        )
      );
    }

    const result = await callUnfurl(url);
    return jsonRpcResult(id, result);
  }

  // Unknown method
  if (isNotification) return null;
  return jsonRpcError(id, -32601, 'Method not found: ' + String(method));
}

// --- handler ---------------------------------------------------------------
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, MCP-Protocol-Version, Mcp-Session-Id'
  );

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0];
  const ua = req.headers['user-agent'] || null;

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET') {
    console.log(
      JSON.stringify({ evt: 'mcp_hit', method: 'GET', ip, ua, ts: Date.now() })
    );
    res.statusCode = 405;
    return res.end(
      JSON.stringify({
        error: 'Use POST for MCP JSON-RPC',
        endpoint: 'https://openunfurl.vercel.app/api/mcp',
      })
    );
  }

  if (req.method !== 'POST') {
    console.log(
      JSON.stringify({
        evt: 'mcp_hit',
        method: req.method || null,
        ip,
        ua,
        ts: Date.now(),
      })
    );
    res.statusCode = 405;
    return res.end(
      JSON.stringify({
        error: 'Use POST for MCP JSON-RPC',
        endpoint: 'https://openunfurl.vercel.app/api/mcp',
      })
    );
  }

  const body = await readBody(req);

  // Parse error → -32700
  if (body && body.__parseError) {
    console.log(
      JSON.stringify({
        evt: 'mcp_hit',
        method: 'parse_error',
        ip,
        ua,
        ts: Date.now(),
      })
    );
    res.statusCode = 200;
    return res.end(
      JSON.stringify(jsonRpcError(null, -32700, 'Parse error: invalid JSON'))
    );
  }

  // --- Batch (array of messages) -------------------------------------------
  if (Array.isArray(body)) {
    console.log(
      JSON.stringify({
        evt: 'mcp_hit',
        method: 'batch',
        ip,
        ua,
        ts: Date.now(),
      })
    );
    if (body.length === 0) {
      res.statusCode = 200;
      return res.end(
        JSON.stringify(jsonRpcError(null, -32600, 'Invalid Request: empty batch'))
      );
    }
    const responses = [];
    for (let i = 0; i < body.length; i++) {
      // eslint-disable-next-line no-await-in-loop
      const r = await handleMessage(body[i]);
      if (r !== null) responses.push(r);
    }
    if (responses.length === 0) {
      // All notifications → no response bodies.
      res.statusCode = 202;
      return res.end();
    }
    res.statusCode = 200;
    return res.end(JSON.stringify(responses));
  }

  // --- Single message (common case) ----------------------------------------
  if (!body || typeof body !== 'object') {
    console.log(
      JSON.stringify({
        evt: 'mcp_hit',
        method: 'invalid_request',
        ip,
        ua,
        ts: Date.now(),
      })
    );
    res.statusCode = 200;
    return res.end(
      JSON.stringify(
        jsonRpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object')
      )
    );
  }

  const method = typeof body.method === 'string' ? body.method : null;
  console.log(
    JSON.stringify({ evt: 'mcp_hit', method, ip, ua, ts: Date.now() })
  );

  const response = await handleMessage(body);

  // Notification → HTTP 202, no JSON-RPC body.
  if (response === null) {
    res.statusCode = 202;
    return res.end();
  }

  res.statusCode = 200;
  return res.end(JSON.stringify(response));
};
