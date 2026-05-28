// Allen · empty-states demo
// Self-contained — has its own router, theme toggle, DEMO toggle.
// Reuses the dropdown popovers from dropdowns.jsx via window.*

// ── Local icon set ───────────────────────────────────────
const __I = ({ children, size = 16 }) =>
<svg viewBox="0 0 24 24" width={size} height={size} fill="none"
stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>;

const Icons = {
  Sparkles: (p) => <__I {...p}><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z" /></__I>,
  Play: (p) => <__I {...p}><polygon points="6 3 20 12 6 21 6 3" /></__I>,
  Msg: (p) => <__I {...p}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></__I>,
  Ticket: (p) => <__I {...p}><path d="M3 7v2a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2" /><path d="M13 5v14" /></__I>,
  PR: (p) => <__I {...p}><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M13 6h3a2 2 0 0 1 2 2v7" /><line x1="6" y1="9" x2="6" y2="21" /></__I>,
  Folder: (p) => <__I {...p}><path d="M22 12V8a2 2 0 0 0-2-2h-7l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7" /><circle cx="17" cy="17" r="3" /><path d="M21 21v-3.3" /></__I>,
  Users: (p) => <__I {...p}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></__I>,
  GitBranch: (p) => <__I {...p}><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></__I>,
  Settings: (p) => <__I {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></__I>,
  Search: (p) => <__I {...p}><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></__I>,
  Sun: (p) => <__I {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></__I>,
  Moon: (p) => <__I {...p}><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></__I>,
  Logout: (p) => <__I {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></__I>,
  ChevRight: (p) => <__I {...p}><polyline points="9 18 15 12 9 6" /></__I>,
  ArrowRight: (p) => <__I {...p}><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></__I>,
  Plus: (p) => <__I {...p}><path d="M12 5v14M5 12h14" /></__I>,
  Send: (p) => <__I {...p}><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></__I>,
  Check: (p) => <__I {...p}><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></__I>,
  XCircle: (p) => <__I {...p}><circle cx="12" cy="12" r="10" /><path d="m15 9-6 6M9 9l6 6" /></__I>,
  Clock: (p) => <__I {...p}><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></__I>,
  Pause: (p) => <__I {...p}><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></__I>,
  Loader: (p) => <__I {...p}><path d="M21 12a9 9 0 1 1-6.219-8.56" /></__I>,
  Terminal: (p) => <__I {...p}><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></__I>,
  Panel: (p) => <__I {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" /></__I>
};
// Expose for closures (Babel-standalone block-scopes const, so child funcs
// in the same file may not see it without an explicit window assignment).
if (typeof window !== 'undefined') window.NavIcons = Icons;

// ── Data ──────────────────────────────────────────────────────
const NAV_GROUPS = [
{ label: '', items: [
  { id: 'home', icon: 'Sparkles', label: 'new chat', count: '4' },
  { id: 'executions', icon: 'Play', label: 'executions', count: '12' },
  { id: 'chats', icon: 'Msg', label: 'chats', count: '27' }]
},
{ label: 'Sources', items: [
  { id: 'tickets', icon: 'Ticket', label: 'tickets', count: '99+' },
  { id: 'prs', icon: 'PR', label: 'pull requests', count: '99+' },
  { id: 'workspaces', icon: 'Folder', label: 'workspaces', count: '85' }]
},
{ label: 'Org', items: [
  { id: 'library', icon: 'Users', label: 'library', children: [
    { id: 'library/teams', label: 'teams & agents' },
    { id: 'library/skills', label: 'skills' },
    { id: 'library/repos', label: 'repos' },
    { id: 'library/integrations', label: 'integrations' }]
  },
  { id: 'workflows', icon: 'GitBranch', label: 'workflows', count: '9' }]
},
{ label: 'Personal', items: [
  { id: 'settings', icon: 'Settings', label: 'settings' }]
}];


const ROUTE_TITLE = {
  'home': 'New Chat',
  'executions': 'Executions',
  'chats': 'Chats',
  'tickets': 'Tickets',
  'prs': 'Pull requests',
  'workspaces': 'Workspaces',
  'library': 'Library',
  'library/teams': 'Library',
  'library/skills': 'Library',
  'library/repos': 'Library',
  'library/integrations': 'Library',
  'workflows': 'Workflows',
  'settings': 'Settings'
};

// ── Sidebar ───────────────────────────────────────────────────
function Sidebar({ route, setRoute, collapsed }) {
  if (collapsed) return <SidebarCollapsed route={route} setRoute={setRoute} />;
  const Icons = window.Icon || {};
  return (
    <nav className="sidebar">
      <div className="brand">
        <div className="brand-mark" style={{ width: "29px" }}>[a]</div>
        <span className="brand-name">allen</span>
        <span className="brand-sub">v0.2</span>
      </div>
      <div className="sidebar-inner">
        {NAV_GROUPS.map((g, gi) =>
        <div className="nav-group" key={gi}>
            {g.label && <div className="nav-group-title">{g.label}</div>}
            {g.items.map((item) => {
            const IconCmp = (window.NavIcons || Icons)[item.icon];
            const active = route === item.id || item.children && route.startsWith(item.id + '/');
            const childActive = item.children && route.startsWith(item.id);
            return (
              <React.Fragment key={item.id}>
                  <button className={`nav-item ${active ? 'active' : ''}`} onClick={() => setRoute(item.children ? item.children[0].id : item.id)} style={{ opacity: "1", backgroundColor: "rgba(223, 226, 247, 0)" }}>
                    <span className="ico">{IconCmp ? <IconCmp /> : null}</span>
                    <span className="lbl">{item.label}</span>
                    {item.count ? <span className="b-count">{item.count}</span> : null}
                    {item.children ?
                  <span className={`nav-caret ${childActive ? 'is-open' : ''}`} aria-hidden="true">
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="9 6 15 12 9 18" />
                        </svg>
                      </span> :
                  null}
                  </button>
                  {item.children && childActive ?
                <div className="es-subnav">
                      {item.children.map((c) =>
                  <button key={c.id}
                  className={route === c.id ? 'active' : ''}
                  onClick={() => setRoute(c.id)}>
                          {c.label}
                        </button>
                  )}
                    </div> :
                null}
                </React.Fragment>);

          })}
          </div>
        )}
      </div>
      <div className="sidebar-foot">
        <div className="avatar">V</div>
        <div className="user-meta">
          <div className="nm">Vallabh</div>
          <div className="em">vallabh@inomy.shop</div>
        </div>
        <button className="foot-btn" title="Sign out">{Icons.Logout ? <Icons.Logout size={14} /> : null}</button>
      </div>
    </nav>);

}

function SidebarCollapsed({ route, setRoute }) {
  const Icons = window.Icon || {};
  // { id, top, left, label } — null when nothing hovered
  const [tip, setTip] = React.useState(null);

  const showTip = (e, item) => {
    const r = e.currentTarget.getBoundingClientRect();
    setTip({
      id: item.id,
      label: item.label,
      // anchor tip to the button's right edge, vertically centered
      top: r.top + r.height / 2,
      left: r.right + 10
    });
  };
  const hideTip = () => setTip(null);
  return (
    <nav className="sidebar" style={{ width: 64, minWidth: 64 }}>
      <div className="brand" style={{ padding: 0, justifyContent: 'center' }}>
        <div className="brand-mark" style={{ width: "29px" }}>[a]</div>
      </div>
      <div className="sidebar-inner" style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', padding: '8px 0' }}>
        {NAV_GROUPS.map((g, gi) =>
        <React.Fragment key={gi}>
            {gi > 0 && <div className="es-rail-sep" />}
            <div className="es-rail-group">
              {g.items.map((item) => {
              const IconCmp = (window.NavIcons || Icons)[item.icon];
              const active = route === item.id || item.children && route.startsWith(item.id);
              return (
                <div key={item.id}
                style={{ position: 'relative' }}
                onMouseEnter={(e) => showTip(e, item)}
                onMouseLeave={hideTip}>
                    <button
                    className={`nav-item ${active ? 'active' : ''}`}
                    style={{ width: 36, height: 36, padding: 0, justifyContent: 'center', flexShrink: 0, borderWidth: "1px", backgroundColor: "rgba(250, 251, 255, 0)" }}
                    onClick={() => setRoute(item.children ? item.children[0].id : item.id)}>
                      <span className="ico">{IconCmp ? <IconCmp /> : null}</span>
                    </button>
                  </div>);

            })}
            </div>
          </React.Fragment>
        )}
      </div>
      <div style={{ padding: 10, display: 'flex', justifyContent: 'center', borderTop: '1px solid rgb(var(--color-border-strong))' }}>
        <div className="avatar">V</div>
      </div>
      {tip && ReactDOM.createPortal(
        <span className="es-rail-tip" style={{ top: tip.top, left: tip.left }}>
          <span className="es-rail-tip-arrow" />
          {tip.label}
        </span>,
        document.body
      )}
    </nav>);

}

// ── Topbar ────────────────────────────────────────────────────
function Topbar({ route, dark, setDark, onOpenCmd }) {
  return (
    <header className="topbar">
      <div className="crumb">
        <span>allen</span>
        <span className="sep">/</span>
        <span className="now">{ROUTE_TITLE[route] || route}</span>
        {route.includes('/') ?
        <>
            <span className="sep">/</span>
            <span className="now" style={{ textTransform: 'capitalize' }}>
              {route.split('/')[1].replace(/-/g, ' ')}
            </span>
          </> :
        null}
      </div>
      <div className="spacer" />

      <span className="chip"><span className="dot dot-run" /> 317 live</span>
      <span className="chip" style={{
        background: 'rgb(var(--color-accent-green) / 0.12)',
        color: 'rgb(var(--color-accent-green))',
        borderColor: 'rgb(var(--color-accent-green) / 0.25)'
      }}>
        <span className="dot dot-ok" />
        healthy
      </span>

      <button className="topbar-search" onClick={onOpenCmd}>
        <Icons.Search size={14} />
        <span className="spacer">Search or run command</span>
        <span className="kbd">⌘K</span>
      </button>

      <button className="foot-btn" title={dark ? 'Switch to light mode' : 'Switch to dark mode'} onClick={() => setDark((d) => !d)}>
        {dark ? <Icons.Sun /> : <Icons.Moon />}
      </button>
      <button className="foot-btn" title="Notifications">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      </button>
    </header>);

}

// ── Empty-state primitive ─────────────────────────────────────
function EmptyState({ icon: IconCmp, title, desc, primary, secondary, footnote }) {
  return (
    <div className="es-empty">
      {IconCmp ? <div className="es-empty-icon"><IconCmp /></div> : null}
      <h2 className="es-empty-title">{title}</h2>
      <p className="es-empty-desc">{desc}</p>
      {(primary || secondary) &&
      <div className="es-empty-actions">
          {primary &&
        <button className="es-btn es-btn-primary">
              {primary.icon ? <primary.icon size={14} /> : null}
              {primary.label}
            </button>
        }
          {secondary &&
        <button className="es-btn es-btn-secondary">
              {secondary.icon ? <secondary.icon size={14} /> : null}
              {secondary.label}
            </button>
        }
        </div>
      }
      {footnote && <div className="es-empty-footnote">{footnote}</div>}
    </div>);

}

// ── Per-route empty + filled content ──────────────────────────
// ── Quick Start, Human Approval, Recent Chats, System ────────
// Three sections that make up the /home filled bottom block.

function QuickStart() {
  const PROMPTS = [
  {
    label: 'Triage backlog tickets',
    // Linear-like ticket
    icon:
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="6" width="18" height="12" rx="2" />
          <path d="M9 6v12" />
          <circle cx="14.5" cy="12" r="1" />
        </svg>

  },
  {
    label: 'Resolve CodeRabbit on open PRs',
    icon:
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="6" cy="6" r="2" />
          <circle cx="6" cy="18" r="2" />
          <circle cx="18" cy="18" r="2" />
          <path d="M6 8v8" />
          <path d="M18 16V9a3 3 0 0 0-3-3H9" />
          <path d="M11 4 9 6l2 2" />
        </svg>

  },
  {
    label: 'Run bug-investigate-and-fix',
    icon:
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="7" y="3" width="10" height="6" rx="1.5" />
          <path d="M9 9v10" />
          <path d="M15 9v10" />
          <path d="M5 13h2M5 17h2M17 13h2M17 17h2" />
        </svg>

  },
  {
    label: 'Generate failing test repro',
    icon:
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m14.7 6.3 3 3-9.4 9.4-3.6.6.6-3.6z" />
          <path d="m13 8 3 3" />
        </svg>

  }];

  return (
    <div style={{ marginTop: 48 }}>
      <div style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10.5,
        fontWeight: 500,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: 'rgb(var(--color-text-subtle))',
        marginBottom: 14
      }}>Quick start</div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 12
      }}>
        {PROMPTS.map((p, i) =>
        <button key={i} className="nc-quick-card" type="button">
            <span className="nc-quick-icon">{p.icon}</span>
            <span className="nc-quick-label">{p.label}</span>
          </button>
        )}
      </div>
    </div>);

}

