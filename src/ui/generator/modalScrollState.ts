interface ScrollPosition {
  signature: string;
  occurrence: number;
  left: number;
  top: number;
}

export type ModalScrollState = ScrollPosition[];

const transientClasses = new Set([
  "active",
  "disabled",
  "error",
  "future",
  "invalid",
  "ok",
  "passed",
  "running",
  "scrubbing",
  "selected",
  "stale",
  "warning",
  "zero",
]);

function elementSignature(element: HTMLElement): string {
  const classes = [...element.classList]
    .filter((name) => !transientClasses.has(name))
    .sort()
    .join(".");
  return [
    element.localName,
    element.id,
    classes,
    element.getAttribute("role") ?? "",
    element.getAttribute("aria-label") ?? "",
  ].join("|");
}

function elementsWithin(root: HTMLElement): HTMLElement[] {
  return [root, ...root.querySelectorAll<HTMLElement>("*")];
}

/** Captures every descendant that currently has a non-zero scroll offset. */
export function captureModalScrollState(root: HTMLElement): ModalScrollState {
  const occurrences = new Map<string, number>();
  const state: ModalScrollState = [];
  for (const element of elementsWithin(root)) {
    const signature = elementSignature(element);
    const occurrence = occurrences.get(signature) ?? 0;
    occurrences.set(signature, occurrence + 1);
    if (element.scrollLeft === 0 && element.scrollTop === 0) continue;
    state.push({
      signature,
      occurrence,
      left: element.scrollLeft,
      top: element.scrollTop,
    });
  }
  return state;
}

/** Restores captured offsets after the modal subtree has been reconstructed. */
export function restoreModalScrollState(root: HTMLElement, state: ModalScrollState): void {
  if (state.length === 0) return;
  const matches = new Map<string, HTMLElement[]>();
  for (const element of elementsWithin(root)) {
    const signature = elementSignature(element);
    const group = matches.get(signature);
    if (group) group.push(element);
    else matches.set(signature, [element]);
  }
  for (const position of state) {
    const element = matches.get(position.signature)?.[position.occurrence];
    if (!element) continue;
    element.scrollLeft = position.left;
    element.scrollTop = position.top;
  }
}
