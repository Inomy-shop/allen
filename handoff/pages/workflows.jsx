// workflows.jsx — Agent Workflows page, three variations

const workflows = [
  ['test-interior-designer', 'End-to-end testing workflow for the interior designer feature in the inomy-ai-service repo. Analyzes the existing implementation…', 8, { ok: 0, err: 0, run: 0 }, 'v1'],
  ['feature-plan-and-implement', 'End-to-end feature workflow: clarify the ask, produce PRD + HLA + TDD with per-doc panel audits, pause at one of N gates…', 12, { ok: 4, err: 0, run: 1 }, 'v3'],
  ['bug-investigate-and-fix', 'Lean bug-fix workflow: investigate the root cause, distinguish from feature-in-disguise, create a worktree, dispatch…', 6, { ok: 12, err: 1, run: 0 }, 'v2'],
  ['understand-and-plan', 'Lightweight planning-only workflow. Takes a task description plus a target repo, runs a requirements-analyst agent…', 4, { ok: 8, err: 0, run: 2 }, 'v5'],
  ['test-chat-loop', 'Real-LLM smoke test for the Human Intervention Protocol. Exercises the full round-trip: user asks a question → LLM…', 5, { ok: 22, err: 0, run: 0 }, 'v2'],
  ['test-artifacts', 'Takes a topic and generates a detailed report on it, across two sequential agent turns. Also serves as a real-world…', 3, { ok: 4, err: 0, run: 0 }, 'v1'],
  ['multi-repo-change-orchestration', 'Parent orchestration workflow for cross-repo change delivery. It takes a single high-level request, clarifies it when…', 9, { ok: 1, err: 0, run: 0 }, 'v1'],
  ['prd-architecture-review', 'Reviews a PRD and functional requirements package from a single freeform user request that may include a Linear…', 7, { ok: 6, err: 1, run: 0 }, 'v2'],
  ['resolve-pr-reviews', 'Resolves unresolved CodeRabbit (and other review-bot) comments on a GitHub pull request. Two nodes, both agen…', 4, { ok: 0, err: 0, run: 61 }, 'v1'],
  ['test-human-intervention', 'Minimal smoke-test workflow for the Human Intervention Protocol. Exercises all three severity types ⊕ QUESTIO…', 3, { ok: 0, err: 0, run: 0 }, 'v1'],
  ['test-create-workspace', 'Minimal smoke-test for the `create-workspace` built-in. No agents, no LLM cost — just exercises the code path that…', 2, { ok: 0, err: 0, run: 0 }, 'v1'],
  ['coding-workflow', 'Universal coding-task workflow. Works on any repo (fullstack, backend, frontend, mobile, CLI, library, infra, data…)', 11, { ok: 14, err: 2, run: 1 }, 'v8'],
];