function RecentChats() {
  const CHATS = [
  { title: 'Improve deal boosting with price history metrics', meta: 'Codex (CLI) / gpt-5.5', age: '22h ago' },
  { title: 'Design response strategy agent templates', meta: 'Claude / opus', age: '1d ago' },
  { title: 'Debug missing iPad Pro in Allen chat', meta: 'Claude / opus', age: '3d ago' }];

  return (
    <div>
      <div className="nc-section-head">
        <span className="nc-section-title">Recent Chats</span>
        <span style={{ flex: 1 }} />
        <a className="nc-section-link" href="#">View all <Icons.ArrowRight size={11} /></a>
      </div>
      <div className="nc-chat-list">
        {CHATS.map((c, i) =>
        <div className="nc-chat-row" key={i}>
            <span className="nc-chat-icon">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="nc-chat-title">{c.title}</div>
              <div className="nc-chat-meta">{c.meta}</div>
            </div>
            <span className="nc-chat-age">{c.age}</span>
          </div>
        )}
      </div>
    </div>);

}

function SystemStats() {
  const STATS = [
  { label: 'Live agents', value: '317', foot: '+12 vs yesterday', footTone: 'ok' },
  { label: 'Runs · 24h', value: '1,248', foot: '+8.4%', footTone: 'ok' },
  { label: 'Avg latency', value: '2.4s', foot: '\u2212180ms', footTone: 'ok' },
  { label: 'Spend today', value: '$84.20', foot: 'of $200 cap', footTone: 'muted' }];

  const toneColor = (t) =>
  t === 'ok' ? 'rgb(var(--color-accent-green))' :
  t === 'err' ? 'rgb(var(--color-accent-red))' :
  'rgb(var(--color-text-subtle))';
  return (
    <div style={{ marginTop: 48 }}>
      <div style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10.5,
        fontWeight: 500,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: 'rgb(var(--color-text-subtle))',
        marginBottom: 14
      }}>System</div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 12
      }}>
        {STATS.map((s, i) =>
        <div key={i} style={{
          background: 'rgb(var(--color-surface-100))',
          border: '1px solid rgb(var(--color-border))',
          borderRadius: 12,
          padding: '18px 20px',
          display: 'flex', flexDirection: 'column', gap: 10,
          minWidth: 0
        }}>
            <div style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10.5,
            fontWeight: 500,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'rgb(var(--color-text-subtle))',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}>{s.label}</div>
            <div style={{
            fontFamily: 'var(--font-heading)',
            fontSize: 32,
            fontWeight: 600,
            letterSpacing: '-0.022em',
            lineHeight: 1.05,
            color: 'rgb(var(--color-text-primary))',
            fontVariantNumeric: 'tabular-nums'
          }}>{s.value}</div>
            <div style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11.5,
            color: toneColor(s.footTone)
          }}>{s.foot}</div>
          </div>
        )}
      </div>
    </div>);

}

