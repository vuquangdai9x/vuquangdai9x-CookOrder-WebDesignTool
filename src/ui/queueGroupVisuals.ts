// Shared geometry for the queue-group connector overlays (linked-slot ropes,
// combined-slot rails), used by both the Design-mode editor
// (design/queueSection.ts) and Play mode (play/index.ts). Each caller finds
// its own DOM elements (by _cid in Design mode, by (x,y) in Play mode) and
// just needs the pixel math to turn two tile centers into drawable segments.

export interface Point {
  x: number;
  y: number;
}

/**
 * Two line segments offset perpendicular to p1->p2 by `offset` px each side —
 * a "double rail" look for a combined-slot connector, reading as "these are
 * welded together" rather than a single connecting line.
 */
export function railSegments(p1: Point, p2: Point, offset = 3): [Point, Point][] {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len;
  const py = dx / len;
  return [-1, 1].map((sign) => [
    { x: p1.x + px * offset * sign, y: p1.y + py * offset * sign },
    { x: p2.x + px * offset * sign, y: p2.y + py * offset * sign },
  ]);
}

/** Appends one <line> to `svg` with the given class, in the overlay's local coordinate space. An explicit `color` overrides the class's default stroke (see railColor()). */
export function appendLine(
  svg: SVGSVGElement,
  a: Point,
  b: Point,
  className: string,
  color?: string,
): void {
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", String(a.x));
  line.setAttribute("y1", String(a.y));
  line.setAttribute("x2", String(b.x));
  line.setAttribute("y2", String(b.y));
  line.setAttribute("class", className);
  if (color) line.style.stroke = color;
  svg.append(line);
}

/** Cycled per combined-slot group so distinct blocks read apart at a glance, especially when two blocks sit in adjacent lanes. */
const COMBINE_RAIL_COLORS = ["#cfd8ff", "#ffcf8f", "#8fffc0", "#ff8fd6", "#8fe0ff", "#e0ff8f"];

/** Picks a stable rail color for a combined-slot group, keyed by its group index (need not be consecutive — just distinct). */
export function railColor(groupIndex: number): string {
  return COMBINE_RAIL_COLORS[((groupIndex % COMBINE_RAIL_COLORS.length) + COMBINE_RAIL_COLORS.length) % COMBINE_RAIL_COLORS.length];
}

/** A fresh, absolutely-positioned SVG overlay sized to `host`, appended by the caller once populated. */
export function createOverlay(host: DOMRect): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg") as unknown as SVGSVGElement;
  svg.setAttribute("class", "queue-link-overlay");
  svg.setAttribute("width", String(host.width));
  svg.setAttribute("height", String(host.height));
  return svg;
}
