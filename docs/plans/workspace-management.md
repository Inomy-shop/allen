# Workspace & PR Management — Implementation Plan

## Goal

1. **Workspaces** — isolated git worktrees with terminal, diff, preview, and agent integration
2. **PR Management** — view, create, test, and manage PRs from Allen
3. **Configurable lifecycle hooks** — setup/cleanup scripts per repo
4. **Sandbox preview** — run full-stack apps in workspace, preview through reverse proxy
5. **Works everywhere** — same behavior on localhost and deployed EC2/server

---

## Core Architecture: Everything Through One Origin

All workspace features (terminal, preview, API) are proxied through the Allen server. The browser ONLY talks to the Allen URL — never to internal ports directly.

```
Browser (localhost:4023 OR allen.company.com)
  │
  ├─ /app/*                              → Allen UI (static)
  ├─ /api/*                              → Allen API
  ├─ /api/workspaces/:id/preview/*       → Reverse proxy → internal port on same machine
  ├─ /api/workspaces/:id/preview-ws/*    → WebSocket proxy (HMR/live reload)
  └─ /ws/workspaces/:id/terminal/:tid    → WebSocket PTY (terminal)
```

**Why this works on both local and deployed:**
- Browser connects to Allen server URL (only changes between environments)
- Express server proxies to `localhost:{port}` internally on the SAME machine
- Terminal WebSocket goes through the same origin
- Vite HMR WebSocket also proxied — no CORS, no port exposure
- No DNS changes, no Docker, no firewall rules needed

---

## Data Models

### Workspace

```typescript
interface Workspace {
  _id: ObjectId;
  name: string;                    // "light-theme-feature"
  repoId: string;
  repoName: string;
  repoPath: string;                // original repo path
  worktreePath: string;            // /tmp/allen-workspaces/<id>
  branch: string;                  // "feature/light-theme"
  baseBranch: string;              // "main"
  status: 'creating' | 'setting_up' | 'active' | 'running' | 'archiving' | 'archived' | 'failed';
  
  // Source
  source: 'new' | 'pr';
  prNumber?: number;
  prTitle?: string;
  prUrl?: string;
  
  // Port assignment
  basePort: number;                // e.g., 15000 (services use basePort + offset)
  
  // Setup progress
  setupProgress?: {
    currentStep: number;
    totalSteps: number;
    currentCommand: string;
    log: string[];
    status: 'running' | 'completed' | 'failed';
  };
  
  // Running services
  services: {
    name: string;                  // "ui", "api"
    command: string;
    port: number;                  // actual assigned port
    pid?: number;
    status: 'stopped' | 'starting' | 'ready' | 'failed';
    healthCheck?: string;
    startedAt?: Date;
  }[];
  
  // Terminal sessions
  terminals: {
    id: string;
    name: string;
    active: boolean;
  }[];
  
  // Git state
  changedFiles: number;
  ahead: number;
  behind: number;
  lastCommit?: { hash: string; message: string; date: Date };
  
  // Agent integration
  chatSessionId?: string;
  
  createdAt: Date;
  updatedAt: Date;
}
```

### Workspace Config (per repo)

```typescript
interface WorkspaceConfig {
  _id: ObjectId;
  repoId: string;
  
  // Lifecycle hooks
  setupScript: string[];             // ["npm install", "cp .env.example .env"]
  cleanupScript: string[];           // ["rm -rf node_modules", "rm -rf dist"]
  prePrScript?: string[];            // ["npm run lint", "npm run test"]
  
  // Services (full-stack support)
  services: {
    name: string;                    // "ui", "api", "worker"
    command: string;                 // "npm run dev -- --port {port}"
    portOffset: number;              // 0, 1, 2
    healthCheck?: string;            // "/", "/api/health"
    env?: Record<string, string>;    // per-service env
  }[];
  
  // Global
  envVars?: Record<string, string>;
  autoStart?: boolean;               // start services on workspace open
  
  createdAt: Date;
  updatedAt: Date;
}
```

### Pull Request

