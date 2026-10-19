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

/** Called by the transcoder: pause background work while many people are watching. */
export function setBackgroundPaused(v) {
  paused = v;
  if (!v) pump();
}

async function pump() {
  if (running || !queue.length) return;
  if (paused && !queue[0].priority) return;
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
