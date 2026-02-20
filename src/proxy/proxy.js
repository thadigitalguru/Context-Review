const http = require('http');
const https = require('https');
const { URL } = require('url');

const PROVIDER_MAP = {
  anthropic: {
    name: 'anthropic',
    target: 'https://api.anthropic.com',
    pathMatch: /^\/v1\/messages/,
  },
  openai: {
    name: 'openai',
    target: 'https://api.openai.com',
    pathMatch: /^\/v1\/chat\/completions/,
  },
  google: {
    name: 'google',
    target: 'https://generativelanguage.googleapis.com',
    pathMatch: /^\/v1beta\/models/,
  },
};

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

function createProxyServer(onCapture) {
  const server = http.createServer((req, res) => {
    const provider = detectProvider(req.url);

    if (!provider) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown API path. Supported: Anthropic (/v1/messages), OpenAI (/v1/chat/completions), Google (/v1beta/models/*)' }));
      return;
    }

    let bodyChunks = [];
    req.on('data', chunk => bodyChunks.push(chunk));
    req.on('end', () => {
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
          headers: { ...req.headers },
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
        captureData.response.headers = { ...proxyRes.headers };

        if (isStreaming) {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          const streamChunks = [];

          proxyRes.on('data', (chunk) => {
            res.write(chunk);
            streamChunks.push(chunk.toString());
          });

          proxyRes.on('end', () => {
            res.end();
            captureData.response.body = parseStreamedResponse(streamChunks, provider.name);
            captureData.response.rawStream = streamChunks.join('');
            onCapture(captureData);
          });
        } else {
          const responseChunks = [];
          proxyRes.on('data', chunk => responseChunks.push(chunk));
          proxyRes.on('end', () => {
            const responseBody = Buffer.concat(responseChunks);
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            res.end(responseBody);

            try {
              captureData.response.body = JSON.parse(responseBody.toString());
            } catch (e) {
              captureData.response.body = responseBody.toString();
            }
            onCapture(captureData);
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
    }
    if (event.type === 'content_block_stop') {
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

  for (const event of events) {
    if (event.model) result.model = event.model;
    if (event.choices && event.choices[0] && event.choices[0].delta) {
      const delta = event.choices[0].delta;
      if (delta.content) result.choices[0].message.content += delta.content;
    }
    if (event.usage) result.usage = event.usage;
  }
  return result;
}

module.exports = { createProxyServer, detectProvider };