```typescript
interface PullRequest {
  _id: ObjectId;
  repoId: string;
  repoName: string;
  number: number;
  title: string;
  description?: string;
  branch: string;
  baseBranch: string;
  status: 'open' | 'merged' | 'closed';
  author: string;
  url: string;
  
  // Allen metadata
  createdByAgent?: string;
  chatSessionId?: string;
  workspaceId?: string;
  
  // Stats
  additions: number;
  deletions: number;
  changedFiles: number;
  labels: string[];
  
  createdAt: Date;
  updatedAt: Date;
  mergedAt?: Date;
}
```

---

## Workspace Config UI (Repo Settings)

```
┌─ Repo: allen ─────────────────────────────────────────────┐
│                                                                │
│  WORKSPACE CONFIGURATION                                       │
│                                                                │
│  Setup Script (runs after worktree creation):                  │
│  ┌───────────────────────────────────────────────────────┐    │
│  │ 1. npm install                                         │    │
│  │ 2. cp .env.example .env                                │    │
│  │ 3. npx prisma generate                                 │    │
│  │ [+ Add step]                                           │    │
│  └───────────────────────────────────────────────────────┘    │
│                                                                │
│  Services:                                                     │
│  ┌───────────────────────────────────────────────────────┐    │
│  │ Name        Command                    Port   Health  │    │
│  │ ─────────── ────────────────────────── ────── ─────── │    │
│  │ ui          npm run dev -- --port {port} +0    /       │    │
│  │ server      cd packages/server && npm    +1    /health │    │
│  │             run dev                                    │    │
│  │ [+ Add service]                                        │    │
│  └───────────────────────────────────────────────────────┘    │
│                                                                │
│  ☑ Auto-start services when workspace opens                   │
│                                                                │
│  Cleanup Script (runs before archive):                         │
│  ┌───────────────────────────────────────────────────────┐    │
│  │ 1. rm -rf node_modules                                 │    │
│  │ 2. rm -rf dist .turbo .next                            │    │
│  │ [+ Add step]                                           │    │
│  └───────────────────────────────────────────────────────┘    │
│                                                                │
│  Pre-PR Checks (runs before creating PR):                     │
│  ┌───────────────────────────────────────────────────────┐    │
│  │ 1. npm run lint                                        │    │
│  │ 2. npm run test                                        │    │
│  │ 3. npm run build                                       │    │
│  │ [+ Add step]                                           │    │
│  └───────────────────────────────────────────────────────┘    │
│                                                                │
│  Environment Variables:                                        │
│  ┌──────────────┬─────────────────────────────────────────┐   │
│  │ NODE_ENV     │ development                              │   │
│  │ DATABASE_URL │ postgresql://localhost:5433/dev           │   │
│  │ [+ Add var]                                             │   │
│  └──────────────┴─────────────────────────────────────────┘   │
│                                                                │
│                                              [Save Config]    │
└────────────────────────────────────────────────────────────────┘
```

---

## Workspace Detail Page

```
┌─ feature/light-theme ─── allen ─── ● active ─────────────────────┐
│ Branch: feature/light-theme → main  |  3 files changed  |  +145 -23  │
│ [Commit]  [Push]  [Create PR]  [Archive]                              │
├───────────────┬───────────────────────────────────────────────────────┤
│               │                                                       │
│  FILES        │  [Terminal]  [Diff]  [Preview]                        │
│               │                                                       │
│  Changed:     │  ┌─ Services ────────────────────────────────────┐   │
│  ~ theme.ts   │  │ ● ui     :15000  ✅ ready   [↗]  [⟳]  [⏹]  │   │
│  + light.ts   │  │ ● server :15001  ✅ ready   [↗]  [⟳]  [⏹]  │   │
│  ~ settings.ts│  │ ● engine :15002  ⏳ building                  │   │
│               │  └───────────────────────────────────────────────┘   │
│  All files:   │                                                       │
│  ▸ packages/  │  ┌───────────────────────────────────────────────┐   │
│    ▸ ui/      │  │                                                │   │
│    ▸ server/  │  │  [iframe: /api/workspaces/:id/preview/ ]      │   │
│    ▸ engine/  │  │                                                │   │
│               │  │  Preview of the running UI                     │   │
│               │  │                                                │   │
│               │  └───────────────────────────────────────────────┘   │
│               │                                                       │
│               │  [↗ Open in new tab]  [Switch: ui ▾]  [Split view]   │
├───────────────┴───────────────────────────────────────────────────────┤
│ Terminal 1  [Terminal 2]  [+]                                          │
│ ┌─────────────────────────────────────────────────────────────────┐   │
│ │ ~/allen-workspaces/abc123 $                                  │   │
│ │ $ npm run dev                                                    │   │
│ │ > allen-ui@1.0.0 dev                                        │   │
│ │ > vite                                                           │   │
│ │ VITE v5.0.0 ready in 340ms                                      │   │
│ │   ➜ Local: http://localhost:15000/                               │   │
│ │ $ _                                                              │   │
│ └─────────────────────────────────────────────────────────────────┘   │
├───────────────────────────────────────────────────────────────────────┤
│ Chat: Linked to "I want full fledge addition of few light theme..."   │
│       @product-manager  [Open chat]  [Unlink]                         │
└───────────────────────────────────────────────────────────────────────┘
```

