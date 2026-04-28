// chrome.jsx — shared layout chrome for all three Allen variations
// Exposes: AllenLogo, Icon, NAV, V1Frame, V2Frame, V3Frame, plus Topbar/Sidebar variants.

const NAV = [
  { group: null, items: [
    { id: 'chat', label: 'Chat', icon: 'chat' },
    { id: 'dashboard', label: 'Dashboard', icon: 'grid' },
  ]},
  { group: 'BUILD', items: [
    { id: 'workflows', label: 'Agent Workflows', icon: 'flow' },
    { id: 'agents', label: 'Agents & Teams', icon: 'people' },
    { id: 'repos', label: 'Repos', icon: 'repo' },
    { id: 'linear', label: 'Linear', icon: 'linear' },
  ]},
  { group: 'DEVELOP', items: [
    { id: 'workspaces', label: 'Workspaces', icon: 'box' },
    { id: 'prs', label: 'Pull Requests', icon: 'merge' },
  ]},
  { group: 'MONITOR', items: [
    { id: 'executions', label: 'Executions', icon: 'play' },
    { id: 'interventions', label: 'Interventions', icon: 'help' },
    { id: 'analytics', label: 'Analytics', icon: 'chart' },
    { id: 'learnings', label: 'Learnings', icon: 'sparkle' },
    { id: 'jobs', label: 'Scheduled Jobs', icon: 'clock' },
  ]},
];

// Linear-style grouping for v2: workspace-scoped + flatter
const NAV_V2 = [
  { group: 'WORKSPACE', items: [
    { id: 'chat', label: 'Inbox', icon: 'inbox', count: 3 },
    { id: 'dashboard', label: 'Overview', icon: 'grid' },
    { id: 'executions', label: 'Activity', icon: 'play', count: 12 },
    { id: 'interventions', label: 'Needs review', icon: 'help', count: 8 },
  ]},
  { group: 'BUILD', items: [
    { id: 'workflows', label: 'Workflows', icon: 'flow' },
    { id: 'agents', label: 'Agents', icon: 'people' },
    { id: 'jobs', label: 'Schedules', icon: 'clock' },
  ]},
  { group: 'CODE', items: [
    { id: 'repos', label: 'Repositories', icon: 'repo' },
    { id: 'workspaces', label: 'Sandboxes', icon: 'box' },
    { id: 'prs', label: 'Pull requests', icon: 'merge', count: 23 },
    { id: 'linear', label: 'Linear', icon: 'linear' },
  ]},
  { group: 'INSIGHT', items: [
    { id: 'analytics', label: 'Analytics', icon: 'chart' },
    { id: 'learnings', label: 'Learnings', icon: 'sparkle' },
  ]},
];

