"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Square, Volume2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import Tooltip from "@/components/common/Tooltip";
import { apiFetch, apiUrl } from "@/lib/api";
import { applySpeaker } from "@/lib/voice-devices";
import {
  consumeVoiceQuestion,
  notifyTtsPlayback,
  useVoiceAutoplay,
} from "@/hooks/useVoiceAutoplay";

// Speaker button: synthesizes the reply via the configured TTS provider and
// plays it. On the first manual play of a session it offers to auto-play the
// rest; `autoPlayFresh` triggers playback automatically for a reply that just
// finished generating when auto-play is on — or when the question it answers
// was dictated through the mic and "reply to voice" is on.
export function PlayAudioButton({
  content,
  conversationKey,
  autoPlayFresh,
}: {
  content: string;
  conversationKey?: string;
  autoPlayFresh: boolean;
}) {
  const { t } = useTranslation();
  const {
    autoplayEnabled,
    replyToVoiceEnabled,
    enableForSession,
    markPrompted,
    shouldPromptOnFirstPlay,
  } = useVoiceAutoplay(conversationKey);
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  const [showPrompt, setShowPrompt] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const autoPlayedRef = useRef(false);
  // Whether this button has told the hands-free listener it is playing, so
  // the matching "stopped" notice goes out exactly once.
  const announcedRef = useRef(false);

  const cleanup = useCallback(() => {
    if (announcedRef.current) {
      announcedRef.current = false;
      notifyTtsPlayback(false);
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  const play = useCallback(async () => {
    setState("loading");
    try {
      const resp = await apiFetch(apiUrl("/api/voice/tts"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: content }),
      });
      if (!resp.ok) {
        cleanup();
        setState("idle");
        return;
      }
      const blob = await resp.blob();
      cleanup();
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      await applySpeaker(audio);
      audio.onended = () => {
        setState("idle");
        cleanup();
      };
      audio.onerror = () => {
        setState("idle");
        cleanup();
      };
      announcedRef.current = true;
      notifyTtsPlayback(true);
      await audio.play();
      setState("playing");
    } catch {
      cleanup();
      setState("idle");
    }
  }, [cleanup, content]);

  const handleClick = useCallback(() => {
    if (state === "playing" || state === "loading") {
      cleanup();
      setState("idle");
      return;
    }
    const willPrompt = shouldPromptOnFirstPlay();
    void play();
    if (willPrompt) {
      markPrompted();
      setShowPrompt(true);
    }
  }, [cleanup, markPrompted, play, shouldPromptOnFirstPlay, state]);

  // Auto-play a freshly-generated reply exactly once: when auto-play is on,
  // or when the question was dictated and "reply to voice" is on. Synthesis
  // starts off the effect body (it sets state), on a timer that is
  // deliberately NOT cleared in a cleanup: an earlier version cancelled it
  // there, which silently dropped the playback whenever the effect re-ran
  // before the timer fired — React's StrictMode double-invocation on mount
  // does exactly that. ``autoPlayedRef`` is what keeps it to one play.
  useEffect(() => {
    if (!autoPlayFresh || autoPlayedRef.current) return;
    if (!content.trim()) return;
    // Consume the flag even when we won't speak, so it can't leak onto a
    // later reply after the user flips the preference.
    const askedByVoice = consumeVoiceQuestion();
    if (!autoplayEnabled && !(askedByVoice && replyToVoiceEnabled)) return;
    autoPlayedRef.current = true;
    window.setTimeout(() => void play(), 0);
  }, [autoPlayFresh, autoplayEnabled, content, play, replyToVoiceEnabled]);

  useEffect(() => cleanup, [cleanup]);

  return (
    <div className="relative inline-flex">
      <Tooltip
        label={state === "playing" ? t("Stop") : t("Play aloud")}
        side="top"
      >
        <button
          type="button"
          onClick={handleClick}
          aria-label={state === "playing" ? t("Stop") : t("Play aloud")}
          className={`inline-flex items-center justify-center rounded-md p-1 transition-colors ${
            state === "playing"
              ? "text-[var(--primary)]"
              : "text-[var(--muted-foreground)] hover:bg-[var(--muted)]/50 hover:text-[var(--foreground)]"
          }`}
        >
          {state === "loading" ? (
            <Loader2 size={15} strokeWidth={1.8} className="animate-spin" />
          ) : state === "playing" ? (
            <Square size={13} strokeWidth={1.8} className="fill-current" />
          ) : (
            <Volume2 size={15} strokeWidth={1.5} />
          )}
        </button>
      </Tooltip>
      {showPrompt && (
        <div className="absolute bottom-full left-0 z-30 mb-2 w-60 rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 shadow-lg">
          <p className="text-[12px] leading-relaxed text-[var(--foreground)]">
            {t("Auto-play replies in this conversation?")}
          </p>
          <div className="mt-2.5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowPrompt(false)}
              className="rounded-md px-2.5 py-1 text-[11.5px] text-[var(--muted-foreground)] hover:bg-[var(--muted)]/50 hover:text-[var(--foreground)]"
            >
              {t("Not now")}
            </button>
            <button
              type="button"
              onClick={() => {
                enableForSession();
                setShowPrompt(false);
              }}
              className="rounded-md bg-[var(--primary)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--primary-foreground)] hover:bg-[var(--primary)]/90"
            >
              {t("Turn on")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
