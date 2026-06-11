/**
 * Desktop URL allowlist policy.
 *
 * Pure URL string logic — no Electron imports.
 * Extracted for testability.
 *
 * Two categories of allowed URLs:
 *
 * 1. External HTTPS URLs (non-loopback) — safe to open in the system browser.
 *    e.g. https://example.com
 *
 * 2. Local preview URLs (http or https, loopback hosts only) — design preview
 *    dev servers run on localhost ports and must be opened externally so the
 *    user can interact with them in their default browser.
 *    e.g. http://localhost:12000/, http://127.0.0.1:12001/
 */

/**
 * Returns true when `hostname` is a loopback address.
 * Covers IPv4 (127.0.0.1), IPv6 (::1), "localhost", and *.localhost.
 */
export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.endsWith('.localhost')
  );
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * Returns true when the URL is a local preview URL:
 * - http OR https protocol
 * - loopback hostname (localhost, 127.0.0.1, ::1, *.localhost)
 * - has an explicit port (required — we only open specific preview ports)
 */
export function isLocalPreviewUrl(raw: string): boolean {
  const url = parseUrl(raw);
  if (!url) return false;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (!isLoopbackHostname(url.hostname)) return false;
  // Require an explicit port to narrow the allow-surface
  return url.port !== '';
}

/**
 * Returns true when the URL is safe to open in the system browser.
 *
 * Allowed:
 *   - https:// non-loopback (safe external)
 *   - http:// or https:// loopback with explicit port (local preview dev server)
 *
 * Blocked:
 *   - http:// non-loopback (insecure external)
 *   - file:// and other protocols
 *   - malformed / empty URLs
 */
export function isAllowedExternalUrl(raw: string): boolean {
  const url = parseUrl(raw);
  if (!url) return false;
  // Safe external HTTPS (non-loopback)
  if (url.protocol === 'https:' && !isLoopbackHostname(url.hostname)) return true;
  // Local preview server (loopback + explicit port)
  if (isLocalPreviewUrl(raw)) return true;
  return false;
}
