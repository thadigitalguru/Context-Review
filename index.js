const express = require('express');
const path = require('path');
const { createProxyServer } = require('./src/proxy/proxy');
const { parseRequest } = require('./src/parser/parser');
const { SessionStorage } = require('./src/storage/storage');
const { BackgroundAnalysisScheduler } = require('./src/analysis/background');
const { createAPIRouter } = require('./src/api/routes');

const storage = new SessionStorage();
const backgroundAnalysisEnabled = process.env.CONTEXT_REVIEW_DISABLE_BACKGROUND_ANALYSIS !== '1';
const analysisScheduler = new BackgroundAnalysisScheduler(storage);
if (backgroundAnalysisEnabled) analysisScheduler.start();

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', createAPIRouter(storage, { analysisScheduler: backgroundAnalysisEnabled ? analysisScheduler : null }));

app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.get('/landing', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || process.env.PORT || 5000);
const DASHBOARD_HOST = process.env.DASHBOARD_HOST || '0.0.0.0';
app.listen(DASHBOARD_PORT, DASHBOARD_HOST, () => {
  console.log(`Dashboard running on http://${DASHBOARD_HOST}:${DASHBOARD_PORT}`);
});

const proxyDisabled = process.env.CONTEXT_REVIEW_DISABLE_PROXY === '1';
if (proxyDisabled) {
  console.log('Proxy startup skipped (CONTEXT_REVIEW_DISABLE_PROXY=1).');
} else {
  const proxyServer = createProxyServer((captureData) => {
    console.log(`[Proxy] Captured ${captureData.provider} request: ${captureData.request.path}`);
    const breakdown = parseRequest(captureData);
    const result = storage.addCapture(captureData, breakdown);
    console.log(`[Proxy] Session: ${result.sessionId}, Capture: ${result.captureId}, Tokens: ${breakdown ? breakdown.total_tokens : 0}`);
  });

  const PROXY_PORT = Number(process.env.PROXY_PORT || 8080);
  const PROXY_HOST = process.env.PROXY_HOST || 'localhost';
  const PROXY_ADVERTISE_HOST = process.env.PROXY_ADVERTISE_HOST || 'localhost';
  proxyServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PROXY_PORT} is in use. Retrying in 2s...`);
      setTimeout(() => {
        proxyServer.close();
        proxyServer.listen(PROXY_PORT, PROXY_HOST);
      }, 2000);
    } else {
      console.error('Proxy server error:', err.message);
    }
  });
  proxyServer.listen(PROXY_PORT, PROXY_HOST, () => {
    console.log(`Proxy listening on ${PROXY_HOST}:${PROXY_PORT}`);
    console.log(`Proxy client URL: http://${PROXY_ADVERTISE_HOST}:${PROXY_PORT}`);
    console.log('');
    console.log('=== Quick Setup ===');
    console.log('Point your LLM tools to this proxy:');
    console.log(`  Anthropic: ANTHROPIC_BASE_URL=http://${PROXY_ADVERTISE_HOST}:${PROXY_PORT}`);
    console.log(`  OpenAI:    OPENAI_BASE_URL=http://${PROXY_ADVERTISE_HOST}:${PROXY_PORT}`);
    console.log(`  Google:    GOOGLE_API_BASE_URL=http://${PROXY_ADVERTISE_HOST}:${PROXY_PORT}`);
    console.log('');
  });
}