function HomeEmpty({ filled = false }) {
  const APPROVALS = [
  { type: 'approval', title: 'Implementation Approval Human', sub: 'bug-investigate-and-fix', age: '6d ago' },
  { type: 'question', title: 'Review Repo Plan', sub: 'multi-repo-change-orchestration', age: '9d ago' },
  { type: 'question', title: 'Clarify Human', sub: 'feature-plan-and-implement', age: '20d ago' },
  { type: 'approval', title: 'Pre-merge sanity check', sub: 'schema-designer', age: '1d ago' }];

  const approvals = filled ? APPROVALS : [];
  const counts = {
    approvals: filled ? approvals.length : 0,
    running: filled ? 1 : 0,
    recent: filled ? 3 : 0
  };

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', padding: '56px 32px 64px' }}>
      {/* Hero */}
      <div>
        <div className="nc-overline-row" style={{ marginBottom: 14, whiteSpace: 'nowrap' }}>
          <span className="nc-overline-dot" />
          <span className="nc-overline">New Chat</span>
        </div>
        <h1 style={{
          margin: 0, fontSize: 32, fontWeight: 600, letterSpacing: '-0.018em',
          color: 'rgb(var(--color-text-primary))', lineHeight: 1.1, whiteSpace: 'nowrap'
        }}>Good afternoon, Vallabh</h1>
        <div style={{
          marginTop: 10, display: 'flex', alignItems: 'center', gap: 10,
          fontFamily: 'var(--font-mono)', fontSize: 12.5,
          color: 'rgb(var(--color-text-muted))', whiteSpace: 'nowrap'
        }}>
          <span><span style={{ color: counts.approvals > 0 ? 'rgb(var(--color-accent-yellow))' : 'rgb(var(--color-text-primary))', fontWeight: 600 }}>{counts.approvals}</span>&nbsp;approvals</span>
          <span style={{ color: 'rgb(var(--color-text-subtle))' }}>·</span>
          <span><span style={{ color: 'rgb(var(--color-text-primary))', fontWeight: 600 }}>{counts.running}</span>&nbsp;running</span>
          <span style={{ color: 'rgb(var(--color-text-subtle))' }}>·</span>
          <span><span style={{ color: 'rgb(var(--color-text-primary))', fontWeight: 600 }}>{counts.recent}</span>&nbsp;recent</span>
        </div>
      </div>

      {/* Composer */}
      <div className="nc-composer-A" style={{ marginTop: 28 }}>
        <div className="nc-caret-wrap">
          <textarea className="nc-composer-textarea" placeholder="Describe a task, paste a Linear ticket, or @mention an agent. Allen routes the work and runs it in an isolated workspace." />
          <span className="nc-caret" aria-hidden="true"></span>
        </div>
        <div className="nc-composer-A-foot">
          <window.ComposerChips />
          <span style={{ flex: 1 }} />
          <button className="nc-attach" title="Attach">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66L9.41 17.41a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <button className="nc-send" title="Send"><Icons.ArrowRight size={15} /></button>
        </div>
      </div>

      {/* Bottom block: setup checklist when empty, data sections when filled */}
      {filled ?
      <React.Fragment>
      <QuickStart />
      <div style={{
          marginTop: 48, display: 'grid',
          gridTemplateColumns: '1.4fr 1fr', gap: 28,
          alignItems: 'flex-start'
        }}>
        {/* Left: Human Approval */}
        <div>
          <div className="nc-section-head">
            <span className="nc-section-title">Human Approval</span>
            <span className="nc-section-meta">· {approvals.length} waiting</span>
            <span style={{ flex: 1 }} />
            {approvals.length ? <a className="nc-section-link" href="#">View all <Icons.ArrowRight size={11} /></a> : null}
          </div>
          {approvals.length ?
            <div className="nc-flat-list">
              {approvals.map((a, i) =>
              <div className="nc-flat-row" key={i}>
                  <span className={`nc-row-tag ${a.type === 'approval' ? 'approval' : 'question'}`}>
                    {a.type === 'approval' ? 'Approval' : 'Question'}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="nc-row-title">{a.title}</div>
                    <div className="nc-row-sub">{a.sub}</div>
                  </div>
                  <span className="nc-row-meta">{a.age}</span>
                  <Icons.ChevRight size={14} />
                </div>
              )}
            </div> :

            <div className="nc-empty" style={{ justifyContent: 'center', padding: '32px 16px' }}>
              <span style={{ width: 6, height: 6, borderRadius: 999, background: 'rgb(var(--color-text-subtle))' }} />
              No approvals waiting
            </div>
            }
        </div>

        {/* Right: Recent Chats */}
        <RecentChats />
      </div>
      <SystemStats />
      </React.Fragment> :

      <SetupChecklist />
      }
    </div>);

}