// Heartbeat-line logo
const AllenLogo = ({ size = 20, color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none">
    <path d="M2 10 L5 10 L7 5 L9 15 L11 7 L13 12 L15 10 L18 10"
      stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

// Tiny icon set — minimal stroke icons
const Icon = ({ name, size = 14, color = 'currentColor', strokeWidth = 1.5 }) => {
  const props = { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: color, strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round' };
  switch (name) {
    case 'chat': return <svg {...props}><path d="M3 3h10v8H6l-3 3z"/></svg>;
    case 'inbox': return <svg {...props}><path d="M2 8v5h12V8M2 8l1.5-5h9L14 8M2 8h4l1 2h2l1-2h4"/></svg>;
    case 'grid': return <svg {...props}><rect x="2" y="2" width="5" height="5"/><rect x="9" y="2" width="5" height="5"/><rect x="2" y="9" width="5" height="5"/><rect x="9" y="9" width="5" height="5"/></svg>;
    case 'flow': return <svg {...props}><circle cx="3" cy="4" r="1.5"/><circle cx="3" cy="12" r="1.5"/><circle cx="13" cy="8" r="1.5"/><path d="M4.5 4.5l7 3M4.5 11.5l7-3"/></svg>;
    case 'people': return <svg {...props}><circle cx="6" cy="6" r="2.5"/><path d="M2 14c0-2.5 2-4 4-4s4 1.5 4 4"/><circle cx="12" cy="5" r="1.8"/><path d="M10.5 14c0-1.5 1-2.5 1.5-3"/></svg>;
    case 'repo': return <svg {...props}><path d="M3 3v10a1 1 0 001 1h10V4a1 1 0 00-1-1H4a1 1 0 00-1 1z"/><path d="M3 11h10M6 3v8"/></svg>;
    case 'linear': return <svg {...props}><path d="M2 9l5 5M2 6l8 8M2 3l11 11M5 2l9 9M9 2l5 5"/></svg>;
    case 'box': return <svg {...props}><path d="M2 4l6-2 6 2v8l-6 2-6-2V4zM2 4l6 2 6-2M8 6v8"/></svg>;
    case 'merge': return <svg {...props}><circle cx="4" cy="3" r="1.5"/><circle cx="4" cy="13" r="1.5"/><circle cx="12" cy="11" r="1.5"/><path d="M4 4.5v7M4 6c0 3 3 4 6 4"/></svg>;
    case 'play': return <svg {...props}><polygon points="4,3 13,8 4,13" /></svg>;
    case 'help': return <svg {...props}><circle cx="8" cy="8" r="6"/><path d="M6.5 6.5c0-1 .8-1.8 1.8-1.8s1.8.8 1.8 1.8c0 1.5-1.8 1.2-1.8 2.5"/><circle cx="8" cy="11" r="0.4" fill={color} stroke="none"/></svg>;
    case 'chart': return <svg {...props}><path d="M2 13h12M4 11V7M7 11V4M10 11V8M13 11V6"/></svg>;
    case 'sparkle': return <svg {...props}><path d="M8 2l1.5 4.5L14 8l-4.5 1.5L8 14l-1.5-4.5L2 8l4.5-1.5z"/></svg>;
    case 'clock': return <svg {...props}><circle cx="8" cy="8" r="6"/><path d="M8 5v3l2 2"/></svg>;
    case 'search': return <svg {...props}><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>;
    case 'plus': return <svg {...props}><path d="M8 3v10M3 8h10"/></svg>;
    case 'cmd': return <svg {...props}><path d="M5 2a2 2 0 100 4h6a2 2 0 100-4M5 2v12M11 2v12M5 14a2 2 0 100-4h6a2 2 0 100 4"/></svg>;
    case 'bell': return <svg {...props}><path d="M4 11V7a4 4 0 018 0v4l1 2H3l1-2zM6.5 13.5a1.5 1.5 0 003 0"/></svg>;
    case 'settings': return <svg {...props}><circle cx="8" cy="8" r="2"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M3 13l1.5-1.5M11.5 4.5L13 3"/></svg>;
    case 'chevron': return <svg {...props}><path d="M6 4l4 4-4 4"/></svg>;
    case 'chevron-down': return <svg {...props}><path d="M4 6l4 4 4-4"/></svg>;
    case 'arrow-up': return <svg {...props}><path d="M8 13V3M4 7l4-4 4 4"/></svg>;
    case 'arrow-down': return <svg {...props}><path d="M8 3v10M4 9l4 4 4-4"/></svg>;
    case 'dot-menu': return <svg {...props}><circle cx="3" cy="8" r="0.8" fill={color}/><circle cx="8" cy="8" r="0.8" fill={color}/><circle cx="13" cy="8" r="0.8" fill={color}/></svg>;
    case 'check': return <svg {...props}><path d="M3 8l3 3 7-7"/></svg>;
    case 'x': return <svg {...props}><path d="M3 3l10 10M13 3L3 13"/></svg>;
    case 'filter': return <svg {...props}><path d="M2 3h12l-4.5 6V13l-3 1V9z"/></svg>;
    case 'refresh': return <svg {...props}><path d="M2 8a6 6 0 0110-4.5L13 5M14 8a6 6 0 01-10 4.5L3 11"/><path d="M13 2v3h-3M3 14v-3h3"/></svg>;
    case 'external': return <svg {...props}><path d="M9 3h4v4M13 3l-6 6M11 9v3a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1h3"/></svg>;
    case 'edit': return <svg {...props}><path d="M11 2l3 3-8 8-4 1 1-4z"/></svg>;
    case 'trash': return <svg {...props}><path d="M3 4h10M5 4V3a1 1 0 011-1h4a1 1 0 011 1v1M5 4v9a1 1 0 001 1h4a1 1 0 001-1V4M7 7v5M9 7v5"/></svg>;
    case 'download': return <svg {...props}><path d="M8 3v8M4 7l4 4 4-4M3 14h10"/></svg>;
    case 'github': return <svg {...props}><path d="M8 1.5C4.4 1.5 1.5 4.4 1.5 8c0 2.9 1.9 5.3 4.4 6.2.3.1.4-.1.4-.3v-1.1c-1.8.4-2.2-.9-2.2-.9-.3-.7-.7-.9-.7-.9-.6-.4 0-.4 0-.4.6 0 1 .6 1 .6.6 1 1.5.7 1.9.6.1-.4.2-.7.4-.9-1.4-.2-2.9-.7-2.9-3.2 0-.7.3-1.3.7-1.7 0-.2-.3-.9.1-1.8 0 0 .6-.2 1.8.6.5-.1 1.1-.2 1.6-.2s1.1.1 1.6.2c1.2-.8 1.8-.6 1.8-.6.4.9.1 1.6.1 1.8.4.4.7 1 .7 1.7 0 2.5-1.5 3-2.9 3.2.2.2.4.6.4 1.2v1.7c0 .2.1.4.4.3 2.5-.9 4.4-3.3 4.4-6.2 0-3.6-2.9-6.5-6.5-6.5z"/></svg>;
    case 'dollar': return <svg {...props}><path d="M8 1v14M11 4H6.5a2 2 0 100 4h3a2 2 0 110 4H4.5"/></svg>;
    case 'pause': return <svg {...props}><rect x="4" y="3" width="3" height="10"/><rect x="9" y="3" width="3" height="10"/></svg>;
    case 'pulse': return <svg {...props}><path d="M2 8h3l1.5-4 3 8L11 8h3"/></svg>;
    case 'terminal': return <svg {...props}><path d="M2 3h12v10H2z"/><path d="M4 6l2 2-2 2M8 10h4"/></svg>;
    case 'star': return <svg {...props}><path d="M8 2l1.8 4 4.2.4-3.2 2.8 1 4.2-3.8-2.4-3.8 2.4 1-4.2L2 6.4l4.2-.4z"/></svg>;
    case 'globe': return <svg {...props}><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/></svg>;
    case 'lock': return <svg {...props}><rect x="3" y="7" width="10" height="7" rx="1"/><path d="M5 7V5a3 3 0 016 0v2"/></svg>;
    case 'tag': return <svg {...props}><path d="M2 2h6l6 6-6 6-6-6V2z"/><circle cx="5" cy="5" r="1" fill={color}/></svg>;
    case 'mcp': return <svg {...props}><circle cx="8" cy="8" r="2"/><circle cx="3" cy="4" r="1.5"/><circle cx="13" cy="4" r="1.5"/><circle cx="3" cy="12" r="1.5"/><circle cx="13" cy="12" r="1.5"/><path d="M4 5l3 2M12 5l-3 2M4 11l3-2M12 11l-3-2"/></svg>;
    default: return <svg {...props}><circle cx="8" cy="8" r="3"/></svg>;
  }
};

// =================================================================
// V1 — Mission Control: dark sidebar + topbar + status strip
// =================================================================
const V1Sidebar = ({ active, dense = false }) => (
  <div style={{
    width: dense ? 56 : 192, background: 'var(--bg-1)', borderRight: '1px solid var(--line)',
    display: 'flex', flexDirection: 'column', flexShrink: 0,
  }}>
    <div style={{ padding: dense ? '12px 0' : '12px 14px', display: 'flex', alignItems: 'center', justifyContent: dense ? 'center' : 'flex-start', gap: 8, borderBottom: '1px solid var(--line)' }}>
      <AllenLogo size={16} color="var(--acc)"/>
      {!dense && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, letterSpacing: '0.12em', color: 'var(--ink)' }}>ALLEN</span>}
    </div>
    <div style={{ flex: 1, overflow: 'hidden', padding: '8px 0' }}>
      {NAV.map((g, i) => (
        <div key={i} style={{ marginBottom: 12 }}>
          {g.group && !dense && (
            <div className="uppercase-label" style={{ padding: '6px 14px 4px' }}>{g.group}</div>
          )}
          {g.group && dense && <div style={{ height: 8 }} />}
          {g.items.map(item => {
            const isActive = item.id === active;
            return (
              <div key={item.id} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: dense ? '7px 0' : '5px 14px',
                justifyContent: dense ? 'center' : 'flex-start',
                color: isActive ? 'var(--acc)' : 'var(--ink-2)',
                background: isActive ? 'color-mix(in srgb, var(--acc) 10%, transparent)' : 'transparent',
                borderLeft: isActive && !dense ? '2px solid var(--acc)' : '2px solid transparent',
                paddingLeft: dense ? 0 : 12,
                fontSize: 12, cursor: 'pointer',
              }}>
                <Icon name={item.icon} size={13} />
                {!dense && <span>{item.label}</span>}
              </div>
            );
          })}
        </div>
      ))}
    </div>
    {!dense && (
      <div style={{ borderTop: '1px solid var(--line)', padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8, color: 'var(--ink-3)', fontSize: 11 }}>
        <Icon name="settings" size={12} />
        <span>Settings</span>
      </div>
    )}
  </div>
);

