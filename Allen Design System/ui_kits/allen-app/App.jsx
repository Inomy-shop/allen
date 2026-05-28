// Top-level shell with in-memory router and dark mode toggle.

function AllenApp() {
  const [route, setRoute] = React.useState('home');
  const [dark, setDark]   = React.useState(false);
  const [cpOpen, setCpOpen] = React.useState(false);

  React.useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  React.useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCpOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  let screen = null;
  switch (route) {
    case 'home':       screen = <window.MyWork onSend={() => setRoute('chats')} />; break;
    case 'executions': screen = <window.Executions />; break;
    case 'chats':      screen = <window.Chat />; break;
    case 'workspaces': screen = <window.Workspaces />; break;
    case 'workflows':  screen = <window.Workflows />; break;
    case 'tickets':    screen = <Placeholder title="Tickets" sub="Linear issues from your connected workspaces." />; break;
    case 'prs':        screen = <Placeholder title="Pull requests" sub="GitHub PRs mirrored here with CodeRabbit status." />; break;
    case 'library':    screen = <Placeholder title="Library" sub="Teams · agents · skills · repos · integrations." />; break;
    case 'settings':   screen = <Placeholder title="Settings" sub="Account, integrations, schedules, learnings." />; break;
    default:           screen = <window.MyWork onSend={() => setRoute('chats')} />;
  }

  return (
    <div className="app-shell">
      <window.Sidebar route={route} setRoute={setRoute} />
      <div className="main-col">
        <window.Topbar route={route} dark={dark} onToggleDark={() => setDark(d => !d)} onCommandOpen={() => setCpOpen(true)} />
        <div className="main-body">{screen}</div>
      </div>
      <window.CommandPalette open={cpOpen} onClose={() => setCpOpen(false)} onNavigate={setRoute} />
    </div>
  );
}

function Placeholder({ title, sub }) {
  return (
    <div className="page-shell">
      <div className="page-head">
        <div>
          <h1 className="page-title">{title}</h1>
          <p className="page-sub">{sub}</p>
        </div>
      </div>
      <div style={{
        border: '1px dashed rgb(var(--color-border))',
        borderRadius: 12,
        padding: 40,
        textAlign: 'center',
        color: 'rgb(var(--color-text-muted))',
        background: 'rgb(var(--color-surface-100))',
        fontSize: 13,
      }}>
        Not part of the UI-kit recreation — open the matching <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12, background: 'rgb(var(--color-surface-200))', padding: '1px 6px', borderRadius: 4 }}>packages/ui/src/pages/&lt;Page&gt;.tsx</code> in the source repo for the real implementation.
      </div>
    </div>
  );
}

window.AllenApp = AllenApp;