// ── Setup checklist (shown on /home in EMPTY mode) ────────────
function SetupChecklist() {
  const GH_ICON = () =>
  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.92.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.34-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.04 0 0 .97-.31 3.18 1.18.92-.26 1.91-.39 2.9-.39.99 0 1.98.13 2.9.39 2.21-1.49 3.18-1.18 3.18-1.18.63 1.58.23 2.75.11 3.04.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.4-5.25 5.68.41.36.78 1.06.78 2.14v3.18c0 .31.21.67.8.56C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z" />
    </svg>;

  const LINEAR_ICON = () =>
  <svg viewBox="0 0 100 100" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 58 42 88M12 42 58 88M12 26 74 88M22 14 86 78M38 10 90 62M58 10 90 42M76 14 86 24" />
    </svg>;

  return (
    <div style={{ marginTop: 40 }}>
      <div className="es-setup-overline">
        <span style={{ color: 'rgb(var(--color-text-subtle))' }}>Set up</span>
        <span style={{ color: 'rgb(var(--color-text-subtle))' }}>·</span>
        <span style={{ color: 'rgb(var(--color-text-primary))', fontWeight: 600 }}>0 of 4</span>
        <span style={{ color: 'rgb(var(--color-text-subtle))' }}>complete</span>
      </div>
      <div className="es-setup">
        <div className="es-setup-item">
          <span className="es-setup-num">1</span>
          <div className="es-setup-body">
            <div className="es-setup-title">Connect GitHub</div>
            <div className="es-setup-desc">Allen needs read access to dispatch agents against your repos.</div>
          </div>
          <button className="es-setup-cta es-setup-cta-primary"><GH_ICON /> Connect</button>
        </div>
        <div className="es-setup-item">
          <span className="es-setup-num">2</span>
          <div className="es-setup-body">
            <div className="es-setup-title">Connect Linear <span className="es-setup-opt">(optional)</span></div>
            <div className="es-setup-desc">Two-way ticket sync so agents can resolve issues end-to-end.</div>
          </div>
          <button className="es-setup-cta"><LINEAR_ICON /> Connect</button>
        </div>
        <div className="es-setup-item">
          <span className="es-setup-num">3</span>
          <div className="es-setup-body">
            <div className="es-setup-title">Add your first agent</div>
            <div className="es-setup-desc">Start from a template or import an <code className="es-setup-code">agents/</code> folder from a repo.</div>
          </div>
          <button className="es-setup-cta"><Icons.Plus size={13} /> Add</button>
        </div>
        <div className="es-setup-item is-locked">
          <span className="es-setup-num">4</span>
          <div className="es-setup-body">
            <div className="es-setup-title">Dispatch a task</div>
            <div className="es-setup-desc">Send a ticket or paste a bug report into the composer.</div>
          </div>
          <span className="es-setup-locked">locked</span>
        </div>
      </div>
    </div>);

}

