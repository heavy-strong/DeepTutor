"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch, apiUrl } from "@/lib/api";
import {
  createSpeechSegmenter,
  speechDetectionSupported,
  type SpeechEngine,
  type SpeechSegmenter,
} from "@/lib/voice-vad";
import { useTtsPlaying, useVoiceHandsfreePreference } from "@/hooks/useVoiceAutoplay";
import { useVoiceDevices } from "@/hooks/useVoiceDevices";

/** What the composer shows on the hands-free button. */
export type HandsFreeState =
  | "off"
  | "loading"
  | "listening"
  | "speaking"
  | "transcribing"
  | "countdown"
  | "paused";

type Phase =
  | "idle"
  | "loading"
  | "listening"
  | "speaking"
  | "transcribing"
  | "countdown";

// Whether hands-free is on, per chat surface. Lives outside component state
// so it survives the composer remounting — the main chat re-routes to
// /chat/<id> after the first send and the partner page rotates sessions —
// which otherwise switched listening off after exactly one question. A full
// reload starts clean (the mic then needs a click anyway).
const intents = new Map<string, boolean>();

/**
 * Hands-free voice input: a voice-activity detector segments the mic into
 * utterances, each one is transcribed through ``/api/voice/stt`` and appended
 * to the draft, then — after a short review window — the draft is sent.
 *
 * Listening pauses while ``paused`` is true (the reply is streaming, the
 * composer is disabled) and while any reply is being read aloud, so the
 * speakers are never transcribed. It resumes on its own afterwards, which
 * makes a spoken back-and-forth with "reply aloud to voice questions" on.
 */