---

## PR Management Page

### PR List (`/pull-requests`)

```
┌──────────────────────────────────────────────────────────────────────┐
│ PULL REQUESTS                         [Sync from GitHub]  [Refresh]  │
├──────────────────────────────────────────────────────────────────────┤
│ [Open ▾]  [All Repos ▾]  [Search...]                                 │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  #42  Add light theme support                              ● Open    │
│  allen · feature/light-theme → main · 🤖 agent:engineer          │
│  2h ago · 3 files · +145 -23                                          │
│  [Open Workspace]  [View Diff]  [GitHub ↗]                           │
│  ──────────────────────────────────────────────────────────────────   │
│                                                                       │
│  #38  Fix pagination edge case                             ● Open    │
│  es-data-pipeline · fix/pagination → development · by shree           │
│  1d ago · 1 file · +12 -4                                             │
│  [Open Workspace]  [View Diff]  [GitHub ↗]                           │
│  ──────────────────────────────────────────────────────────────────   │
│                                                                       │
│  #35  Update API documentation                            ✅ Merged   │
│  allen · docs/api-update → main · 🤖 agent:coding-writer         │
│  3d ago · 5 files · +89 -12                                           │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

### "Open Workspace" from PR

```
1. Click "Open Workspace" on PR #42
2. → git fetch origin feature/light-theme
3. → git worktree add /tmp/allen-workspaces/<id> feature/light-theme
4. → Run repo's setupScript (npm install, etc.)
5. → Auto-start services if configured
6. → Link workspace to PR
7. → Navigate to workspace detail page
8. User tests the changes, runs app in preview
9. When done → Archive workspace (runs cleanup)
```

---

## Reverse Proxy (Preview)

### Express Middleware

```typescript
// In app.ts — handles both HTTP and WebSocket proxy
import { createProxyMiddleware } from 'http-proxy-middleware';

// HTTP preview proxy
app.use('/api/workspaces/:id/preview', async (req, res, next) => {
  const workspace = await getWorkspace(req.params.id);
  const serviceName = req.query.service ?? workspace.services[0]?.name;
  const service = workspace.services.find(s => s.name === serviceName);
  if (!service || service.status !== 'ready') return res.status(503).json({ error: 'Service not ready' });
  
  return createProxyMiddleware({
    target: `http://localhost:${service.port}`,
    changeOrigin: true,
    pathRewrite: { [`^/api/workspaces/${req.params.id}/preview`]: '' },
    ws: true,  // proxy WebSocket too (for HMR)
  })(req, res, next);
});

// WebSocket preview proxy (Vite HMR, Next.js hot reload)
app.use('/api/workspaces/:id/preview-ws', async (req, res, next) => {
  // Same as above but specifically for WebSocket upgrade
});
```

### How HMR Works Through Proxy

1. Vite dev server runs on `localhost:15000` inside workspace
2. Vite's HMR WebSocket connects to the same origin (the Allen URL)
3. Browser sends WS to `/api/workspaces/:id/preview-ws/`
4. Express proxies WS to `localhost:15000`
5. Vite sends file change notification → browser hot-reloads
6. User sees changes instantly in the iframe

### Port Assignment

```
Workspace index 0: ports 15000-15009
Workspace index 1: ports 15010-15019
Workspace index 2: ports 15020-15029
...
```

Each workspace gets 10 ports. Services use `basePort + portOffset`. Port range stored in workspace document. On archive, ports are freed.

---

## Workspace Lifecycle

### Creation

```
POST /api/workspaces
  { repoId, branch, baseBranch, name }

