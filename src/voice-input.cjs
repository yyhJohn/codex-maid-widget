'use strict';
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const modelFiles = require('../assets/voice-models.json');

const SAMPLE_RATE = 16000;
const MAX_SAMPLES = 60 * SAMPLE_RATE;
const READY_MARKER = 0x564F4943;
const FINAL_FLAG = 0x80000000;
let toSimplified;

function containsAudio(samples) {
  let audible = 0;
  for (let offset = 0; offset < samples.length; offset += 2) {
    if (Math.abs(samples.readInt16LE(offset)) > 115 && ++audible >= 800) return true;
  }
  return false;
}

function readSamples(pcm) {
  if (!(pcm instanceof ArrayBuffer) || pcm.byteLength > MAX_SAMPLES * 2 || pcm.byteLength % 2) return null;
  return Buffer.from(pcm);
}

// The models stay loaded for the recording and communicate through private
// child-process pipes.
class VoiceWorker {
  constructor(executable, model, vad, cpu = false) {
    this.child = spawn(executable, [model, vad, ...(cpu ? ['cpu'] : [])], {
      cwd: path.dirname(executable), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.closed = false;
    this.buffer = Buffer.alloc(0);
    this.output = this.child.stdout[Symbol.asyncIterator]();
    this.child.once('error', () => this.close());
    this.child.stdin.on('error', () => this.close());
    const startup = setTimeout(() => this.close(), 30000);
    this.ready = this.read(4).then(header => {
      if (header.readUInt32LE() !== READY_MARKER) throw new Error('VOICE_WORKER_PROTOCOL');
    }).finally(() => clearTimeout(startup));
    this.ready.catch(() => this.close());
  }

  async read(length) {
    while (this.buffer.length < length) {
      const packet = await this.output.next();
      if (packet.done) throw new Error('VOICE_WORKER_CLOSED');
      this.buffer = Buffer.concat([this.buffer, packet.value]);
    }
    const bytes = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return bytes;
  }

  async decode(samples, final) {
    await this.ready;
    if (this.closed) throw new Error('VOICE_WORKER_CLOSED');
    const timeout = setTimeout(() => this.close(), final ? 120000 : 30000);
    try {
      const header = Buffer.alloc(4);
      header.writeUInt32LE(samples.length + (final ? FINAL_FLAG : 0));
      this.child.stdin.write(header);
      this.child.stdin.write(samples);
      const length = (await this.read(4)).readUInt32LE();
      if (length > 24000) throw new Error('VOICE_DECODE_FAILED');
      return (await this.read(length)).toString('utf8').trim().slice(0, 8000);
    } finally {
      clearTimeout(timeout);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.destroy();
    this.child.kill();
  }
}

class VoiceInput {
  constructor(dataDir) {
    this.directory = path.join(dataDir, 'voice-input');
    this.executable = path.join(this.directory, 'engine', 'maid-voice-worker.exe');
    this.model = path.join(this.directory, 'ggml-large-v3.bin');
    this.previewExecutable = path.join(this.directory, 'preview-engine', 'maid-voice-worker.exe');
    this.previewModel = path.join(this.directory, 'ggml-small-q5_1.bin');
    this.vad = path.join(this.directory, 'ggml-silero-v6.2.0.bin');
    this.bundledExecutable = process.resourcesPath && path.join(process.resourcesPath, 'voice-engine', 'maid-voice-worker.exe');
    this.capture = null;
  }

  engine(local) {
    const isFile = file => file && fs.statSync(file, { throwIfNoEntry: false })?.isFile();
    if (isFile(local)) return local;
    if (isFile(this.bundledExecutable)) return this.bundledExecutable;
    return null;
  }

  available() {
    if (process.platform !== 'win32' || process.arch !== 'x64') return false;
    return !!(this.engine(this.executable) && this.engine(this.previewExecutable) &&
      modelFiles.every(({ file, size }) => {
        const info = fs.statSync(path.join(this.directory, file), { throwIfNoEntry: false });
        return info?.isFile() && info.size === size;
      }));
  }

  begin() {
    if (!this.available()) return { error: 'unavailable' };
    if (this.capture && !this.capture.finishing && Date.now() >= this.capture.expires) this.cancel();
    if (this.capture) return { error: 'busy' };
    const id = randomUUID();
    const finalEngine = this.engine(this.executable);
    const previewWorker = new VoiceWorker(this.engine(this.previewExecutable), this.previewModel, this.vad, true);
    const worker = new VoiceWorker(finalEngine, this.model, this.vad, finalEngine === this.bundledExecutable);
    this.capture = { id, worker, previewWorker, permissionUntil: Date.now() + 15000, expires: Date.now() + 90000, preview: null, finishing: false };
    return { id, maxSamples: MAX_SAMPLES };
  }

  permitsMicrophone() {
    return !!this.capture && Date.now() < this.capture.permissionUntil;
  }

  microphoneStarted(id) {
    if (this.capture?.id === id) this.capture.permissionUntil = 0;
  }

  cancel(id) {
    const capture = this.capture;
    if (!capture || id !== undefined && capture.id !== id) return;
    this.capture = null;
    capture.previewWorker.close();
    capture.worker.close();
  }

  async decode(capture, samples, final) {
    try {
      const worker = final ? capture.worker : capture.previewWorker;
      const text = await worker.decode(samples, final);
      if (this.capture !== capture) return { error: 'cancelled' };
      if (!text) return final ? { error: 'empty' } : { text: '' };
      toSimplified ||= require('opencc-js/t2cn').Converter({ from: 't', to: 'cn' });
      return { text: toSimplified(text) };
    } catch {
      return { error: this.capture === capture ? 'failed' : 'cancelled' };
    }
  }

  async preview(id, pcm) {
    const capture = this.capture;
    if (!capture || capture.id !== id || capture.finishing || Date.now() > capture.expires) return { error: 'cancelled' };
    if (capture.preview) return { error: 'busy' };
    const samples = readSamples(pcm);
    if (!samples) return { error: 'failed' };
    if (samples.length < SAMPLE_RATE || !containsAudio(samples)) return { text: '' };
    const pending = this.decode(capture, samples, false);
    capture.preview = pending;
    try {
      return await pending;
    } finally {
      capture.preview = null;
    }
  }

  async transcribe(id, pcm) {
    const capture = this.capture;
    if (!capture || capture.id !== id || capture.finishing) return { error: 'cancelled' };
    capture.finishing = true;
    capture.permissionUntil = 0;
    capture.previewWorker.close();
    try {
      if (Date.now() > capture.expires) return { error: 'cancelled' };
      const samples = readSamples(pcm);
      if (!samples) return { error: 'failed' };
      if (samples.length < SAMPLE_RATE / 2 || !containsAudio(samples)) return { error: 'empty' };
      return await this.decode(capture, samples, true);
    } finally {
      this.cancel(id);
    }
  }
}

module.exports = { VoiceInput };
