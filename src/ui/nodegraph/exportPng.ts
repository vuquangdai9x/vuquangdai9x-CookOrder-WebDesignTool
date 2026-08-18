const EXPORT_MARGIN = 48;
const MAX_CANVAS_SIDE = 8_192;
const MAX_CANVAS_PIXELS = 32_000_000;
const IMAGE_FETCH_TIMEOUT_MS = 3_000;

interface Bounds { x: number; y: number; width: number; height: number }
interface Rect { x: number; y: number; width: number; height: number }

function contentBounds(canvas: HTMLElement): Bounds {
  const positioned = [...canvas.children].filter(
    (child): child is HTMLElement => child instanceof HTMLElement &&
      (child.classList.contains("nodegraph-node") || child.classList.contains("nodegraph-note")),
  );
  if (positioned.length === 0) {
    return { x: 0, y: 0, width: Math.max(1, canvas.scrollWidth), height: Math.max(1, canvas.scrollHeight) };
  }
  const minX = Math.min(...positioned.map((element) => element.offsetLeft)) - EXPORT_MARGIN;
  const minY = Math.min(...positioned.map((element) => element.offsetTop)) - EXPORT_MARGIN;
  const maxX = Math.max(...positioned.map((element) => element.offsetLeft + element.offsetWidth)) + EXPORT_MARGIN;
  const maxY = Math.max(...positioned.map((element) => element.offsetTop + element.offsetHeight)) + EXPORT_MARGIN;
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

function isTransparent(color: string): boolean {
  return color === "transparent" || color === "rgba(0, 0, 0, 0)" || color.endsWith(", 0)");
}

function numberPx(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundedRect(context: CanvasRenderingContext2D, rect: Rect, radius: number): void {
  context.beginPath();
  context.roundRect(rect.x, rect.y, rect.width, rect.height, Math.max(0, radius));
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("The browser could not encode the PNG.")),
      "image/png",
    );
  });
}

async function loadSafeImages(root: HTMLElement): Promise<Map<HTMLImageElement, ImageBitmap>> {
  const loaded = new Map<HTMLImageElement, ImageBitmap>();
  await Promise.all([...root.querySelectorAll<HTMLImageElement>("img")].map(async (image) => {
    const source = image.currentSrc || image.src;
    if (!source) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(source, { signal: controller.signal });
      if (!response.ok) return;
      loaded.set(image, await createImageBitmap(await response.blob()));
    } catch {
      // Cross-origin artwork without CORS is deliberately omitted. Drawing it
      // directly would taint the canvas and make PNG download impossible.
    } finally {
      clearTimeout(timeout);
    }
  }));
  return loaded;
}

