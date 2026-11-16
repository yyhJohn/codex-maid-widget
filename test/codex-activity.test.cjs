'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CodexActivityReader } = require('../src/codex-activity.cjs');

test('the dragon tracks recent Codex starts, overlapping turns, completions and interruptions', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'maid-codex-activity-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const first = path.join(directory, 'first.jsonl'), second = path.join(directory, 'second.jsonl');
  const monitor = new CodexActivityReader(async () => (await fs.readdir(directory)).map(file => path.join(directory, file)));
  const now = Date.now();
  const event = (type, turnId, time = now) => JSON.stringify({
    timestamp: new Date(time).toISOString(), type: 'event_msg', payload: { type, turn_id: turnId },
  }) + '\n';
  const append = (file, type, id) => fs.appendFile(file, event(type, id));
  assert.equal(await monitor.read(now), 'idle');
  await fs.writeFile(first, event('task_started', 'old', now - 60000) + event('task_complete', 'old', now - 50000));
  assert.equal(await monitor.read(now), 'idle');
  await append(first, 'task_started', 'first');
  assert.equal(await monitor.read(now), 'working');
  await append(second, 'task_started', 'second');
  await append(first, 'task_complete', 'first');
  assert.equal(await monitor.read(now), 'working');
  await append(second, 'task_complete', 'second');
  assert.equal(await monitor.read(now), 'completed');
  assert.equal(await monitor.read(now + 5000), 'idle');
  await append(first, 'task_started', 'next');
  await append(first, 'task_complete', 'other');
  assert.equal(await monitor.read(now + 5000), 'working');
  await fs.appendFile(first, ' '.repeat(1024 * 1024 + 1) + '\n');
  assert.equal(await monitor.read(now + 5000), 'working');
  await append(first, 'turn_aborted', 'next');
  assert.equal(await monitor.read(now + 5000), 'idle');
});
