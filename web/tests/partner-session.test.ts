import assert from "node:assert/strict";
import test from "node:test";

import { latestOpenSessionKey } from "../lib/partner-session";

test("latestOpenSessionKey picks the most recently updated open conversation", () => {
  assert.equal(
    latestOpenSessionKey([
      { session_key: "web-old", updated_at: "2026-08-01T10:00:00" },
      { session_key: "web-new", updated_at: "2026-08-30T17:49:20" },
      { session_key: "web-mid", updated_at: "2026-08-15T09:00:00" },
    ]),
    "web-new",
  );
});

test("latestOpenSessionKey skips archived conversations", () => {
  assert.equal(
    latestOpenSessionKey([
      { session_key: "web-archived", archived: true, updated_at: "2026-09-01" },
      { session_key: "web-open", archived: false, updated_at: "2026-08-01" },
    ]),
    "web-open",
  );
});

test("latestOpenSessionKey is null when nothing is open", () => {
  assert.equal(latestOpenSessionKey([]), null);
  assert.equal(
    latestOpenSessionKey([{ session_key: "web-x", archived: true }]),
    null,
  );
});
