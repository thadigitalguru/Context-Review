const http = require('http');
const https = require('https');
const { URL } = require('url');
const { redactHeaders } = require('./redact');

const PROVIDER_MAP = {
  anthropic: {
    name: 'anthropic',
    target: 'https://api.anthropic.com',
    pathMatch: /^\/v1\/messages/,
  },
  openai: {
    name: 'openai',
    target: 'https://api.openai.com',
    pathMatch: /^\/v1\/(chat\/completions|responses)/,
  },
  google: {
    name: 'google',
    target: 'https://generativelanguage.googleapis.com',
    pathMatch: /^\/v1beta\/models/,
  },
};

const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_STREAM_CHARS = 8 * 1024 * 1024;

function resolveProxyLimits(env = process.env) {
  const maxBodyBytes = toPositiveInt(env.CONTEXT_REVIEW_PROXY_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES);
  const maxStreamChars = toPositiveInt(env.CONTEXT_REVIEW_PROXY_MAX_STREAM_CHARS, DEFAULT_MAX_STREAM_CHARS);
  return { maxBodyBytes, maxStreamChars };
}

function toPositiveInt(raw, fallback) {
  const value = Number(raw);
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  return fallback;
}

function detectProvider(reqPath) {
  for (const key of Object.keys(PROVIDER_MAP)) {
    if (PROVIDER_MAP[key].pathMatch.test(reqPath)) {
      return PROVIDER_MAP[key];
    }
  }
  return null;
}

function isStreamingRequest(headers, body, reqUrl) {
  if (body && typeof body === 'object') {
    if (body.stream === true) return true;
  }
  if (reqUrl && (reqUrl.includes(':streamGenerateContent') || reqUrl.includes('alt=sse'))) {
    return true;
  }
  return false;
}

