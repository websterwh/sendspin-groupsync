/**
 * Microphone Recorder
 *
 * Records the microphone continuously and keeps every sample, stamped by the
 * audio context's own frame counter, so analysis times come from the sample
 * clock instead of (jittery) callback timing. Dropped blocks show up as frame
 * gaps and are zero-filled so the timeline stays correct.
 */

interface Chunk {
  frame: number;
  /** 16-bit PCM (half the memory of floats; plenty of range for microphone audio) */
  data: Int16Array;
}

const WORKLET_SOURCE = `
class GroupSyncRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1024);
    this.filled = 0;
    this.startFrame = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    const n = 128;
    if (this.filled === 0) this.startFrame = currentFrame;
    if (ch) this.buf.set(ch, this.filled);
    else this.buf.fill(0, this.filled, this.filled + n);
    this.filled += n;
    if (this.filled >= this.buf.length) {
      this.port.postMessage({ frame: this.startFrame, data: this.buf.slice() });
      this.filled = 0;
    }
    return true;
  }
}
registerProcessor('groupsync-recorder', GroupSyncRecorder);
`;

export class MicRecorder {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private chunks: Chunk[] = [];
  private firstFrame: number | null = null;
  private lastLevel = 0;
  private node: AudioNode | null = null;
  private nextFrame: number | null = null;
  /** Number of times the audio context skipped frames (dropped blocks, zero-filled in the timeline) */
  gapCount = 0;

  /** Maximum recording length (seconds) to bound memory */
  static readonly MAX_SECONDS = 640;

  get sampleRate(): number {
    return this.context?.sampleRate ?? 48000;
  }

  /** Seconds recorded so far */
  get elapsed(): number {
    if (this.chunks.length === 0 || this.firstFrame === null) return 0;
    const last = this.chunks[this.chunks.length - 1];
    return (last.frame - this.firstFrame + last.data.length) / this.sampleRate;
  }

  get level(): number {
    return this.lastLevel;
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    this.context = new AudioContext();
    if (this.context.state === 'suspended') await this.context.resume();
    const source = this.context.createMediaStreamSource(this.stream);

    const onChunk = (frame: number, data: Float32Array) => {
      if (this.firstFrame === null) this.firstFrame = frame;
      if (this.nextFrame !== null && frame !== this.nextFrame) {
        // Gaps while the stream is still starting up are harmless; later ones shift the timeline
        if (this.elapsed > 1) this.gapCount++;
        console.warn(`[MicRecorder] Audio gap: ${frame - this.nextFrame} frames at ${this.elapsed.toFixed(2)}s`);
      }
      this.nextFrame = frame + data.length;
      if (this.elapsed > MicRecorder.MAX_SECONDS) return;
      const pcm = new Int16Array(data.length);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = Math.max(-1, Math.min(1, data[i]));
        pcm[i] = Math.round(v * 32767);
        sum += v * v;
      }
      this.chunks.push({ frame, data: pcm });
      this.lastLevel = Math.sqrt(sum / data.length);
    };

    if (this.context.audioWorklet) {
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
      try {
        await this.context.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const node = new AudioWorkletNode(this.context, 'groupsync-recorder', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
      });
      node.port.onmessage = (e: MessageEvent<{ frame: number; data: Float32Array }>) =>
        onChunk(e.data.frame, e.data.data);
      source.connect(node);
      // Some browsers only run worklets that are connected to the destination; output is silent
      node.connect(this.context.destination);
      this.node = node;
    } else {
      // Fallback for old browsers: counted samples (can't detect dropped blocks)
      const proc = this.context.createScriptProcessor(2048, 1, 1);
      let frame = 0;
      proc.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0).slice();
        onChunk(frame, data);
        frame += data.length;
      };
      source.connect(proc);
      proc.connect(this.context.destination);
      this.node = proc;
    }
  }

  /** Samples between two recording times (seconds); gaps are zero-filled. */
  getSamples(fromS: number, toS: number): Float32Array {
    const sr = this.sampleRate;
    const first = this.firstFrame ?? 0;
    const start = Math.max(0, Math.floor(fromS * sr));
    const end = Math.max(start, Math.floor(toS * sr));
    const out = new Float32Array(end - start);
    for (const c of this.chunks) {
      const cStart = c.frame - first;
      const cEnd = cStart + c.data.length;
      if (cEnd <= start || cStart >= end) continue;
      const from = Math.max(start, cStart);
      const to = Math.min(end, cEnd);
      for (let i = from; i < to; i++) out[i - start] = c.data[i - cStart] / 32767;
    }
    return out;
  }

  stop(): void {
    try {
      this.node?.disconnect();
    } catch {
      // already disconnected
    }
    this.node = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.context && this.context.state !== 'closed') this.context.close();
    this.context = null;
  }
}
