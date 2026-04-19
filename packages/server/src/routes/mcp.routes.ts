import { Router, type Request, type Response } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import multer from 'multer';
import { param } from '../types.js';
import {
  McpService,
  resolveEnvSecrets,
  resolveArgSecrets,
  storeEnvLiteralsAsSecrets,
  storeArgLiteralsAsSecretsForPreset,
} from '../services/mcp.service.js';
import { McpBundleService } from '../services/mcp-bundle.service.js';
import { healthCheckMcpServer } from '../services/mcp-health.service.js';
import type { Db } from 'mongodb';

const BUNDLE_UPLOAD_TMP = '/tmp/mcp-bundle-uploads';
if (!existsSync(BUNDLE_UPLOAD_TMP)) mkdirSync(BUNDLE_UPLOAD_TMP, { recursive: true });

const bundleUpload = multer({
  dest: BUNDLE_UPLOAD_TMP,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (_req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.zip')) {
      cb(new Error('Only .zip files are accepted'));
      return;
    }
    cb(null, true);
  },
});

const execFileAsync = promisify(execFile);

/** Sync all enabled MCP servers to Codex CLI config */
async function syncAllToCodex(service: McpService, db: Db): Promise<void> {
  try {
    const servers = await service.list();
    let existing = '';
    try { existing = (await execFileAsync('codex', ['mcp', 'list'], { timeout: 5000 })).stdout; } catch {}

    for (const s of servers) {
      if (s.type !== 'stdio') continue;
      const isRegistered = existing.includes(s.name);
      // Resolve @secret: references in both env and args — Codex needs plaintext
      const [env, serverArgs] = await Promise.all([
        resolveEnvSecrets(s.env, db),
        resolveArgSecrets(s.args, db),
      ]);

      // Silence dotenv banner on stdout — corrupts Codex's strict rmcp client
      const envWithQuiet = { ...env, DOTENV_CONFIG_QUIET: 'true' };

      if (s.enabled && !isRegistered) {
        // Add
        const args = ['mcp', 'add', s.name];
        for (const [k, v] of Object.entries(envWithQuiet)) args.push('--env', `${k}=${v}`);
        args.push('--', s.command!, ...serverArgs);
        await execFileAsync('codex', args, { timeout: 10000 });
      } else if (!s.enabled && isRegistered) {
        // Remove
        await execFileAsync('codex', ['mcp', 'remove', s.name], { timeout: 5000 });
      } else if (s.enabled && isRegistered) {
        // Update: remove + re-add
        await execFileAsync('codex', ['mcp', 'remove', s.name], { timeout: 5000 });
        const args = ['mcp', 'add', s.name];
        for (const [k, v] of Object.entries(envWithQuiet)) args.push('--env', `${k}=${v}`);
        args.push('--', s.command!, ...serverArgs);
        await execFileAsync('codex', args, { timeout: 10000 });
      }
    }

    // Remove servers from Codex that no longer exist in DB
    const dbNames = new Set(servers.map(s => s.name));
    const lines = existing.split('\n').filter(l => l.trim() && !l.startsWith('Name'));
    for (const line of lines) {
      const name = line.split(/\s+/)[0];
      if (name && !dbNames.has(name) && name !== 'allen') {
        await execFileAsync('codex', ['mcp', 'remove', name], { timeout: 5000 }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[mcp] Codex sync failed:', (err as Error).message);
  }
}

export function mcpRoutes(db: Db): Router {
  const router = Router();
  const service = new McpService(db);
  const bundleService = new McpBundleService(db);

  // ── Bundle upload routes ──

  // POST /api/mcp/servers/upload — upload a zip bundle, extract, run npm install
  router.post('/servers/upload', bundleUpload.single('file'), async (req: Request, res: Response) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });
    try {
      const meta = await bundleService.extractZip(file.path, file.originalname);
      // Delete the temp uploaded file — it's been extracted
      try { unlinkSync(file.path); } catch {}
      res.status(201).json(meta);
    } catch (err: unknown) {
      try { unlinkSync(file.path); } catch {}
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // GET /api/mcp/servers/upload/:bundleId — get current status (for polling)
  router.get('/servers/upload/:bundleId', (req: Request, res: Response) => {
    const meta = bundleService.getMeta(param(req, 'bundleId'));
    if (!meta) return res.status(404).json({ error: 'Bundle not found' });
    res.json(meta);
  });

  // PATCH /api/mcp/servers/upload/:bundleId — override entry point
  router.patch('/servers/upload/:bundleId', (req: Request, res: Response) => {
    try {
      const { entry } = req.body;
      if (!entry) return res.status(400).json({ error: 'entry is required' });
      bundleService.setEntry(param(req, 'bundleId'), entry);
      res.json(bundleService.getMeta(param(req, 'bundleId')));
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // DELETE /api/mcp/servers/upload/:bundleId — discard an uploaded bundle
  router.delete('/servers/upload/:bundleId', (req: Request, res: Response) => {
    bundleService.delete(param(req, 'bundleId'));
    res.status(204).send();
  });

  // GET /api/mcp/servers — List all MCP servers
  router.get('/servers', async (_req: Request, res: Response) => {
    try {
      const servers = await service.list();
      res.json(servers);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/mcp/presets — List available presets
  router.get('/presets', (_req: Request, res: Response) => {
    res.json(service.getPresets());
  });

  // POST /api/mcp/servers — Create MCP server
  router.post('/servers', async (req: Request, res: Response) => {
    try {
      const { name, description, type, enabled, command, args, env, url, headers, bundleId } = req.body;
      if (!name || !type) return res.status(400).json({ error: 'name and type are required' });

      const existing = await service.getByName(name);
      if (existing) return res.status(409).json({ error: `MCP server "${name}" already exists` });

      // Resolve bundle if bundleId is present — command/args/cwd come from the bundle
      let finalCommand = command;
      let finalArgs: string[] = args ?? [];
      let bundlePath: string | undefined;
      let bundleEntry: string | undefined;

      if (bundleId) {
        const meta = bundleService.getMeta(bundleId);
        if (!meta) return res.status(404).json({ error: `Bundle ${bundleId} not found` });
        if (meta.status !== 'ready') {
          return res.status(400).json({ error: `Bundle is not ready (status: ${meta.status})` });
        }
        const entryPath = bundleService.getEntryPath(bundleId);
        if (!entryPath) return res.status(400).json({ error: 'Bundle has no entry point' });
        finalCommand = 'node';
        finalArgs = [entryPath];
        bundlePath = bundleService.getBundlePath(bundleId);
        bundleEntry = meta.entry;
      }

      // Move any literal env values AND preset-defined sensitive args into the
      // encrypted secrets store, replacing them with `@secret:` references.
      const [envWithRefs, argsWithRefs] = await Promise.all([
        storeEnvLiteralsAsSecrets(env, db),
        storeArgLiteralsAsSecretsForPreset(name, finalArgs, db),
      ]);

      const server = await service.create({
        name, description: description ?? '', type, enabled: enabled ?? true,
        command: finalCommand, args: argsWithRefs, env: envWithRefs, url, headers,
        bundleId, bundlePath, bundleEntry,
      });

      // Link the bundle so the cleanup cron keeps it
      if (bundleId && server._id) {
        bundleService.markLinked(bundleId, server._id.toString());
      }

      syncAllToCodex(service, db).catch(() => {});
      res.status(201).json(server);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // PUT /api/mcp/servers/:id — Update MCP server
  router.put('/servers/:id', async (req: Request, res: Response) => {
    try {
      const id = param(req, 'id');
      // If env or args are being updated, run literals through the secrets store first.
      const update = { ...req.body };
      if (update.env !== undefined) {
        update.env = await storeEnvLiteralsAsSecrets(update.env, db);
      }
      if (update.args !== undefined) {
        // Need the server name to look up the preset's argKeys
        const existing = await service.getById(id);
        const presetName = update.name ?? existing?.name;
        update.args = await storeArgLiteralsAsSecretsForPreset(presetName, update.args, db);
      }
      const server = await service.update(id, update);
      if (!server) return res.status(404).json({ error: 'MCP server not found' });
      syncAllToCodex(service, db).catch(() => {});
      res.json(server);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // PATCH /api/mcp/servers/:id/toggle — Toggle enabled/disabled
  router.patch('/servers/:id/toggle', async (req: Request, res: Response) => {
    try {
      const id = param(req, 'id');
      const server = await service.toggle(id);
      if (!server) return res.status(404).json({ error: 'MCP server not found' });
      syncAllToCodex(service, db).catch(() => {});
      res.json(server);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // DELETE /api/mcp/servers/:id — Delete MCP server
  router.delete('/servers/:id', async (req: Request, res: Response) => {
    try {
      const id = param(req, 'id');
      const existing = await service.getById(id);
      await service.delete(id);
      // Clean up the bundle directory if this server had one
      if (existing?.bundleId) {
        bundleService.delete(existing.bundleId);
      }
      syncAllToCodex(service, db).catch(() => {});
      res.status(204).send();
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/mcp/servers/:id/test — Test connection via a real MCP handshake
  router.post('/servers/:id/test', async (req: Request, res: Response) => {
    const id = param(req, 'id');
    try {
      const server = await service.getById(id);
      if (!server) return res.status(404).json({ error: 'MCP server not found' });

      // Spawn the server and do an actual MCP handshake (initialize + tools/list)
      // to count the real number of tools. Avoids relying on an LLM round-trip.
      const result = await healthCheckMcpServer(server, db);

      if (result.ok) {
        await service.updateStatus(id, 'connected', {
          serverInfo: result.serverInfo,
          toolCount: result.toolCount ?? 0,
        });
        res.json({
          status: 'connected',
          serverInfo: result.serverInfo,
          toolCount: result.toolCount ?? 0,
          durationMs: result.durationMs,
        });
      } else {
        await service.updateStatus(id, 'failed', { error: result.error });
        res.json({ status: 'failed', error: result.error, durationMs: result.durationMs });
      }
    } catch (err: unknown) {
      const error = (err as Error).message;
      await service.updateStatus(id, 'failed', { error });
      res.json({ status: 'failed', error });
    }
  });

  return router;
}