const V1Topbar = ({ crumbs = [], actions }) => (
  <div style={{
    height: 40, borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center',
    padding: '0 14px', gap: 12, background: 'var(--bg-1)',
  }}>
    {/* workspace switcher */}
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px', border: '1px solid var(--line)', borderRadius: 'var(--radius)', fontSize: 11 }}>
      <div style={{ width: 12, height: 12, borderRadius: 3, background: 'linear-gradient(135deg, #5eead4, #818cf8)' }} />
      <span className="mono">inomy/main</span>
      <Icon name="chevron-down" size={11} color="var(--ink-3)"/>
    </div>
    {crumbs.length > 0 && (
      <>
        <div style={{ color: 'var(--ink-4)' }}>/</div>
        {crumbs.map((c, i) => (
          <React.Fragment key={i}>
            <span style={{ fontSize: 12, color: i === crumbs.length - 1 ? 'var(--ink)' : 'var(--ink-3)', fontWeight: i === crumbs.length - 1 ? 600 : 400 }}>{c}</span>
            {i < crumbs.length - 1 && <div style={{ color: 'var(--ink-4)' }}>/</div>}
          </React.Fragment>
        ))}
      </>
    )}
    <div style={{ flex: 1 }} />
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', border: '1px solid var(--line)',
      borderRadius: 'var(--radius)', color: 'var(--ink-3)', fontSize: 11, minWidth: 220, cursor: 'pointer',
    }}>
      <Icon name="search" size={12} />
      <span>Search workflows, agents, executions…</span>
      <div style={{ flex: 1 }} />
      <span className="mono" style={{ background: 'var(--bg-3)', padding: '1px 4px', borderRadius: 3, fontSize: 10 }}>⌘K</span>
    </div>
    {actions}
    <Icon name="bell" size={14} color="var(--ink-3)" />
    <div style={{ width: 22, height: 22, borderRadius: '50%', background: 'linear-gradient(135deg, #5eead4, #818cf8)' }} />
  </div>
);

