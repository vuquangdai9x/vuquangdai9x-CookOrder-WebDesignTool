// Visual layer for Play mode: items flying between places, and the celebration
// burst when a customer's order completes. Uses the Web Animations API so the
// sim never has to know about frames — it just waits for onfinish.

import { el } from "../dom.ts";

export interface Point {
  x: number;
  y: number;
}

/** Centre of an element in viewport coordinates. */
export function centerOf(node: Element): Point {
  const r = node.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

export class EffectsLayer {
  private root: HTMLElement;

  constructor(parent: HTMLElement = document.body) {
    this.root = el("div", { class: "fx-layer" });
    parent.append(this.root);
  }

  destroy(): void {
    this.root.remove();
  }

  /**
   * Flies `content` from one point to another and resolves when it lands.
   * With `instant`, it resolves on the next microtask so skip mode doesn't
   * wait on animation at all.
   */
  fly(
    content: HTMLElement,
    from: Point,
    to: Point,
    opts: { durationMs?: number; instant?: boolean; arc?: number } = {},
  ): Promise<void> {
    if (opts.instant) return Promise.resolve();

    const node = el("div", { class: "fx-flier" }, [content]);
    node.style.left = `${from.x}px`;
    node.style.top = `${from.y}px`;
    this.root.append(node);

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    // Lift the midpoint so the path arcs instead of sliding in a straight line.
    const lift = opts.arc ?? Math.min(90, Math.abs(dx) * 0.35 + 30);

    const anim = node.animate(
      [
        { transform: "translate(-50%, -50%) scale(0.85)", opacity: 0.85 },
        {
          transform: `translate(calc(-50% + ${dx / 2}px), calc(-50% + ${dy / 2 - lift}px)) scale(1.15)`,
          opacity: 1,
          offset: 0.5,
        },
        {
          transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.9)`,
          opacity: 0.9,
        },
      ],
      { duration: opts.durationMs ?? 420, easing: "cubic-bezier(.35,.05,.35,1)" },
    );

    return anim.finished
      .catch(() => undefined) // a cancelled animation still resolves the flight
      .then(() => {
        node.remove();
      });
  }

  /**
   * Celebration for a completed order, played on the customer's own card and
   * ending with it shrinking away: brighten → burst → scale to zero. Resolves
   * once the shrink finishes — the caller removes the card for real only then,
   * so "new customer arrives" never overlaps "old one leaving".
   *
   * The card is animated in place (not a clone) because the caller is expected
   * to hold the surrounding layout still (e.g. not yet reassigning grid-column
   * counts) until this resolves — see PlayView's `pendingExits` gate.
   */
  celebrateAndRemove(
    card: HTMLElement,
    opts: { instant?: boolean; count?: number } = {},
  ): Promise<void> {
    if (opts.instant) return Promise.resolve();

    this.burst(centerOf(card), opts.count);

    const anim = card.animate(
      [
        { transform: "scale(1)", filter: "brightness(1)", opacity: 1, offset: 0 },
        { transform: "scale(1.06)", filter: "brightness(1.7)", opacity: 1, offset: 0.28 },
        { transform: "scale(1)", filter: "brightness(1.15)", opacity: 1, offset: 0.55 },
        { transform: "scale(0)", filter: "brightness(1)", opacity: 0, offset: 1 },
      ],
      { duration: 850, easing: "cubic-bezier(.4,0,.2,1)" },
    );
    return anim.finished.catch(() => undefined).then(() => undefined);
  }

  /**
   * Ring of particles bursting from a point. `colors` overrides the default
   * warm palette — used for e.g. an icy palette on a Freeze break.
   * Adapted from the Web Animations API particle technique:
   * https://css-tricks.com/playing-with-particles-using-the-web-animations-api/
   */
  burst(origin: Point, particleCount?: number, colorPalette?: string[]): void {
    const opts = { count: particleCount };
    const count = opts.count ?? 18;
    const colors = colorPalette ?? ["#f0a441", "#6bbf59", "#ffd98e", "#ffffff", "#8fd1ff"];

    for (let i = 0; i < count; i++) {
      const particle = el("div", { class: "fx-particle" });
      const size = 5 + Math.random() * 7;
      particle.style.width = `${size}px`;
      particle.style.height = `${size}px`;
      particle.style.background = colors[i % colors.length];
      particle.style.left = `${origin.x}px`;
      particle.style.top = `${origin.y}px`;
      if (Math.random() > 0.5) particle.style.borderRadius = "2px";
      this.root.append(particle);

      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
      const distance = 60 + Math.random() * 90;
      const dx = Math.cos(angle) * distance;
      // Bias upward so the burst reads as a pop rather than a splat.
      const dy = Math.sin(angle) * distance - 30;

      const anim = particle.animate(
        [
          { transform: "translate(-50%, -50%) scale(1)", opacity: 1 },
          {
            transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.2) rotate(${
              Math.random() * 540 - 270
            }deg)`,
            opacity: 0,
          },
        ],
        {
          duration: 600 + Math.random() * 400,
          easing: "cubic-bezier(.15,.75,.35,1)",
        },
      );
      anim.finished.catch(() => undefined).then(() => particle.remove());
    }
  }
}
