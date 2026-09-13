/**
 * Per-partner web session key, persisted in localStorage so a refresh / tab
 * switch / navigation reattaches to the SAME conversation. The key is the
 * canonical session id the backend stores under (colon-free, so it doubles as
 * the filename stem and the id used by resume / delete / branch).
 *
 * localStorage is per origin, and the same DeepTutor is reached from several:
 * `localhost` in a browser, `127.0.0.1` in the desktop shell's webview, a LAN
 * address from another machine. A browser that has never opened a partner
 * therefore asks the server which conversation is open (`latestOpenSessionKey`)
 * instead of minting a fresh key — otherwise every origin starts its own
 * conversation and the ones from elsewhere look lost.
 */

import { browserStorage } from "@/shared/storage";

function storageKey(partnerId: string): string {
  return `partner-session:${partnerId}`;
}

export function freshPartnerSessionKey(): string {
  return `web-${Math.random().toString(36).slice(2, 10)}`;
}

/** The key this browser last used for the partner, or null if it never has. */
export function storedPartnerSessionKey(partnerId: string): string | null {
  try {
    return browserStorage.readRaw("local", storageKey(partnerId)) || null;
  } catch {
    return null;
  }
}

export function loadPartnerSessionKey(partnerId: string): string {
  const existing = storedPartnerSessionKey(partnerId);
  if (existing) return existing;
  const fresh = freshPartnerSessionKey();
  persistPartnerSessionKey(partnerId, fresh);
  return fresh;
}

export function persistPartnerSessionKey(partnerId: string, key: string): void {
  try {
    browserStorage.writeRaw("local", storageKey(partnerId), key);
  } catch {
    /* private mode / storage disabled — in-memory only */
  }
}

/**
 * The most recently active, non-archived session from the server's list — the
 * conversation to pick up when this browser has no key of its own. Null when
 * every session is archived (or there are none), meaning a fresh key is right.
 */
export function latestOpenSessionKey(
  sessions: ReadonlyArray<{
    session_key: string;
    archived?: boolean;
    updated_at?: string;
  }>,
): string | null {
  let best: { session_key: string; updated_at?: string } | null = null;
  for (const session of sessions) {
    if (session.archived || !session.session_key) continue;
    if (!best || (session.updated_at ?? "") > (best.updated_at ?? "")) {
      best = session;
    }
  }
  return best?.session_key ?? null;
}