1. status → 'creating'
2. Assign basePort from available range
3. git worktree add <path> -b <branch> <baseBranch>
4. status → 'setting_up'
5. For each setupScript command:
   → Run in workspace cwd
   → Stream output to setupProgress.log
   → Update setupProgress.currentStep
6. status → 'active'
7. If autoStart: start all services
   → status → 'running'
```

### Archive

```
DELETE /api/workspaces/:id

1. status → 'archiving'
2. Stop all services (kill PIDs)
3. Close all terminal PTYs
4. For each cleanupScript command:
   → Run in workspace cwd
   → rm -rf node_modules, dist, etc.
5. git worktree remove <path>
6. Free port range
7. status → 'archived'
```

### Create PR from Workspace

```
POST /api/workspaces/:id/create-pr
  { title, description }

1. Run prePrScript if configured:
   → npm run lint → must pass
   → npm run test → must pass
   → npm run build → must pass
   → If any fail: return error with output
2. git add -A && git commit (if uncommitted changes)
3. git push -u origin <branch>
4. gh pr create --title --body --base <baseBranch>
5. Save PR to pull_requests collection
6. Link workspace to PR
7. Return PR URL
```

---

## API Endpoints

### Workspaces
```
GET    /api/workspaces                              → List
POST   /api/workspaces                              → Create new
POST   /api/workspaces/from-pr                      → Create from PR
GET    /api/workspaces/:id                          → Details
PATCH  /api/workspaces/:id                          → Update
DELETE /api/workspaces/:id                          → Archive

