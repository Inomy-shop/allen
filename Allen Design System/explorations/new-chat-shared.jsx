// Shared chrome + data for the New Chat variations.
// Dark-mode dashboard sidebar/topbar matching the user's screenshot.

const NAV_GROUPS = [
  { label: '', items: [
    { id: 'home',       icon: 'Sparkles', label: 'new chat', count: 4, active: true },
    { id: 'executions', icon: 'Play',     label: 'executions' },
    { id: 'chats',      icon: 'Msg',      label: 'chats',       count: 5 },
  ]},
  { label: 'Sources', items: [
    { id: 'tickets',    icon: 'Ticket',   label: 'tickets',    count: '99+' },
    { id: 'prs',        icon: 'PR',       label: 'pull requests', count: '99+' },
    { id: 'workspaces', icon: 'Folder',   label: 'workspaces',  count: 85 },
  ]},
  { label: 'Org', items: [
    { id: 'library',    icon: 'Users',    label: 'library', children: ['teams & agents', 'skills', 'repos', 'integrations'] },
    { id: 'workflows',  icon: 'GitBranch',label: 'workflows' },
  ]},
  { label: 'Personal', items: [
    { id: 'settings',   icon: 'Settings', label: 'settings' },
  ]},
];

function DashSidebarCollapsed() {
  return (
    <nav className="sidebar" style={{ width: 64, minWidth: 64 }}>
      <div className="brand" style={{ padding: 0, justifyContent: 'center' }}>
        <div className="brand-mark" title="allen · v0.2">[a]</div>
      </div>
      <div className="sidebar-inner" style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', padding: '8px 0' }}>
        {NAV_GROUPS.map((g, gi) => (
          <React.Fragment key={gi}>
            {gi > 0 && <div className="dash-rail-sep" />}
            <div className="dash-rail-group">
              {g.items.map(item => {
                const IconCmp = window.Icon[item.icon];
                return (
                  <button
                    key={item.id}
                    className={`nav-item ${item.active ? 'active' : ''}`}
                    style={{ width: 36, height: 36, padding: 0, justifyContent: 'center', position: 'relative', flexShrink: 0 }}
                    title={item.label}
                  >
                    <span className="ico"><IconCmp /></span>
                    {item.count ? <span style={{
                      position: 'absolute', top: 4, right: 4,
                      width: 6, height: 6, borderRadius: 999,
                      background: 'rgb(var(--color-accent))',
                    }} /> : null}
                  </button>
                );
              })}
            </div>
          </React.Fragment>
        ))}
      </div>
      <div style={{ padding: 10, display: 'flex', justifyContent: 'center', borderTop: '1px solid rgb(var(--color-border-strong))' }}>
        <div className="avatar" title="Vallabh">V</div>
      </div>
    </nav>
  );
}

function DashSidebar({ collapsed }) {
  if (collapsed) return <DashSidebarCollapsed />;
  return (
    <nav className="sidebar">
      <div className="brand">
        <div className="brand-mark">[a]</div>
        <span className="brand-name">allen</span>
        <span className="brand-sub">v0.2</span>
      </div>
      <div className="sidebar-inner">
        {NAV_GROUPS.map((g, i) => (
          <div className="nav-group" key={i}>
            {g.label && <div className="nav-group-title">{g.label}</div>}
            {g.items.map(item => {
              const IconCmp = window.Icon[item.icon];
              return (
                <React.Fragment key={item.id}>
                  <div className={`nav-item ${item.active ? 'active' : ''}`}>
                    <span className="ico"><IconCmp /></span>
                    <span className="lbl">{item.label}</span>
                    {item.count ? <span className="b-count">{item.count}</span> : null}
                  </div>
                  {item.children ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, margin: '4px 0 6px 35px' }}>
                      {item.children.map(c => (
                        <div key={c} style={{
                          padding: '5px 10px 5px 14px',
                          fontSize: 12.5,
                          color: 'rgb(var(--color-text-muted))',
                        }}>{c}</div>
                      ))}
                    </div>
                  ) : null}
                </React.Fragment>
              );
            })}
          </div>
        ))}
      </div>
      <div className="sidebar-foot">
        <div className="avatar">V</div>
        <div className="user-meta">
          <div className="nm">Vallabh</div>
          <div className="em">vallabh@inomy.shop</div>
        </div>
        <button className="foot-btn" title="Sign out"><window.Icon.Logout size={14} /></button>
      </div>
    </nav>
  );
}

