/**
 * Speech segmentation for hands-free listening: open the mic, tell the
 * caller when an utterance starts, and hand over each finished utterance as
 * an audio blob ready for the STT endpoint.
 *
 * Two engines behind one interface:
 *   • "silero" — Silero VAD (via @ricky0123/vad-web) running in-browser on
 *     onnxruntime-web. Judges "is this a voice", so keyboards and room noise
 *     don't trigger it. Needs the assets in /public/vad (copy-vad-assets).
 *   • "energy" — RMS threshold on an AnalyserNode with a short noise-floor
 *     calibration. Zero dependencies; the fallback when Silero can't load.
 */

import { micConstraints } from "@/lib/voice-devices";
import { stripAudioMimeParameters } from "@/lib/voice-mime";
import { encodeWav } from "@/lib/voice-wav";

export type SpeechEngine = "silero" | "energy";

export interface SpeechSegmenterCallbacks {
  onSpeechStart: () => void;
  /** A finished utterance; `filename` carries the right extension. */
  onSpeechEnd: (audio: Blob, filename: string) => void;
  /** Speech started but was too short to count — return to listening. */
  onSpeechCancel: () => void;
}

export interface SpeechSegmenterOptions extends SpeechSegmenterCallbacks {
  /** Pause length (ms) that ends an utterance. */
  silenceMs: number;
}

export interface SpeechSegmenter {
  readonly engine: SpeechEngine;
  start: () => Promise<void>;
  pause: () => Promise<void>;
  destroy: () => Promise<void>;
}

/** Where copy-vad-assets.mjs puts the model, worklet and ONNX wasm. */
const VAD_ASSET_PATH = "/vad/";
const MIN_SPEECH_MS = 250;
const PRE_SPEECH_PAD_MS = 300;

export function speechDetectionSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof AudioContext !== "undefined"
  );
}

async function createSileroSegmenter(
  options: SpeechSegmenterOptions,
): Promise<SpeechSegmenter> {
  const { MicVAD } = await import("@ricky0123/vad-web");
  const vad = await MicVAD.new({
    model: "v5",
    baseAssetPath: VAD_ASSET_PATH,
    onnxWASMBasePath: VAD_ASSET_PATH,
    startOnLoad: false,
    submitUserSpeechOnPause: false,
    // vad-web's default stream, plus the user's chosen microphone.
    getStream: () =>
      navigator.mediaDevices.getUserMedia({
        audio: micConstraints({
          channelCount: 1,
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: true,
        }),
      }),
    positiveSpeechThreshold: 0.5,
    negativeSpeechThreshold: 0.35,
    redemptionMs: options.silenceMs,
    preSpeechPadMs: PRE_SPEECH_PAD_MS,
    minSpeechMs: MIN_SPEECH_MS,
    onSpeechStart: options.onSpeechStart,
    onVADMisfire: options.onSpeechCancel,
    onSpeechEnd: (audio) => {
      // vad-web resamples to 16 kHz mono before handing the segment over.
      options.onSpeechEnd(encodeWav(audio, 16000), "utterance.wav");
    },
  });
  if (vad.errored) throw new Error(vad.errored);
  // MicVAD's start/pause/destroy are async and share the mic; a pause that
  // lands after destroy (a remount tearing the old detector down while the
  // hold effect is still settling) throws "MicVAD has null stream". Chain
  // them and make everything after destroy a no-op.
  let destroyed = false;
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (op: () => Promise<void>) => {
    queue = queue.then(() => (destroyed ? undefined : op())).catch(() => {});
    return queue;
  };
  return {
    engine: "silero",
    start: () => enqueue(() => vad.start()),
    pause: () => enqueue(() => vad.pause()),
    destroy: () =>
      enqueue(async () => {
        destroyed = true;
        await vad.destroy();
      }),
  };
}

async function createEnergySegmenter(
  options: SpeechSegmenterOptions,
): Promise<SpeechSegmenter> {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("Recording is not supported in this browser.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: micConstraints(),
  });
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const frame = new Float32Array(analyser.fftSize);

  const POLL_MS = 50;
  const CALIBRATION_MS = 600;
  const MIN_THRESHOLD = 0.015;
  let noiseFloor = 0;
  let calibrationSamples = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let speaking = false;
  let speechStartedAt = 0;
  let lastLoudAt = 0;
  let active = false;

  const rms = () => {
    analyser.getFloatTimeDomainData(frame);
    let sum = 0;
    for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i];
    return Math.sqrt(sum / frame.length);
  };

  const beginUtterance = () => {
    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };
    recorder.start();
    speaking = true;
    speechStartedAt = Date.now();
    lastLoudAt = speechStartedAt;
    options.onSpeechStart();
  };

  const endUtterance = (deliver: boolean) => {
    const current = recorder;
    recorder = null;
    speaking = false;
    if (!current) return;
    const mimeType = stripAudioMimeParameters(current.mimeType);
    current.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType });
      chunks = [];
      if (!deliver || !blob.size) {
        options.onSpeechCancel();
        return;
      }
      const ext = mimeType.includes("ogg")
        ? "ogg"
        : mimeType.includes("mp4")
          ? "mp4"
          : "webm";
      options.onSpeechEnd(blob, `utterance.${ext}`);
    };
    if (current.state !== "inactive") current.stop();
  };

  const tick = () => {
    if (!active) return;
    const level = rms();
    const now = Date.now();
    // First few hundred ms establish the room's noise floor.
    if (calibrationSamples * POLL_MS < CALIBRATION_MS) {
      noiseFloor =
        (noiseFloor * calibrationSamples + level) / (calibrationSamples + 1);
      calibrationSamples += 1;
      return;
    }
    const threshold = Math.max(MIN_THRESHOLD, noiseFloor * 3);
    if (!speaking) {
      if (level > threshold) beginUtterance();
      return;
    }
    if (level > threshold) {
      lastLoudAt = now;
    } else if (now - lastLoudAt >= options.silenceMs) {
      endUtterance(
        now - speechStartedAt >= MIN_SPEECH_MS + options.silenceMs,
      );
    }
  };

  return {
    engine: "energy",
    start: async () => {
      if (active) return;
      if (audioContext.state === "suspended") await audioContext.resume();
      active = true;
      timer = setInterval(tick, POLL_MS);
    },
    pause: async () => {
      active = false;
      if (timer) clearInterval(timer);
      timer = null;
      if (speaking) endUtterance(false);
    },
    destroy: async () => {
      active = false;
      if (timer) clearInterval(timer);
      timer = null;
      if (speaking) endUtterance(false);
      source.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      await audioContext.close().catch(() => {});
    },
  };
}

/**
 * Build the best available segmenter: Silero when its runtime loads, the
 * energy detector otherwise. Rejects only when the mic itself is unusable.
 */
export async function createSpeechSegmenter(
  options: SpeechSegmenterOptions,
): Promise<SpeechSegmenter> {
  try {
    return await createSileroSegmenter(options);
  } catch (err) {
    console.warn("[voice] Silero VAD unavailable, using energy detector:", err);
    return createEnergySegmenter(options);
  }
}
