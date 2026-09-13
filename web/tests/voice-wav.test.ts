import test from "node:test";
import assert from "node:assert/strict";

import { encodeWav } from "../lib/voice-wav";

test("encodeWav writes a 16-bit mono PCM header and clamped samples", async () => {
  const blob = encodeWav(new Float32Array([0, 1, -1, 0.5, 2]), 16000);
  assert.equal(blob.type, "audio/wav");
  const view = new DataView(await blob.arrayBuffer());
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(
      ...Array.from({ length }, (_, i) => view.getUint8(offset + i)),
    );

  assert.equal(ascii(0, 4), "RIFF");
  assert.equal(ascii(8, 4), "WAVE");
  assert.equal(view.getUint16(22, true), 1); // mono
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(34, true), 16); // bits per sample
  assert.equal(view.getUint32(40, true), 5 * 2); // data bytes
  assert.equal(view.byteLength, 44 + 10);

  assert.equal(view.getInt16(44, true), 0);
  assert.equal(view.getInt16(46, true), 0x7fff);
  assert.equal(view.getInt16(48, true), -0x8000);
  assert.equal(view.getInt16(50, true), Math.trunc(0.5 * 0x7fff));
  assert.equal(view.getInt16(52, true), 0x7fff); // clamped, not wrapped
});
