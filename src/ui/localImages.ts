// Maps a config row's `localImage` path (given relative to src/assets/) to
// its bundled URL via Vite's import.meta.glob. Local, bundled art takes
// priority over the Google Drive fallback — see icon.ts.

const modules = import.meta.glob("../assets/**/*.{png,jpg,jpeg,svg,webp}", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const PREFIX = "../assets/";

/** Resolves a "Map1-burger/ingredients/foo.png"-style config path to its bundled URL. */
export function localImageUrl(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return modules[PREFIX + path];
}
