/**
 * Allen Design Studio — Standalone bundle export (R19/R20)
 *
 * Writes a version's screens into a self-contained folder that renders correctly
 * when opened directly in a browser on another machine — no Allen, no build step,
 * no internet-hosted resource. Screens are already self-contained (inline CSS/JS,
 * no remote assets), so navigation between them works offline via relative links.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { resolveAllenHome } from '@allen/engine';
import type { DesignVersion } from './types.js';
import { materializeScreens } from './preview.service.js';

function exportRoot(): string {
  return join(resolveAllenHome(), 'design-studio', 'exports');
}

function safeName(name: string): string {
  return name.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'design';
}

export interface ExportResult {
  dir: string;
  files: string[];
  /** A small manifest describing the bundle. */
  manifest: { generatedAt: string; screens: { name: string; fileName: string }[] };
}

/**
 * Export a version to a standalone folder.
 * @param destinationDir Optional user-chosen destination (R21). When omitted,
 *   the bundle is written under Allen-managed storage.
 */
export async function exportVersion(version: DesignVersion, opts: { sessionTitle?: string; destinationDir?: string }): Promise<ExportResult> {
  const folder = `${safeName(opts.sessionTitle ?? 'design')}-v${version.seq}`;
  const base = opts.destinationDir ? opts.destinationDir : exportRoot();
  const dir = join(base, folder);

  await materializeScreens(dir, version.screens);

  const manifest = {
    generatedAt: new Date().toISOString(),
    screens: version.screens.map((s) => ({ name: s.name, fileName: s.fileName })),
  };
  await fs.writeFile(join(dir, 'allen-design.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const entry = version.screens.find((s) => s.fileName === 'index.html')?.fileName ?? version.screens[0]?.fileName ?? 'index.html';
  await fs.writeFile(
    join(dir, 'README.txt'),
    `Allen Design export\n\nOpen ${entry} in any web browser. No internet connection or installation required.\n`,
    'utf8',
  );

  const files = await fs.readdir(dir);
  return { dir, files, manifest };
}
