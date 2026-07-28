// Small DOM helpers shared by the Design and Play views.

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function button(
  label: string,
  onClick: (event: MouseEvent) => void,
  attrs: Record<string, string> = {},
): HTMLButtonElement {
  const b = el("button", attrs, [label]);
  b.addEventListener("click", onClick);
  return b;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}
