/**
 * Allen Design Studio — Preview hosting
 *
 * Materializes a version's screens to a managed temp directory and serves them
 * over an UNAUTHENTICATED, token-scoped static route so the design opens in the
 * user's real local browser (R11/R12) with working multi-screen navigation
 * (R15). The token is unguessable and maps to one version's directory.
 */

import { promises as fs } from 'node:fs';
import { join, normalize } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Db } from 'mongodb';
import { resolveAllenHome } from '@allen/engine';
import type { Screen } from './types.js';
import { ArtifactService } from '../artifact.service.js';

export const DSTUDIO_PREVIEW_PREFIX = '/dstudio-preview';

interface PreviewEntry {
  dir: string;
  versionId: string;
}

const registry = new Map<string, PreviewEntry>();

function previewRoot(): string {
  return join(resolveAllenHome(), 'design-studio', 'previews');
}

/** Write every screen as a file so relative links resolve like a static site. */
export async function materializeScreens(dir: string, screens: Screen[]): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  // Clear any stale files from a previous render.
  for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
    await fs.rm(join(dir, f), { force: true });
  }
  let wroteIndex = false;
  for (const s of screens) {
    await fs.writeFile(join(dir, s.fileName), s.html, 'utf8');
    if (s.fileName === 'index.html') wroteIndex = true;
  }
  if (!wroteIndex && screens[0]) {
    await fs.writeFile(join(dir, 'index.html'), screens[0].html, 'utf8');
  }
}

/**
 * Build/refresh a preview for a version and return a relative URL the client can
 * turn into an absolute one and open in the browser.
 */
export async function buildPreview(versionId: string, screens: Screen[]): Promise<{ token: string; url: string }> {
  // Reuse a stable token per version so refresh updates the same preview (R11).
  let token = [...registry.entries()].find(([, e]) => e.versionId === versionId)?.[0];
  if (!token) token = randomBytes(16).toString('hex');
  const dir = join(previewRoot(), token);
  await materializeScreens(dir, screens);
  registry.set(token, { dir, versionId });
  return { token, url: `${DSTUDIO_PREVIEW_PREFIX}/${token}/index.html` };
}

/** Express handler for the unauthenticated static preview route. */
export function createPreviewHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    const { token, file } = req.params as { token: string; file?: string };
    const entry = registry.get(token);
    if (!entry) {
      res.status(404).send('Preview expired or not found.');
      return;
    }
    const requested = file && file.length > 0 ? file : 'index.html';
    // Prevent path traversal — resolved path must stay inside the entry dir.
    const safe = normalize(requested).replace(/^(\.\.[/\\])+/, '');
    const full = join(entry.dir, safe);
    if (!full.startsWith(entry.dir)) {
      res.status(403).send('Forbidden');
      return;
    }
    try {
      const html = await fs.readFile(full, 'utf8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(html);
    } catch {
      res.status(404).send('Not found');
    }
  };
}

/** Test/maintenance helper. */
export function _resetPreviewRegistry(): void {
  registry.clear();
}

// ── Chat-session-scoped static preview ────────────────────────────────────────
// Serves a Design Studio chat session's HTML/CSS/JS artifacts as a mini static
// site so multi-screen prototypes (relative links between screens + a shared
// stylesheet) render correctly — both in the in-app iframe and the real browser.

export const DSTUDIO_CHAT_PREVIEW_PREFIX = '/dstudio-preview/chat';

function mimeForFile(filename: string): string {
  const f = filename.toLowerCase();
  if (/\.html?$/.test(f)) return 'text/html; charset=utf-8';
  if (f.endsWith('.css')) return 'text/css; charset=utf-8';
  if (f.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (f.endsWith('.json')) return 'application/json; charset=utf-8';
  if (f.endsWith('.svg')) return 'image/svg+xml';
  return 'text/plain; charset=utf-8';
}

/**
 * Express handler for `${DSTUDIO_CHAT_PREVIEW_PREFIX}/:sessionId/:file?` —
 * resolves a filename to the matching chat artifact and serves its content.
 * Unauthenticated (scoped by the session id, like the by-id artifact route).
 */
export function createChatPreviewHandler(db: Db) {
  const artifacts = new ArtifactService(db);
  return async (req: Request, res: Response): Promise<void> => {
    const { sessionId } = req.params as { sessionId: string };
    const requested = (req.params as { file?: string }).file?.trim() || 'index.html';
    const wanted = normalize(requested).replace(/^(\.\.[/\\])+/, '').replace(/^\/+/, '').toLowerCase();
    try {
      const docs = await artifacts.list({ rootType: 'chat', rootId: sessionId, limit: 500 });
      // Match by filename (basename); fall back to newest .html for the entry point.
      let doc = docs.find((d) => d.filename.toLowerCase() === wanted)
        ?? docs.find((d) => d.filename.toLowerCase().endsWith('/' + wanted));
      if (!doc && wanted === 'index.html') {
        doc = docs.filter((d) => /\.html?$/i.test(d.filename))
          .sort((a, b) => (b.createdAt?.getTime?.() ?? 0) - (a.createdAt?.getTime?.() ?? 0))[0];
      }
      if (!doc) { res.status(404).send('Not found'); return; }
      const result = await artifacts.readContent(doc.artifactId);
      if (!result) { res.status(404).send('Not found'); return; }
      res.setHeader('Content-Type', mimeForFile(doc.filename));
      res.setHeader('Cache-Control', 'no-store');
      res.send(result.content);
    } catch (e) {
      res.status(500).send((e as Error).message);
    }
  };
}
