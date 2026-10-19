import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import './db.js';
import authRoutes from './routes/auth.js';
import libraryRoutes from './routes/library.js';
import playbackRoutes from './routes/playback.js';
import adminRoutes from './routes/admin.js';
import { scanAll, scheduleScans } from './scanner.js';
import { queueBackgroundWork } from './streaming/background.js';
import { sessions, stopSession } from './streaming/sessions.js';
import { killBackgroundProcs } from './tasks.js';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'warn' },
  trustProxy: true,
  bodyLimit: 1024 * 1024,
  // Segment requests can legitimately wait for the encoder after a seek.
  requestTimeout: 0,
  keepAliveTimeout: 65000,
});

await app.register(authRoutes);
await app.register(libraryRoutes);
await app.register(playbackRoutes);
await app.register(adminRoutes);

app.get('/api/health', async () => ({ ok: true }));

if (fs.existsSync(config.webDir)) {
  await app.register(fastifyStatic, {
    root: config.webDir,
    setHeaders(res, file) {
      if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else res.setHeader('Cache-Control', 'no-cache');
    },
  });
  // Single-page app: unknown non-API paths serve index.html.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
    return reply.type('text/html').header('Cache-Control', 'no-cache').sendFile('index.html');
  });
} else {
  console.warn(`[web] ${config.webDir} not found – UI not served (API only).`);
}

await app.listen({ port: config.port, host: config.host });
console.log(`Streamarr listening on http://${config.host}:${config.port}`);

scheduleScans();
// Rescan on boot (incremental) and catch up on any missing background work.
setTimeout(() => {
  scanAll()
    .catch(() => {})
    .finally(() => queueBackgroundWork());
}, 3000);

async function shutdown() {
  for (const id of [...sessions.keys()]) await stopSession(id);
  killBackgroundProcs();
  await app.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
