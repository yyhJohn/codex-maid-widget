'use strict';

class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Int16Array(1024);
    this.length = 0;
    this.stopped = false;
    this.port.onmessage = () => {
      this.stopped = true;
      this.flush();
      this.port.postMessage(null);
    };
  }

  flush() {
    if (!this.length) return;
    const samples = this.length === this.chunk.length ? this.chunk : this.chunk.slice(0, this.length);
    this.port.postMessage(samples, [samples.buffer]);
    this.chunk = new Int16Array(1024);
    this.length = 0;
  }

  process(inputs) {
    if (this.stopped) return false;
    for (const sample of inputs[0]?.[0] || []) {
      const clipped = Math.max(-1, Math.min(1, sample));
      this.chunk[this.length++] = Math.round(clipped * (clipped < 0 ? 32768 : 32767));
      if (this.length === this.chunk.length) this.flush();
    }
    return true;
  }
}

registerProcessor('voice-capture', VoiceCaptureProcessor);
