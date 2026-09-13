"use client";

import { browserStorage } from "@/shared/storage";

import { useCallback, useEffect, useState } from "react";

import { apiFetch, apiUrl } from "@/lib/api";

// Three-state autoplay model:
//   • global default — persisted per-user (Settings › Voice → ui.voice_autoplay)
//   • session override — sessionStorage, wins over the global default
//   • first-play prompt — when the global default is off and the user manually
//     plays one reply, we offer to auto-play the rest of the session.
const SESSION_KEY_PREFIX = "deeptutor.voiceAutoplay.session"; // "on" | "off"
const PROMPTED_KEY_PREFIX = "deeptutor.voiceAutoplay.prompted"; // "1"
const GLOBAL_EVENT = "deeptutor:voice-autoplay-global";
const SESSION_EVENT = "deeptutor:voice-autoplay-session";

const REPLY_TO_VOICE_EVENT = "deeptutor:voice-reply-to-voice-global";
const HANDSFREE_EVENT = "deeptutor:voice-handsfree-global";
const TTS_PLAYING_EVENT = "deeptutor:voice-tts-playing";

let cachedGlobal: boolean | null = null;
// "Ask by voice → answered by voice": defaults on (mirrors the backend
// default) so a dictated question is spoken back even with autoplay off.
let cachedReplyToVoice: boolean | null = null;
// Hands-free listening timings (Settings › STT). Mirrors the backend defaults.
export interface HandsfreeTimings {
  silenceMs: number;
  sendDelayMs: number;
}
const DEFAULT_HANDSFREE: HandsfreeTimings = { silenceMs: 800, sendDelayMs: 2000 };
let cachedHandsfree: HandsfreeTimings | null = null;
let inflight: Promise<void> | null = null;

function readHandsfree(ui: Record<string, unknown> | undefined): HandsfreeTimings {
  const silence = Number(ui?.voice_handsfree_silence_ms);
  const delay = Number(ui?.voice_handsfree_send_delay_ms);
  return {
    silenceMs: Number.isFinite(silence) && silence > 0 ? silence : DEFAULT_HANDSFREE.silenceMs,
    sendDelayMs: Number.isFinite(delay) && delay >= 0 ? delay : DEFAULT_HANDSFREE.sendDelayMs,
  };
}

