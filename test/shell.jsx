// App shell — sidebar, topbar, route switching, theme + sidebar mode

const { useState, useEffect, useRef, useMemo, useCallback, createContext, useContext } = React;

const NAV = [
  { group: 'Inbox', items: [
    { id: 'home',     label: 'home',           icon: 'sparkle',  badge: '' },
    { id: 'chat',     label: 'chat',           icon: 'chat',     badge: '3' },
    { id: 'interventions', label: 'interventions', icon: 'intervene', badge: '8' },
  ]},
  { group: 'Work', items: [
    { id: 'executions', label: 'live runs',     icon: 'exec',     badge: '14' },
    { id: 'workspaces', label: 'workspaces',    icon: 'workspace',badge: '10' },
    { id: 'pulls',      label: 'pull requests', icon: 'pr',       badge: '21' },
  ]},
  { group: 'Build', items: [
    { id: 'workflows', label: 'workflows',     icon: 'flow',     badge: '12' },
    { id: 'agents',    label: 'agents & teams',icon: 'agents',   badge: '149' },
  ]},
  { group: 'Sources', items: [
    { id: 'repos',     label: 'repos',         icon: 'repo',     badge: '5' },
    { id: 'linear',    label: 'linear',        icon: 'linear',   badge: '200' },
  ]},
  { group: 'Insight', items: [
    { id: 'analytics', label: 'analytics',     icon: 'analytics', badge: '' },
  ]},
];

const ROUTE_TITLES = {
  home: 'Home',
  chat: 'Chat',
  interventions: 'Interventions',
  executions: 'Live runs',
  workspaces: 'Workspaces',
  pulls: 'Pull requests',
  workflows: 'Workflows',
  agents: 'Agents & teams',
  repos: 'Repositories',
  linear: 'Linear',
  analytics: 'Analytics',
};

// ===== Sidebar =====
function Sidebar({ route, setRoute, sidebarMode }) {
  return (
    <aside className="sidebar" data-screen-label="sidebar">
      <div className="sidebar-inner scroll-hide" style={{overflowY:'auto'}}>
        <div className="brand">
          <div className="brand-mark">[a]</div>
          <div className="brand-name">allen</div>
          <div className="brand-sub">v0.2</div>
        </div>

        {NAV.map(group => (
          <div key={group.group} className="nav-group">
            <div className="nav-group-title">{sidebarMode === 'icon' ? '·' : group.group}</div>
            {group.items.map(it => {
              const I = Icons[it.icon];
              return (
                <div
                  key={it.id}
                  className={`nav-item ${route === it.id ? 'active' : ''}`}
                  onClick={() => setRoute(it.id)}
                  title={it.label}
                >
                  <I className="ico" />
                  <span className="lbl">{it.label}</span>
                  {it.badge && <span className="badge">{it.badge}</span>}
                </div>
              );
            })}
          </div>
        ))}

        <div className="sidebar-foot">
          <div className="avatar">M</div>
          <div className="user-meta">
            <div className="nm">Manish</div>
            <div className="em">manish@inomy.shop</div>
          </div>
          <button className="foot-btn" title="Sign out">
            <Icons.ext size={14}/>
          </button>
        </div>
      </div>
    </aside>
  );
}

// ===== Topbar =====
function Topbar({ route, theme, setTheme, sidebarMode, setSidebarMode, openCmdK, liveCount }) {
  return (
    <header className="topbar">
      <button className="btn ghost sm" title="Toggle sidebar" onClick={() => {
        const next = sidebarMode === 'full' ? 'icon' : sidebarMode === 'icon' ? 'collapsed' : 'full';
        setSidebarMode(next);
      }}>
        <Icons.panel size={16}/>
      </button>
      <div className="crumb">
        <span>allen</span>
        <span className="sep">/</span>
        <span className="now">{ROUTE_TITLES[route]}</span>
      </div>

      <div className="spacer" />

      <div className="row" style={{gap: 6}}>
        <span className="chip" title="Active runs across all workspaces">
          <span className="dot accent pulse" /> {liveCount} live
        </span>
        <span className="chip ok" title="Cluster healthy">
          <span className="dot ok" /> healthy
        </span>
      </div>

      <div className="topbar-search" onClick={openCmdK}>
        <Icons.search size={14} />
        <span>Search or run command</span>
        <kbd>⌘K</kbd>
      </div>

      <button className="btn ghost sm" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} title="Toggle theme">
        {theme === 'light' ? <Icons.moon size={16}/> : <Icons.sun size={16}/>}
      </button>
      <button className="btn ghost sm" title="Notifications" style={{position:'relative'}}>
        <Icons.bell size={16} />
        <span style={{position:'absolute',top:2,right:2,width:6,height:6,borderRadius:'50%',background:'var(--err)'}}/>
      </button>
    </header>
  );
}

// ===== Command Palette =====
function CommandPalette({ open, onClose, setRoute }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const items = useMemo(() => {
    const all = [
      ...Object.entries(ROUTE_TITLES).map(([id, title]) => ({ id, label: `Go to ${title}`, group: 'Navigate', action: () => setRoute(id) })),
      { id: 'new-run', label: 'New run — feature-plan-and-implement', group: 'Action', action: () => setRoute('executions') },
      { id: 'new-ws', label: 'New workspace', group: 'Action', action: () => setRoute('workspaces') },
      { id: 'new-flow', label: 'New workflow', group: 'Action', action: () => setRoute('workflows') },
      { id: 'sync-linear', label: 'Sync from Linear', group: 'Action', action: () => setRoute('linear') },
      { id: 'sync-gh', label: 'Sync from GitHub', group: 'Action', action: () => setRoute('pulls') },
    ];
    if (!q) return all;
    return all.filter(i => i.label.toLowerCase().includes(q.toLowerCase()));
  }, [q]);

  useEffect(() => { setSel(0); }, [q, open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s+1, items.length-1)); }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setSel(s => Math.max(s-1, 0)); }
      if (e.key === 'Enter')     { e.preventDefault(); items[sel]?.action(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, items, sel]);

  if (!open) return null;
  return (
    <div className="cmdk-bg" onClick={onClose}>
      <div className="cmdk" onClick={e => e.stopPropagation()}>
        <div className="cmdk-input">
          <Icons.search size={16}/>
          <input autoFocus placeholder="Search or run command…" value={q} onChange={e => setQ(e.target.value)} />
          <kbd className="mono" style={{fontSize:10, color:'var(--ink-4)'}}>esc</kbd>
        </div>
        <div className="cmdk-list">
          {items.length === 0 && <div className="empty" style={{padding:20}}>No matches</div>}
          {items.map((it, i) => (
            <div key={it.id} className={`cmdk-item ${sel===i ? 'sel' : ''}`}
                 onMouseEnter={() => setSel(i)}
                 onClick={() => { it.action(); onClose(); }}>
              <Icons.chevR size={12}/>
              <span>{it.label}</span>
              <span className="group">{it.group}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

window.Sidebar = Sidebar;
window.Topbar = Topbar;
window.CommandPalette = CommandPalette;
window.NAV = NAV;
window.ROUTE_TITLES = ROUTE_TITLES;
