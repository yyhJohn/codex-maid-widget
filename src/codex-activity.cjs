'use strict';

const fs = require('node:fs/promises');

const TAIL_BYTES = 1024 * 1024;
const ACTIVE_LOG_AGE_MS = 30 * 60 * 1000;
const CELEBRATION_MS = 4000;

function readTurnEvents(text, lastTurn) {
  for (const line of text.split('\n')) {
    if (!/"(?:task_started|task_complete|turn_aborted)"/.test(line)) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type !== 'event_msg') continue;
    const kind = event.payload?.type, id = event.payload?.turn_id;
    if (kind === 'task_started') {
      lastTurn = { id, working: true, completedAt: 0 };
    } else if (kind === 'task_complete' || kind === 'turn_aborted') {
      if (lastTurn?.id && id && lastTurn.id !== id) continue;
      lastTurn = { id, working: false, completedAt: kind === 'task_complete' ? Date.parse(event.timestamp) || 0 : 0 };
    }
  }
  return lastTurn;
}

// Only lifecycle events are retained. This reader never sends Codex requests
// or forwards rollout data to a renderer.
class CodexActivityReader {
  constructor(listRollouts) {
    this.listRollouts = listRollouts;
    this.logs = new Map();
  }

  async read(now = Date.now()) {
    const files = await this.listRollouts();
    const present = new Set(files);
    for (const file of this.logs.keys()) if (!present.has(file)) this.logs.delete(file);
    for (let index = 0; index < files.length; index += 12) {
      await Promise.all(files.slice(index, index + 12).map(file => this.readLog(file, now)));
    }
    const logs = [...this.logs.values()];
    if (logs.some(log => log.turn?.working)) return 'working';
    if (logs.some(log => log.turn?.completedAt > now - CELEBRATION_MS)) return 'completed';
    return 'idle';
  }

  async readLog(file, now) {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || now - stat.mtimeMs > ACTIVE_LOG_AGE_MS) {
        this.logs.delete(file);
        return;
      }
      const previous = this.logs.get(file);
      if (previous?.size === stat.size && previous.mtimeMs === stat.mtimeMs) return;
      const start = Math.max(0, stat.size - TAIL_BYTES);
      const handle = await fs.open(file, 'r');
      let text;
      try {
        const buffer = Buffer.alloc(stat.size - start);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
        text = buffer.toString('utf8', 0, bytesRead);
      } finally {
        await handle.close();
      }
      if (start) text = text.slice(text.indexOf('\n') + 1);
      const lastTurn = start && previous?.size < stat.size ? previous.turn : null;
      const turn = readTurnEvents(text, lastTurn);
      this.logs.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, turn });
    } catch {
      // Retry transient access errors on the next poll. A missing or
      // inaccessible log cannot keep the widget in its working pose.
      this.logs.delete(file);
    }
  }
}

module.exports = { CodexActivityReader };
