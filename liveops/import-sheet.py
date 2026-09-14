#!/usr/bin/env python3
"""Import the CookOrder live-ops Google Sheet into liveops/data/*.json.

Every *named table* in the workbook (Google Sheets "Convert to table") becomes one JSON
file: liveops/data/<SheetTitle>/<TableName>.json. A manifest.json records where each table
came from. Nothing in the game or the web tool reads these files -- they are a queryable
snapshot for people and agents (see liveops-cli.py and README.md).

Usage:
  python liveops/import-sheet.py                       # download the default sheet id
  python liveops/import-sheet.py --sheet-id <id>       # another sheet
  python liveops/import-sheet.py --xlsx path/to.xlsx   # offline, from an exported workbook
  python liveops/import-sheet.py --exclude LevelData   # skip tables (repeatable)
  python liveops/import-sheet.py --keep-derived        # also export formula-only columns

Formula-only columns (concat strings, ROW() indexes, COUNTIFs, margin math) are *derived* by the
sheet, not authored, and are dropped by default; manifest.json lists them per table. Pin one with
`keep_columns` in import-config.json.

Requires: python3 + openpyxl (pip install openpyxl). Uses the sheet's public xlsx export
(File > Share > "Anyone with the link" must be on); no Google credentials needed.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import shutil
import sys
import urllib.request
from pathlib import Path

DEFAULT_SHEET_ID = "1BIosxNjfnueck5VubwwG6_kW8KRH_-gQU6q1WPy_UNA"
HERE = Path(__file__).resolve().parent
DATA_DIR = HERE / "data"
CONFIG_PATH = HERE / "import-config.json"


def load_config() -> dict:
    if CONFIG_PATH.exists():
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    return {}


def download_xlsx(sheet_id: str, dest: Path) -> None:
    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=xlsx"
    req = urllib.request.Request(url, headers={"User-Agent": "cookorder-liveops-import/1"})
    with urllib.request.urlopen(req, timeout=60) as resp, dest.open("wb") as out:
        ctype = resp.headers.get("Content-Type", "")
        if "spreadsheetml" not in ctype:
            sys.exit(f"Export did not return an xlsx (Content-Type={ctype!r}). "
                     "Is the sheet shared as 'Anyone with the link'?")
        shutil.copyfileobj(resp, out)


def clean(v):
    """Normalise a cell value for JSON: integral floats -> int, strip strings, errors -> None."""
    if v is None:
        return None
    if isinstance(v, float):
        return int(v) if v.is_integer() else v
    if isinstance(v, (dt.datetime, dt.date, dt.time)):
        return v.isoformat()
    if isinstance(v, str):
        s = v.strip()
        if s.startswith("#") and s.endswith("!") and s.upper() == s:  # #REF!, #N/A ...
            return None
        return s
    return v


def slug(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", s).strip("_")


def parse_ref(ref: str):
    m = re.fullmatch(r"([A-Z]+)(\d+):([A-Z]+)(\d+)", ref)
    if not m:
        raise ValueError(f"unsupported table ref {ref!r}")
    from openpyxl.utils import column_index_from_string as ci
    return ci(m.group(1)), int(m.group(2)), ci(m.group(3)), int(m.group(4))


def is_formula(v) -> bool:
    return (isinstance(v, str) and v.startswith("=")) or type(v).__name__ == "ArrayFormula"


def derived_columns(ws_formulas, headers: list[str], ref: str) -> set[str]:
    """Columns whose every non-empty cell is a formula: sheet-side derived data (concat strings,
    ROW() indexes, COUNTIFs, margin math). Not authored, so not exported."""
    c1, r1, c2, r2 = parse_ref(ref)
    derived = set()
    for j, col in enumerate(ws_formulas.iter_cols(min_row=r1 + 1, max_row=r2, min_col=c1, max_col=c2)):
        vals = [c.value for c in col if c.value is not None and c.value != ""]
        if vals and all(is_formula(v) for v in vals):
            derived.add(headers[j])
    return derived


def export_table(ws, ws_formulas, name: str, ref: str, cfg: dict, keep_derived: bool):
    c1, r1, c2, r2 = parse_ref(ref)
    rows = list(ws.iter_rows(min_row=r1, max_row=r2, min_col=c1, max_col=c2, values_only=True))
    if not rows:
        return [], []
    headers = []
    for i, h in enumerate(rows[0]):
        h = clean(h)
        headers.append(h if isinstance(h, str) and h else f"col{i + 1}")
    ffill_cols = set(cfg.get("forward_fill", {}).get(name, []))
    drop_cols = set(cfg.get("drop_columns", {}).get(name, []))
    keep_cols = set(cfg.get("keep_columns", {}).get(name, []))
    dropped_derived: list[str] = []
    if not keep_derived:
        dropped_derived = sorted(derived_columns(ws_formulas, headers, ref) - keep_cols)
        drop_cols |= set(dropped_derived)
    out: list[dict] = []
    last: dict = {}
    for raw in rows[1:]:
        rec = {}
        for h, v in zip(headers, raw):
            if h in drop_cols:
                continue
            v = clean(v)
            if v is None and h in ffill_cols:
                v = last.get(h)
            rec[h] = v
        if all(v is None for v in rec.values()):
            continue
        last = rec
        out.append(rec)
    return out, dropped_derived


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sheet-id", default=DEFAULT_SHEET_ID)
    ap.add_argument("--xlsx", type=Path, help="read this workbook instead of downloading")
    ap.add_argument("--out", type=Path, default=DATA_DIR)
    ap.add_argument("--exclude", action="append", default=[], help="table name to skip (repeatable)")
    ap.add_argument("--keep-xlsx", action="store_true", help="also save the downloaded workbook next to data/")
    ap.add_argument("--keep-derived", action="store_true",
                    help="export formula-only columns too (concat strings, indexes, margin math); dropped by default")
    args = ap.parse_args()

    try:
        import openpyxl
    except ImportError:
        sys.exit("openpyxl is required: pip install openpyxl")

    cfg = load_config()
    excludes = set(args.exclude) | set(cfg.get("exclude_tables", []))

    xlsx = args.xlsx
    source = str(xlsx) if xlsx else f"https://docs.google.com/spreadsheets/d/{args.sheet_id}"
    if xlsx is None:
        xlsx = HERE / "sheet-export.xlsx"
        print(f"downloading {source} ...")
        download_xlsx(args.sheet_id, xlsx)

    wb = openpyxl.load_workbook(xlsx, data_only=True)
    wb_formulas = openpyxl.load_workbook(xlsx, data_only=False)
    if args.out.exists():
        shutil.rmtree(args.out)
    args.out.mkdir(parents=True)

    manifest = {
        "source": source,
        "sheet_id": None if args.xlsx else args.sheet_id,
        "imported_at": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "tables": [],
    }
    for ws in wb.worksheets:
        for name, ref in ws.tables.items():
            if name in excludes:
                print(f"  skip  {ws.title}/{name}")
                continue
            rows, derived = export_table(ws, wb_formulas[ws.title], name, ref, cfg, args.keep_derived)
            rel = Path(slug(ws.title)) / f"{slug(name)}.json"
            path = args.out / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(rows, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            columns = list(rows[0].keys()) if rows else []
            manifest["tables"].append({
                "table": name, "sheet": ws.title, "range": ref,
                "file": rel.as_posix(), "rows": len(rows), "columns": columns,
                "derived_columns_dropped": derived,
                "note": cfg.get("table_notes", {}).get(name),
            })
            extra = f"  (dropped derived: {', '.join(derived)})" if derived else ""
            print(f"  wrote {rel.as_posix():48s} {len(rows):4d} rows{extra}")
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    if args.xlsx is None and not args.keep_xlsx:
        xlsx.unlink(missing_ok=True)
    print(f"done: {len(manifest['tables'])} tables -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
