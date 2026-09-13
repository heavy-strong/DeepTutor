"use client";

import { useEffect } from "react";
import { detectDesktopHost, installDesktopLinkBridge } from "@/lib/desktop";

/**
 * Mounts the Tauri link bridge when the page is hosted by the desktop shell
 * (see `desktop/` and `lib/desktop.ts`). Renders nothing and is a no-op in a
 * browser tab, so it is safe to keep in the root layout unconditionally.
 */
export default function DesktopBridge() {
  useEffect(() => {
    const host = detectDesktopHost(window);
    if (!host) return;
    return installDesktopLinkBridge(window, host);
  }, []);
  return null;
}