function createProxyServer(onCapture, options = {}) {
  const limits = { ...resolveProxyLimits(), ...(options.limits || {}) };
  const server = http.createServer((req, res) => {
    const provider = detectProvider(req.url);

    if (!provider) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown API path. Supported: Anthropic (/v1/messages), OpenAI (/v1/chat/completions, /v1/responses), Google (/v1beta/models/*)' }));
      return;
    }

    req.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad request', message: 'Inbound request error' }));
      } else {
        try { res.end(); } catch { /* socket already gone */ }
      }
    });

    let bodyChunks = [];
    let bodyBytes = 0;
    let bodyTooLarge = false;
    req.on('data', chunk => {
      bodyBytes += chunk.length;
      if (bodyBytes > limits.maxBodyBytes) {
        bodyTooLarge = true;
        return;
      }
      bodyChunks.push(chunk);
    });
    req.on('end', () => {
      if (bodyTooLarge) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload Too Large', message: `Request body exceeds ${limits.maxBodyBytes} bytes` }));
        return;
      }
      const rawBody = Buffer.concat(bodyChunks);
      let parsedBody = null;
      try {
        parsedBody = JSON.parse(rawBody.toString());
      } catch (e) {
        parsedBody = null;
      }

      const targetUrl = new URL(req.url, provider.target);
      const isStreaming = isStreamingRequest(req.headers, parsedBody, req.url);

      const proxyHeaders = { ...req.headers };
      delete proxyHeaders['host'];
      proxyHeaders['host'] = targetUrl.hostname;

      const options = {
        hostname: targetUrl.hostname,
        port: 443,
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers: proxyHeaders,
      };

      const captureData = {
        provider: provider.name,
        timestamp: Date.now(),
        request: {
          method: req.method,
          path: req.url,
          headers: redactHeaders({ ...req.headers }),
          body: parsedBody,
        },
        response: {
          statusCode: null,
          headers: {},
          body: null,
        },
        isStreaming,
      };

      const proxyReq = https.request(options);
      proxyReq.setTimeout(120000, () => {
        proxyReq.destroy(new Error('Upstream timeout after 120s'));
      });

      proxyReq.on('response', (proxyRes) => {
        captureData.response.statusCode = proxyRes.statusCode;
        captureData.response.headers = redactHeaders({ ...proxyRes.headers });

        if (isStreaming) {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          const streamChunks = [];
          let streamChars = 0;
          let streamTruncated = false;

          proxyRes.on('data', (chunk) => {
            try { res.write(chunk); } catch { /* client gone */ }
            const text = chunk.toString();
            if (!streamTruncated) {
              if (streamChars + text.length > limits.maxStreamChars) {
                streamTruncated = true;
              } else {
                streamChars += text.length;
                streamChunks.push(text);
              }
            }
          });

          proxyRes.on('error', () => {
            try { res.end(); } catch { /* client gone */ }
            captureData.response.body = parseStreamedResponse(streamChunks, provider.name);
            captureData.upstreamError = true;
            if (streamTruncated) captureData.truncated = true;
            safeCapture(onCapture, captureData);
          });

          proxyRes.on('end', () => {
            try { res.end(); } catch { /* client gone */ }
            captureData.response.body = parseStreamedResponse(streamChunks, provider.name);
            captureData.response.rawStream = streamChunks.join('');
            if (streamTruncated) captureData.truncated = true;
            safeCapture(onCapture, captureData);
          });
        } else {
          const responseChunks = [];
          let responseBytes = 0;
          proxyRes.on('data', chunk => {
            responseBytes += chunk.length;
            responseChunks.push(chunk);
          });
          proxyRes.on('error', () => {
            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Proxy error', message: 'Upstream response error' }));
            } else {
              try { res.end(); } catch { /* client gone */ }
            }
          });
          proxyRes.on('end', () => {
            const responseBody = Buffer.concat(responseChunks);
            if (!res.headersSent) {
              res.writeHead(proxyRes.statusCode, proxyRes.headers);
            }
            // Always forward the complete upstream body for fidelity; truncate
            // only the captured copy when it exceeds the capture budget.
            try { res.end(responseBody); } catch { /* client gone */ }

            if (responseBytes > limits.maxBodyBytes) {
              captureData.truncated = true;
              const preview = responseBody.slice(0, limits.maxBodyBytes).toString();
              try {
                captureData.response.body = JSON.parse(preview);
              } catch (e) {
                captureData.response.body = preview;
              }
            } else {
              try {
                captureData.response.body = JSON.parse(responseBody.toString());
              } catch (e) {
                captureData.response.body = responseBody.toString();
              }
            }
            safeCapture(onCapture, captureData);
          });
        }
      });

      proxyReq.on('error', (err) => {
        console.error(`Proxy error: ${err.message}`);
        if (!res.headersSent) {
          const status = err.message.includes('timeout') ? 504 : 502;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: status === 504 ? 'Gateway Timeout' : 'Proxy error', message: err.message }));
        }
      });

      if (rawBody.length > 0) {
        proxyReq.write(rawBody);
      }
      proxyReq.end();
    });
  });

  return server;
}

function safeCapture(onCapture, captureData) {
  try {
    onCapture(captureData);
  } catch (err) {
    console.error(`Capture handler error: ${err && err.message ? err.message : err}`);
  }
}

function parseStreamedResponse(chunks, provider) {
  const combined = chunks.join('');
  const events = [];

  if (provider === 'anthropic') {
    const lines = combined.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));
          events.push(data);
        } catch (e) {}
      }
    }
    return reconstructAnthropicStream(events);
  } else if (provider === 'openai') {
    const lines = combined.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ') && line.trim() !== 'data: [DONE]') {
        try {
          const data = JSON.parse(line.slice(6));
          events.push(data);
        } catch (e) {}
      }
    }
    return reconstructOpenAIStream(events);
  }

  if (provider === 'google') {
    const lines = combined.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));
          events.push(data);
        } catch (e) {}
      }
    }
    if (events.length === 0 && combined.trim().length > 0) {
      // Non-SSE JSON payload (e.g. unary GenerateContent over a stream URL).
      try {
        const payload = JSON.parse(combined.trim());
        if (payload && (payload.candidates || payload.usageMetadata)) return payload;
      } catch (e) {}
    }
    if (events.length > 0) {
      const result = { candidates: [], usageMetadata: {} };
      let text = '';
      for (const event of events) {
        if (event.candidates) {
          for (const c of event.candidates) {
            if (c.content && c.content.parts) {
              for (const p of c.content.parts) {
                if (p.text) text += p.text;
              }
            }
          }
        }
        if (event.usageMetadata) result.usageMetadata = event.usageMetadata;
      }
      result.candidates = [{ content: { parts: [{ text }] } }];
      return result;
    }
  }

  return { raw: combined };
}

