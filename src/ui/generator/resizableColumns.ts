import { el } from "../dom.ts";

export interface GeneratorColumnWidths {
  config?: number;
  issues?: number;
}

export interface ResizableGeneratorColumns {
  config: HTMLElement;
  content: HTMLElement;
  issues: HTMLElement;
  widths: GeneratorColumnWidths;
}

const MIN_CONFIG = 260;
const MIN_CONTENT = 320;
const MIN_ISSUES = 220;
const DIVIDER_WIDTH = 8;

/** Three generator panes with keyboard- and pointer-adjustable dividers. */
export function createResizableGeneratorColumns(options: ResizableGeneratorColumns): HTMLElement {
  const main = el("div", { class: "qf-main generator-resizable-main" });
  const leftDivider = el("div", {
    class: "generator-column-divider",
    role: "separator",
    tabindex: "0",
    "aria-label": "Resize configuration and content panels",
    "aria-orientation": "vertical",
  });
  const rightDivider = el("div", {
    class: "generator-column-divider",
    role: "separator",
    tabindex: "0",
    "aria-label": "Resize content and artifact issues panels",
    "aria-orientation": "vertical",
  });

  const apply = (): void => {
    const config = options.widths.config === undefined
      ? "minmax(320px, 1.15fr)"
      : `${Math.round(options.widths.config)}px`;
    const issues = options.widths.issues === undefined
      ? "minmax(240px, .9fr)"
      : `${Math.round(options.widths.issues)}px`;
    main.style.gridTemplateColumns = `${config} ${DIVIDER_WIDTH}px minmax(${MIN_CONTENT}px, 1.85fr) ${DIVIDER_WIDTH}px ${issues}`;
  };

  const availableForConfig = (): number => {
    const width = main.getBoundingClientRect().width;
    const issues = options.widths.issues ?? options.issues.getBoundingClientRect().width;
    return Math.max(MIN_CONFIG, width - issues - MIN_CONTENT - DIVIDER_WIDTH * 2);
  };
  const availableForIssues = (): number => {
    const width = main.getBoundingClientRect().width;
    const config = options.widths.config ?? options.config.getBoundingClientRect().width;
    return Math.max(MIN_ISSUES, width - config - MIN_CONTENT - DIVIDER_WIDTH * 2);
  };
  const setConfig = (value: number): void => {
    options.widths.config = Math.max(MIN_CONFIG, Math.min(availableForConfig(), value));
    apply();
    leftDivider.setAttribute("aria-valuenow", String(Math.round(options.widths.config)));
  };
  const setIssues = (value: number): void => {
    options.widths.issues = Math.max(MIN_ISSUES, Math.min(availableForIssues(), value));
    apply();
    rightDivider.setAttribute("aria-valuenow", String(Math.round(options.widths.issues)));
  };

  const bind = (divider: HTMLElement, side: "config" | "issues"): void => {
    divider.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const mainRect = main.getBoundingClientRect();
      divider.setPointerCapture(event.pointerId);
      divider.classList.add("dragging");
      const move = (next: PointerEvent): void => {
        if (side === "config") setConfig(next.clientX - mainRect.left);
        else setIssues(mainRect.right - next.clientX);
      };
      const stop = (next: PointerEvent): void => {
        if (divider.hasPointerCapture(next.pointerId)) divider.releasePointerCapture(next.pointerId);
        divider.classList.remove("dragging");
        divider.removeEventListener("pointermove", move);
        divider.removeEventListener("pointerup", stop);
        divider.removeEventListener("pointercancel", stop);
      };
      divider.addEventListener("pointermove", move);
      divider.addEventListener("pointerup", stop);
      divider.addEventListener("pointercancel", stop);
    });
    divider.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const direction = event.key === "ArrowRight" ? 1 : -1;
      if (side === "config") setConfig((options.widths.config ?? options.config.getBoundingClientRect().width) + direction * 16);
      else setIssues((options.widths.issues ?? options.issues.getBoundingClientRect().width) - direction * 16);
      event.preventDefault();
    });
  };
  bind(leftDivider, "config");
  bind(rightDivider, "issues");
  main.append(options.config, leftDivider, options.content, rightDivider, options.issues);
  apply();
  return main;
}