function PageHead({ title, sub, actions }) {
  return (
    <div className="es-page-head">
      <div>
        <h1 className="es-page-title">{title}</h1>
        {sub && <p className="es-page-sub">{sub}</p>}
      </div>
      {actions && <div className="es-page-actions">{actions}</div>}
    </div>);

}

// Each route exports an "empty" view + a tiny "filled" sample
// so the toggle has somewhere to land.
function ExecutionsEmpty() {
  return (
    <div className="es-page">
      <PageHead title="Executions" sub="Every workflow run, agent invocation, and node trace." />
      <EmptyState
        icon={() => <Icons.Play />}
        title="No executions yet"
        desc="Executions appear here as soon as you send a message or dispatch a workflow. Each run gets a timeline, per-node logs, tool calls with payloads, and a cost summary."
        primary={{ label: 'Start a new chat', icon: Icons.Sparkles }}
        secondary={{ label: 'Browse workflows', icon: Icons.GitBranch }}
        footnote={<>Tip: press <span className="es-empty-kbd">⌘K</span> to open the command palette</>} />
      
    </div>);

}

function ChatsEmpty() {
  return (
    <div className="es-page">
      <PageHead title="Chats" sub="Conversations with Allen and its agents." />
      <EmptyState
        icon={() => <Icons.Msg />}
        title="No conversations yet"
        desc="Every thread you start with Allen lives here — including delegations to specialist agents, attached Linear tickets, and the full agent reply history."
        primary={{ label: 'Start a new chat', icon: Icons.Sparkles }} />
      
    </div>);

}

function TicketsEmpty() {
  return (
    <div className="es-page">
      <PageHead title="Tickets" sub="Linear issues from your connected workspace." />
      <EmptyState
        icon={() => <Icons.Ticket />}
        title="No Linear workspace connected"
        desc="Connect Linear to browse and filter issues, mark a preferred agent, and dispatch a ticket to a workflow. Write-back uses the Linear MCP server."
        primary={{ label: 'Connect Linear', icon: Icons.Plus }}
        secondary={{ label: 'View setup guide' }} />
      
    </div>);

}

function PrsEmpty() {
  return (
    <div className="es-page">
      <PageHead title="Pull requests" sub="GitHub PRs mirrored here with CodeRabbit status." />
      <EmptyState
        icon={() => <Icons.PR />}
        title="No GitHub repos connected"
        desc="Once you connect a repo, Allen mirrors its PRs here. You can resolve CodeRabbit review comments, run tests, and push fixes — all in an isolated worktree."
        primary={{ label: 'Connect a repo', icon: Icons.Plus }}
        secondary={{ label: 'Open library' }} />
      
    </div>);

}

function WorkspacesEmpty() {
  return (
    <div className="es-page">
      <PageHead title="Workspaces" sub="Isolated git worktrees with a live terminal and preview proxy." />
      <EmptyState
        icon={() => <Icons.Folder />}
        title="No workspaces yet"
        desc="Every coding task gets a dedicated git worktree. You'll see a live terminal, file browser with diffs, and a reverse proxy to preview any dev server the agent starts."
        primary={{ label: 'New workspace', icon: Icons.Plus }}
        secondary={{ label: 'Connect a repo' }}
        footnote="Worktrees live under ~/.allen/repositories" />
      
    </div>);

}

function LibraryTeamsEmpty() {
  return (
    <div className="es-page">
      <PageHead title="Teams & agents"
      sub="Configure the multi-team agent org Allen runs against your code." />
      <EmptyState
        icon={() => <Icons.Users />}
        title="Seed the default org"
        desc="Allen ships with 6 teams (executive · product · engineering · quality · meta · unassigned) and 20+ specialist agents. Seed them with one click, then tune from there."
        primary={{ label: 'Seed default org', icon: Icons.Sparkles }}
        secondary={{ label: 'Import from YAML' }} />
      
    </div>);

}

function LibrarySkillsEmpty() {
  return (
    <div className="es-page">
      <PageHead title="Skills" sub="Reusable capability modules agents can invoke." />
      <EmptyState
        icon={() => <Icons.Sparkles />}
        title="No skills yet"
        desc="Skills are reusable units (a prompt, a sub-workflow, a code snippet) that agents can call by name. Create one or browse the built-in registry."
        primary={{ label: 'Create skill', icon: Icons.Plus }}
        secondary={{ label: 'Browse registry' }} />
      
    </div>);

}

function LibraryReposEmpty() {
  return (
    <div className="es-page">
      <PageHead title="Repos" sub="Connected repositories agents can clone, branch, and ship from." />
      <EmptyState
        icon={() => <Icons.Folder />}
        title="No repos connected"
        desc="Register a repository by local path or by cloning from a GitHub SSH URL. Agents work in isolated worktrees — your main branch is never touched."
        primary={{ label: 'Add repository', icon: Icons.Plus }}
        secondary={{ label: 'Connect via GitHub' }} />
      
    </div>);

}

function LibraryIntegrationsEmpty() {
  return (
    <div className="es-page">
      <PageHead title="Integrations" sub="Linear · Slack · GitHub · MCP servers." />
      <EmptyState
        icon={() => <Icons.Settings />}
        title="No integrations configured"
        desc="Wire up GitHub, Linear, Slack, and any MCP server you need. Credentials are forwarded to subprocesses with the ALLEN_ prefix stripped so they never leak."
        primary={{ label: 'Add integration', icon: Icons.Plus }}
        secondary={{ label: 'View .env.example' }} />
      
    </div>);

}

