/**
 * What transcript content is allowed to display without touching the network.
 *
 * Everything CodeSesh renders was produced by an agent, so any URL inside it is
 * untrusted input. Fetching one would tell a third party the reader's IP and
 * when they opened the session — which is exactly what "100% local" rules out.
 * Callers ask for a displayable source and get nothing back when the policy
 * refuses; protocol, origin and size limits stay in here.
 */

/**
 * Roughly 9 MB of image data once base64 is decoded. Large enough for a
 * full-resolution screenshot, small enough that a malformed payload cannot
 * stall the renderer.
 */
const MAX_INLINE_IMAGE_CHARS = 12 * 1024 * 1024;

const INLINE_IMAGE_PATTERN = /^data:image\/[a-z0-9.+-]+(?:;[a-z0-9-]+=[^,;]*)*(?:;base64)?,/i;

function appOrigin(): string | null {
  return typeof window === "undefined" ? null : window.location.origin;
}

/** Resolves against the app origin so `//host/x` is judged by its target, not its prefix. */
function resolveAgainstApp(value: string): URL | null {
  const origin = appOrigin();
  try {
    return origin ? new URL(value, origin) : new URL(value);
  } catch {
    return null;
  }
}

function isInlineImage(value: string): boolean {
  if (!INLINE_IMAGE_PATTERN.test(value)) return false;
  return value.length <= MAX_INLINE_IMAGE_CHARS;
}

/**
 * Returns a source safe to put in `src`, or null when the policy refuses it.
 * Accepts inline image data and same-origin paths served by CodeSesh itself.
 */
export function resolveLocalMediaSource(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (isInlineImage(raw)) return raw;

  const url = resolveAgainstApp(raw);
  if (!url) return null;
  // A blob URL only refers to something the current page created, so one stored
  // in a transcript is either stale or forged.
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const origin = appOrigin();
  return origin && url.origin === origin ? url.href : null;
}

/** Builds an inline image source from a mime type and base64 payload. */
export function inlineImageSource(mimeType: string, base64Data: string): string | null {
  if (!mimeType.startsWith("image/") || !base64Data) return null;
  return resolveLocalMediaSource(`data:${mimeType};base64,${base64Data}`);
}