function reconstructAnthropicStream(events) {
  const result = { type: 'message', content: [], model: '', usage: {} };
  let currentBlock = null;

  for (const event of events) {
    if (event.type === 'message_start' && event.message) {
      result.model = event.message.model || '';
      result.usage = event.message.usage || {};
    }
    if (event.type === 'content_block_start' && event.content_block) {
      currentBlock = { ...event.content_block, text: event.content_block.text || '' };
    }
    if (event.type === 'content_block_delta' && event.delta) {
      if (currentBlock && event.delta.text) {
        currentBlock.text += event.delta.text;
      }
      if (currentBlock && event.delta.thinking) {
        currentBlock.thinking = (currentBlock.thinking || '') + event.delta.thinking;
      }
      if (currentBlock && event.delta.partial_json) {
        currentBlock.input = (currentBlock.input || '') + event.delta.partial_json;
      }
    }
    if (event.type === 'content_block_stop') {
      if (currentBlock && currentBlock.type === 'tool_use' && typeof currentBlock.input === 'string') {
        try {
          currentBlock.input = JSON.parse(currentBlock.input);
        } catch {
          // Preserve raw partial payload when JSON assembly is incomplete.
        }
      }
      if (currentBlock) result.content.push(currentBlock);
      currentBlock = null;
    }
    if (event.type === 'message_delta' && event.usage) {
      result.usage = { ...result.usage, ...event.usage };
    }
  }
  return result;
}

function reconstructOpenAIStream(events) {
  const result = { choices: [{ message: { role: 'assistant', content: '' } }], model: '', usage: {} };
  const toolCalls = new Map();

  for (const event of events) {
    if (event.model) result.model = event.model;
    if (typeof event.delta === 'string' && event.delta) {
      // OpenAI Responses API: response.output_text.delta events carry { delta, ... }.
      result.choices[0].message.content += event.delta;
    }
    if (event.response && typeof event.response === 'object') {
      if (typeof event.response.output_text === 'string' && event.response.output_text) {
        result.choices[0].message.content += event.response.output_text;
      }
      if (Array.isArray(event.response.output)) {
        for (const item of event.response.output) {
          if (item && Array.isArray(item.content)) {
            for (const part of item.content) {
              if (part && (part.text || part.output_text)) {
                result.choices[0].message.content += part.text || part.output_text;
              }
            }
          }
        }
      }
    }
    if (event.choices && event.choices[0] && event.choices[0].delta) {
      const delta = event.choices[0].delta;
      if (delta.content) result.choices[0].message.content += delta.content;
      if (Array.isArray(delta.tool_calls)) {
        for (const toolDelta of delta.tool_calls) {
          const index = Number.isFinite(toolDelta.index) ? toolDelta.index : 0;
          const existing = toolCalls.get(index) || {
            id: toolDelta.id || '',
            type: toolDelta.type || 'function',
            function: { name: '', arguments: '' },
          };
          if (toolDelta.id) existing.id = toolDelta.id;
          if (toolDelta.type) existing.type = toolDelta.type;
          if (toolDelta.function) {
            if (toolDelta.function.name) existing.function.name = toolDelta.function.name;
            if (toolDelta.function.arguments) {
              existing.function.arguments += toolDelta.function.arguments;
            }
          }
          toolCalls.set(index, existing);
        }
      }
    }
    if (event.usage) result.usage = event.usage;
  }

  if (toolCalls.size > 0) {
    result.choices[0].message.tool_calls = [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, value]) => value);
  }
  return result;
}

module.exports = {
  createProxyServer,
  detectProvider,
  parseStreamedResponse,
  reconstructAnthropicStream,
  reconstructOpenAIStream,
  isStreamingRequest,
  resolveProxyLimits,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_STREAM_CHARS,
};
