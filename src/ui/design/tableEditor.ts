// Generic table editor used for every definition table (effects, cell types,
// customer types, raw/cooked ingredients, cook mappings).
// See docs/IMPLEMENT_PLAN.md Phase 2.

import { button, el } from "../dom.ts";

export interface ColumnDef<T> {
  key: string;
  label: string;
  type?: "text" | "number";
  /** Read the cell's display value from a row. */
  get(row: T): string;
  /** Write an edited value back into the row. */
  set(row: T, value: string): void;
  width?: string;
}

export interface TableEditorOptions<T> {
  title: string;
  columns: ColumnDef<T>[];
  rows: T[];
  /** Builds a blank row when the user clicks "Add row". */
  makeRow(rows: T[]): T;
  onChange(): void;
  /** Optional per-row extra editor rendered under the row (e.g. param defs). */
  subEditor?(row: T, onChange: () => void): HTMLElement | null;
}

export function tableEditor<T>(opts: TableEditorOptions<T>): HTMLElement {
  const wrap = el("section", { class: "panel" });

  const render = () => {
    wrap.replaceChildren();
    const table = el("table", { class: "def-table" });
    const head = el("tr");
    for (const col of opts.columns) {
      const th = el("th", {}, [col.label]);
      if (col.width) th.style.width = col.width;
      head.append(th);
    }
    head.append(el("th", {}, [""]));
    table.append(el("thead", {}, [head]));

    const body = el("tbody");
    for (const row of opts.rows) {
      const tr = el("tr");
      for (const col of opts.columns) {
        const input = el("input", {
          value: col.get(row),
          type: col.type === "number" ? "number" : "text",
        }) as HTMLInputElement;
        input.addEventListener("change", () => {
          col.set(row, input.value);
          opts.onChange();
        });
        tr.append(el("td", {}, [input]));
      }
      tr.append(
        el("td", {}, [
          button("🗑", () => {
            opts.rows.splice(opts.rows.indexOf(row), 1);
            opts.onChange();
            render();
          }, { class: "icon-btn", title: "Delete row" }),
        ]),
      );
      body.append(tr);

      const sub = opts.subEditor?.(row, () => {
        opts.onChange();
        render();
      });
      if (sub) {
        const subRow = el("tr", { class: "sub-row" });
        const cell = el("td", { colspan: String(opts.columns.length + 1) }, [sub]);
        subRow.append(cell);
        body.append(subRow);
      }
    }
    table.append(body);

    wrap.append(
      el("div", { class: "panel-head" }, [
        el("h3", {}, [`${opts.title} (${opts.rows.length})`]),
        button("+ Add row", () => {
          opts.rows.push(opts.makeRow(opts.rows));
          opts.onChange();
          render();
        }),
      ]),
      el("div", { class: "table-wrap" }, [table]),
    );
  };

  render();
  return wrap;
}
