export type Language = "en" | "zh" | "ko";

export function languageFromI18n(language: string | undefined): Language {
  const code = (language ?? "en").toLowerCase();
  if (code.startsWith("zh")) return "zh";
  if (code.startsWith("ko")) return "ko";
  return "en";
}

export function getLocale(lang: Language): string {
  if (lang === "zh") return "zh-CN";
  if (lang === "ko") return "ko-KR";
  return "en-US";
}

export function formatDate(
  date: Date,
  lang: Language,
  options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
  },
): string {
  return new Intl.DateTimeFormat(getLocale(lang), options).format(date);
}

export function formatTime(
  date: Date,
  lang: Language,
  options: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" },
): string {
  return new Intl.DateTimeFormat(getLocale(lang), options).format(date);
}
