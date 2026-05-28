// ⌘K command palette overlay. Filterable, keyboard-navigable.

const COMMANDS = [
  { id: 'home',       label: 'Go to new chat',        group: 'Navigate',  to: 'home' },
  { id: 'executions', label: 'Open executions',       group: 'Navigate',  to: 'executions' },
  { id: 'chats',      label: 'Open chats',            group: 'Navigate',  to: 'chats' },
  { id: 'running',    label: 'View running executions', group: 'Executions', to: 'executions' },
  { id: 'tickets',    label: 'Open Linear tickets',   group: 'Sources',   to: 'tickets' },
  { id: 'prs',        label: 'Open pull requests',    group: 'Sources',   to: 'prs' },
  { id: 'workspaces', label: 'Open workspaces',       group: 'Code',      to: 'workspaces' },
  { id: 'workflows',  label: 'Open workflows',        group: 'Library',   to: 'workflows' },
  { id: 'agents',     label: 'Open agents and teams', group: 'Library',   to: 'library' },
  { id: 'settings',   label: 'Open settings',         group: 'Settings',  to: 'settings' },
];

function CommandPalette({ open, onClose, onNavigate }) {
  const [query, setQuery] = React.useState('');
  const [selected, setSelected] = React.useState(0);
  const inputRef = React.useRef(null);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COMMANDS;
    return COMMANDS.filter(c =>
      c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q));
  }, [query]);

  React.useEffect(() => {
    if (!open) return;
    setQuery(''); setSelected(0);
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [open]);

  React.useEffect(() => { setSelected(0); }, [query]);

  React.useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(i => Math.min(i + 1, filtered.length - 1)); }
      else if (e.key === 'ArrowUp')   { e.preventDefault(); setSelected(i => Math.max(i - 1, 0)); }
      else if (e.key === 'Enter')     {
        e.preventDefault();
        const c = filtered[selected];
        if (c) { onNavigate(c.to); onClose(); }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filtered, selected, open, onClose, onNavigate]);

  if (!open) return null;
  return (
    <div className="cp-scrim" onClick={onClose}>
      <div className="cp-panel" onClick={e => e.stopPropagation()}>
        <div className="cp-input-row">
          <window.Icon.Cmd size={14} />
          <input ref={inputRef} placeholder="Search navigation and actions..."
                 value={query} onChange={e => setQuery(e.target.value)} />
          <span className="kbd">esc</span>
        </div>
        <div className="cp-list">
          {filtered.length === 0 ? (
            <div style={{ padding: '32px 16px', textAlign: 'center', color: 'rgb(var(--color-text-muted))', fontSize: 12 }}>
              No commands match.
            </div>
          ) : filtered.map((c, i) => (
            <div key={c.id} className={`cp-item ${i === selected ? 'active' : ''}`}
                 onMouseEnter={() => setSelected(i)}
                 onClick={() => { onNavigate(c.to); onClose(); }}>
              <window.Icon.ArrowRight size={14} />
              <span className="label">{c.label}</span>
              <span className="group">{c.group}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

window.CommandPalette = CommandPalette;
