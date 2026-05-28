// Topbar — 52px high. Breadcrumb · live chip · health chip · ⌘K search · theme · bell.

const ROUTE_TITLES = {
  home: 'New chat',
  executions: 'Executions',
  chats: 'Chats',
  tickets: 'Tickets',
  prs: 'Pull requests',
  workspaces: 'Workspaces',
  library: 'Library',
  workflows: 'Workflows',
  settings: 'Settings',
};

function Topbar({ route, dark, onToggleDark, onCommandOpen }) {
  return (
    <header className="topbar">
      <button className="foot-btn" title="Toggle sidebar"><window.Icon.Panel /></button>
      <div className="crumb">
        <span>allen</span>
        <span className="sep">/</span>
        <span className="now">{ROUTE_TITLES[route] || 'Allen'}</span>
      </div>
      <div className="spacer" />
      <span className="chip"><span className="dot dot-run" /> 12 live</span>
      <span className="chip" style={{
        background: 'rgb(var(--color-accent-green) / 0.12)',
        color: 'rgb(var(--color-accent-green))',
        borderColor: 'rgb(var(--color-accent-green) / 0.25)',
      }}>
        <span className="dot dot-ok" />
        healthy
      </span>
      <button className="topbar-search" onClick={onCommandOpen}>
        <window.Icon.Search size={14} />
        <span className="spacer">Search or run command</span>
        <span className="kbd">⌘K</span>
      </button>
      <button className="foot-btn" onClick={onToggleDark} title={`Switch to ${dark ? 'light' : 'dark'} mode`}>
        {dark ? <window.Icon.Sun /> : <window.Icon.Moon />}
      </button>
    </header>
  );
}

window.Topbar = Topbar;