// Both preferences ride the same /api/settings payload, so one fetch fills
// both caches.
function loadVoicePreferences(): Promise<void> {
  if (
    cachedGlobal !== null &&
    cachedReplyToVoice !== null &&
    cachedHandsfree !== null
  ) {
    return Promise.resolve();
  }
  if (!inflight) {
    inflight = apiFetch(apiUrl("/api/settings"))
      .then((r) => (r.ok ? r.json() : null))
      .then((payload) => {
        cachedGlobal = Boolean(payload?.ui?.voice_autoplay);
        cachedReplyToVoice = payload?.ui?.voice_reply_to_voice !== false;
        cachedHandsfree = readHandsfree(payload?.ui);
      })
      .catch(() => {
        cachedGlobal = false;
        cachedReplyToVoice = true;
        cachedHandsfree = DEFAULT_HANDSFREE;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function fetchGlobalDefault(): Promise<boolean> {
  return loadVoicePreferences().then(() => cachedGlobal ?? false);
}

function fetchReplyToVoice(): Promise<boolean> {
  return loadVoicePreferences().then(() => cachedReplyToVoice ?? true);
}

function fetchHandsfree(): Promise<HandsfreeTimings> {
  return loadVoicePreferences().then(() => cachedHandsfree ?? DEFAULT_HANDSFREE);
}

// Speaker buttons announce playback so the hands-free listener can stop
// listening while a reply is read aloud (otherwise it would transcribe the
// speakers). Counted, since two buttons could overlap for a moment.
let ttsPlayingCount = 0;

export function notifyTtsPlayback(playing: boolean): void {
  ttsPlayingCount = Math.max(0, ttsPlayingCount + (playing ? 1 : -1));
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(TTS_PLAYING_EVENT, { detail: { playing: ttsPlayingCount > 0 } }),
  );
}

/** Whether any reply is currently being read aloud in this tab. */
export function useTtsPlaying(): boolean {
  const [playing, setPlaying] = useState(ttsPlayingCount > 0);
  useEffect(() => {
    const onChange = (e: Event) =>
      setPlaying(Boolean((e as CustomEvent).detail?.playing));
    window.addEventListener(TTS_PLAYING_EVENT, onChange);
    return () => window.removeEventListener(TTS_PLAYING_EVENT, onChange);
  }, []);
  return playing;
}

/**
 * Hands-free timings: read by the listener, written from Settings › STT.
 */
export function useVoiceHandsfreePreference() {
  const [value, setVal] = useState<HandsfreeTimings>(
    cachedHandsfree ?? DEFAULT_HANDSFREE,
  );
  const [loading, setLoading] = useState<boolean>(cachedHandsfree === null);

  useEffect(() => {
    let active = true;
    fetchHandsfree().then((v) => {
      if (active) {
        setVal(v);
        setLoading(false);
      }
    });
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent).detail as HandsfreeTimings | undefined;
      if (detail) setVal(detail);
    };
    window.addEventListener(HANDSFREE_EVENT, onChange);
    return () => {
      active = false;
      window.removeEventListener(HANDSFREE_EVENT, onChange);
    };
  }, []);

  const setValue = useCallback(async (patch: Partial<HandsfreeTimings>) => {
    const next = { ...(cachedHandsfree ?? DEFAULT_HANDSFREE), ...patch };
    cachedHandsfree = next;
    setVal(next);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(HANDSFREE_EVENT, { detail: next }));
    }
    const body: Record<string, number> = {};
    if (patch.silenceMs !== undefined) {
      body.voice_handsfree_silence_ms = patch.silenceMs;
    }
    if (patch.sendDelayMs !== undefined) {
      body.voice_handsfree_send_delay_ms = patch.sendDelayMs;
    }
    await apiFetch(apiUrl("/api/settings/voice-handsfree"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }, []);

  return { value, setValue, loading };
}

// The composer flags a send whose text came from the microphone; the reply's
// speaker button consumes the flag once the answer has finished generating.
// One flag per tab is enough: a surface runs one turn at a time, and a typed
// send clears it so a later reply is never spoken by mistake.
let pendingVoiceReply = false;

/** Composer-side: record whether the question just sent was dictated. */
export function markQuestionSent(viaVoice: boolean): void {
  pendingVoiceReply = viaVoice;
}

/** Reply-side: was the question that produced this reply dictated? Clears. */
export function consumeVoiceQuestion(): boolean {
  const value = pendingVoiceReply;
  pendingVoiceReply = false;
  return value;
}

function scopedKey(prefix: string, scopeKey?: string): string {
  return `${prefix}:${scopeKey || "default"}`;
}

function readSession(scopeKey?: string): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const v = browserStorage.readRaw(
      "session",
      scopedKey(SESSION_KEY_PREFIX, scopeKey),
    );
    return v === "on" ? true : v === "off" ? false : null;
  } catch {
    return null;
  }
}

function writeSession(value: boolean, scopeKey?: string): void {
  if (typeof window === "undefined") return;
  try {
    browserStorage.writeRaw(
      "session",
      scopedKey(SESSION_KEY_PREFIX, scopeKey),
      value ? "on" : "off",
    );
    window.dispatchEvent(
      new CustomEvent(SESSION_EVENT, { detail: { scopeKey, value } }),
    );
  } catch {
    // sessionStorage may be unavailable
  }
}

/**
 * Settings-page hook: read/write the persisted global default.
 */