export function useHandsFreeVoice({
  scope,
  onTranscript,
  onAutoSend,
  paused,
}: {
  /** Which surface this is ("chat", "partner:<id>"): the on/off state is
   *  remembered per scope across remounts. */
  scope: string;
  /** Append a transcript to the draft (same as the manual mic). */
  onTranscript: (text: string) => void;
  /** Submit the draft once the review window elapses. */
  onAutoSend: () => void;
  /** Hold listening (reply streaming, composer disabled, …). */
  paused: boolean;
}) {
  const { value: timings } = useVoiceHandsfreePreference();
  const ttsPlaying = useTtsPlaying();
  // The chosen mic is read inside the detector; changing it rebuilds one.
  const { prefs: devicePrefs } = useVoiceDevices();
  const micId = devicePrefs.micId;
  const [enabled, setEnabledState] = useState(
    () => intents.get(scope) ?? false,
  );
  const setEnabled = useCallback(
    (next: boolean) => {
      intents.set(scope, next);
      setEnabledState(next);
    },
    [scope],
  );
  const [phase, setPhase] = useState<Phase>("idle");
  const [countdown, setCountdown] = useState<number | null>(null);
  const [engine, setEngine] = useState<SpeechEngine | null>(null);
  const [error, setError] = useState<string | null>(null);

  const segmenterRef = useRef<SpeechSegmenter | null>(null);
  const phaseRef = useRef<Phase>("idle");
  phaseRef.current = phase;
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const onAutoSendRef = useRef(onAutoSend);
  onAutoSendRef.current = onAutoSend;
  const sendDelayRef = useRef(timings.sendDelayMs);
  sendDelayRef.current = timings.sendDelayMs;

  const clearCountdown = useCallback(() => {
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    countdownTimerRef.current = null;
    setCountdown(null);
  }, []);

  const startCountdown = useCallback(() => {
    const total = sendDelayRef.current;
    if (total <= 0) {
      onAutoSendRef.current();
      setPhase("listening");
      return;
    }
    const endAt = Date.now() + total;
    setPhase("countdown");
    setCountdown(Math.ceil(total / 1000));
    countdownTimerRef.current = setInterval(() => {
      const left = endAt - Date.now();
      if (left > 0) {
        setCountdown(Math.ceil(left / 1000));
        return;
      }
      clearCountdown();
      setPhase("listening");
      onAutoSendRef.current();
    }, 100);
  }, [clearCountdown]);

  /** The user edited the draft (or pressed send) — don't send on their behalf. */
  const cancelCountdown = useCallback(() => {
    if (phaseRef.current !== "countdown") return;
    clearCountdown();
    setPhase("listening");
  }, [clearCountdown]);

  const transcribe = useCallback(
    async (audio: Blob, filename: string) => {
      setPhase("transcribing");
      setError(null);
      try {
        const form = new FormData();
        form.append("file", audio, filename);
        const resp = await apiFetch(apiUrl("/api/voice/stt"), {
          method: "POST",
          body: form,
        });
        if (!resp.ok) {
          const detail = (await resp.json().catch(() => null)) as {
            detail?: string;
          } | null;
          throw new Error(
            detail?.detail || `Transcription failed (HTTP ${resp.status}).`,
          );
        }
        const data = (await resp.json()) as { text?: string };
        const text = (data.text || "").trim();
        if (!text) {
          setPhase("listening");
          return;
        }
        onTranscriptRef.current(text);
        startCountdown();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Transcription failed.");
        setPhase("listening");
      }
    },
    [startCountdown],
  );
  const transcribeRef = useRef(transcribe);
  transcribeRef.current = transcribe;

  // Open the mic and build the detector while enabled; tear it down after.
  // ``micId`` is a dependency on purpose: a new microphone means a new
  // capture stream, so the detector is rebuilt on it.
  useEffect(() => {
    if (!enabled) return;
    void micId;
    let cancelled = false;
    let segmenter: SpeechSegmenter | null = null;
    setPhase("loading");
    setError(null);
    createSpeechSegmenter({
      silenceMs: timings.silenceMs,
      onSpeechStart: () => setPhase("speaking"),
      onSpeechCancel: () => setPhase("listening"),
      onSpeechEnd: (audio, filename) => {
        void transcribeRef.current(audio, filename);
      },
    })
      .then((built) => {
        if (cancelled) {
          void built.destroy();
          return;
        }
        segmenter = built;
        segmenterRef.current = built;
        setEngine(built.engine);
        setPhase("listening");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof Error
            ? err.message
            : "Microphone permission denied.",
        );
        setEnabled(false);
        setPhase("idle");
      });
    return () => {
      cancelled = true;
      segmenterRef.current = null;
      if (segmenter) void segmenter.destroy();
      clearCountdown();
      setPhase("idle");
      setEngine(null);
    };
  }, [clearCountdown, enabled, micId, setEnabled, timings.silenceMs]);

  // Listen only when nothing else owns the turn: not while the reply streams,
  // not while it is read aloud, not while we are transcribing or counting down.
  // pause()/start() are async and release/re-acquire the mic, so they are
  // chained: a quick hold-then-resume must not overlap them.
  const holding =
    paused || ttsPlaying || phase === "transcribing" || phase === "countdown";
  const opsRef = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    const segmenter = segmenterRef.current;
    if (!segmenter || phase === "idle" || phase === "loading") return;
    opsRef.current = opsRef.current
      .then(() => {
        if (segmenterRef.current !== segmenter) return;
        return holding ? segmenter.pause() : segmenter.start();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
    // A pause mid-utterance drops that utterance (nothing to transcribe).
    if (holding && phase === "speaking") setPhase("listening");
  }, [holding, phase]);

  const toggle = useCallback(() => {
    if (enabled) {
      setEnabled(false);
      return;
    }
    if (!speechDetectionSupported()) {
      setError("Recording is not supported in this browser.");
      return;
    }
    setEnabled(true);
  }, [enabled, setEnabled]);

  const state: HandsFreeState = !enabled
    ? "off"
    : phase === "loading"
      ? "loading"
      : phase === "transcribing"
        ? "transcribing"
        : phase === "countdown"
          ? "countdown"
          : paused || ttsPlaying
            ? "paused"
            : phase === "speaking"
              ? "speaking"
              : "listening";

  return { enabled, state, countdown, engine, error, toggle, cancelCountdown };
}
