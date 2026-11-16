(function () {
  'use strict';

  const PREVIEW_INTERVAL_SAMPLES = 19200;

  function mount({ button, maid, t, onChange, onPreview, onText }) {
    if (!button || typeof maid.voiceInputAvailable !== 'function') return null;
    let operation = null;
    let phase = '';
    let message = '';

    const labels = {
      starting: '正在打开麦克风…',
      recording: '正在录音，点击停止',
      transcribing: '正在离线转写，点击取消',
    };
    const errors = {
      unavailable: '未安装离线语音模型',
      busy: '请稍后再试语音输入',
      empty: '没有听清语音，请再录一次',
      failed: '离线转写失败，请重试',
    };

    function paint() {
      const label = t(labels[phase] || '语音输入');
      button.title = label;
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-pressed', String(phase === 'recording'));
      button.dataset.phase = phase;
    }

    function update(nextPhase = '', nextMessage = '') {
      phase = nextPhase;
      message = nextMessage;
      paint();
      onChange();
    }

    function stopTracks(stream) {
      for (const track of stream?.getTracks() || []) track.stop();
    }

    function release(op) {
      clearTimeout(op.timer);
      stopTracks(op.stream);
      op.source?.disconnect();
      op.processor?.disconnect();
      if (op.context && op.context.state !== 'closed') void op.context.close().catch(() => {});
    }

    function discard(op, feedback = '') {
      if (operation !== op) return;
      operation = null;
      release(op);
      if (op.id) void maid.cancelVoiceInput(op.id).catch(() => {});
      onPreview('');
      update('', feedback);
    }

    async function preview(op) {
      op.previewAt = op.used;
      op.previewPending = true;
      try {
        const result = await maid.previewVoiceInput(op.id, op.samples.buffer.slice(0, op.used * 2));
        if (operation === op && phase === 'recording' && typeof result.text === 'string') onPreview(result.text);
      } catch {
        // The final pass still gets the full recording even if a preview failed.
      } finally {
        op.previewPending = false;
      }
    }

    function handleSamples(op, samples) {
      if (samples === null) {
        op.flush?.();
        return;
      }
      if (operation !== op || op.used >= op.samples.length) return;
      const count = Math.min(samples.length, op.samples.length - op.used);
      op.samples.set(samples.subarray(0, count), op.used);
      op.used += count;
      if (op.used === op.samples.length) void finish(op);
      else if (phase === 'recording' && !op.previewPending && op.used - op.previewAt >= PREVIEW_INTERVAL_SAMPLES) void preview(op);
    }

    async function finish(op) {
      if (operation !== op || phase !== 'recording') return;
      update('transcribing');
      clearTimeout(op.timer);
      stopTracks(op.stream);
      try {
        await new Promise(resolve => {
          const timeout = setTimeout(resolve, 450);
          op.flush = () => { clearTimeout(timeout); resolve(); };
          op.processor.port.postMessage('flush');
        });
        if (operation !== op) return;
        release(op);
        const result = await maid.transcribeVoiceInput(op.id, op.samples.buffer.slice(0, op.used * 2));
        if (operation !== op) return;
        if (result.text) onText(result.text);
        operation = null;
        onPreview('');
        update('', result.text ? '转写完成，请确认后发送' : errors[result.error] || '');
      } catch {
        discard(op, errors.failed);
      }
    }

    async function start() {
      const op = { used: 0, previewAt: 0, previewPending: false };
      operation = op;
      update('starting');
      try {
        op.context = new AudioContext({ sampleRate: 16000 });
        await op.context.audioWorklet.addModule('voice-capture-worklet.js');
        if (operation !== op) return;
        const ticket = await maid.beginVoiceInput();
        op.id = ticket.id;
        if (operation !== op) {
          if (op.id) void maid.cancelVoiceInput(op.id).catch(() => {});
          return;
        }
        if (!op.id) { discard(op, errors[ticket.error] || errors.failed); return; }
        op.samples = new Int16Array(ticket.maxSamples);
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
        });
        if (operation !== op) { stopTracks(stream); return; }
        op.stream = stream;
        for (const track of stream.getAudioTracks()) {
          track.addEventListener('ended', () => discard(op, '麦克风已断开'), { once: true });
        }
        await maid.voiceMicrophoneStarted(op.id);
        if (operation !== op) return;
        op.source = op.context.createMediaStreamSource(stream);
        op.processor = new AudioWorkletNode(op.context, 'voice-capture', { channelCount: 1, channelCountMode: 'explicit' });
        op.processor.port.onmessage = event => handleSamples(op, event.data);
        op.source.connect(op.processor).connect(op.context.destination);
        await op.context.resume();
        if (operation !== op) return;
        update('recording');
        op.timer = setTimeout(() => void finish(op), 60000);
      } catch (error) {
        const feedback = error?.name === 'NotAllowedError' ? '麦克风权限未开启' :
          error?.name === 'NotFoundError' ? '找不到麦克风' : '无法开始录音，请检查麦克风';
        discard(op, feedback);
      }
    }

    function cancel() { if (operation) discard(operation); }
    button.addEventListener('click', () => {
      if (phase === 'recording') void finish(operation);
      else if (operation) cancel();
      else void start();
    });
    const unsubscribe = maid.onVoiceInputCancelled?.(cancel);
    window.addEventListener('pagehide', cancel, { once: true });
    void maid.voiceInputAvailable().then(available => {
      button.hidden = !available;
      paint();
    }).catch(() => {});
    return {
      get busy() { return !!phase; },
      get status() { return labels[phase] || message; },
      paint,
      cancel,
      dispose() { cancel(); unsubscribe?.(); window.removeEventListener('pagehide', cancel); },
    };
  }

  window.MaidVoiceRecorder = { mount };
})();
