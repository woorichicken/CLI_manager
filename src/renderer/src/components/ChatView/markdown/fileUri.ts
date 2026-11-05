// From ovis (https://github.com/devswha/ovis, 3e51902) — MIT, Copyright (c) 2026 devswha. Modified.
// Source: shared/fileUri.ts — verbatim.
/** Local file URIs are read by the existing server-side file viewer. */
export function fileUriPath(uri: string): string | null {
  // a control character belongs to no path, and URL drops a trailing one before it can be seen
  if (!/^file:\/\/\//i.test(uri) || /[\u0000-\u001f\u007f]/.test(uri)) return null;
  try {
    const url = new URL(uri);
    if (url.host || url.search || url.hash) return null;
    const path = decodeURIComponent(url.pathname);
    // two separators in front name a network share on a Windows PC, however the second was written
    if (/[\u0000-\u001f\u007f]/.test(path) || /^[\\/]{2}/.test(path)) return null;
    // `/C:/Users/me/a.md` is how a URI writes a Windows drive path
    return /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path;
  } catch {
    return null; // malformed URI input is not a file link
  }
}