// =============================================================
// V1 — Mission Control: dense table with split detail panel
// =============================================================
const WorkflowsV1 = () => (
  <V1Frame active="workflows" crumbs={['Build', 'Agent Workflows']}
    actions={
      <>
        <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>{workflows.length} WORKFLOWS</span>
        <button className="btn btn-line"><Icon name="refresh" size={11}/></button>
        <button className="btn btn-primary"><Icon name="plus" size={11}/> NEW</button>
      </>
    }>
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '24px 240px 1fr 70px 100px 110px', padding: '6px 14px', borderBottom: '1px solid var(--line)', background: 'var(--bg-1)' }}>
          {['', 'NAME', 'DESCRIPTION', 'NODES', 'STATS', 'ACTIONS'].map((h, i) => (
            <div key={i} className="uppercase-label">{h}</div>
          ))}
        </div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          {workflows.map((w, i) => (
            <div key={i} style={{
              display: 'grid', gridTemplateColumns: '24px 240px 1fr 70px 100px 110px',
              padding: '7px 14px', borderBottom: '1px solid var(--line)',
              fontSize: 12, alignItems: 'center', cursor: 'pointer',
              background: i === 1 ? 'color-mix(in srgb, var(--acc) 6%, transparent)' : 'transparent',
            }}>
              <Icon name="chevron" size={11} color="var(--ink-3)"/>
              <div>
                <div className="mono" style={{ color: 'var(--ink)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Icon name="flow" size={11} color="var(--acc)"/>
                  {w[0]} <span style={{ color: 'var(--ink-3)', fontSize: 10 }}>{w[4]}</span>
                </div>
              </div>
              <div style={{ color: 'var(--ink-3)', fontSize: 11 }} className="truncate">{w[1]}</div>
              <div className="mono" style={{ color: 'var(--ink-2)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Icon name="grid" size={10} color="var(--ink-3)"/> {w[2]}
              </div>
              <div className="mono" style={{ display: 'flex', gap: 6, fontSize: 10.5 }}>
                <span style={{ color: 'var(--ok)' }}>✓{w[3].ok}</span>
                <span style={{ color: 'var(--err)' }}>✗{w[3].err}</span>
                <span style={{ color: 'var(--info)' }}>▶{w[3].run}</span>
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <button className="btn btn-line" style={{ padding: '2px 8px', fontSize: 10.5 }}><Icon name="play" size={10}/> Run</button>
                <button className="btn btn-line" style={{ padding: '2px 6px', fontSize: 10.5 }}><Icon name="edit" size={10}/></button>
              </div>
            </div>
          ))}
        </div>
      </div>
      {/* Detail rail */}
      <div style={{ width: 320, borderLeft: '1px solid var(--line)', background: 'var(--bg-1)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)' }}>
          <div className="uppercase-label">SELECTED · feature-plan-and-implement</div>
          <div className="mono" style={{ fontSize: 14, fontWeight: 600, marginTop: 4 }}>v3 · 12 nodes</div>
        </div>
        <div style={{ padding: 12, fontSize: 11, color: 'var(--ink-2)', lineHeight: 1.55, borderBottom: '1px solid var(--line)' }}>
          End-to-end feature workflow: clarify the ask, produce PRD + HLA + TDD with per-doc panel audits, pause at one of N gates for human sign-off, then dispatch implementation.
        </div>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)' }}>
          <div className="uppercase-label" style={{ marginBottom: 6 }}>NODE GRAPH</div>
          {[
            ['clarify-human', 'human', 'var(--warn)'],
            ['requirements-analyst', 'agent', 'var(--info)'],
            ['prd-author', 'agent', 'var(--info)'],
            ['hla-author', 'agent', 'var(--info)'],
            ['tdd-author', 'agent', 'var(--info)'],
            ['plan-approval-gate', 'human', 'var(--warn)'],
            ['feature-plan-output', 'output', 'var(--ok)'],
          ].map((n, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
              <span style={{ color: 'var(--ink-4)', width: 14 }}>{i + 1}.</span>
              <span style={{ color: n[2], width: 50, fontSize: 10 }}>[{n[1]}]</span>
              <span style={{ flex: 1, color: 'var(--ink-2)' }}>{n[0]}</span>
            </div>
          ))}
        </div>
        <div style={{ padding: 12, flex: 1 }}>
          <div className="uppercase-label" style={{ marginBottom: 6 }}>RECENT RUNS</div>
          {[['ba7c221d', 'ok', '175.1s'], ['98f364f2', 'run', '12.3s'], ['5f60fe67', 'err', '11.2s']].map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, fontSize: 10.5, fontFamily: 'var(--font-mono)', padding: '3px 0' }}>
              <span style={{ color: 'var(--acc)' }}>{r[0]}</span>
              <span className={`pill pill-${r[1]}`} style={{ padding: '0 5px', fontSize: 9 }}>{r[1]}</span>
              <span style={{ flex: 1 }}/>
              <span style={{ color: 'var(--ink-3)' }}>{r[2]}</span>
            </div>
          ))}
        </div>
        <div style={{ padding: 10, borderTop: '1px solid var(--line)', display: 'flex', gap: 6 }}>
          <button className="btn btn-line" style={{ flex: 1 }}><Icon name="play" size={11}/> Run</button>
          <button className="btn btn-primary" style={{ flex: 1 }}><Icon name="edit" size={11}/> Edit</button>
        </div>
      </div>
    </div>
  </V1Frame>
);