export function useVoiceAutoplayPreference() {
  const [value, setVal] = useState<boolean>(cachedGlobal ?? false);
  const [loading, setLoading] = useState<boolean>(cachedGlobal === null);

  useEffect(() => {
    let active = true;
    fetchGlobalDefault().then((v) => {
      if (active) {
        setVal(v);
        setLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const setValue = useCallback(async (next: boolean) => {
    setVal(next);
    cachedGlobal = next;
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent(GLOBAL_EVENT, { detail: { value: next } }),
      );
    }
    await apiFetch(apiUrl("/api/settings/voice-autoplay"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice_autoplay: next }),
    });
  }, []);

  return { value, setValue, loading };
}

/**
 * Settings-page hook: read/write "reply aloud to questions asked by voice".
 */
export function useVoiceReplyToVoicePreference() {
  const [value, setVal] = useState<boolean>(cachedReplyToVoice ?? true);
  const [loading, setLoading] = useState<boolean>(cachedReplyToVoice === null);

  useEffect(() => {
    let active = true;
    fetchReplyToVoice().then((v) => {
      if (active) {
        setVal(v);
        setLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const setValue = useCallback(async (next: boolean) => {
    setVal(next);
    cachedReplyToVoice = next;
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent(REPLY_TO_VOICE_EVENT, { detail: { value: next } }),
      );
    }
    await apiFetch(apiUrl("/api/settings/voice-reply-to-voice"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice_reply_to_voice: next }),
    });
  }, []);

  return { value, setValue, loading };
}

/**
 * Chat-surface hook: the effective autoplay flag plus the session controls
 * and the first-play prompt gate.
 */
export function useVoiceAutoplay(scopeKey?: string) {
  const normalizedScopeKey = scopeKey || undefined;
  const [globalDefault, setGlobalDefault] = useState<boolean>(
    cachedGlobal ?? false,
  );
  const [stateScopeKey, setStateScopeKey] = useState<string | undefined>(
    normalizedScopeKey,
  );
  const [replyToVoice, setReplyToVoice] = useState<boolean>(
    cachedReplyToVoice ?? true,
  );
  const [sessionOverride, setSessionOverride] = useState<boolean | null>(() =>
    readSession(normalizedScopeKey),
  );
  if (stateScopeKey !== normalizedScopeKey) {
    setStateScopeKey(normalizedScopeKey);
    setSessionOverride(readSession(normalizedScopeKey));
  }

  useEffect(() => {
    let active = true;
    fetchGlobalDefault().then((v) => active && setGlobalDefault(v));
    fetchReplyToVoice().then((v) => active && setReplyToVoice(v));
    const onGlobal = (e: Event) =>
      setGlobalDefault(Boolean((e as CustomEvent).detail?.value));
    const onReplyToVoice = (e: Event) =>
      setReplyToVoice(Boolean((e as CustomEvent).detail?.value));
    const onSession = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { scopeKey?: string; value?: boolean }
        | undefined;
      if ((detail?.scopeKey || undefined) !== normalizedScopeKey) return;
      setSessionOverride(Boolean(detail?.value));
    };
    window.addEventListener(GLOBAL_EVENT, onGlobal);
    window.addEventListener(REPLY_TO_VOICE_EVENT, onReplyToVoice);
    window.addEventListener(SESSION_EVENT, onSession);
    return () => {
      active = false;
      window.removeEventListener(GLOBAL_EVENT, onGlobal);
      window.removeEventListener(REPLY_TO_VOICE_EVENT, onReplyToVoice);
      window.removeEventListener(SESSION_EVENT, onSession);
    };
  }, [normalizedScopeKey]);

  const autoplayEnabled = sessionOverride ?? globalDefault;

  const enableForSession = useCallback(() => {
    writeSession(true, normalizedScopeKey);
    setSessionOverride(true);
  }, [normalizedScopeKey]);

  const disableForSession = useCallback(() => {
    writeSession(false, normalizedScopeKey);
    setSessionOverride(false);
  }, [normalizedScopeKey]);

  const markPrompted = useCallback(() => {
    if (typeof window === "undefined") return;
    try {
      browserStorage.writeRaw(
        "session",
        scopedKey(PROMPTED_KEY_PREFIX, normalizedScopeKey),
        "1",
      );
    } catch {
      // ignore
    }
  }, [normalizedScopeKey]);

  // Offer the "auto-play this session?" prompt only when autoplay isn't already
  // on and we haven't asked yet this session.
  const shouldPromptOnFirstPlay = useCallback((): boolean => {
    if (autoplayEnabled) return false;
    if (sessionOverride !== null) return false;
    if (typeof window === "undefined") return false;
    try {
      return (
        browserStorage.readRaw(
          "session",
          scopedKey(PROMPTED_KEY_PREFIX, normalizedScopeKey),
        ) !== "1"
      );
    } catch {
      return false;
    }
  }, [autoplayEnabled, normalizedScopeKey, sessionOverride]);

  return {
    autoplayEnabled,
    /** Speak the reply to a dictated question even when autoplay is off. */
    replyToVoiceEnabled: replyToVoice,
    enableForSession,
    disableForSession,
    markPrompted,
    shouldPromptOnFirstPlay,
  };
}
