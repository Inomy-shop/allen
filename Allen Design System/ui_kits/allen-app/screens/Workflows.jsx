// Workflows — the built-in pipelines.

const WORKFLOWS = [
  {
    name: 'feature-plan-and-implement',
    desc: 'Clarify requirements, write PRD / HLD / TDD, implement, validate, open a PR.',
    chips: ['9 nodes', '~12 min', 'human checkpoint'],
  },
  {
    name: 'bug-fix-by-severity',
    desc: 'Triage a bug by severity and dispatch the appropriate fix path.',
    chips: ['7 nodes', '~4 min'],
  },
  {
    name: 'resolve-pr-reviews',
    desc: 'Resolve CodeRabbit / PR review comments, run tests, push fixes, summarize.',
    chips: ['5 nodes', '~6 min', 'GitHub'],
  },
  {
    name: 'prd-tdd-design-by-severity',
    desc: 'Generate product + technical design documents scaled to severity.',
    chips: ['6 nodes', '~8 min'],
  },
  {
    name: 'milestone-implementation-from-prd-tdd',
    desc: 'Implement milestones from existing PRD / TDD documents.',
    chips: ['8 nodes', '~20 min'],
  },
  {
    name: 'self-healing-incident-triage',
    desc: 'Classify and route a production / runtime incident.',
    chips: ['4 nodes', '~2 min', 'Linear'],
  },
];

function Workflows() {
  return (
    <div className="page-shell">
      <div className="page-head">
        <div>
          <h1 className="page-title">Workflows</h1>
          <p className="page-sub">YAML pipelines with agent nodes, conditionals, parallel branches, sub-workflows, and human checkpoints.</p>
        </div>
        <button className="btn btn-primary"><window.Icon.Plus size={14} /> Create workflow</button>
      </div>

      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="overline" style={{ flex: 1 }}>Built-in</span>
        <span className="chip">{WORKFLOWS.length} workflows</span>
      </div>

      <div className="wf-grid">
        {WORKFLOWS.map(w => (
          <div className="wf-card" key={w.name}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <window.Icon.GitBranch size={14} />
              <span className="wf-name">{w.name}</span>
            </div>
            <div className="wf-desc">{w.desc}</div>
            <div className="wf-foot">
              {w.chips.map(c => <span className="chip" key={c}>{c}</span>)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

window.Workflows = Workflows;
