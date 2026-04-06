import { Router, type Request, type Response } from 'express';
import { param } from '../types.js';
import { McpService } from '../services/mcp.service.js';
import type { Db } from 'mongodb';

export function mcpRoutes(db: Db): Router {
  const router = Router();
  const service = new McpService(db);

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
      const { name, description, type, enabled, command, args, env, url, headers } = req.body;
      if (!name || !type) return res.status(400).json({ error: 'name and type are required' });

      const existing = await service.getByName(name);
      if (existing) return res.status(409).json({ error: `MCP server "${name}" already exists` });

      const server = await service.create({
        name, description: description ?? '', type, enabled: enabled ?? true,
        command, args, env, url, headers,
      });
      res.status(201).json(server);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // PUT /api/mcp/servers/:id — Update MCP server
  router.put('/servers/:id', async (req: Request, res: Response) => {
    try {
      const id = param(req, 'id');
      const server = await service.update(id, req.body);
      if (!server) return res.status(404).json({ error: 'MCP server not found' });
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
      res.json(server);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // DELETE /api/mcp/servers/:id — Delete MCP server
  router.delete('/servers/:id', async (req: Request, res: Response) => {
    try {
      const id = param(req, 'id');
      await service.delete(id);
      res.status(204).send();
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/mcp/servers/:id/test — Test connection to MCP server
  router.post('/servers/:id/test', async (req: Request, res: Response) => {
    try {
      const id = param(req, 'id');
      const server = await service.getById(id);
      if (!server) return res.status(404).json({ error: 'MCP server not found' });

      // Build config for this single server
      const mcpConfig: Record<string, unknown> = {};
      if (server.type === 'stdio') {
        mcpConfig[server.name] = { type: 'stdio', command: server.command, args: server.args ?? [], env: server.env ?? {} };
      } else if (server.type === 'sse') {
        mcpConfig[server.name] = { type: 'sse', url: server.url, headers: server.headers ?? {} };
      } else {
        mcpConfig[server.name] = { type: 'http', url: server.url, headers: server.headers ?? {} };
      }

      // Quick test: start a Claude query with this MCP server and check its status
      const { query } = await import('@anthropic-ai/claude-code');

      const conversation = query({
        prompt: `List the tools available from the "${server.name}" MCP server. Just list tool names, nothing else.`,
        options: {
          model: 'sonnet',
          maxTurns: 1,
          permissionMode: 'bypassPermissions',
          mcpServers: mcpConfig as any,
        } as any,
      });

      let toolCount = 0;
      let serverInfo: { name: string; version: string } | undefined;
      let responseText = '';

      for await (const msg of conversation) {
        if (msg.type === 'assistant') {
          const blocks = msg.message.content as Array<{ type: string; text?: string }>;
          responseText = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('');
        }
        // Check for MCP server status in the init message
        if (msg.type === 'result') {
          const result = msg as any;
          if (result.mcp_servers) {
            const mcpStatus = result.mcp_servers.find((s: any) => s.name === server.name);
            if (mcpStatus) {
              serverInfo = mcpStatus.serverInfo;
            }
          }
        }
      }

      // Count tools mentioned in response (rough heuristic)
      const lines = responseText.split('\n').filter(l => l.trim().startsWith('-') || l.trim().match(/^\d+\./));
      toolCount = lines.length || 1;

      await service.updateStatus(id, 'connected', { serverInfo, toolCount });
      res.json({ status: 'connected', serverInfo, toolCount, response: responseText.slice(0, 500) });
    } catch (err: unknown) {
      const error = (err as Error).message;
      const id = param(req, 'id');
      await service.updateStatus(id, 'failed', { error });
      res.json({ status: 'failed', error });
    }
  });

  return router;
}
