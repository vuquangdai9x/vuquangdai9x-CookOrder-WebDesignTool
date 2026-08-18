/** Returns a safe preview URL only when the complete note is one HTTP(S) link. */
export function noteImageURL(text: string): string | null {
  const candidate = text.trim();
  if (!candidate || /\s/.test(candidate)) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
