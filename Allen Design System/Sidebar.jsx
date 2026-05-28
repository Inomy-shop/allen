// Sidebar — 220px wide, lowercase nav, group titles in mono overlines.
// Receives `route` and `setRoute` so the in-memory router can swap screens.

const NAV_GROUPS = [
{ label: '', items: [
  { id: 'home', icon: 'Sparkles', label: 'new chat' },
  { id: 'executions', icon: 'Play', label: 'executions', count: 12 },
  { id: 'chats', icon: 'Msg', label: 'chats', count: 4 }]
},
{ label: 'Sources', items: [
  { id: 'tickets', icon: 'Ticket', label: 'tickets', count: 7 },
  { id: 'prs', icon: 'PR', label: 'pull requests' },
  { id: 'workspaces', icon: 'Folder', label: 'workspaces', count: 4 }]
},
{ label: 'Org', items: [
  { id: 'library', icon: 'Users', label: 'library' },
  { id: 'workflows', icon: 'GitBranch', label: 'workflows' }]
},
{ label: 'Personal', items: [
  { id: 'settings', icon: 'Settings', label: 'settings' }]
}];


function Sidebar({ route, setRoute }) {
  return (
    <nav className="sidebar">
      <div className="brand">
        <div className="brand-mark">[a]</div>
        <span className="brand-name" style={{ fontFamily: "\"Inter Tight\"" }}>allen</span>
        <span className="brand-sub">v0.2</span>
      </div>
      <div className="sidebar-inner">
        {NAV_GROUPS.map((g, i) =>
        <div className="nav-group" key={i}>
            {g.label && <div className="nav-group-title">{g.label}</div>}
            {g.items.map((item) => {
            const IconCmp = window.Icon[item.icon];
            const active = route === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={`nav-item ${active ? 'active' : ''}`}
                onClick={() => setRoute(item.id)}>
                
                  <span className="ico"><IconCmp /></span>
                  <span className="lbl">{item.label}</span>
                  {item.count ? <span className="b-count">{item.count}</span> : null}
                </button>);

          })}
          </div>
        )}
      </div>
      <div className="sidebar-foot">
        <div className="avatar">EJ</div>
        <div className="user-meta">
          <div className="nm">Elena Jones</div>
          <div className="em">elena@inomy.shop</div>
        </div>
        <button className="foot-btn" title="Sign out"><window.Icon.Logout size={14} /></button>
      </div>
    </nav>);

}

window.Sidebar = Sidebar;