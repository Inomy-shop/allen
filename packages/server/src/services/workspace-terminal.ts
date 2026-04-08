/**
 * Workspace Terminal Service
 * Manages real PTY shells via node-pty + WebSocket transport.
 */

import { createServer, type IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { createRequire } from 'module';

// node-pty is a native C++ addon — must use require() not import()
let pty: typeof import('node-pty') | null = null;
try {
  const req = createRequire(import.meta.url);
  pty = req('node-pty');
  console.log('[terminal] node-pty loaded successfully');
} catch (err: any) {
  console.warn('[terminal] node-pty not available:', err.message);
}

interface TerminalSession {
  id: string;
  workspaceId: string;
  pty: any; // IPty
  ws: Set<WebSocket>;
}

const sessions = new Map<string, TerminalSession>();

const WS_PORT = parseInt(process.env.TERMINAL_WS_PORT ?? '4024', 10);

/**
 * Start a dedicated WebSocket server for terminal PTY on its own port.
 * URL pattern: /ws/workspaces/:workspaceId/terminal/:terminalId
 */
export function startTerminalWebSocketServer(getWorkspacePath: (workspaceId: string) => Promise<string | null>): void {
  if (!pty) {
    console.warn('[terminal] Skipping WebSocket setup — node-pty not available');
    return;
  }

  const httpServer = createServer((_req: IncomingMessage, res: any) => {
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request: IncomingMessage, socket: any, head: Buffer) => {
    const url = request.url ?? '';

    // Terminal WebSocket
    const termMatch = url.match(/^\/ws\/workspaces\/([a-f0-9]+)\/terminal\/([a-zA-Z0-9_-]+)/);
    if (termMatch) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        handleConnection(ws, termMatch[1], termMatch[2], getWorkspacePath);
      });
      return;
    }

    // File watch WebSocket — handled by workspace-watcher if imported
    const watchMatch = url.match(/^\/ws\/workspaces\/([a-f0-9]+)\/watch/);
    if (watchMatch) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        // Register client for file change notifications
        const wsId = watchMatch[1];
        if (!(globalThis as any).__fileWatchClients) (globalThis as any).__fileWatchClients = new Map();
        const clients: Map<string, Set<WebSocket>> = (globalThis as any).__fileWatchClients;
        if (!clients.has(wsId)) clients.set(wsId, new Set());
        clients.get(wsId)!.add(ws);
        ws.on('close', () => { clients.get(wsId)?.delete(ws); });
      });
      return;
    }

    socket.destroy();
  });

  httpServer.listen(WS_PORT, () => {
    console.log(`[terminal] WebSocket PTY server running on ws://localhost:${WS_PORT}`);
  });
}

async function handleConnection(ws: WebSocket, workspaceId: string, terminalId: string, getWorkspacePath: (id: string) => Promise<string | null>): Promise<void> {
  const key = `${workspaceId}:${terminalId}`;

  // Reuse existing session or create new
  let session = sessions.get(key);

  if (!session) {
    const cwd = await getWorkspacePath(workspaceId);
    if (!cwd) {
      ws.send(JSON.stringify({ type: 'error', data: 'Workspace not found' }));
      ws.close();
      return;
    }

    const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL ?? 'zsh');

    const term = pty!.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      } as Record<string, string>,
    });

    session = { id: terminalId, workspaceId, pty: term, ws: new Set() };
    sessions.set(key, session);

    // PTY output → broadcast to all connected WebSockets
    term.onData((data: string) => {
      for (const client of session!.ws) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(data);
        }
      }
    });

    term.onExit(() => {
      for (const client of session!.ws) { client.close(); }
      sessions.delete(key);
    });
  }

  // Add this WebSocket to the session
  session.ws.add(ws);

  // WebSocket input → PTY
  ws.on('message', (msg) => {
    const data = msg.toString();

    // Check for resize messages
    try {
      const parsed = JSON.parse(data);
      if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
        session?.pty.resize(parsed.cols, parsed.rows);
        return;
      }
    } catch {
      // Not JSON — regular terminal input
    }

    session?.pty.write(data);
  });

  ws.on('close', () => {
    session?.ws.delete(ws);
    // Don't kill the PTY when a client disconnects — allow reconnect
    // Only kill if no clients for 5 minutes
    if (session?.ws.size === 0) {
      setTimeout(() => {
        const s = sessions.get(key);
        if (s && s.ws.size === 0) {
          s.pty.kill();
          sessions.delete(key);
        }
      }, 300_000); // 5 min
    }
  });
}

/** Kill all terminals for a workspace (called on archive) */
export function killWorkspaceTerminals(workspaceId: string): void {
  for (const [key, session] of sessions) {
    if (session.workspaceId === workspaceId) {
      session.pty.kill();
      for (const client of session.ws) client.close();
      sessions.delete(key);
    }
  }
}
