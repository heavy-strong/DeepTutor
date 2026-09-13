# DeepTutor Desktop (Tauri)

A native window for DeepTutor. The shell launches the local runtime
(`deeptutor start`) the same way `deeptutor start --detach` does, shows a boot
screen until both servers answer, then loads the Web UI in a Tauri webview.
Closing the window stops the runtime it started.

Nothing about the Web UI or the Python backend is forked: the shell is a thin
supervisor around the existing launcher contract in
`deeptutor/runtime/launcher.py` (`data/user/runtime/launcher.json` /
`launcher.stop`), so `deeptutor stop` still works and a runtime that is already
running is attached to instead of started twice.

## Prerequisites

| Requirement | Why |
| --- | --- |
| A working DeepTutor install (`pip install deeptutor`, or `pip install -e .` in this checkout with `web/` built) | The shell only *launches* DeepTutor; it does not bundle Python or Node. |
| Rust toolchain via [rustup](https://rustup.rs) | Compiles the shell. |
| Platform webview deps — WebView2 (Windows, preinstalled on 10/11), Xcode CLT (macOS), `webkit2gtk-4.1` + `libappindicator3` (Linux) | See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). |
| Node ≥ 20 | Runs the Tauri CLI (`@tauri-apps/cli`). |

## Run from this checkout

```bash
cd desktop
npm install
npm run dev        # debug build, opens the window
npm run build      # release bundle under src-tauri/target/release/bundle/
```

When launched from inside the repository (or from a binary built under
`desktop/src-tauri/target/`), the shell picks this checkout as the runtime
home — the same workspace `deeptutor start` would use from the repo root — and
prefers `./.venv` if one exists.

## Configuration

Every setting can come from the environment or from `desktop.json` in the
app's config directory (shown on the boot screen; e.g.
`%APPDATA%\info.deeptutor.desktop\desktop.json` on Windows,
`~/Library/Application Support/info.deeptutor.desktop/desktop.json` on macOS,
`~/.config/info.deeptutor.desktop/desktop.json` on Linux). Environment wins.

| `desktop.json` key | Environment | Meaning |
| --- | --- | --- |
| `home` | `DEEPTUTOR_HOME` | Runtime workspace root (`--home`). Defaults to the enclosing source checkout, else `<app data dir>/home`. |
| `python` | `DEEPTUTOR_DESKTOP_PYTHON` | Interpreter with DeepTutor installed; runs `python -m deeptutor_cli.main start`. |
| `command` | `DEEPTUTOR_DESKTOP_COMMAND` | Explicit `deeptutor` executable (wins over `python`). |
| `url` | `DEEPTUTOR_DESKTOP_URL` | Attach to an already running DeepTutor at this URL instead of launching one. Useful against Docker. |
| `dev` | `DEEPTUTOR_DESKTOP_DEV` | Pass `--dev` (Next.js dev server) to the launcher. |

Without overrides the launcher is found in this order: `<home>/.venv`,
`deeptutor` on `PATH`, then `python3`/`python` on `PATH` that can import
`deeptutor_cli`.

Example `desktop.json` for a pip install with its own workspace:

```json
{
  "home": "~/DeepTutor",
  "python": "~/.venvs/deeptutor/bin/python"
}
```

## How the pieces fit

```
desktop/
  splash/index.html            boot screen (frontendDist); listens for deeptutor:status
  src-tauri/src/config.rs      env / desktop.json resolution
  src-tauri/src/runtime.rs     spawn `deeptutor start`, drive launcher.json/.stop, readiness, shutdown
  src-tauri/src/lib.rs         Tauri wiring, `runtime_status` / `retry_runtime` commands
  src-tauri/capabilities/      IPC allow-list: the boot screen (default.json) and the
                               localhost Web UI (remote.json — opener only)
web/lib/desktop.ts             host detection + link routing rules (unit-tested)
web/components/desktop/DesktopBridge.tsx   mounted in the root layout
```

Inside the shell the Web UI sets `<html data-desktop="tauri">` and routes
`target="_blank"`, cross-origin and `download` links (and `window.open`) to the
OS browser through Tauri's opener plugin, since a webview has no tab strip.

## Known limitations

- Python and Node are not bundled; the shell needs an existing DeepTutor
  install on the machine. Bundling a self-contained runtime is a separate
  packaging step.
- OAuth flows that open an `about:blank` popup and steer it afterwards
  (Codex / CodeBuddy sign-in) cannot run inside the webview; finish those in a
  browser tab against the same local URL.
- Icons are generated from `web/public/logo.png` via `npm run icons` (needs
  Pillow in the active Python); the output in `src-tauri/icons/` is committed.