/** Captures every graph node, note, table, and edge without using a taint-prone foreignObject SVG. */
export async function downloadGraphPng(canvas: HTMLElement, filename: string): Promise<void> {
  await document.fonts?.ready;
  const bounds = contentBounds(canvas);
  const sideScale = MAX_CANVAS_SIDE / Math.max(bounds.width, bounds.height);
  const areaScale = Math.sqrt(MAX_CANVAS_PIXELS / (bounds.width * bounds.height));
  const outputScale = Math.max(0.2, Math.min(1, sideScale, areaScale));
  const output = document.createElement("canvas");
  output.width = Math.max(1, Math.round(bounds.width * outputScale));
  output.height = Math.max(1, Math.round(bounds.height * outputScale));
  const context = output.getContext("2d");
  if (!context) throw new Error("Canvas rendering is unavailable in this browser.");

  const canvasRect = canvas.getBoundingClientRect();
  const domScale = canvas.offsetWidth > 0 ? canvasRect.width / canvas.offsetWidth : 1;
  const mapRect = (rect: DOMRect): Rect => ({
    x: (rect.left - canvasRect.left) / domScale,
    y: (rect.top - canvasRect.top) / domScale,
    width: rect.width / domScale,
    height: rect.height / domScale,
  });
  const images = await loadSafeImages(canvas);

  context.scale(outputScale, outputScale);
  context.translate(-bounds.x, -bounds.y);

  const viewportStyle = getComputedStyle(canvas.parentElement ?? canvas);
  context.fillStyle = isTransparent(viewportStyle.backgroundColor) ? "#1f2026" : viewportStyle.backgroundColor;
  context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
  context.fillStyle = "#3a3d46";
  for (let x = Math.floor(bounds.x / 24) * 24 + 1; x < bounds.x + bounds.width; x += 24) {
    for (let y = Math.floor(bounds.y / 24) * 24 + 1; y < bounds.y + bounds.height; y += 24) {
      context.fillRect(x, y, 1, 1);
    }
  }

  // Edges already carry exact canvas-space Bézier paths; paint them before
  // HTML nodes, matching the live canvas stacking order.
  for (const path of canvas.querySelectorAll<SVGPathElement>(".nodegraph-edges path")) {
    const data = path.getAttribute("d");
    if (!data) continue;
    const style = getComputedStyle(path);
    context.save();
    context.strokeStyle = style.stroke;
    context.lineWidth = numberPx(style.strokeWidth) || 2;
    const dash = path.getAttribute("stroke-dasharray")?.split(/[ ,]+/).map(Number).filter(Number.isFinite) ?? [];
    context.setLineDash(dash);
    context.stroke(new Path2D(data));
    context.restore();
  }

  const drawText = (textNode: Text, parent: HTMLElement, style: CSSStyleDeclaration): void => {
    const text = textNode.data.replace(/\s+/g, " ").trim();
    if (!text) return;
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const rect = mapRect(range.getBoundingClientRect());
    if (rect.width <= 0 || rect.height <= 0) return;
    context.save();
    context.globalAlpha = Number(style.opacity) || 1;
    context.fillStyle = style.color;
    context.font = style.font;
    context.textAlign = style.textAlign === "center" ? "center" : style.textAlign === "right" ? "right" : "left";
    context.textBaseline = "top";
    const x = context.textAlign === "center" ? rect.x + rect.width / 2 : context.textAlign === "right" ? rect.x + rect.width : rect.x;
    context.fillText(text, x, rect.y, Math.max(1, rect.width));
    context.restore();
    void parent;
  };

  const paint = (element: HTMLElement): void => {
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || element.classList.contains("nodegraph-marquee")) return;
    const rect = mapRect(element.getBoundingClientRect());
    if (rect.width <= 0 || rect.height <= 0) return;

    context.save();
    context.globalAlpha = Number(style.opacity) || 1;
    const radius = numberPx(style.borderTopLeftRadius);
    if (!isTransparent(style.backgroundColor)) {
      roundedRect(context, rect, radius);
      context.fillStyle = style.backgroundColor;
      context.fill();
    }
    const borderWidth = Math.max(
      numberPx(style.borderTopWidth), numberPx(style.borderRightWidth),
      numberPx(style.borderBottomWidth), numberPx(style.borderLeftWidth),
    );
    if (borderWidth > 0 && !isTransparent(style.borderTopColor)) {
      roundedRect(context, {
        x: rect.x + borderWidth / 2,
        y: rect.y + borderWidth / 2,
        width: Math.max(0, rect.width - borderWidth),
        height: Math.max(0, rect.height - borderWidth),
      }, radius);
      context.strokeStyle = style.borderTopColor;
      context.lineWidth = borderWidth;
      context.stroke();
    }
    context.restore();

    if (element instanceof HTMLImageElement) {
      const bitmap = images.get(element);
      if (bitmap) context.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height);
      else if (element.alt) {
        context.fillStyle = style.color || "#fff";
        context.font = style.font;
        context.textBaseline = "middle";
        context.fillText(element.alt, rect.x, rect.y + rect.height / 2, rect.width);
      }
      return;
    }

    for (const child of element.childNodes) {
      if (child instanceof Text) drawText(child, element, style);
      else if (child instanceof HTMLElement) paint(child);
      // SVG edges were painted as paths above; do not recurse into them here.
    }
  };

  for (const child of canvas.children) if (child instanceof HTMLElement) paint(child);

  const url = URL.createObjectURL(await canvasBlob(output));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
  for (const bitmap of images.values()) bitmap.close();
}
