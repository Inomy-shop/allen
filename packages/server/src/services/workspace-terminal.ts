/**
 * Workspace Terminal Service
 * Manages real PTY shells via node-pty + WebSocket transport.
 */

import { createServer, type IncomingMessage, type Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { createRequire } from 'module';
import { statSync, constants as fsConstants, accessSync, chmodSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

// node-pty is a native C++ addon — must use require() not import()
let pty: typeof import('node-pty') | null = null;
try {
  const req = createRequire(import.meta.url);
  pty = req('node-pty');
  console.log('[terminal] node-pty loaded successfully');
  // Self-heal: ensure the prebuilt `spawn-helper` binary for this
  // platform+arch has the execute bit set. Some installers (certain
  // archive tools, certain CI caches) strip the +x bit when
  // extracting node-pty's prebuilds, and posix_spawnp then fails
  // with a cryptic "posix_spawnp failed." error. This check runs
  // once at module load and is a no-op if the bit is already set.
  ensureSpawnHelperExecutable();
} catch (err: any) {
  console.warn('[terminal] node-pty not available:', err.message);
}

/**
 * Walks node-pty's prebuilds directory looking for the spawn-helper
 * binary matching the current platform+arch, and forces the execute
 * bit on if missing. Logs a heads-up so operators know what was fixed.
 *
 * Safe to run unconditionally — if the binary is already executable
 * the chmod is a no-op. If the file doesn't exist or we can't touch
 * it, we just log and move on; the spawn itself will produce a
 * cleaner error downstream.
 */
function ensureSpawnHelperExecutable(): void {
  if (process.platform === 'win32') return; // Windows has no spawn-helper
  try {
    const req = createRequire(import.meta.url);
    const ptyPkgPath = req.resolve('node-pty/package.json');
    const ptyRoot = dirname(ptyPkgPath);
    const triplet = `${process.platform}-${process.arch}`;
    const helperPath = join(ptyRoot, 'prebuilds', triplet, 'spawn-helper');
    if (!existsSync(helperPath)) {
      console.warn(`[terminal] spawn-helper not found at ${helperPath} — node-pty may not support ${triplet}`);
      return;
    }
    // Check current mode — fix only if the user or group execute bit is missing
    const st = statSync(helperPath);
    const mode = st.mode & 0o777;
    if ((mode & 0o111) === 0o111) return; // already executable for u/g/o — nothing to do
    chmodSync(helperPath, mode | 0o755);
    console.log(`[terminal] Fixed execute permissions on ${helperPath} (was ${mode.toString(8)}, now 755)`);
  } catch (err) {
    console.warn('[terminal] Could not self-heal spawn-helper permissions:', (err as Error).message);
  }
}

interface TerminalSession {
  id: string;
  workspaceId: string;
  pty: any; // IPty
  ws: Set<WebSocket>;
  buffer: string;
}

const sessions = new Map<string, TerminalSession>();
const MAX_TERMINAL_BUFFER_CHARS = 500_000;
const TERMINAL_IDLE_TIMEOUT_MS = 60 * 60 * 1000;

function appendTerminalBuffer(session: TerminalSession, data: string): void {
  session.buffer += data;
  if (session.buffer.length > MAX_TERMINAL_BUFFER_CHARS) {
    session.buffer = session.buffer.slice(session.buffer.length - MAX_TERMINAL_BUFFER_CHARS);
  }
}

export interface TerminalWebSocketServerOptions {
  host?: string;
  port?: number;
  server?: Server;
  serverPort?: number;
}

export interface TerminalWebSocketServerHandle {
  server: Server | null;
  port: number | null;
  url: string | null;
  ready: Promise<void>;
  stop(): Promise<void>;
}

/**
 * Resolve a shell binary that actually exists on this machine. Walks
 * a fallback chain so that a missing $SHELL doesn't break the terminal.
 *
 * Priority:
 *   1. ALLEN_TERMINAL_SHELL env override — explicit opt-in for ops.
 *   2. $SHELL from the environment — if it points at an existing, executable file.
 *   3. /bin/bash — nearly universal on Linux and macOS.
 *   4. /bin/sh — POSIX last-resort.
 *   5. /usr/bin/zsh — some distros ship zsh here.
 *   6. Windows: powershell.exe, cmd.exe.
 *
 * Returns null if none of these work — caller must handle that by
 * sending an error to the WebSocket instead of calling pty.spawn.
 */
function resolveShell(): string | null {
  if (process.platform === 'win32') {
    return process.env.COMSPEC ?? 'cmd.exe';
  }

  const candidates: string[] = [];
  if (process.env.ALLEN_TERMINAL_SHELL) candidates.push(process.env.ALLEN_TERMINAL_SHELL);
  if (process.env.SHELL) candidates.push(process.env.SHELL);
  candidates.push('/bin/bash', '/bin/sh', '/usr/bin/zsh', '/usr/local/bin/bash');

  for (const candidate of candidates) {
    try {
      const st = statSync(candidate);
      if (!st.isFile()) continue;
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Missing or not executable — try the next one.
    }
  }

  return null;
}

// Read lazily — dotenv hasn't loaded yet at import time
function getWsPort(): number {
  return parseInt(process.env.TERMINAL_WS_PORT ?? '4024', 10);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function killAllTerminalSessions(): void {
  for (const [key, session] of sessions) {
    try { session.pty.kill(); } catch { /* ignore */ }
    for (const client of session.ws) {
      try { client.close(); } catch { /* ignore */ }
    }
    sessions.delete(key);
  }
}

/**
 * Start a dedicated WebSocket server for terminal PTY on its own port.
 * URL patterns:
 *   /ws/workspaces/:workspaceId/terminal/:terminalId
 *   /ws/repos/:repoId/terminal/:terminalId
 */
export function startTerminalWebSocketServer(
  getWorkspacePath: (workspaceId: string) => Promise<string | null>,
  getRepoPath?: (repoId: string) => Promise<string | null>,
  options: TerminalWebSocketServerOptions = {},
): TerminalWebSocketServerHandle {
  if (!pty) {
    console.warn('[terminal] Skipping WebSocket setup — node-pty not available');
    return {
      server: null,
      port: null,
      url: null,
      ready: Promise.resolve(),
      stop: async () => { killAllTerminalSessions(); },
    };
  }

  const ownsServer = options.server == null;
  const httpServer = options.server ?? createServer((_req: IncomingMessage, res: any) => {
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true });

  const upgradeHandler = (request: IncomingMessage, socket: any, head: Buffer) => {
    const url = request.url ?? '';

    // Terminal WebSocket
    const termMatch = url.match(/^\/ws\/workspaces\/([a-f0-9]+)\/terminal\/([a-zA-Z0-9_-]+)/);
    if (termMatch) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        handleConnection(ws, 'workspace', termMatch[1], termMatch[2], getWorkspacePath);
      });
      return;
    }

    const repoTermMatch = url.match(/^\/ws\/repos\/([a-f0-9]+)\/terminal\/([a-zA-Z0-9_-]+)/);
    if (repoTermMatch && getRepoPath) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        handleConnection(ws, 'repo', repoTermMatch[1], repoTermMatch[2], getRepoPath);
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

    // On the desktop runtime this HTTP server also owns the application
    // realtime channel. Leave unknown upgrades untouched so its handler can
    // claim them. A dedicated terminal server may still reject unknown paths.
    if (ownsServer) socket.destroy();
  };
  httpServer.on('upgrade', upgradeHandler);

  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? getWsPort();
  let boundPort: number | null = options.serverPort ?? (typeof port === 'number' && port !== 0 ? port : null);
  let url: string | null = boundPort == null ? null : `ws://${host}:${boundPort}`;

  const ready = ownsServer
    ? new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, host, () => {
        httpServer.off('error', reject);
        const address = httpServer.address();
        if (address && typeof address === 'object') {
          boundPort = address.port;
          url = `ws://${host}:${boundPort}`;
        }
        console.log(`[terminal] WebSocket PTY server running on ${url ?? `ws://${host}:${port}`}`);
        resolve();
      });
    })
    : Promise.resolve().then(() => {
      console.log(`[terminal] WebSocket PTY handler attached to Allen server on ${url ?? `ws://${host}`}`);
    });

  return {
    server: httpServer,
    get port() { return boundPort; },
    get url() { return url; },
    ready,
    stop: async () => {
      killAllTerminalSessions();
      httpServer.off('upgrade', upgradeHandler);
      wss.close();
      if (ownsServer) {
        await closeServer(httpServer).catch((err) => {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'ERR_SERVER_NOT_RUNNING') throw err;
        });
      }
    },
  };
}

