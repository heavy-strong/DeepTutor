import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const vadDir = path.join(webRoot, "node_modules", "@ricky0123", "vad-web", "dist");
const ortDir = path.join(webRoot, "node_modules", "onnxruntime-web", "dist");
const targetDir = path.join(webRoot, "public", "vad");

// The hands-free listener runs Silero VAD in the browser. The model and the
// AudioWorklet come from vad-web; the ONNX runtime is a wasm module that
// onnxruntime-web resolves at runtime from `env.wasm.wasmPaths`. Neither is
// traced into Next's bundles, and the packages default to a CDN — so they
// are vendored into public/ (like pdfjs) to keep the desktop app offline-safe.
const VAD_FILES = ["vad.worklet.bundle.min.js", "silero_vad_v5.onnx"];

/**
 * Copy the voice-activity-detection runtime into Next's public asset tree.
 */
export function copyVadAssets() {
  if (!existsSync(vadDir) || !existsSync(ortDir)) {
    throw new Error(
      `Missing VAD assets at ${vadDir} or ${ortDir}. Run npm install first.`,
    );
  }

  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  for (const file of VAD_FILES) {
    copyFileSync(path.join(vadDir, file), path.join(targetDir, file));
  }
  // The non-JSEP, non-asyncify wasm build plus its loader is all the
  // single-threaded CPU path needs.
  for (const file of readdirSync(ortDir)) {
    if (/^ort-wasm-simd-threaded\.(wasm|mjs)$/.test(file)) {
      copyFileSync(path.join(ortDir, file), path.join(targetDir, file));
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  copyVadAssets();
}