const V1StatusStrip = ({ items = [] }) => (
  <div style={{
    height: 22, borderTop: '1px solid var(--line)', background: 'var(--bg-1)',
    display: 'flex', alignItems: 'center', padding: '0 12px', gap: 16,
    fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.04em',
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <span className="dot dot-run" style={{ width: 5, height: 5 }} />
      <span style={{ color: 'var(--acc)' }}>LIVE</span>
    </div>
    {items.map((it, i) => (
      <div key={i}>{it.label}: <span style={{ color: 'var(--ink-2)' }}>{it.value}</span></div>
    ))}
    <div style={{ flex: 1 }} />
    <div>v0.142.7</div>
    <div>·</div>
    <div>uptime 14d 06:22</div>
  </div>
);

const V1Frame = ({ active, crumbs, actions, status, children, dense }) => (
  <div className="frame v1">
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <V1Sidebar active={active} dense={dense} />
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <V1Topbar crumbs={crumbs} actions={actions} />
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {children}
        </div>
      </div>
    </div>
    <V1StatusStrip items={status || [
      { label: 'EXEC', value: '290 RUN' },
      { label: 'AGENTS', value: '149 ACT' },
      { label: 'COST/H', value: '$12.40' },
      { label: 'INTERV', value: '3 PEND' },
    ]} />
  </div>
);

// =================================================================
// V2 — Linear-clean: light sidebar + content, slide-over feed
// =================================================================
const V2Sidebar = ({ active, dense = false }) => (
  <div style={{
    width: dense ? 56 : 220, background: 'var(--bg-2)',
    display: 'flex', flexDirection: 'column', flexShrink: 0, padding: dense ? '12px 6px' : '12px 8px',
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, marginBottom: 14, cursor: 'pointer' }}>
      <div style={{ width: 22, height: 22, borderRadius: 6, background: 'linear-gradient(135deg, #5e6ad2, #8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <AllenLogo size={13} color="#fff" />
      </div>
      {!dense && (
        <>
          <div style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>Inomy</div>
          <Icon name="chevron-down" size={12} color="var(--ink-3)" />
        </>
      )}
    </div>
    {!dense && (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', borderRadius: 6,
        background: 'var(--bg-1)', border: '1px solid var(--line)', color: 'var(--ink-3)', fontSize: 12, marginBottom: 12,
      }}>
        <Icon name="search" size={12} />
        <span style={{ flex: 1 }}>Search…</span>
        <span className="mono" style={{ fontSize: 10 }}>⌘K</span>
      </div>
    )}
    <div style={{ flex: 1, overflow: 'hidden' }}>
      {NAV_V2.map((g, i) => (
        <div key={i} style={{ marginBottom: 12 }}>
          {g.group && !dense && (
            <div className="uppercase-label" style={{ padding: '4px 8px' }}>{g.group}</div>
          )}
          {g.items.map(item => {
            const isActive = item.id === active;
            return (
              <div key={item.id} style={{
                display: 'flex', alignItems: 'center', gap: 9,
                padding: dense ? '6px 0' : '5px 8px',
                justifyContent: dense ? 'center' : 'flex-start',
                color: isActive ? 'var(--ink)' : 'var(--ink-2)',
                background: isActive ? 'var(--bg-1)' : 'transparent',
                borderRadius: 6, fontSize: 13, cursor: 'pointer', fontWeight: isActive ? 500 : 400,
                boxShadow: isActive ? '0 1px 2px rgba(0,0,0,0.05)' : 'none',
              }}>
                <Icon name={item.icon} size={14} color={isActive ? 'var(--acc)' : 'var(--ink-3)'} />
                {!dense && <span style={{ flex: 1 }}>{item.label}</span>}
                {!dense && item.count != null && (
                  <span style={{ fontSize: 11, color: 'var(--ink-3)', fontFamily: 'var(--font-mono)' }}>{item.count}</span>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
    {!dense && (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', color: 'var(--ink-2)', fontSize: 12 }}>
        <div style={{ width: 22, height: 22, borderRadius: '50%', background: 'linear-gradient(135deg, #5e6ad2, #06b6d4)' }} />
        <span style={{ flex: 1 }}>Ashish</span>
        <Icon name="settings" size={13} color="var(--ink-3)" />
      </div>
    )}
  </div>
);

const V2Topbar = ({ title, crumbs = [], actions, tabs }) => (
  <div style={{
    padding: '14px 24px 0', background: 'var(--bg)', display: 'flex', flexDirection: 'column',
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
      {crumbs.map((c, i) => (
        <React.Fragment key={i}>
          <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{c}</span>
          {i < crumbs.length - 1 && <Icon name="chevron" size={10} color="var(--ink-4)" />}
        </React.Fragment>
      ))}
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0, letterSpacing: '-0.02em' }}>{title}</h1>
      <div style={{ flex: 1 }} />
      {actions}
    </div>
    {tabs && (
      <div style={{ display: 'flex', gap: 4, marginTop: 14, borderBottom: '1px solid var(--line)' }}>
        {tabs.map((t, i) => (
          <div key={i} style={{
            padding: '6px 10px', fontSize: 13, cursor: 'pointer',
            color: t.active ? 'var(--ink)' : 'var(--ink-3)', fontWeight: t.active ? 500 : 400,
            borderBottom: t.active ? '2px solid var(--acc)' : '2px solid transparent',
            marginBottom: -1, display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <span>{t.label}</span>
            {t.count != null && <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>{t.count}</span>}
          </div>
        ))}
      </div>
    )}
  </div>
);

const V2Frame = ({ active, title, crumbs, actions, tabs, children, dense }) => (
  <div className="frame v2">
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <V2Sidebar active={active} dense={dense} />
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, background: 'var(--bg)' }}>
        <V2Topbar title={title} crumbs={crumbs} actions={actions} tabs={tabs} />
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {children}
        </div>
      </div>
    </div>
  </div>
);

// =================================================================
// V3 — Operator: top bar with command-palette feel, table-heavy
// =================================================================
const V3Topbar = ({ active }) => (
  <div style={{
    height: 44, borderBottom: '2px solid var(--ink)', display: 'flex', alignItems: 'center',
    background: 'var(--bg-1)', padding: '0 16px', gap: 14, flexShrink: 0,
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <AllenLogo size={16} color="var(--ink)"/>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, letterSpacing: '0.05em' }}>ALLEN</span>
    </div>
    <div style={{ width: 1, height: 18, background: 'var(--line)' }} />
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
      <span style={{ color: 'var(--ink-3)' }}>ws:</span>
      <span style={{ fontWeight: 600 }}>inomy/main</span>
      <Icon name="chevron-down" size={10} color="var(--ink-3)"/>
    </div>
    <div style={{ flex: 1 }} />
    {/* command palette */}
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px',
      border: '1px solid var(--ink)', background: 'var(--bg)', minWidth: 360, cursor: 'text',
    }}>
      <Icon name="terminal" size={12} />
      <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>type a command, agent, or workflow…</span>
      <div style={{ flex: 1 }} />
      <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>⌘K</span>
    </div>
    <div style={{ flex: 1 }} />
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--ink-2)' }}>
      <span>290<span style={{ color: 'var(--ink-3)' }}> running</span></span>
      <span>3<span style={{ color: 'var(--ink-3)' }}> need review</span></span>
      <span style={{ color: 'var(--err)' }}>1 failed</span>
    </div>
    <div style={{ width: 24, height: 24, background: 'var(--ink)', color: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: 11 }}>A</div>
  </div>
);

const V3SubNav = ({ active }) => {
  const tabs = [
    { id: 'chat', label: 'Chat' }, { id: 'dashboard', label: 'Dashboard' },
    { id: 'workflows', label: 'Workflows' }, { id: 'agents', label: 'Agents' },
    { id: 'repos', label: 'Repos' }, { id: 'workspaces', label: 'Sandboxes' },
    { id: 'prs', label: 'PRs' }, { id: 'linear', label: 'Linear' },
    { id: 'executions', label: 'Executions' }, { id: 'interventions', label: 'Review' },
    { id: 'analytics', label: 'Analytics' }, { id: 'jobs', label: 'Schedules' },
  ];
  return (
    <div style={{
      height: 32, borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'stretch',
      background: 'var(--bg-1)', padding: '0 8px', gap: 0, flexShrink: 0, overflow: 'hidden',
    }}>
      {tabs.map(t => (
        <div key={t.id} style={{
          padding: '0 12px', display: 'flex', alignItems: 'center', fontSize: 12,
          fontFamily: 'var(--font-mono)', cursor: 'pointer',
          color: t.id === active ? 'var(--ink)' : 'var(--ink-3)',
          background: t.id === active ? 'var(--bg)' : 'transparent',
          borderBottom: t.id === active ? '2px solid var(--acc)' : '2px solid transparent',
          marginBottom: -1, fontWeight: t.id === active ? 600 : 400,
        }}>
          {t.label}
        </div>
      ))}
      <div style={{ flex: 1 }} />
    </div>
  );
};

const V3PageHeader = ({ title, subtitle, actions, count }) => (
  <div style={{
    padding: '18px 20px 12px', display: 'flex', alignItems: 'flex-end', gap: 16, flexShrink: 0,
    borderBottom: '1px solid var(--line)', background: 'var(--bg-1)',
  }}>
    <div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.08em' }}>
        {(subtitle || '').toUpperCase()}
      </div>
      <h1 style={{ fontSize: 26, fontWeight: 700, margin: '2px 0 0', letterSpacing: '-0.02em', display: 'flex', alignItems: 'baseline', gap: 10 }}>
        {title}
        {count != null && <span style={{ fontSize: 14, fontFamily: 'var(--font-mono)', color: 'var(--ink-3)', fontWeight: 400 }}>{count}</span>}
      </h1>
    </div>
    <div style={{ flex: 1 }} />
    {actions}
  </div>
);

const V3Frame = ({ active, title, subtitle, count, actions, children }) => (
  <div className="frame v3">
    <V3Topbar active={active}/>
    <V3SubNav active={active}/>
    <V3PageHeader title={title} subtitle={subtitle} count={count} actions={actions}/>
    <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      {children}
    </div>
  </div>
);

Object.assign(window, {
  AllenLogo, Icon, NAV, NAV_V2,
  V1Sidebar, V1Topbar, V1StatusStrip, V1Frame,
  V2Sidebar, V2Topbar, V2Frame,
  V3Topbar, V3SubNav, V3PageHeader, V3Frame,
});
