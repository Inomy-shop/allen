// Chat — conversation list + thread + composer.

const CONVS = [
  { id: 'c1', title: 'Fix delete crash on empty workflow', meta: 'EXE_29sk2a · 2m' },
  { id: 'c2', title: 'Resolve CodeRabbit comments #142',   meta: 'EXE_29sk2c · 11m' },
  { id: 'c3', title: 'OAuth login flow',                   meta: 'completed · 1h' },
  { id: 'c4', title: 'Stale cache investigation',          meta: 'failed · 3h' },
];

const SEED_MESSAGES = [
  {
    who: 'user', name: 'Elena Jones', meta: '2 min ago', avatar: 'EJ',
    body: <>Clicking <code>Delete</code> on an empty workflow crashes the UI with <code>Cannot read property 'id' of undefined</code>. <span className="mention">@engineering-bug-fix-l2</span> can you triage this against <span className="mention">@inomy-shop/allen</span>?</>,
  },
  {
    who: 'agent', name: 'engineering-bug-fix-l2', meta: '~1 min ago · routed', avatar: 'BF', color: '#9763CC',
    body: <>Pulling latest from <code>main</code> and reproducing locally. I'll spin up a workspace, run the failing path, and propose a fix.</>,
    tool: { label: 'workspace.create · inomy-shop/allen@main', body: 'Created worktree WS_a7f31c\nClaude session initialized\nReady · 1.2s' },
  },
  {
    who: 'agent', name: 'engineering-bug-fix-l2', meta: '20s ago · investigating', avatar: 'BF', color: '#9763CC',
    body: <>Reproduced. Root cause is in <code>WorkflowListPage.handleDelete</code> — the early-return guard doesn't account for the case where <code>selected</code> is <code>undefined</code> after an optimistic delete. Patch coming.</>,
  },
];

function Chat({ onActiveChange }) {
  const [active, setActive] = React.useState('c1');
  const [draft, setDraft] = React.useState('');
  const [messages, setMessages] = React.useState(SEED_MESSAGES);

  function send() {
    if (!draft.trim()) return;
    setMessages(m => [...m, {
      who: 'user', name: 'Elena Jones', meta: 'just now', avatar: 'EJ', body: draft,
    }]);
    setDraft('');
    setTimeout(() => {
      setMessages(m => [...m, {
        who: 'agent', name: 'engineering-bug-fix-l2', meta: 'just now', avatar: 'BF', color: '#9763CC',
        body: 'Acknowledged. Adjusting plan and resuming the patch.',
      }]);
    }, 800);
  }

  return (
    <div className="chat-shell">
      <aside className="chat-conversations">
        <div style={{ padding: '6px 8px 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgb(var(--color-text-subtle))' }}>Conversations</span>
          <button className="foot-btn" title="New chat"><window.Icon.Plus size={14} /></button>
        </div>
        {CONVS.map(c => (
          <div key={c.id} className={`conv-item ${active === c.id ? 'active' : ''}`}
               onClick={() => setActive(c.id)}>
            <div className="conv-title">{c.title}</div>
            <div className="conv-meta">{c.meta}</div>
          </div>
        ))}
      </aside>
      <div className="chat-main">
        <div className="chat-stream">
          {messages.map((m, i) => (
            <div className="msg-row" key={i}>
              <div className="avatar" style={{ width: 32, height: 32, fontSize: 12, ...(m.color ? { background: `linear-gradient(135deg, ${m.color}, #2A76E2)` } : {}) }}>{m.avatar}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div>
                  <span className="msg-author">{m.name}</span>
                  <span className="msg-meta">{m.meta}</span>
                </div>
                <div className="msg-body">{m.body}</div>
                {m.tool && (
                  <div className="msg-tool">
                    <div className="msg-tool-head"><window.Icon.Terminal size={12} /> {m.tool.label}</div>
                    <div className="msg-tool-body">{m.tool.body}</div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="composer-wrap">
          <div className="composer">
            <textarea
              placeholder="Message Allen..."
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }}
            />
            <div className="composer-foot">
              <span className="chip"><span className="dot" style={{ background: 'rgb(var(--color-accent-purple))' }} /> engineering-bug-fix-l2</span>
              <span className="chip">@ENG-142</span>
              <span className="chip">claude-sonnet-4-5</span>
              <span style={{ flex: 1 }} />
              <span className="kbd">⌘↵</span>
              <button className="btn btn-primary" onClick={send}><window.Icon.Send size={14} /> Send</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

window.Chat = Chat;
