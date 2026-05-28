// Executions — the run log.

const RUNS = [
  { id: 'EXE_29sk2a', wf: 'feature-plan-and-implement',     status: 'running',           cost: '$0.42', opened: '2m' },
  { id: 'EXE_29sk2b', wf: 'bug-fix-by-severity',            status: 'running',           cost: '$0.09', opened: '4m' },
  { id: 'EXE_29sk2c', wf: 'resolve-pr-reviews',             status: 'waiting_for_input', cost: '$0.08', opened: '11m' },
  { id: 'EXE_29sk1z', wf: 'bug-fix-by-severity',            status: 'completed',         cost: '$0.04', opened: '34m' },
  { id: 'EXE_29sk1y', wf: 'feature-plan-and-implement',     status: 'completed',         cost: '$1.24', opened: '1h' },
  { id: 'EXE_29sk1x', wf: 'self-healing-incident-triage',   status: 'failed',            cost: '$0.18', opened: '3h' },
  { id: 'EXE_29sk1w', wf: 'milestone-implementation',       status: 'queued',            cost: '$0.00', opened: '5h' },
  { id: 'EXE_29sk1v', wf: 'prd-tdd-design-by-severity',     status: 'completed',         cost: '$0.61', opened: '6h' },
];

const STATUS_BADGE = {
  running:           { cls: 'badge-info',  Icon: () => <window.Icon.Loader size={12} /> },
  completed:         { cls: 'badge-ok',    Icon: () => <window.Icon.Check  size={12} /> },
  failed:            { cls: 'badge-err',   Icon: () => <window.Icon.XCircle size={12} /> },
  queued:            { cls: 'badge-warn',  Icon: () => <window.Icon.Clock  size={12} /> },
  waiting_for_input: { cls: 'badge-human', Icon: () => <window.Icon.Pause  size={12} /> },
};

function Executions() {
  const [filter, setFilter] = React.useState('all');
  const shown = filter === 'all' ? RUNS : RUNS.filter(r => r.status === filter);

  const Tab = ({ id, children }) => (
    <button
      className={`chip ${filter === id ? 'active' : ''}`}
      style={filter === id ? {
        background: 'rgb(var(--color-accent-soft))',
        color: 'rgb(var(--color-accent))',
        borderColor: 'rgb(var(--color-accent) / 0.25)',
      } : { cursor: 'pointer' }}
      onClick={() => setFilter(id)}
    >{children}</button>
  );

  return (
    <div className="page-shell">
      <div className="page-head">
        <div>
          <h1 className="page-title">Executions</h1>
          <p className="page-sub">Every workflow run, agent invocation, and node trace.</p>
        </div>
        <button className="btn btn-secondary"><window.Icon.Plus size={14} /> New run</button>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <Tab id="all">all · {RUNS.length}</Tab>
        <Tab id="running">running · {RUNS.filter(r => r.status === 'running').length}</Tab>
        <Tab id="waiting_for_input">waiting · {RUNS.filter(r => r.status === 'waiting_for_input').length}</Tab>
        <Tab id="completed">completed · {RUNS.filter(r => r.status === 'completed').length}</Tab>
        <Tab id="failed">failed · {RUNS.filter(r => r.status === 'failed').length}</Tab>
      </div>

      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>id</th>
              <th>workflow</th>
              <th>status</th>
              <th style={{ textAlign: 'right' }}>cost</th>
              <th style={{ textAlign: 'right' }}>opened</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(r => {
              const s = STATUS_BADGE[r.status] || { cls: 'badge-muted', Icon: () => null };
              return (
                <tr className="row" key={r.id}>
                  <td className="id">{r.id}</td>
                  <td>{r.wf}</td>
                  <td><span className={`badge ${s.cls}`}><s.Icon />{r.status.replace(/_/g, ' ')}</span></td>
                  <td style={{ textAlign: 'right' }} className="id">{r.cost}</td>
                  <td style={{ textAlign: 'right' }} className="id">{r.opened} ago</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

window.Executions = Executions;
