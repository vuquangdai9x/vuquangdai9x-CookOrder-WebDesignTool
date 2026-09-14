#!/usr/bin/env python3
"""Query the imported live-ops config (liveops/data/) without opening the JSON files.

  python liveops/liveops-cli.py tables                      # every table: sheet, rows, columns, note
  python liveops/liveops-cli.py show <Table> [opts]         # rows of one table (default: markdown)
  python liveops/liveops-cli.py get <Table> <key>           # one value from a Key/Value table
  python liveops/liveops-cli.py kv <Table>                  # a Key/Value table as {key: value}
  python liveops/liveops-cli.py find <text>                 # grep every table for a substring
  python liveops/liveops-cli.py manifest                    # source sheet id and import time

show options:
  --where COL=VALUE   (repeatable; case-insensitive equality, '*' wildcard suffix/prefix)
  --cols A,B,C        only these columns
  --limit N           first N rows
  --json              JSON instead of a markdown table
  --wide              don't truncate long cells

Table names are the Google Sheets table names (see `tables`), matched case-insensitively.
Stdlib only -- no dependencies.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA_DIR = HERE / "data"


def load_manifest() -> dict:
    p = DATA_DIR / "manifest.json"
    if not p.exists():
        sys.exit("liveops/data/manifest.json not found -- run `python liveops/import-sheet.py` first")
    return json.loads(p.read_text(encoding="utf-8"))


def resolve(manifest: dict, name: str) -> dict:
    hits = [t for t in manifest["tables"] if t["table"].lower() == name.lower()]
    if not hits:
        hits = [t for t in manifest["tables"] if name.lower() in t["table"].lower()]
    if len(hits) != 1:
        names = ", ".join(t["table"] for t in (hits or manifest["tables"]))
        sys.exit(f"table {name!r} is {'ambiguous' if hits else 'unknown'}; candidates: {names}")
    return hits[0]


def load_rows(entry: dict) -> list[dict]:
    return json.loads((DATA_DIR / entry["file"]).read_text(encoding="utf-8"))


def match(value, pattern: str) -> bool:
    s = "" if value is None else str(value).lower()
    p = pattern.lower()
    if p.startswith("*") and p.endswith("*"):
        return p[1:-1] in s
    if p.startswith("*"):
        return s.endswith(p[1:])
    if p.endswith("*"):
        return s.startswith(p[:-1])
    return s == p


def fmt_cell(v, wide: bool) -> str:
    s = "" if v is None else (json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else str(v))
    s = s.replace("\n", " / ").replace("|", "\\|")
    if not wide and len(s) > 60:
        s = s[:57] + "..."
    return s


def print_table(rows: list[dict], cols: list[str], wide: bool) -> None:
    if not rows:
        print("(no rows)")
        return
    print("| " + " | ".join(cols) + " |")
    print("|" + "|".join("---" for _ in cols) + "|")
    for r in rows:
        print("| " + " | ".join(fmt_cell(r.get(c), wide) for c in cols) + " |")


def kv_pairs(rows: list[dict]) -> dict:
    """Key/Value style tables: first column is the key, second the value."""
    if not rows:
        return {}
    keys = list(rows[0].keys())
    if len(keys) < 2:
        sys.exit("not a key/value table")
    k, v = keys[0], keys[1]
    return {r[k]: r[v] for r in rows if r.get(k) is not None}


def cmd_tables(m: dict, _a) -> None:
    print(f"source: {m['source']}  imported: {m['imported_at']}\n")
    print("| table | sheet | rows | columns | note |")
    print("|---|---|---|---|---|")
    for t in m["tables"]:
        cols = ", ".join(t["columns"][:8]) + (" ..." if len(t["columns"]) > 8 else "")
        note = (t.get("note") or "")[:90]
        print(f"| {t['table']} | {t['sheet']} | {t['rows']} | {cols} | {note} |")


def cmd_show(m: dict, a) -> None:
    entry = resolve(m, a.table)
    rows = load_rows(entry)
    for w in a.where or []:
        if "=" not in w:
            sys.exit(f"--where expects COL=VALUE, got {w!r}")
        col, val = w.split("=", 1)
        colname = next((c for c in entry["columns"] if c.lower() == col.lower()), col)
        rows = [r for r in rows if match(r.get(colname), val)]
    cols = entry["columns"]
    if a.cols:
        want = [c.strip().lower() for c in a.cols.split(",")]
        cols = [c for c in cols if c.lower() in want]
    if a.limit:
        rows = rows[: a.limit]
    if a.json:
        print(json.dumps([{c: r.get(c) for c in cols} for r in rows], indent=2, ensure_ascii=False))
    else:
        if entry.get("note"):
            print(f"_{entry['note']}_\n")
        print_table(rows, cols, a.wide)
        print(f"\n{len(rows)} row(s) from {entry['sheet']}/{entry['table']} ({entry['range']})")


def cmd_get(m: dict, a) -> None:
    entry = resolve(m, a.table)
    kv = kv_pairs(load_rows(entry))
    for k, v in kv.items():
        if str(k).lower() == a.key.lower():
            print(json.dumps(v, ensure_ascii=False))
            return
    sys.exit(f"key {a.key!r} not in {entry['table']}; keys: {', '.join(map(str, kv))}")


def cmd_kv(m: dict, a) -> None:
    entry = resolve(m, a.table)
    print(json.dumps(kv_pairs(load_rows(entry)), indent=2, ensure_ascii=False))


def cmd_find(m: dict, a) -> None:
    needle = a.text.lower()
    n = 0
    for t in m["tables"]:
        for i, r in enumerate(load_rows(t)):
            hit = {k: v for k, v in r.items() if v is not None and needle in str(v).lower()}
            if hit:
                n += 1
                print(f"{t['table']}[{i}]: " + json.dumps(hit, ensure_ascii=False))
    print(f"\n{n} row(s) matched")


def cmd_manifest(m: dict, _a) -> None:
    print(json.dumps({k: v for k, v in m.items() if k != "tables"}, indent=2))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("tables").set_defaults(fn=cmd_tables)
    s = sub.add_parser("show")
    s.add_argument("table")
    s.add_argument("--where", action="append")
    s.add_argument("--cols")
    s.add_argument("--limit", type=int)
    s.add_argument("--json", action="store_true")
    s.add_argument("--wide", action="store_true")
    s.set_defaults(fn=cmd_show)
    g = sub.add_parser("get")
    g.add_argument("table")
    g.add_argument("key")
    g.set_defaults(fn=cmd_get)
    k = sub.add_parser("kv")
    k.add_argument("table")
    k.set_defaults(fn=cmd_kv)
    f = sub.add_parser("find")
    f.add_argument("text")
    f.set_defaults(fn=cmd_find)
    sub.add_parser("manifest").set_defaults(fn=cmd_manifest)
    a = ap.parse_args()
    a.fn(load_manifest(), a)
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # emoji in the sheet; Windows consoles default to cp1252
    except AttributeError:
        pass
    sys.exit(main())