function DashTopbar() {
  return (
    <header className="topbar">
      <div className="crumb">
        <span>allen</span>
        <span className="sep">/</span>
        <span className="now">New Chat</span>
      </div>
      <div className="spacer" />
      <span className="chip"><span className="dot dot-run" /> 317 live</span>
      <span className="chip" style={{
        background: 'rgb(var(--color-accent-green) / 0.12)',
        color: 'rgb(var(--color-accent-green))',
        borderColor: 'rgb(var(--color-accent-green) / 0.25)',
      }}>
        <span className="dot dot-ok" />
        healthy
      </span>
      <button className="topbar-search">
        <window.Icon.Search size={14} />
        <span className="spacer">Search or run command</span>
        <span className="kbd">⌘K</span>
      </button>
      <button className="foot-btn"><window.Icon.Sun /></button>
      <button className="foot-btn">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        </svg>
      </button>
    </header>
  );
}

// ── Data ──────────────────────────────────────────────────────
const APPROVALS = [
  { type: 'approval', title: 'Implementation Approval Human', sub: 'bug-investigate-and-fix',      age: '6d ago' },
  { type: 'question', title: 'Review Repo Plan',              sub: 'multi-repo-change-orchestration', age: '8d ago' },
  { type: 'question', title: 'Clarify Human',                 sub: 'feature-plan-and-implement',    age: '20d ago' },
];

const RECENT = [
  { title: 'Backend Developer',           wf: 'feature-plan-and-implement',     status: 'failed',    age: '2d' },
  { title: 'Spec rewrite',                wf: 'prd-tdd-design-by-severity',     status: 'completed', age: '3d' },
];

// ── Composer chips (shared across variants) ───────────────────
function ChipWithDropdown({ children, icon: IconCmp, accent, mono, dropdownKey }) {
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef(null);
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    const onKey  = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const baseCls = accent ? 'nc-chip nc-chip-accent' : mono ? 'nc-chip nc-chip-mono' : 'nc-chip';
  const Dropdown = window[dropdownKey];
  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className={`${baseCls} ${open ? 'is-active' : ''}`}
        onClick={() => setOpen(o => !o)}
      >
        {IconCmp ? <IconCmp size={13} /> : null}
        {children}
        <span className="caret">{'\u25BE'}</span>
      </button>
      {open && Dropdown ? (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 10px)',
          left: 0,
          zIndex: 60,
        }}>
          <Dropdown />
        </div>
      ) : null}
    </div>
  );
}

function ComposerChips({ size = 'md' }) {
  const PersonIcon = (p) => (
    <svg viewBox="0 0 24 24" width={p.size || 13} height={p.size || 13} fill="none"
         stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
      <circle cx="12" cy="7" r="4"/>
    </svg>
  );
  return (
    <>
      <ChipWithDropdown icon={PersonIcon} dropdownKey="AgentDropdown">Assistant</ChipWithDropdown>
      <ChipWithDropdown mono dropdownKey="ModelDropdown">Codex (CLI) / gpt-5.5</ChipWithDropdown>
      <ChipWithDropdown icon={window.Icon.Sparkles} dropdownKey="ReasoningDropdown">High (default)</ChipWithDropdown>
      <ChipWithDropdown icon={window.Icon.Folder} dropdownKey="RepoDropdown">Auto</ChipWithDropdown>
    </>
  );
}

// Expose
window.DashSidebar = DashSidebar;
window.DashTopbar = DashTopbar;
window.NewChatData = { APPROVALS, RECENT };
window.ComposerChips = ComposerChips;