async function handleConnection(
  ws: WebSocket,
  sourceType: 'workspace' | 'repo',
  sourceId: string,
  terminalId: string,
  getPath: (id: string) => Promise<string | null>,
): Promise<void> {
  const sourceLabel = sourceType === 'repo' ? 'Repository' : 'Workspace';
  const key = `${sourceType}:${sourceId}:${terminalId}`;

  // Reuse existing session or create new
  let session = sessions.get(key);

  if (!session) {
    const cwd = await getPath(sourceId);
    if (!cwd) {
      ws.send(JSON.stringify({ type: 'error', data: `${sourceLabel} not found` }));
      ws.close();
      return;
    }

    // Guard: cwd must actually exist as a directory. node-pty's
    // posix_spawnp throws a hard, uncatchable error if the cwd is
    // missing — which has historically crashed the entire server
    // process. Check explicitly before the spawn.
    try {
      const st = statSync(cwd);
      if (!st.isDirectory()) {
        ws.send(JSON.stringify({ type: 'error', data: `${sourceLabel} path is not a directory: ${cwd}` }));
        ws.close();
        return;
      }
    } catch (err) {
      ws.send(JSON.stringify({
        type: 'error',
        data: `${sourceLabel} path not accessible: ${cwd} (${(err as Error).message})`,
      }));
      ws.close();
      return;
    }

    // Resolve a working shell. On Linux, $SHELL may point at a binary
    // that doesn't exist on the target machine (e.g., /bin/zsh inherited
    // from a dev laptop's systemd env, when the server only has bash).
    // Walk a fallback chain and pick the first one that actually exists
    // and is executable.
    const shell = resolveShell();
    if (!shell) {
      const tried = process.platform === 'win32'
        ? 'powershell.exe, cmd.exe'
        : '$SHELL, /bin/bash, /bin/sh';
      ws.send(JSON.stringify({
        type: 'error',
        data: `No executable shell found on this server. Tried: ${tried}. Install bash or set SHELL to an existing binary in the Allen systemd environment.`,
      }));
      ws.close();
      return;
    }

    // Clean env for workspace terminals — remove host server's PORT and other
    // conflicting vars so workspace services can use their own ports
    const cleanEnv = { ...process.env };
    delete cleanEnv.PORT;
    delete cleanEnv.TERMINAL_WS_PORT;
    delete cleanEnv.FILE_WATCH_WS_PORT;
    // Also overwrite SHELL in the child env so interactive programs
    // inside the terminal pick up the shell we actually spawned
    // (important when the user's $SHELL points at a missing binary).
    cleanEnv.SHELL = shell;

    // Wrap the pty spawn in a try/catch. node-pty's posix_spawnp can
    // fail for reasons we can't predict (kernel process table full,
    // shell missing, cwd deleted between the check above and the
    // spawn, SELinux/AppArmor denies, etc.), and if we don't catch
    // the error it propagates up through the async boundary and
    // crashes the entire Node process — killing every chat session,
    // every workflow run, and every MCP health check. Catching it
    // here keeps the blast radius to ONE broken terminal connection.
    let term;
    try {
      term = pty!.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd,
        env: {
          ...cleanEnv,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
        } as Record<string, string>,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[terminal] Failed to spawn pty for ${sourceType} ${sourceId} in ${cwd} with shell ${shell}:`, msg);

      // Build a user-facing hint based on the error pattern. "posix_spawnp
      // failed." almost always means node-pty's spawn-helper binary is
      // missing the execute bit or the prebuilt native module is broken
      // for this Node version. The startup self-heal should have fixed
      // this already, but if it didn't (read-only filesystem, wrong
      // install path, etc.), point the user at the manual fix.
      let hint = '';
      if (msg.includes('posix_spawnp')) {
        hint = ' This usually means node-pty\'s native prebuilt module is broken for your Node runtime. '
          + 'Try: (1) `chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper` '
          + '(substitute darwin-arm64 for your platform+arch), '
          + 'or (2) `cd node_modules/node-pty && npm run install` to rebuild, '
          + 'or (3) delete node_modules and reinstall.';
      } else if (msg.toLowerCase().includes('enoent')) {
        hint = ` The shell binary or cwd was not found. Verified cwd: ${cwd}. Verified shell: ${shell}.`;
      } else if (msg.toLowerCase().includes('eacces') || msg.toLowerCase().includes('permission')) {
        hint = ` Permission denied. Check that the shell (${shell}) and the cwd (${cwd}) are both accessible by the Allen process user.`;
      }

      try {
        ws.send(JSON.stringify({
          type: 'error',
          data: `Failed to start terminal: ${msg}${hint}`,
        }));
        ws.close();
      } catch {}
      return;
    }

    session = { id: terminalId, workspaceId: sourceId, pty: term, ws: new Set(), buffer: '' };
    sessions.set(key, session);

    // PTY output → broadcast to all connected WebSockets
    term.onData((data: string) => {
      appendTerminalBuffer(session!, data);
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
  if (session.buffer && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'replay', data: session.buffer }));
  }

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
      }, TERMINAL_IDLE_TIMEOUT_MS);
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
