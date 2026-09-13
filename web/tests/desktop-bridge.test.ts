import assert from "node:assert/strict";
import test from "node:test";

import {
  detectDesktopHost,
  isDesktopHost,
  resolveExternalUrl,
} from "../lib/desktop";

const APP = "http://127.0.0.1:3782/chat";

test("browser tabs are not desktop hosts", () => {
  assert.equal(isDesktopHost({}), false);
  assert.equal(detectDesktopHost({}), null);
  assert.equal(isDesktopHost(undefined), false);
});

test("the shell is detected only with a usable opener bridge", () => {
  assert.equal(isDesktopHost({ __TAURI_INTERNALS__: {} }), true);
  // Injected internals but no global API (withGlobalTauri off / IPC denied for
  // this origin): behave like a browser rather than swallowing clicks.
  assert.equal(detectDesktopHost({ __TAURI_INTERNALS__: {} }), null);

  const calls: string[] = [];
  const host = detectDesktopHost({
    __TAURI_INTERNALS__: {},
    __TAURI__: {
      opener: {
        openUrl: async (url: string) => {
          calls.push(url);
        },
      },
    },
  });
  assert.ok(host);
  void host.openUrl("https://example.com/");
  assert.deepEqual(calls, ["https://example.com/"]);
});

test("in-app navigation stays in the webview", () => {
  assert.equal(
    resolveExternalUrl({ href: "/settings", currentHref: APP }),
    null,
  );
  assert.equal(
    resolveExternalUrl({ href: "#section", currentHref: APP }),
    null,
  );
  assert.equal(
    resolveExternalUrl({
      href: "http://127.0.0.1:3782/knowledge",
      target: "_self",
      currentHref: APP,
    }),
    null,
  );
  assert.equal(
    resolveExternalUrl({ href: "javascript:void 0", currentHref: APP }),
    null,
  );
  assert.equal(
    resolveExternalUrl({
      href: "blob:http://127.0.0.1:3782/abc",
      target: "_blank",
      currentHref: APP,
    }),
    null,
  );
  assert.equal(resolveExternalUrl({ href: "", currentHref: APP }), null);
  assert.equal(resolveExternalUrl({ href: null, currentHref: APP }), null);
});

test("other origins open in the OS browser regardless of target", () => {
  assert.equal(
    resolveExternalUrl({
      href: "https://github.com/HKUDS/DeepTutor/releases",
      currentHref: APP,
    }),
    "https://github.com/HKUDS/DeepTutor/releases",
  );
  // A different port is a different origin (e.g. the backend's own docs).
  assert.equal(
    resolveExternalUrl({
      href: "http://127.0.0.1:8001/docs",
      currentHref: APP,
    }),
    "http://127.0.0.1:8001/docs",
  );
});

test("new-window and download links open in the OS browser even when same-origin", () => {
  assert.equal(
    resolveExternalUrl({
      href: "/api/files/report.pdf",
      target: "_BLANK",
      currentHref: APP,
    }),
    "http://127.0.0.1:3782/api/files/report.pdf",
  );
  assert.equal(
    resolveExternalUrl({
      href: "/api/export/session.json",
      download: true,
      currentHref: APP,
    }),
    "http://127.0.0.1:3782/api/export/session.json",
  );
});

test("mailto and tel go to the OS handlers", () => {
  assert.equal(
    resolveExternalUrl({ href: "mailto:hi@example.com", currentHref: APP }),
    "mailto:hi@example.com",
  );
  assert.equal(
    resolveExternalUrl({ href: "tel:+1234", currentHref: APP }),
    "tel:+1234",
  );
});

test("unparseable inputs are left to the webview", () => {
  assert.equal(
    resolveExternalUrl({ href: "http://", currentHref: APP }),
    null,
  );
  assert.equal(
    resolveExternalUrl({
      href: "https://example.com",
      currentHref: "not a url",
    }),
    null,
  );
});
