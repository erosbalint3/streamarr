// A tiny low-priority background task queue (trickplay sheets, subtitle extraction...).
// Runs one task at a time so it never competes with live transcodes for long.

const queue = [];
const keys = new Set();
let running = null;
let paused = false;

export const taskState = () => ({ running: running?.label || null, queued: queue.length, paused });

export function enqueue(key, label, fn, { priority = false } = {}) {
  if (keys.has(key)) return;
  keys.add(key);
  const task = { key, label, fn, priority };
  if (priority) {
    // Ahead of normal work, but behind earlier priority tasks (keeps library order).
    const i = queue.findIndex((t) => !t.priority);
    queue.splice(i < 0 ? queue.length : i, 0, task);
  } else queue.push(task);
  pump();
}

// ffmpeg processes started by background tasks, so they can be frozen mid-task.
const procs = new Set();

/** On shutdown: don't leave background ffmpeg processes behind. */
export function killBackgroundProcs() {
  for (const c of procs) {
    try {
      c.kill('SIGCONT');
      c.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
}

/** Pass as exec()'s onSpawn for background ffmpeg runs. */
export function trackBackgroundProc(child) {
  procs.add(child);
  child.on('close', () => procs.delete(child));
  if (paused) child.kill('SIGSTOP');
}

/**
 * Called by the playback layer: background work (preview thumbnails, subtitle extraction,
 * artwork) waits while anyone is watching. Jobs already running are frozen (SIGSTOP) and
 * continue exactly where they were once playback ends.
 */
export function setBackgroundPaused(v) {
  if (v === paused) return;
  paused = v;
  for (const c of procs) {
    try {
      c.kill(v ? 'SIGSTOP' : 'SIGCONT');
    } catch {
      /* already exited */
    }
  }
  if (!v) pump();
}

async function pump() {
  if (running || paused || !queue.length) return;
  running = queue.shift();
  try {
    await running.fn();
  } catch (e) {
    console.warn(`[tasks] ${running.label} failed: ${e.message}`);
  } finally {
    keys.delete(running.key);
    running = null;
    setImmediate(pump);
  }
}
