// Workspaces — git worktree cards with terminal previews.

const WORKSPACES = [
  {
    id: 'WS_a7f31c',
    repo: 'inomy-shop/allen',
    branch: 'feature/fix-delete-crash',
    agent: 'engineering-bug-fix-l2',
    status: 'running',
    age: '2m',
    lines: [
      <><span className="dim">$</span> <span className="prompt">npm</span> test --workspace=ui</>,
      <><span className="dim">› ui:</span> running 132 tests</>,
      <><span className="ok">✓</span> WorkflowListPage › renders empty state</>,
      <><span className="ok">✓</span> WorkflowListPage › guards on optimistic delete</>,
    ],
  },
  {
    id: 'WS_a7f31a',
    repo: 'inomy-shop/web',
    branch: 'pr-142-rebase',
    agent: 'engineering-pr-resolver',
    status: 'idle',
    age: '11m',
    lines: [
      <><span className="dim">$</span> <span className="prompt">gh</span> pr view 142 --comments</>,
      <><span className="dim">›</span> 4 unresolved CodeRabbit comments</>,
      <><span className="dim">›</span> waiting for human approval</>,
    ],
  },
  {
    id: 'WS_a7f30b',
    repo: 'inomy-shop/api',
    branch: 'feat/oauth-login',
    agent: 'engineering-impl-l2',
    status: 'completed',
    age: '1h',
    lines: [
      <><span className="dim">$</span> <span className="prompt">gh</span> pr create --fill</>,
      <><span className="ok">✓</span> opened #156 · oauth-login</>,
      <><span className="dim">›</span> CI: passing · 18 checks</>,
    ],
  },
  {
    id: 'WS_a7f309',
    repo: 'inomy-shop/allen',
    branch: 'investigate/cache',
    agent: 'engineering-investigation',
    status: 'failed',
    age: '3h',
    lines: [
      <><span className="dim">$</span> <span className="prompt">node</span> dist/repro.js</>,
      <><span className="dim">›</span> Error: ECONNREFUSED 127.0.0.1:27017</>,
      <><span className="dim">›</span> mongo container not running</>,
    ],
  },
];

const STATUS_DOT = {
  running:   { dot: 'dot-run', label: 'running'   },
  idle:      { dot: 'dot-idle', label: 'idle'     },
  completed: { dot: 'dot-ok',  label: 'completed' },
  failed:    { dot: 'dot-err', label: 'failed'    },
};

function Workspaces() {
  return (
    <div className="page-shell">
      <div className="page-head">
        <div>
          <h1 className="page-title">Workspaces</h1>
          <p className="page-sub">Isolated git worktrees. One per task. Each has a live terminal and preview proxy.</p>
        </div>
        <button className="btn btn-secondary"><window.Icon.Plus size={14} /> New workspace</button>
      </div>

      <div className="ws-grid">
        {WORKSPACES.map(w => {
          const s = STATUS_DOT[w.status];
          return (
            <div className="ws-card" key={w.id}>
              <div className="ws-head">
                <window.Icon.Folder size={16} />
                <span className="ws-title">{w.repo}</span>
                <span className="chip"><span className={`dot ${s.dot}`} />{s.label}</span>
              </div>
              <div className="ws-meta">
                <span><window.Icon.GitBranch size={11} /> {w.branch}</span>
                <span>{w.id}</span>
                <span style={{ marginLeft: 'auto' }}>{w.age} ago</span>
              </div>
              <div className="ws-preview">
                {w.lines.map((line, i) => <div key={i}>{line}</div>)}
              </div>
              <div style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="chip">
                  <span className="dot" style={{ background: 'rgb(var(--color-accent-purple))' }} />
                  {w.agent}
                </span>
                <span style={{ flex: 1 }} />
                <button className="btn btn-ghost" style={{ height: 24, padding: '0 8px', fontSize: 12 }}>Open</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

window.Workspaces = Workspaces;
