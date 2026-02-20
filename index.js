const express = require('express');
const path = require('path');
const { createProxyServer } = require('./src/proxy/proxy');
const { parseRequest } = require('./src/parser/parser');
const { SessionStorage } = require('./src/storage/storage');
const { createAPIRouter } = require('./src/api/routes');

const storage = new SessionStorage();

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', createAPIRouter(storage));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const DASHBOARD_PORT = 5000;
app.listen(DASHBOARD_PORT, '0.0.0.0', () => {
  console.log(`Dashboard running on http://0.0.0.0:${DASHBOARD_PORT}`);
});

const proxyServer = createProxyServer((captureData) => {
  console.log(`[Proxy] Captured ${captureData.provider} request: ${captureData.request.path}`);
  const breakdown = parseRequest(captureData);
  const result = storage.addCapture(captureData, breakdown);
  console.log(`[Proxy] Session: ${result.sessionId}, Capture: ${result.captureId}, Tokens: ${breakdown ? breakdown.total_tokens : 0}`);
});

const PROXY_PORT = 8080;
proxyServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PROXY_PORT} is in use. Retrying in 2s...`);
    setTimeout(() => {
      proxyServer.close();
      proxyServer.listen(PROXY_PORT, 'localhost');
    }, 2000);
  } else {
    console.error('Proxy server error:', err.message);
  }
});
proxyServer.listen(PROXY_PORT, 'localhost', () => {
  console.log(`Proxy running on http://localhost:${PROXY_PORT}`);
  console.log('');
  console.log('=== Quick Setup ===');
  console.log('Point your LLM tools to this proxy:');
  console.log(`  Anthropic: ANTHROPIC_BASE_URL=http://localhost:${PROXY_PORT}`);
  console.log(`  OpenAI:    OPENAI_BASE_URL=http://localhost:${PROXY_PORT}`);
  console.log(`  Google:    GOOGLE_API_BASE_URL=http://localhost:${PROXY_PORT}`);
  console.log('');
});