GET    /api/workspaces/:id/diff                     → Diff vs base
GET    /api/workspaces/:id/files                    → Changed files
GET    /api/workspaces/:id/file/*path               → File content
POST   /api/workspaces/:id/commit                   → Commit
POST   /api/workspaces/:id/push                     → Push
POST   /api/workspaces/:id/create-pr                → Create PR
POST   /api/workspaces/:id/pull                     → Pull from base
POST   /api/workspaces/:id/link-chat                → Link chat session
```

### Services (Sandbox)
```
GET    /api/workspaces/:id/services                 → List services + status
POST   /api/workspaces/:id/services/:name/start     → Start service
POST   /api/workspaces/:id/services/:name/stop      → Stop service
POST   /api/workspaces/:id/services/:name/restart    → Restart
GET    /api/workspaces/:id/preview/*                → Reverse proxy to service
WS     /api/workspaces/:id/preview-ws/*             → WebSocket proxy (HMR)
```

### Terminal
```
WS     /ws/workspaces/:id/terminal/:termId          → WebSocket PTY
POST   /api/workspaces/:id/terminals                → Create terminal
DELETE /api/workspaces/:id/terminals/:termId         → Close terminal
POST   /api/workspaces/:id/terminals/:termId/resize → Resize
```

### Workspace Config
```
GET    /api/workspace-config/:repoId                → Get config
PUT    /api/workspace-config/:repoId                → Save config
```

### Pull Requests
```
GET    /api/pull-requests                           → List PRs
POST   /api/pull-requests/sync                      → Sync from GitHub
GET    /api/pull-requests/:id                       → PR detail
GET    /api/pull-requests/:id/diff                  → PR diff
POST   /api/pull-requests/:id/workspace             → Create workspace from PR
POST   /api/pull-requests/:id/merge                 → Merge PR
POST   /api/pull-requests/:id/close                 → Close PR
```

---

## Sidebar Navigation

```
Chat
Dashboard

BUILD
  ▸ Agent Workflows
  ▸ Agents
  ▸ Repos

DEVELOP                              ← NEW
  ▸ Workspaces
  ▸ Pull Requests

MONITOR
  ▸ Executions
  ▸ Analytics
  ▸ Learnings
```

---

## Implementation Phases

### Phase 1: Core Workspace CRUD + Config
- MongoDB collections: `workspaces`, `workspace_configs`
- Workspace CRUD API (create, list, get, archive)
- Git worktree operations (create, status, remove)
- Workspace config API + config UI in repo settings
- Setup/cleanup script execution with progress tracking
- Workspace list page + create dialog
- Port range assignment

**Dependencies**: none
**Estimated effort**: Medium

### Phase 2: Terminal
- Install `node-pty` (server), `xterm` + addons (UI)
- WebSocket handler for PTY (attached to Express via `ws` library)
- Terminal component with multiple tabs
- Workspace detail page (3-panel layout)
- Terminal persistence (reconnect to same PTY on page refresh)

**Dependencies**: Phase 1
**New packages**: `node-pty`, `ws`, `xterm`, `xterm-addon-fit`, `xterm-addon-web-links`, `xterm-addon-search`

### Phase 3: Diff + File Viewer
- Git diff API (`git diff <base>...HEAD`)
- Changed files tree component
- Diff viewer using Monaco editor diff mode
- File content viewer
- Click file in tree → shows diff

**Dependencies**: Phase 1
**Existing packages**: Monaco editor (already in project)

### Phase 4: Service Management + Sandbox Preview
- Service config per repo (multi-service)
- Service start/stop/restart with PID tracking
- Health check polling (5s interval)
- Reverse proxy middleware (`http-proxy-middleware`)
- WebSocket proxy for HMR
- Preview panel with iframe + service switcher
- Service status indicators
- Auto-start from config

**Dependencies**: Phase 2 (terminal for manual commands)
**New packages**: `http-proxy-middleware`

### Phase 5: PR Management
- MongoDB collection: `pull_requests`
- GitHub sync via `gh` CLI
- PR list + detail pages
- PR diff viewer (reuse workspace diff component)
- Create workspace from PR branch
- Create PR from workspace (with pre-PR script execution)
- Agent attribution on PRs

**Dependencies**: Phase 1, Phase 3

### Phase 6: Agent Integration
- Link workspace to chat session
- Agent `repo_path` resolves to workspace path when linked
- `spawn_agent` uses workspace path
- Live diff updates as agents edit files
- "Create PR" agent action → workspace PR flow
- Workspace context in agent system prompts

**Dependencies**: Phase 1, existing chat system

### Phase 7: Polish
- Terminal themes matching app theme
- Keyboard shortcuts (Ctrl+` toggle terminal)
- Workspace templates
- Bulk archive
- Activity timeline per workspace
- Notifications (setup done, PR merged)
- Split preview (UI + API side by side)

---

## Files to Create

### Server
| File | Purpose |
|------|---------|
| `routes/workspace.routes.ts` | Workspace + config + service APIs |
| `routes/pull-request.routes.ts` | PR management APIs |
| `services/workspace.service.ts` | Git worktree ops + lifecycle hooks |
| `services/workspace-terminal.ts` | PTY spawn + WebSocket management |
| `services/workspace-service-manager.ts` | Service start/stop + health check + port mgmt |
| `services/workspace-proxy.ts` | Reverse proxy middleware for preview |
| `services/pull-request.service.ts` | GitHub PR sync + operations |

### UI
| File | Purpose |
|------|---------|
| `pages/WorkspaceListPage.tsx` | List all workspaces |
| `pages/WorkspaceDetailPage.tsx` | Terminal + diff + preview (3-panel) |
| `pages/PullRequestListPage.tsx` | PR list |
| `pages/PullRequestDetailPage.tsx` | PR detail + diff |
| `components/workspace/TerminalPanel.tsx` | xterm.js terminal with tabs |
| `components/workspace/DiffViewer.tsx` | Monaco diff viewer |
| `components/workspace/FileTree.tsx` | Changed files tree |
| `components/workspace/ServicePanel.tsx` | Service status + preview iframe |
| `components/workspace/PreviewPanel.tsx` | iframe + service switcher |
| `components/workspace/CreateWorkspaceDialog.tsx` | Create form |
| `components/workspace/WorkspaceConfigPanel.tsx` | Lifecycle config editor |
| `services/workspaceService.ts` | API client |
| `services/pullRequestService.ts` | API client |
| `hooks/useWorkspace.ts` | React hooks |
| `hooks/usePullRequests.ts` | React hooks |

### Modified
| File | Change |
|------|--------|
| `server/src/app.ts` | Register routes, WebSocket upgrade, proxy middleware |
| `ui/src/App.tsx` | Add DEVELOP section to sidebar |
| `ui/src/main.tsx` | Add workspace + PR routes |
| `server/src/services/chat.service.ts` | Resolve workspace path for linked sessions |
| `server/src/services/chat-tools.ts` | Use workspace path in spawn_agent/delegate_to_agent |
