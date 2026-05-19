import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { AccountManager } from './account-manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();

// CORS — origin từ env var ALLOWED_ORIGINS (comma-separated), mặc định allow all
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim())
  : null;
app.use(cors({
  origin: allowedOrigins || true,
  credentials: true,
}));

// Optional API key auth: nếu set API_KEY env, mọi request /api/* phải có header X-API-Key đúng
const API_KEY = process.env.API_KEY;
app.use('/api', (req, res, next) => {
  if (!API_KEY) return next();
  if (req.headers['x-api-key'] === API_KEY) return next();
  res.status(401).json({ error: 'unauthorized' });
});

app.use(express.json({ limit: '5mb' }));
app.use(express.static(join(__dirname, 'web')));

const mgr = new AccountManager();

// ===== REST API =====

// GET /api/accounts → list
app.get('/api/accounts', (req, res) => {
  res.json(mgr.list());
});

// POST /api/accounts → add (body = { cookies, pinCode })
app.post('/api/accounts', (req, res) => {
  try {
    const acc = mgr.add(req.body);
    res.json(acc.toJSON());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/accounts/:id/start
app.post('/api/accounts/:id/start', async (req, res) => {
  const acc = mgr.get(req.params.id);
  if (!acc) return res.status(404).json({ error: 'not found' });
  try {
    await acc.start();
    res.json(acc.toJSON());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/accounts/:id/refresh → load tin nhắn của thread, body: { threadKey, numMessages }
app.post('/api/accounts/:id/refresh', async (req, res) => {
  const acc = mgr.get(req.params.id);
  if (!acc) return res.status(404).json({ error: 'not found' });
  try {
    const result = await acc.refresh(req.body || {});
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/accounts/:id/stop
app.post('/api/accounts/:id/stop', async (req, res) => {
  const acc = mgr.get(req.params.id);
  if (!acc) return res.status(404).json({ error: 'not found' });
  await acc.stop();
  res.json(acc.toJSON());
});

// POST /api/accounts/:id/ai → update AI config (body = partial AI config)
app.post('/api/accounts/:id/ai', async (req, res) => {
  const acc = mgr.get(req.params.id);
  if (!acc) return res.status(404).json({ error: 'not found' });
  await acc.updateAIConfig(req.body || {});
  res.json(acc.toJSON());
});

// GET /api/accounts/:id/ai → get current AI config (mask key)
app.get('/api/accounts/:id/ai', (req, res) => {
  const acc = mgr.get(req.params.id);
  if (!acc) return res.status(404).json({ error: 'not found' });
  const c = { ...acc.aiConfig, apiKey: acc.aiConfig.apiKey ? '***' : '' };
  res.json(c);
});

// DELETE /api/accounts/:id
app.delete('/api/accounts/:id', async (req, res) => {
  const ok = await mgr.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// Health
app.get('/api/health', (req, res) => res.json({ ok: true, accounts: mgr.accounts.size }));

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`Web UI: http://localhost:${PORT}/`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await mgr.stopAll();
  process.exit(0);
});
