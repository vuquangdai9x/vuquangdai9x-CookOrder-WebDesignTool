// Light/dark theme: which one is active, and how to change it.
//
// The whole mechanism is one attribute on <html>, because that is what the
// stylesheet's two palette blocks key off (see style.css's `:root[data-theme]`).
// Nothing else in the app reads the theme — a component that needed to branch
// on it would be a component whose colours had escaped the palette.

export type Theme = "dark" | "light";

const STORAGE_KEY = "cookorder-theme";

/**
 * Fired on `window` after the theme changes.
 *
 * Almost everything restyles from the palette on its own, but a view that
 * computes colours in JS — Level Path's statistic ramp, which has to invert
 * dark-on-light — holds inline styles that no stylesheet can reach. This is how
 * those get told to recompute, without the toggle needing to know who they are.
 */
export const THEME_CHANGE_EVENT = "cookorder-theme-change";

/**
 * The stored choice, or the one the OS asks for.
 *
 * A designer who has set a theme here keeps it everywhere; one who has not
 * gets whatever their system is already doing, which is the better first
 * impression than picking dark for someone working in daylight.
 */
export function loadTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Storage unavailable — fall through to the system preference.
  }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/**
 * Stamps the theme on <html>.
 *
 * Explicit on both themes rather than treating dark as "no attribute": a
 * stylesheet that has to mean two things by the absence of one attribute is a
 * stylesheet where adding a third theme breaks the first.
 */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  window.dispatchEvent(new CustomEvent<Theme>(THEME_CHANGE_EVENT, { detail: theme }));
}

/** The theme currently stamped on the document. */
export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch (err) {
    console.warn("Could not persist the theme choice", err);
  }
}

/** What the header button shows for the theme it would switch TO. */
export function themeToggleLabel(theme: Theme): string {
  return theme === "dark" ? "☀ Light" : "🌙 Dark";
}

export const otherTheme = (theme: Theme): Theme => (theme === "dark" ? "light" : "dark");
