// My Work — the landing screen. Hero greet + composer + recent runs.

function MyWork({ onSend }) {
  const [draft, setDraft] = React.useState('');
  return (
    <div className="page-shell" style={{ padding: 0 }}>
      <div className="mw-hero">
        <div className="mw-hero-inner">
          <div className="mw-greet">
            <div className="mw-hello">
              <span className="mw-kicker">Tuesday afternoon</span>
              <h1>What should Allen work on?</h1>
              <p className="sub">Describe a task, paste a Linear ticket, or @mention an agent. Allen will route the work and run it in an isolated workspace.</p>
            </div>
            <div className="mw-pulse">
              <span><span className="dot dot-run" /> 3 running</span>
              <span><span className="dot dot-warn" /> 1 waiting</span>
              <span><span className="dot dot-ok" /> 8 today</span>
            </div>
          </div>
          <div className="mw-command-composer">
            <textarea
              placeholder="Message Allen..."
              value={draft}
              onChange={e => setDraft(e.target.value)}
            />
            <div className="mw-foot">
              <span className="chip">
                <span className="dot" style={{ background: 'rgb(var(--color-accent-purple))' }} />
                engineering-bug-fix-l2
              </span>
              <span className="chip">claude-sonnet-4-5</span>
              <span className="chip">+ workspace</span>
              <span style={{ flex: 1 }} />
              <span className="kbd">⌘↵</span>
              <button className="btn btn-primary" onClick={() => { if (draft.trim()) onSend(draft); }}>
                <window.Icon.Send size={14} /> Send
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="mw-recent">
        <h2>Recent</h2>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>workflow</th>
                <th>repo</th>
                <th>status</th>
                <th style={{ textAlign: 'right' }}>cost</th>
                <th style={{ textAlign: 'right' }}>opened</th>
              </tr>
            </thead>
            <tbody>
              <tr className="row">
                <td>
                  <div style={{ fontWeight: 500 }}>Fix delete on empty workflow crash</div>
                  <div className="id">feature-plan-and-implement</div>
                </td>
                <td className="id">inomy-shop/allen</td>
                <td><span className="badge badge-info"><window.Icon.Loader size={12} /> running</span></td>
                <td style={{ textAlign: 'right' }} className="id">$0.42</td>
                <td style={{ textAlign: 'right' }} className="id">2m</td>
              </tr>
              <tr className="row">
                <td>
                  <div style={{ fontWeight: 500 }}>Resolve CodeRabbit comments on #142</div>
                  <div className="id">resolve-pr-reviews</div>
                </td>
                <td className="id">inomy-shop/web</td>
                <td><span className="badge badge-human"><window.Icon.Pause size={12} /> waiting for input</span></td>
                <td style={{ textAlign: 'right' }} className="id">$0.08</td>
                <td style={{ textAlign: 'right' }} className="id">11m</td>
              </tr>
              <tr className="row">
                <td>
                  <div style={{ fontWeight: 500 }}>Add OAuth login flow</div>
                  <div className="id">feature-plan-and-implement</div>
                </td>
                <td className="id">inomy-shop/api</td>
                <td><span className="badge badge-ok"><window.Icon.Check size={12} /> completed</span></td>
                <td style={{ textAlign: 'right' }} className="id">$1.24</td>
                <td style={{ textAlign: 'right' }} className="id">1h</td>
              </tr>
              <tr className="row">
                <td>
                  <div style={{ fontWeight: 500 }}>Investigate stale cache invalidation</div>
                  <div className="id">bug-fix-by-severity</div>
                </td>
                <td className="id">inomy-shop/allen</td>
                <td><span className="badge badge-err"><window.Icon.XCircle size={12} /> failed</span></td>
                <td style={{ textAlign: 'right' }} className="id">$0.18</td>
                <td style={{ textAlign: 'right' }} className="id">3h</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

window.MyWork = MyWork;
