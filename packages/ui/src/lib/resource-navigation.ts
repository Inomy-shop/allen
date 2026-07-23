const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'avif']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv']);
const FILE_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'mdx', 'txt', 'csv', 'yml', 'yaml',
  'css', 'scss', 'sass', 'less', 'html', 'xml', 'svg', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'cc', 'cpp', 'h', 'hpp', 'sh', 'bash', 'zsh', 'fish', 'sql', 'graphql', 'gql', 'toml', 'ini',
  'env', 'lock', 'log', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
]);

export type MediaKind = 'image' | 'video';

function extension(value: string): string {
  return value.split(/[?#]/, 1)[0]?.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? '';
}

export function mediaKindForPath(value: string): MediaKind | null {
  const ext = extension(value);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  return null;
}

export function mimeTypeForMediaPath(value: string, kind = mediaKindForPath(value)): string | null {
  if (!kind) return null;
  const ext = extension(value);
  if (kind === 'image') {
    if (ext === 'jpg') return 'image/jpeg';
    if (ext === 'svg') return 'image/svg+xml';
    return `image/${ext || 'png'}`;
  }
  if (ext === 'mov') return 'video/quicktime';
  if (ext === 'm4v') return 'video/x-m4v';
  if (ext === 'ogv') return 'video/ogg';
  return `video/${ext || 'mp4'}`;
}

export function chatSessionIdFromHref(href: string): string | null {
  try {
    const url = new URL(href, typeof window !== 'undefined' ? window.location.href : 'http://localhost/');
    if (typeof window !== 'undefined' && url.origin !== window.location.origin) return null;
    const match = url.pathname.match(/^\/chat\/([^/]+)\/?$/);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

/** Extract a conservative repository-relative file reference from inline code. */
export function filePathFromReference(value: string): string | null {
  let candidate = value.trim();
  if (!candidate || /\s|^[a-z]+:\/\//i.test(candidate) || candidate.startsWith('-')) return null;
  candidate = candidate.replace(/^\.\//, '');
  candidate = candidate.replace(/#L\d+(?:-L?\d+)?$/i, '');
  candidate = candidate.replace(/:(\d+)(?::\d+)?$/, '');
  if (!candidate || candidate.startsWith('/') || candidate.includes('..')) return null;

  const ext = extension(candidate);
  const isSpecialFilename = /^(Dockerfile|Makefile|Procfile|README|LICENSE)(\.[A-Za-z0-9]+)?$/i.test(candidate);
  if (!candidate.includes('/') && !FILE_EXTENSIONS.has(ext) && !isSpecialFilename) return null;
  if (!/^[A-Za-z0-9_@+.,()\[\]{}' -]+(?:\/[A-Za-z0-9_@+.,()\[\]{}' -]+)*$/u.test(candidate)) return null;
  return candidate;
}

export function openExternalResource(href: string): void {
  let resolved: URL;
  try {
    resolved = new URL(href, window.location.href);
  } catch {
    return;
  }
  if (!['http:', 'https:', 'mailto:', 'tel:'].includes(resolved.protocol)) return;
  if (window.allenDesktop?.openExternal) {
    void window.allenDesktop.openExternal(resolved.toString());
    return;
  }
  window.open(resolved.toString(), '_blank', 'noopener,noreferrer');
}
