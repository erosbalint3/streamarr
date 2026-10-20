// Pre-compress built assets (brotli + gzip) so the server can send them without per-request work.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dist = path.resolve(import.meta.dirname, '../dist');
const exts = new Set(['.js', '.css', '.html', '.svg', '.json', '.webmanifest']);
let saved = 0;
for (const f of fs.readdirSync(dist, { recursive: true })) {
  const p = path.join(dist, f);
  if (!exts.has(path.extname(p)) || !fs.statSync(p).isFile()) continue;
  const raw = fs.readFileSync(p);
  if (raw.length < 1024) continue;
  const br = zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
  fs.writeFileSync(p + '.br', br);
  fs.writeFileSync(p + '.gz', zlib.gzipSync(raw, { level: 9 }));
  saved += raw.length - br.length;
}
console.log(`pre-compressed assets, ${(saved / 1024).toFixed(0)} KB saved per full load (brotli)`);
