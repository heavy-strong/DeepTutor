import test from "node:test";
import assert from "node:assert/strict";

import {
  isAppLanguage,
  normalizeLanguage,
  resolveResponseLanguage,
} from "../context/app-shell-storage";

test("response language remains independent from the interface language", () => {
  assert.equal(resolveResponseLanguage("zh", "en"), "zh");
  assert.equal(resolveResponseLanguage("en", "zh"), "en");
  assert.equal(resolveResponseLanguage("ko", "en"), "ko");
});

test("legacy settings inherit the interface language when response language is missing", () => {
  assert.equal(resolveResponseLanguage(null, "zh"), "zh");
  assert.equal(resolveResponseLanguage(undefined, "en"), "en");
  assert.equal(resolveResponseLanguage(null, "ko"), "ko");
});

test("interface language accepts korean", () => {
  assert.equal(normalizeLanguage("ko"), "ko");
  assert.equal(normalizeLanguage("zh"), "zh");
  assert.equal(normalizeLanguage("en"), "en");
  assert.equal(normalizeLanguage("fr"), "en");
  assert.equal(isAppLanguage("ko"), true);
  assert.equal(isAppLanguage("fr"), false);
});