function WorkflowsEmpty() {
  return (
    <div className="es-page">
      <PageHead title="Workflows" sub="YAML pipelines with agent nodes, conditionals, parallel branches, and human checkpoints." />
      <EmptyState
        icon={() => <Icons.GitBranch />}
        title="Load the built-in workflows"
        desc="Allen ships with 9 production-ready workflows: feature planning, bug fix, PR review resolution, self-healing incident triage, and more. Load them or start one from scratch."
        primary={{ label: 'Load built-ins', icon: Icons.Sparkles }}
        secondary={{ label: 'New workflow', icon: Icons.Plus }} />
      
    </div>);

}

function SettingsEmpty() {
  return (
    <div className="es-page">
      <PageHead title="Settings" sub="Account · keys · schedules · learnings · health." />
      <EmptyState
        icon={() => <Icons.Settings />}
        title="Finish setting up Allen"
        desc="Configure API keys, schedule recurring agent runs, manage learnings (long-term agent memory), and re-run the runtime dependency checks."
        primary={{ label: 'Run health check' }}
        secondary={{ label: 'Open .env.example' }} />
      
    </div>);

}

// ── Tiny "filled" sample so the toggle has something to flip to ──
function FilledStub({ title, hint, rows }) {
  return (
    <div className="es-page">
      <PageHead title={title} sub={hint}
      actions={<><button className="es-btn es-btn-secondary"><Icons.Plus size={14} /> New</button></>} />
      <div style={{
        border: '1px solid rgb(var(--color-border))',
        borderRadius: 12,
        background: 'rgb(var(--color-surface-100))',
        overflow: 'hidden'
      }}>
        {rows.map((r, i) =>
        <div key={i} style={{
          display: 'flex', alignItems: 'center', gap: 14,
          padding: '14px 16px',
          borderBottom: i < rows.length - 1 ? '1px solid rgb(var(--color-border) / 0.7)' : 'none'
        }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ font: '500 13.5px var(--font-body)', color: 'rgb(var(--color-text-primary))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</div>
              <div style={{ font: '400 11.5px var(--font-mono)', color: 'rgb(var(--color-text-muted))', marginTop: 2 }}>{r.sub}</div>
            </div>
            {r.badge ? <span className={`badge ${r.badge.cls}`} style={{ flexShrink: 0 }}>{r.badge.label}</span> : null}
            <span style={{ font: '400 11px var(--font-mono)', color: 'rgb(var(--color-text-subtle))', minWidth: 50, textAlign: 'right' }}>{r.age}</span>
          </div>
        )}
      </div>
    </div>);

}

const FILLED_DATA = {
  executions: { title: 'Executions', hint: '3 active · 12 today', rows: [
    { title: 'Fix delete on empty workflow', sub: 'EXE_29sk2a · feature-plan-and-implement', badge: { label: 'running', cls: 'badge-info' }, age: '2m' },
    { title: 'Resolve CodeRabbit comments #142', sub: 'EXE_29sk2c · resolve-pr-reviews', badge: { label: 'waiting', cls: 'badge-human' }, age: '11m' },
    { title: 'Add OAuth login flow', sub: 'EXE_29sk1y · feature-plan-and-implement', badge: { label: 'completed', cls: 'badge-ok' }, age: '1h' },
    { title: 'Investigate stale cache', sub: 'EXE_29sk1x · bug-fix-by-severity', badge: { label: 'failed', cls: 'badge-err' }, age: '3h' }]
  },
  chats: { title: 'Chats', hint: '5 conversations', rows: [
    { title: 'Backend Developer onboarding', sub: 'with @assistant · last reply 2m ago', age: '2m' },
    { title: 'Spec rewrite for billing', sub: 'with @product-manager · 8 messages', age: '1h' },
    { title: 'Investigate stale cache', sub: 'with @engineering-bug-fix-l2', age: '3h' }]
  },
  tickets: { title: 'Tickets', hint: '99+ Linear issues', rows: [
    { title: 'API: tighten rate-limit per token', sub: 'ENG-142 · Eng / Platform · in progress', badge: { label: 'P1', cls: 'badge-err' }, age: '2d' },
    { title: 'UI: empty-state polish across tabs', sub: 'DSGN-58 · Design / Web · backlog', badge: { label: 'P2', cls: 'badge-warn' }, age: '4d' },
    { title: 'Onboarding: SSO bug on Edge', sub: 'ENG-129 · Eng / Auth · todo', badge: { label: 'P1', cls: 'badge-err' }, age: '6d' }]
  },
  prs: { title: 'Pull requests', hint: '99+ open PRs', rows: [
    { title: 'feat(api): add cursor pagination', sub: 'inomy-shop/api#412 · CodeRabbit · 4 unresolved', badge: { label: 'review', cls: 'badge-warn' }, age: '12m' },
    { title: 'fix(ui): caret blink on focus', sub: 'inomy-shop/web#218 · CI · passing', badge: { label: 'mergeable', cls: 'badge-ok' }, age: '1h' }]
  },
  workspaces: { title: 'Workspaces', hint: '85 worktrees · 3 running', rows: [
    { title: 'inomy-shop/allen', sub: 'WS_a7f31c · feature/fix-delete-crash', badge: { label: 'running', cls: 'badge-info' }, age: '2m' },
    { title: 'inomy-shop/api', sub: 'WS_a7f30b · feat/oauth-login', badge: { label: 'completed', cls: 'badge-ok' }, age: '1h' }]
  },
  workflows: { title: 'Workflows', hint: '9 built-in · 0 custom', rows: [
    { title: 'feature-plan-and-implement', sub: 'Clarify · PRD · HLD · TDD · implement · validate · open PR', age: '' },
    { title: 'bug-fix-by-severity', sub: 'Triage by severity, dispatch the right fix path', age: '' },
    { title: 'resolve-pr-reviews', sub: 'Resolve CodeRabbit comments, run tests, push fixes', age: '' }]
  },
  'library/teams': { title: 'Teams & agents', hint: '6 teams · 20+ agents', rows: [
    { title: 'Engineering', sub: '8 agents · bug-fix · impl · review · investigate', age: '' },
    { title: 'Product', sub: '5 agents · brainstorm · spec · prd · tdd', age: '' },
    { title: 'Quality', sub: '4 agents · acceptance · audit · test-generation', age: '' }]
  },
  'library/skills': { title: 'Skills', hint: '12 skills', rows: [
    { title: 'compile-prd', sub: 'product · template fill · 4 inputs', age: '' },
    { title: 'spawn-worktree', sub: 'engineering · git · 2 inputs', age: '' }]
  },
  'library/repos': { title: 'Repos', hint: '12 repositories', rows: [
    { title: 'inomy-mono', sub: '~/.allen/repositories/inomy-mono · ts', age: 'active' },
    { title: 'allen', sub: '~/.allen/repositories/allen · ts', age: 'active' }]
  },
  'library/integrations': { title: 'Integrations', hint: '3 connected', rows: [
    { title: 'GitHub', sub: 'allen-bot · 4 repos · ALLEN_GITHUB_PERSONAL_ACCESS_TOKEN', badge: { label: 'ok', cls: 'badge-ok' }, age: '' },
    { title: 'Linear', sub: 'INO team · 2 projects · ALLEN_LINEAR_ACCESS_TOKEN', badge: { label: 'ok', cls: 'badge-ok' }, age: '' },
    { title: 'Slack', sub: '#allen-runs · ALLEN_SLACK_BOT_TOKEN', badge: { label: 'ok', cls: 'badge-ok' }, age: '' }]
  },
  settings: { title: 'Settings', hint: 'Account · keys · schedules · learnings', rows: [
    { title: 'API keys', sub: '3 configured · Anthropic · OpenAI · GitHub', age: '' },
    { title: 'Scheduled jobs', sub: '6 active · 2 paused', age: '' },
    { title: 'Health checks', sub: 'last run 2 min ago · all passing', badge: { label: 'ok', cls: 'badge-ok' }, age: '' }]
  }
};

// ── App shell ─────────────────────────────────────────────────
function AllenEmptyStates() {
  const [route, setRoute] = React.useState('home');
  const [demo, setDemo] = React.useState('filled');
  const [dark, setDark] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(false);
  const [selectedExec, setSelectedExec] = React.useState('97fc5afd');
  const [selectedChat, setSelectedChat] = React.useState(null);
  const [selectedTicket, setSelectedTicket] = React.useState('ENG-1505');
  const [selectedPR, setSelectedPR] = React.useState('633');
  const [selectedIntegration, setSelectedIntegration] = React.useState('github');
  const [cmdOpen, setCmdOpen] = React.useState(false);
  const detailRoutes = ['chat-detail', 'execution-detail', 'ticket-detail', 'pr-detail', 'workspace-detail', 'agent-detail', 'skill-detail', 'repo-detail', 'integration-config', 'workflow-editor'];

  React.useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  // Global ⌘K shortcut.
  React.useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Pick the screen
  let screen;
  if (detailRoutes.includes(route)) {
    if (route === 'chat-detail') screen = <window.ChatDetail setRoute={setRoute} />;else
    if (route === 'execution-detail') screen = <window.ExecutionDetail execId={selectedExec} setRoute={setRoute} />;else
    if (route === 'ticket-detail') screen = <window.TicketDetail ticketId={selectedTicket} setRoute={setRoute} setSelectedExec={setSelectedExec} />;else
    if (route === 'pr-detail') screen = <window.PRDetail prNum={selectedPR} setRoute={setRoute} setSelectedExec={setSelectedExec} />;else
    if (route === 'workspace-detail') screen = <window.WorkspaceDetail setRoute={setRoute} />;else
    if (route === 'agent-detail') screen = <window.AgentDetail setRoute={setRoute} setSelectedExec={setSelectedExec} />;else
    if (route === 'skill-detail') screen = <window.SkillDetail setRoute={setRoute} />;else
    if (route === 'repo-detail') screen = <window.RepoDetail setRoute={setRoute} />;else
    if (route === 'integration-config') screen = <window.IntegrationConfig setRoute={setRoute} integrationId={selectedIntegration} />;else
    if (route === 'workflow-editor') screen = <window.WorkflowEditor setRoute={setRoute} />;
  } else if (demo === 'empty') {
    if (route === 'home') screen = <HomeEmpty filled={false} />;else
    if (route === 'executions') screen = <ExecutionsEmpty />;else
    if (route === 'chats') screen = <ChatsEmpty />;else
    if (route === 'tickets') screen = <TicketsEmpty />;else
    if (route === 'prs') screen = <PrsEmpty />;else
    if (route === 'workspaces') screen = <WorkspacesEmpty />;else
    if (route === 'library/teams') screen = <LibraryTeamsEmpty />;else
    if (route === 'library/skills') screen = <LibrarySkillsEmpty />;else
    if (route === 'library/repos') screen = <LibraryReposEmpty />;else
    if (route === 'library/integrations') screen = <LibraryIntegrationsEmpty />;else
    if (route === 'workflows') screen = <WorkflowsEmpty />;else
    if (route === 'settings') screen = <SettingsEmpty />;else
    screen = <ExecutionsEmpty />;
  } else {
    // FILLED state — rich reference screens
    if (route === 'home') screen = <HomeEmpty filled={true} />;else
    if (route === 'executions') screen = <window.ExecutionsScreen setRoute={setRoute} setSelectedExec={setSelectedExec} />;else
    if (route === 'chats') screen = <window.ChatsScreen setRoute={setRoute} setSelectedChat={setSelectedChat} />;else
    if (route === 'tickets') screen = <window.TicketsScreen setRoute={setRoute} setSelectedTicket={setSelectedTicket} />;else
    if (route === 'prs') screen = <window.PullRequestsScreen setRoute={setRoute} setSelectedExec={setSelectedExec} setSelectedPR={setSelectedPR} />;else
    if (route === 'workspaces') screen = <window.WorkspacesScreen setRoute={setRoute} />;else
    if (route === 'library/teams') screen = <window.LibraryTeams setRoute={setRoute} />;else
    if (route === 'library/skills') screen = <window.LibrarySkills setRoute={setRoute} />;else
    if (route === 'library/repos') screen = <window.LibraryRepos setRoute={setRoute} />;else
    if (route === 'library/integrations') screen = <window.LibraryIntegrations setRoute={setRoute} setSelectedIntegration={setSelectedIntegration} />;else
    if (route === 'workflows') screen = <window.WorkflowsScreen setRoute={setRoute} />;else
    if (route === 'settings') screen = <window.SettingsScreen />;else
    screen = <window.ExecutionsScreen setRoute={setRoute} setSelectedExec={setSelectedExec} />;
  }

  return (
    <div className={`es-shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <Sidebar route={route} setRoute={setRoute} collapsed={collapsed} />
      <button
        className="sidebar-handle"
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-label="Toggle sidebar"
        onClick={() => setCollapsed((v) => !v)}>
        
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
        strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>
      <div className="es-main-col">
        <Topbar route={route} dark={dark} setDark={setDark} onOpenCmd={() => setCmdOpen(true)} />
        <div className="es-main-body" style={route === 'chat-detail' || route === 'workspace-detail' || route === 'workflow-editor' ? { padding: 0, overflow: 'hidden' } : {}}>{screen}</div>
      </div>
      <DemoFab demo={demo} setDemo={setDemo} />
      {window.CmdKOverlay ? <window.CmdKOverlay open={cmdOpen} onClose={() => setCmdOpen(false)} setRoute={setRoute} /> : null}
    </div>);

}

// Draggable demo FAB — bottom-right by default, drag handle on the left.
function DemoFab({ demo, setDemo }) {
  const STORAGE_KEY = 'allen-empty-fab-pos';
  const [pos, setPos] = React.useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && Number.isFinite(saved.r) && Number.isFinite(saved.b)) return saved;
    } catch {}
    return { r: 24, b: 24 };
  });
  const dragRef = React.useRef(null);

  React.useEffect(() => {
    try {localStorage.setItem(STORAGE_KEY, JSON.stringify(pos));} catch {}
  }, [pos]);

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startR: pos.r,
      startB: pos.b
    };
    const onMove = (ev) => {
      const s = dragRef.current;
      if (!s) return;
      const dx = ev.clientX - s.startX;
      const dy = ev.clientY - s.startY;
      const nextR = Math.max(8, Math.min(window.innerWidth - 80, s.startR - dx));
      const nextB = Math.max(8, Math.min(window.innerHeight - 60, s.startB - dy));
      setPos({ r: nextR, b: nextB });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div className="es-fab" style={{ right: pos.r, bottom: pos.b }}>
      <button className="es-fab-drag" onPointerDown={onPointerDown}
      title="Drag to reposition" aria-label="Drag to reposition">
        <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="4" r="1.3" />
          <circle cx="5" cy="8" r="1.3" />
          <circle cx="5" cy="12" r="1.3" />
          <circle cx="11" cy="4" r="1.3" />
          <circle cx="11" cy="8" r="1.3" />
          <circle cx="11" cy="12" r="1.3" />
        </svg>
      </button>
      <span className="es-fab-label">Demo</span>
      <div className="es-fab-seg">
        <button className={`es-fab-btn ${demo === 'empty' ? 'is-active' : ''}`} onClick={() => setDemo('empty')}>
          <span className="dot" /> Empty
        </button>
        <button className={`es-fab-btn ${demo === 'filled' ? 'is-active' : ''}`} onClick={() => setDemo('filled')}>
          <span className="dot" /> Filled
        </button>
      </div>
    </div>);

}

// Composer chips → reused from dropdowns
function ComposerChips() {
  const PersonIcon = (p) =>
  <svg viewBox="0 0 24 24" width={p.size || 13} height={p.size || 13} fill="none"
  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: "rgb(169, 175, 192)" }}>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>;

  return (
    <>
      <ChipDD icon={PersonIcon} dropdownKey="AgentDropdown">Assistant</ChipDD>
      <ChipDD mono dropdownKey="ModelDropdown">Codex (CLI) / gpt-5.5</ChipDD>
      <ChipDD icon={Icons.Sparkles} dropdownKey="ReasoningDropdown">High (default)</ChipDD>
      <ChipDD icon={Icons.Folder} dropdownKey="RepoDropdown">Auto</ChipDD>
    </>);

}

function ChipDD({ children, icon: IconCmp, accent, mono, dropdownKey }) {
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef(null);
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e) => {if (!wrapRef.current?.contains(e.target)) setOpen(false);};
    const onKey = (e) => {if (e.key === 'Escape') setOpen(false);};
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
      <button type="button"
      className={`${baseCls} ${open ? 'is-active' : ''}`}
      onClick={() => setOpen((o) => !o)}>
        {IconCmp ? <IconCmp size={13} /> : null}
        {children}
        <span className="caret">{'\u25BE'}</span>
      </button>
      {open && Dropdown ?
      <div style={{ position: 'absolute', top: 'calc(100% + 10px)', left: 0, zIndex: 60 }}>
          <Dropdown />
        </div> :
      null}
    </div>);

}

window.ComposerChips = ComposerChips;
window.AllenEmptyStates = AllenEmptyStates;