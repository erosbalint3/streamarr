import { spawn } from 'node:child_process';

/** Run a command and collect stdout. Rejects on non-zero exit or timeout. */
export function exec(cmd, args, { timeout = 120000, maxBuffer = 64 * 1024 * 1024, nice = false } = {}) {
  return new Promise((resolve, reject) => {
    const [bin, argv] = nice ? ['nice', ['-n', '15', cmd, ...args]] : [cmd, args];
    const child = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let outLen = 0;
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeout}ms`));
    }, timeout);
    child.stdout.on('data', (d) => {
      outLen += d.length;
      if (outLen <= maxBuffer) out.push(d);
    });
    child.stderr.on('data', (d) => {
      if (err.length < 8000) err += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${cmd} exited with ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

/** Simple concurrency limiter. */
export function limiter(concurrency) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
