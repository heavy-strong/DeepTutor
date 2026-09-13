"use client";

import { useTranslation } from "react-i18next";

import { ServiceConfigEditor } from "@/components/settings/ServiceConfigEditor";
import { SettingsPageHeader } from "@/components/settings/shared";
import {
  useVoiceAutoplayPreference,
  useVoiceReplyToVoicePreference,
} from "@/hooks/useVoiceAutoplay";

function PlaybackToggle({
  label,
  description,
  value,
  loading,
  onChange,
  className,
}: {
  label: string;
  description: string;
  value: boolean;
  loading: boolean;
  onChange: (next: boolean) => void;
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
      <button
        type="button"
        role="switch"
        aria-checked={value}
        disabled={loading}
        onClick={() => onChange(!value)}
        className={`relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
          value ? "bg-[var(--foreground)]" : "bg-[var(--border)]"
        }`}
        aria-label={label}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-[var(--background)] shadow-sm transition-transform ${
            value ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
    </div>
  );
}

function AutoplayToggle() {
  const { t } = useTranslation();
  const { value, setValue, loading } = useVoiceAutoplayPreference();
  return (
    <PlaybackToggle
      label={t("Auto-play replies")}
      description={t(
        "Read each assistant reply aloud automatically. You can also toggle this per conversation from the speaker button.",
      )}
      value={value}
      loading={loading}
      onChange={(next) => void setValue(next)}
      className="border-t border-[var(--border)]/50"
    />
  );
}

function ReplyToVoiceToggle() {
  const { t } = useTranslation();
  const { value, setValue, loading } = useVoiceReplyToVoicePreference();
  return (
    <PlaybackToggle
      label={t("Reply aloud to voice questions")}
      description={t(
        "When you dictate a question with the microphone, read the reply aloud even if auto-play is off. Typed questions stay silent.",
      )}
      value={value}
      loading={loading}
      onChange={(next) => void setValue(next)}
      className="border-y border-[var(--border)]/50"
    />
  );
}

export default function TtsSettingsPage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-10">
      <SettingsPageHeader
        title={t("Text-to-Speech")}
        description={t(
          "Read assistant replies aloud from the speaker button in chat and partner conversations. Works with any OpenAI-compatible audio API — OpenAI, OpenRouter, Groq, SiliconFlow, Azure, or a local server.",
        )}
      />

      <ServiceConfigEditor service="tts" />

      <section>
        <div className="mb-3">
          <h2 className="text-[15px] font-semibold tracking-tight text-[var(--foreground)]">
            {t("Playback")}
          </h2>
          <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--muted-foreground)]">
            {t("How spoken replies behave in chat.")}
          </p>
        </div>
        <AutoplayToggle />
        <ReplyToVoiceToggle />
      </section>
    </div>
  );
}
