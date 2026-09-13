"use client";

import { useTranslation } from "react-i18next";

import { ServiceConfigEditor } from "@/components/settings/ServiceConfigEditor";
import { SettingsPageHeader } from "@/components/settings/shared";
import { useVoiceHandsfreePreference } from "@/hooks/useVoiceAutoplay";
import { VoiceDevicePicker } from "@/components/chat/VoiceDevicePicker";

function TimingRow({
  label,
  description,
  value,
  options,
  loading,
  onChange,
  className,
}: {
  label: string;
  description: string;
  value: number;
  options: { value: number; label: string }[];
  loading: boolean;
  onChange: (next: number) => void;
  className: string;
}) {
  return (
    <div className={`flex items-start justify-between gap-6 py-3.5 ${className}`}>
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-medium text-[var(--foreground)]">
          {label}
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-[var(--muted-foreground)]">
          {description}
        </p>
      </div>
      <select
        value={value}
        disabled={loading}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        className="mt-0.5 shrink-0 rounded-md border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-[12.5px] text-[var(--foreground)] disabled:opacity-50"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function HandsFreeSettings() {
  const { t } = useTranslation();
  const { value, setValue, loading } = useVoiceHandsfreePreference();
  const seconds = (ms: number) =>
    t("{{seconds}}s", { seconds: (ms / 1000).toFixed(ms % 1000 ? 1 : 0) });
  return (
    <section className="mt-10">
      <div className="mb-3">
        <h2 className="text-[15px] font-semibold tracking-tight text-[var(--foreground)]">
          {t("Hands-free listening")}
        </h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--muted-foreground)]">
          {t(
            "Turn it on from the composer's listening button. A voice detector running in your browser picks out each sentence, transcribes it, and sends it — no pressing required. Listening pauses while a reply is generating or being read aloud.",
          )}
        </p>
      </div>
      <TimingRow
        label={t("End of sentence after")}
        description={t(
          "How long a pause ends what you're saying. Shorter feels snappier; longer tolerates thinking mid-sentence.",
        )}
        value={value.silenceMs}
        options={[500, 800, 1200, 1500, 2000].map((ms) => ({
          value: ms,
          label: seconds(ms),
        }))}
        loading={loading}
        onChange={(silenceMs) => void setValue({ silenceMs })}
        className="border-t border-[var(--border)]/50"
      />
      <TimingRow
        label={t("Send after")}
        description={t(
          "Review window before a transcribed sentence is sent. Editing the draft cancels it. Choose immediately to skip the wait.",
        )}
        value={value.sendDelayMs}
        options={[
          { value: 0, label: t("Immediately") },
          ...[1000, 2000, 3000, 5000].map((ms) => ({
            value: ms,
            label: seconds(ms),
          })),
        ]}
        loading={loading}
        onChange={(sendDelayMs) => void setValue({ sendDelayMs })}
        className="border-y border-[var(--border)]/50"
      />
    </section>
  );
}

export default function SttSettingsPage() {
  const { t } = useTranslation();
  return (
    <div>
      <SettingsPageHeader
        title={t("Speech-to-Text")}
        description={t(
          "Transcribe the chat composer's microphone recordings. Works with any OpenAI-compatible audio API — OpenAI, Groq, SiliconFlow, Azure, or a local server.",
        )}
      />
      <ServiceConfigEditor service="stt" />
      <section className="mt-10">
        <div className="mb-3">
          <h2 className="text-[15px] font-semibold tracking-tight text-[var(--foreground)]">
            {t("Voice devices")}
          </h2>
          <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--muted-foreground)]">
            {t(
              "Which microphone and speaker this browser uses for dictation, hands-free listening and spoken replies. Also reachable from the headphones button in the composer.",
            )}
          </p>
        </div>
        <div className="max-w-md">
          <VoiceDevicePicker />
        </div>
      </section>
      <HandsFreeSettings />
    </div>
  );
}
