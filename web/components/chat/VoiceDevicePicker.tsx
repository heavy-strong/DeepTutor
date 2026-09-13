"use client";

import { useEffect, useRef, useState } from "react";
import { Headphones, Mic, Volume2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useVoiceDevices } from "@/hooks/useVoiceDevices";

/**
 * Microphone + speaker choice for this browser. Used inline on the
 * settings page and inside the composer popover.
 */
export function VoiceDevicePicker({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const {
    devices,
    prefs,
    loading,
    speakerSelectable,
    setMic,
    setSpeaker,
    unlockLabels,
  } = useVoiceDevices();

  const selectClass = compact
    ? "w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-[12px] text-[var(--foreground)] disabled:opacity-50"
    : "w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-2 py-1.5 text-[12.5px] text-[var(--foreground)] disabled:opacity-50";
  const labelClass = compact
    ? "mb-1 flex items-center gap-1.5 text-[11px] font-medium text-[var(--muted-foreground)]"
    : "mb-1.5 flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--foreground)]";

  return (
    <div className={compact ? "space-y-3" : "space-y-4"}>
      {!loading && !devices.labelsAvailable && (
        <p className="text-[11.5px] leading-relaxed text-[var(--muted-foreground)]">
          {t("Device names appear once the microphone is allowed.")}{" "}
          <button
            type="button"
            onClick={() => void unlockLabels()}
            className="font-medium text-[var(--primary)] hover:underline"
          >
            {t("Allow microphone")}
          </button>
        </p>
      )}
      <label className="block">
        <span className={labelClass}>
          <Mic size={13} strokeWidth={1.9} />
          {t("Microphone")}
        </span>
        <select
          value={prefs.micId}
          disabled={loading}
          onChange={(e) => setMic(e.target.value)}
          className={selectClass}
        >
          <option value="">{t("System default")}</option>
          {devices.inputs
            .filter((d) => d.deviceId && d.deviceId !== "default")
            .map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
        </select>
      </label>
      <label className="block">
        <span className={labelClass}>
          <Volume2 size={13} strokeWidth={1.9} />
          {t("Speaker")}
        </span>
        <select
          value={prefs.speakerId}
          disabled={loading || !speakerSelectable}
          onChange={(e) => setSpeaker(e.target.value)}
          className={selectClass}
        >
          <option value="">{t("System default")}</option>
          {devices.outputs
            .filter((d) => d.deviceId && d.deviceId !== "default")
            .map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
        </select>
        {!speakerSelectable && (
          <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">
            {t("This browser can't choose an output device; it uses the system default.")}
          </p>
        )}
      </label>
    </div>
  );
}

/**
 * Composer control: a headphones button that shows which mic and speaker
 * the voice features are using and opens the picker to change them.
 */
export function VoiceDeviceButton({
  className = "",
  iconSize = 16,
}: {
  className?: string;
  iconSize?: number;
}) {
  const { t } = useTranslation();
  const { micLabel, speakerLabel } = useVoiceDevices();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Click outside / Escape closes the popover.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const summary = t("Mic: {{mic}} · Speaker: {{speaker}}", {
    mic: micLabel ?? t("System default"),
    speaker: speakerLabel ?? t("System default"),
  });

  return (
    <div ref={rootRef} className="relative flex items-center">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("Voice devices")}
        title={summary}
        data-testid="voice-devices-toggle"
        className={`inline-flex shrink-0 items-center justify-center transition-colors ${
          open
            ? "bg-[var(--muted)] text-[var(--foreground)]"
            : "text-[var(--muted-foreground)] hover:bg-[var(--muted)]/55 hover:text-[var(--foreground)]"
        } ${className}`}
      >
        <Headphones size={iconSize} strokeWidth={1.9} />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t("Voice devices")}
          className="absolute bottom-full left-0 z-30 mb-2 w-72 rounded-xl border border-[var(--border)] bg-[var(--card)] p-3 shadow-lg"
        >
          <p className="mb-2.5 text-[12px] font-medium text-[var(--foreground)]">
            {t("Voice devices")}
          </p>
          <VoiceDevicePicker compact />
          <p className="mt-2.5 text-[10.5px] leading-relaxed text-[var(--muted-foreground)]">
            {t("Remembered for this browser. Applies to the mic, hands-free listening and spoken replies.")}
          </p>
        </div>
      )}
    </div>
  );
}
