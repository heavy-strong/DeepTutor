"""Pad web/public/logo.png to the square, transparent 1024px source `tauri icon` wants.

Run via ``npm run icons`` from ``desktop/``; the generated ``src-tauri/icons/``
set is checked in, so this only needs to run again when the logo changes.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "web" / "public" / "logo.png"
TARGET = ROOT / "desktop" / "build" / "icon-source.png"
SIZE = 1024
# Leave a margin so rounded OS icon masks do not clip the mark.
INNER = 880


def main() -> None:
    logo = Image.open(SOURCE).convert("RGBA")
    logo.thumbnail((INNER, INNER), Image.LANCZOS)
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    offset = ((SIZE - logo.width) // 2, (SIZE - logo.height) // 2)
    canvas.paste(logo, offset, logo)
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(TARGET)
    print(f"wrote {TARGET}")


if __name__ == "__main__":
    main()
