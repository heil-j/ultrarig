"""Add AI Tone to an installed UltraRig Editor (the desktop app), and take it out again.

The editor is an Electron app: its control page lives in resources/app.asar (www/tankg.html). This script
  1. keeps a copy of the untouched archive, once, as resources/app.asar.original,
  2. unpacks that original, adds web/aitone.js and web/aitone.css from this repo to www/,
     and makes the same three small edits to www/tankg.html as the browser page in web/,
  3. packs it back as resources/app.asar.
It always starts from the .original, so running it again (for example after editing aitone.js) is safe.
The editor's Electron build does not check the archive's integrity (EnableEmbeddedAsarIntegrityValidation is off).

    python desktop/patch_editor.py "C:/Users/<you>/Music"            # the folder with "UltraRig Editor.exe"
    python desktop/patch_editor.py "C:/Users/<you>/Music" --restore  # put the original back

Close the editor first. Standard library only.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
WEB = HERE.parent / "web"
MARK = "/* AI tone (aitone.js)"

# (what to find, what to put instead): each must match exactly once in the editor's www/tankg.html
EDITS = [
    ("</head>", '<link rel="stylesheet" href="aitone.css">\n</head>'),
    ("</body>",
     "<!-- AI tone (the tankgtone fork): the AI TONE button and panel. Separate file so UltraRig updates merge cleanly -->\n"
     '<script src="aitone.js"></script>\n</body>'),
    ("async function pioImport(text) {",
     MARK + ": o.auto = load without the \"Import?\" question when nothing unsaved would be lost */\n"
     "async function pioImport(text, o = {}) {"),
    ('  if (!await uiConfirm({ title: T("Import \\"{name}\\"?", { name }), okLabel: "Import",',
     '  if (!(o.auto && !edCount() && !at.ups.length) && !await uiConfirm({ title: T(o.auto ? "Load \\"{name}\\"?" : '
     '"Import \\"{name}\\"?", { name }), okLabel: o.auto ? "Load" : "Import",'),
    ('  if (PH) setTab("presets"); else {',
     '  if (o.auto) return true;                                                 /* (AI tone: the chain stays in view) */\n'
     '  if (PH) setTab("presets"); else {'),
]


# ---- the .asar format: [4][pickle size][payload size][json length][json][pad] then the files ----

def asar_read(path: Path) -> tuple[dict, int]:
    with open(path, "rb") as f:
        _four, pickle_size, _payload, json_len = struct.unpack("<4I", f.read(16))
        header = json.loads(f.read(json_len).decode("utf-8"))
    return header, 8 + pickle_size


def asar_walk(node: dict, prefix: str = ""):
    for name, child in node.get("files", {}).items():
        p = f"{prefix}/{name}" if prefix else name
        if "files" in child:
            yield from asar_walk(child, p)
        else:
            yield p, child


def asar_extract(archive: Path, out: Path) -> None:
    header, base = asar_read(archive)
    root = out.resolve()
    with open(archive, "rb") as f:
        for p, e in asar_walk(header):
            dest = (out / p).resolve()
            if root not in dest.parents:
                raise SystemExit(f"unsafe path in the archive: {p}")
            if e.get("unpacked") or "link" in e:
                raise SystemExit(f"this editor has unpacked or linked files ({p}); not supported")
            dest.parent.mkdir(parents=True, exist_ok=True)
            f.seek(base + int(e["offset"]))
            dest.write_bytes(f.read(e["size"]))


def asar_pack(src: Path, archive: Path) -> None:
    blobs, offset = [], 0

    def add(directory: Path) -> dict:
        nonlocal offset
        node = {}
        for entry in sorted(directory.iterdir(), key=lambda x: x.name):
            if entry.is_dir():
                node[entry.name] = {"files": add(entry)}
            else:
                data = entry.read_bytes()
                node[entry.name] = {"size": len(data), "offset": str(offset)}
                blobs.append(data)
                offset += len(data)
        return node

    js = json.dumps({"files": add(src)}, separators=(",", ":")).encode("utf-8")
    payload = struct.pack("<I", len(js)) + js + b"\0" * ((4 - len(js) % 4) % 4)
    pickle = struct.pack("<I", len(payload)) + payload
    with open(archive, "wb") as f:
        f.write(struct.pack("<II", 4, len(pickle)))
        f.write(pickle)
        for b in blobs:
            f.write(b)


# ---- the patch ---------------------------------------------------------------------------------

def patch_page(page: Path) -> None:
    text = page.read_text(encoding="utf-8")
    if MARK in text or 'src="aitone.js"' in text:
        raise SystemExit("www/tankg.html already has AI Tone: the .original backup is not the original")
    for find, put in EDITS:
        n = text.count(find)
        if n != 1:
            raise SystemExit(f"this editor's page changed: expected one {find[:60]!r}, found {n}. Nothing was written.")
        text = text.replace(find, put)
    page.write_text(text, encoding="utf-8", newline="")


def editor_running(folder: Path) -> bool:
    """Is the editor in `folder` open? (Another copy elsewhere doesn't lock this one.)"""
    if os.name != "nt":
        return False
    out = subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         "Get-Process -Name 'UltraRig Editor' -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }"],
        capture_output=True, text=True).stdout
    here = (folder / "UltraRig Editor.exe").resolve()
    return any(Path(line.strip()).resolve() == here for line in out.splitlines() if line.strip())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("editor", help='the folder with "UltraRig Editor.exe" (and resources/app.asar)')
    ap.add_argument("--restore", action="store_true", help="put the original app.asar back")
    args = ap.parse_args()

    res = Path(args.editor) / "resources"
    asar, orig = res / "app.asar", res / "app.asar.original"
    if not asar.is_file():
        print(f"no resources/app.asar in {args.editor}", file=sys.stderr)
        return 1
    if editor_running(Path(args.editor)):
        print("Close UltraRig Editor first, then run this again.", file=sys.stderr)
        return 1

    if args.restore:
        if not orig.is_file():
            print("no app.asar.original: the editor was never patched (nothing to restore)")
            return 0
        shutil.copy2(orig, asar)
        print("Restored the original editor. AI Tone is gone; app.asar.original is kept.")
        return 0

    if not orig.is_file():
        shutil.copy2(asar, orig)
        print(f"Backed up the original editor to {orig}")
    for f in ("aitone.js", "aitone.css"):
        if not (WEB / f).is_file():
            print(f"missing {WEB / f}", file=sys.stderr)
            return 1

    with tempfile.TemporaryDirectory(prefix="ultrarig_editor_") as tmp:
        src = Path(tmp) / "app"
        asar_extract(orig, src)
        page = src / "www" / "tankg.html"
        if not page.is_file():
            print("this editor has no www/tankg.html: unknown layout, nothing written", file=sys.stderr)
            return 1
        patch_page(page)
        idx = src / "www" / "index.html"
        if idx.is_file():                               # the editor ships index.html as a copy of tankg.html
            shutil.copy2(page, idx)
        for f in ("aitone.js", "aitone.css"):
            shutil.copy2(WEB / f, src / "www" / f)
        out = Path(tmp) / "app.asar"
        asar_pack(src, out)
        # check what was written reads back with the same files
        before = {p for p, _ in asar_walk(asar_read(orig)[0])}
        after = {p for p, _ in asar_walk(asar_read(out)[0])}
        if after != before | {"www/aitone.js", "www/aitone.css"}:
            print("the new archive doesn't match the original's files: nothing written", file=sys.stderr)
            return 1
        shutil.copyfile(out, asar)

    page_info = {}
    try:
        h, base = asar_read(orig)
        e = dict(asar_walk(h)).get("www/page.json")
        if e:
            with open(orig, "rb") as f:
                f.seek(base + int(e["offset"]))
                page_info = json.loads(f.read(e["size"]))
    except Exception:
        pass
    print(f"AI Tone added to UltraRig Editor (page {page_info.get('release', '?')}, built {page_info.get('build', '?')}).")
    print("Start tankgtone (python -m tankgtone ui), then open the editor: AI TONE is next to FOOTSWITCHES.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