// =============================================================
// V2 — Linear-clean: card grid grouped by category
// =============================================================
const WorkflowsV2 = () => {
  const groups = [
    { title: 'Feature work', desc: 'Plan, implement, ship', items: workflows.slice(0, 4) },
    { title: 'Code & quality', desc: 'Investigate, review, fix', items: workflows.slice(4, 8) },
    { title: 'Smoke tests & utilities', desc: 'Internal verification', items: workflows.slice(8) },
  ];
  return (
    <V2Frame active="workflows" title="Workflows" crumbs={['Build', 'Workflows']}
      actions={
        <>
          <button className="btn btn-line"><Icon name="filter" size={12}/> All</button>
          <button className="btn btn-line"><Icon name="search" size={12}/></button>
          <button className="btn btn-primary"><Icon name="plus" size={12}/> New workflow</button>
        </>
      }
      tabs={[{ label: 'All', count: 12, active: true }, { label: 'Featured' }, { label: 'My drafts' }, { label: 'Archived', count: 4 }]}>
      <div style={{ flex: 1, padding: '20px 24px', overflow: 'hidden' }}>
        {groups.map((g, gi) => (
          <div key={gi} style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{g.title}</span>
              <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>{g.desc}</span>
              <span style={{ flex: 1, height: 1, background: 'var(--line)' }}/>
              <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>{g.items.length}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
              {g.items.slice(0, 4).map((w, i) => (
                <div key={i} style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 8, cursor: 'pointer' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 28, height: 28, borderRadius: 7, background: 'var(--acc-dim)', color: 'var(--acc)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Icon name="flow" size={14}/>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="mono" style={{ fontSize: 13, fontWeight: 500 }} >{w[0]}</div>
                      <div style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>{w[4]} · {w[2]} nodes</div>
                    </div>
                    <button className="btn btn-line" style={{ padding: '3px 8px' }}><Icon name="play" size={11}/></button>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{w[1]}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                    <span style={{ color: 'var(--ok)', display: 'flex', alignItems: 'center', gap: 3 }}>● {w[3].ok}</span>
                    <span style={{ color: 'var(--err)', display: 'flex', alignItems: 'center', gap: 3 }}>● {w[3].err}</span>
                    <span style={{ color: 'var(--info)', display: 'flex', alignItems: 'center', gap: 3 }}>● {w[3].run}</span>
                    <span style={{ flex: 1 }}/>
                    <span style={{ color: 'var(--ink-3)' }}>last run · 4m</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </V2Frame>
  );
};

// =============================================================
// V3 — Operator: dense full-width table
// =============================================================
const WorkflowsV3 = () => (
  <V3Frame active="workflows" title="Workflows" subtitle="agent orchestration" count={`${workflows.length} TOTAL`}
    actions={
      <>
        <button className="btn btn-line mono">FILTER</button>
        <button className="btn btn-line mono">SORT</button>
        <button className="btn btn-primary mono">+ NEW WORKFLOW</button>
      </>
    }>
    <div style={{ flex: 1, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        <thead>
          <tr style={{ background: 'var(--bg-1)', borderBottom: '1px solid var(--ink)' }}>
            {[
              ['#', 28], ['NAME', 240], ['VER', 50], ['DESCRIPTION', null], ['NODES', 60],
              ['OK', 50], ['ERR', 50], ['RUN', 50], ['LAST', 90], ['', 110],
            ].map(([h, w], i) => (
              <th key={i} style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, letterSpacing: '0.08em', color: 'var(--ink-3)', fontWeight: 500, width: w || 'auto', borderRight: i < 9 ? '1px solid var(--line)' : 'none' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {workflows.map((w, i) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--line)', cursor: 'pointer', background: i === 1 ? 'var(--acc-dim)' : 'var(--bg-1)' }}>
              <td style={{ padding: '8px 12px', color: 'var(--ink-4)', borderRight: '1px solid var(--line)' }}>{String(i + 1).padStart(2, '0')}</td>
              <td style={{ padding: '8px 12px', fontWeight: 600, borderRight: '1px solid var(--line)' }}>{w[0]}</td>
              <td style={{ padding: '8px 12px', color: 'var(--ink-3)', borderRight: '1px solid var(--line)' }}>{w[4]}</td>
              <td style={{ padding: '8px 12px', color: 'var(--ink-2)', fontFamily: 'var(--font-sans)', maxWidth: 0, borderRight: '1px solid var(--line)' }} className="truncate">{w[1]}</td>
              <td style={{ padding: '8px 12px', textAlign: 'center', borderRight: '1px solid var(--line)' }}>{w[2]}</td>
              <td style={{ padding: '8px 12px', textAlign: 'center', color: w[3].ok > 0 ? 'var(--ok)' : 'var(--ink-4)', borderRight: '1px solid var(--line)' }}>{w[3].ok}</td>
              <td style={{ padding: '8px 12px', textAlign: 'center', color: w[3].err > 0 ? 'var(--err)' : 'var(--ink-4)', borderRight: '1px solid var(--line)' }}>{w[3].err}</td>
              <td style={{ padding: '8px 12px', textAlign: 'center', color: w[3].run > 0 ? 'var(--info)' : 'var(--ink-4)', borderRight: '1px solid var(--line)' }}>{w[3].run}</td>
              <td style={{ padding: '8px 12px', color: 'var(--ink-3)', borderRight: '1px solid var(--line)' }}>{['4m', '12m', '1h', '2h', 'now', '14m', '6h', '1d', 'now', '—', '—', '8m'][i]}</td>
              <td style={{ padding: '4px 8px' }}>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button className="btn btn-line" style={{ padding: '2px 8px', fontSize: 10 }}>RUN</button>
                  <button className="btn btn-line" style={{ padding: '2px 8px', fontSize: 10 }}>EDIT</button>
                  <button className="btn btn-line" style={{ padding: '2px 6px', fontSize: 10, color: 'var(--err)' }}>DEL</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </V3Frame>
);

window.WorkflowsV1 = WorkflowsV1; window.WorkflowsV2 = WorkflowsV2; window.WorkflowsV3 = WorkflowsV3;
