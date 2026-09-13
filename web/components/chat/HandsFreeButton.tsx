"use client";

import { AudioLines, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { HandsFreeState } from "@/hooks/useHandsFreeVoice";

/**
 * Hands-free listening toggle shared by the chat and partner composers. One
 * control, six looks: off, loading the detector, listening (soft pulse),
 * speaking (solid), transcribing (spinner), and a send countdown (number).
 */
export function HandsFreeButton({
  state,
  countdown,
  error,
  disabled,
  onClick,
  className = "",
  iconSize = 16,
}: {
  state: HandsFreeState;
  countdown: number | null;
  error?: string | null;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
  iconSize?: number;
}) {
  const { t } = useTranslation();
  const labels: Record<HandsFreeState, string> = {
    off: t("Hands-free listening"),
    loading: t("Starting hands-free listening…"),
    listening: t("Listening — speak whenever you're ready"),
    speaking: t("Hearing you…"),
    transcribing: t("Transcribing…"),
    countdown: t("Sending in {{seconds}}s — edit to cancel", {
      seconds: countdown ?? 0,
    }),
    paused: t("Hands-free paused while the reply plays"),
  };
  const label = labels[state];
  const active = state !== "off";
  const tone =
    state === "off"
      ? "text-[var(--muted-foreground)] hover:bg-[var(--muted)]/55 hover:text-[var(--foreground)]"
      : state === "speaking"
        ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
        : state === "paused"
          ? "bg-[var(--muted)]/60 text-[var(--muted-foreground)]"
          : "bg-[var(--primary)]/12 text-[var(--primary)]";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      aria-label={label}
      data-testid="hands-free-toggle"
      data-state={state}
      title={error || label}
      className={`relative inline-flex shrink-0 items-center justify-center transition-[background-color,color,transform] duration-150 active:scale-90 disabled:opacity-40 ${tone} ${className}`}
    >
      {state === "listening" && (
        <span className="pointer-events-none absolute inset-0 animate-pulse rounded-[inherit] border border-[var(--primary)]/40" />
      )}
      {state === "loading" || state === "transcribing" ? (
        <Loader2 size={iconSize} strokeWidth={1.9} className="animate-spin" />
      ) : state === "countdown" ? (
        <span className="text-[12px] font-semibold tabular-nums">
          {countdown ?? 0}
        </span>
      ) : (
        <AudioLines size={iconSize} strokeWidth={1.9} />
      )}
    </button>
  );
}
