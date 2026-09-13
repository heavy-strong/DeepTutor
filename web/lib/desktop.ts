/**
 * Desktop (Tauri) host detection and link routing.
 *
 * The desktop shell in `desktop/` opens the regular Web UI served by the local
 * runtime inside a native webview. Two things differ from a browser tab:
 *
 * - There is no tab strip, so `target="_blank"` links and `window.open` have
 *   nowhere to go. WebView2 pops a bare window, WKWebView drops them. Routing
 *   those through the OS browser via Tauri's opener plugin restores the
 *   "open in a new tab" experience.
 * - The page can tell it is hosted: `<html data-desktop="tauri">` lets styles
 *   or components adapt (hide "open in browser" hints, tighten chrome, …).
 *
 * Kept free of React so the routing rules are unit-testable in Node.
 */

export interface DesktopHost {
  openUrl(url: string): Promise<void>;
}

interface TauriGlobal {
  opener?: { openUrl?: (url: string) => Promise<void> };
}

interface DesktopWindow {
  __TAURI_INTERNALS__?: unknown;
  __TAURI__?: TauriGlobal;
}

export const DESKTOP_HOST_ATTRIBUTE = "desktop";
export const DESKTOP_HOST_TAURI = "tauri";

/** Whether this document runs inside the DeepTutor desktop shell. */
export function isDesktopHost(win: unknown = globalThis): boolean {
  const candidate = win as DesktopWindow | undefined;
  return Boolean(candidate && "__TAURI_INTERNALS__" in candidate);
}

/**
 * The host bridge, if the shell injected one. `withGlobalTauri` exposes the
 * opener plugin on `window.__TAURI__` so the Web bundle needs no Tauri package.
 */
export function detectDesktopHost(
  win: unknown = globalThis,
): DesktopHost | null {
  if (!isDesktopHost(win)) return null;
  const openUrl = (win as DesktopWindow).__TAURI__?.opener?.openUrl;
  if (typeof openUrl !== "function") return null;
  return { openUrl: (url) => openUrl(url) };
}

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

export interface LinkIntent {
  href: string | null | undefined;
  /** The anchor's `target` (or `window.open`'s second argument). */
  target?: string | null;
  /** Present on `<a download>` — the webview cannot save files itself. */
  download?: boolean;
  /** `location.href` of the document the link lives in. */
  currentHref: string;
}

/**
 * The absolute URL the OS browser should open for this link, or `null` when
 * the webview should handle it as usual (same-origin in-app navigation,
 * `javascript:`/`blob:` schemes, hash jumps, …).
 */
export function resolveExternalUrl(intent: LinkIntent): string | null {
  const raw = intent.href?.trim();
  if (!raw) return null;
  let url: URL;
  let current: URL;
  try {
    current = new URL(intent.currentHref);
    url = new URL(raw, current);
  } catch {
    return null;
  }
  if (!EXTERNAL_PROTOCOLS.has(url.protocol)) return null;
  if (url.protocol === "mailto:" || url.protocol === "tel:") return url.href;
  const newWindow = (intent.target ?? "").toLowerCase() === "_blank";
  if (url.origin !== current.origin) return url.href;
  if (intent.download) return url.href;
  return newWindow ? url.href : null;
}

/**
 * Route new-window navigations to the OS browser. Returns a disposer so the
 * bridge can be mounted from a React effect.
 */
export function installDesktopLinkBridge(
  win: Window,
  host: DesktopHost,
): () => void {
  const doc = win.document;
  doc.documentElement.setAttribute(
    `data-${DESKTOP_HOST_ATTRIBUTE}`,
    DESKTOP_HOST_TAURI,
  );

  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as Element | null)?.closest?.(
      "a[href]",
    ) as HTMLAnchorElement | null;
    if (!anchor) return;
    const external = resolveExternalUrl({
      href: anchor.getAttribute("href"),
      target: anchor.getAttribute("target"),
      download: anchor.hasAttribute("download"),
      currentHref: win.location.href,
    });
    if (!external) return;
    event.preventDefault();
    void host.openUrl(external).catch(() => {});
  };
  doc.addEventListener("click", onClick, true);

  const nativeOpen = win.open;
  const patchedOpen: Window["open"] = (url, target, features) => {
    const external = resolveExternalUrl({
      href: url == null ? null : String(url),
      target: target ?? "_blank",
      currentHref: win.location.href,
    });
    if (!external) return nativeOpen.call(win, url, target, features);
    void host.openUrl(external).catch(() => {});
    return null;
  };
  win.open = patchedOpen;

  return () => {
    doc.removeEventListener("click", onClick, true);
    if (win.open === patchedOpen) win.open = nativeOpen;
    doc.documentElement.removeAttribute(`data-${DESKTOP_HOST_ATTRIBUTE}`);
  };
}
