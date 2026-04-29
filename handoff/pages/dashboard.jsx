// dashboard.jsx — Dashboard page, three variations

const sampleWorkflows = [
  ['chat:spawn_agent/frontend-developer', 175.1, 0.52, 2],
  ['chat:spawn_agent/engineering-lead', 249.7, 3.23, 6],
  ['understand-and-plan', 996.5, 2.95, 1],
  ['brand-strategist:spawn_agent/brand-strategist-judge', 48.8, 0.58, 1],
  ['chat:spawn_agent/workflow-builder-agent', 595.4, 9.23, 2],
  ['chat:spawn_agent/grouping-quality-evaluator', 257.5, 2.44, 1],
  ['pipeline-incident-watchdog', 476.3, 1.90, 2],
  ['test-interior-designer', 4188.9, 13.40, 1],
  ['chat:spawn_agent/scraped-data-validator', 1128.4, 46.79, 19],
  ['chat:spawn_agent/category-taxonomy-mover', 240.1, 1.65, 2],
  ['chat:spawn_agent/backend-developer', 418.8, 1.15, 1],
  ['chat:spawn_agent/variant-scraped-data-validator', 1224.5, 41.96, 6],
  ['chat:spawn_agent/classification-judge', 869.8, 376.91, 97],
  ['chat:spawn_agent/grouping-quality-evaluator-judge', 92.9, 5.21, 4],
  ['chat:spawn_agent/vendor-rule-onboarder', 1997.6, 141.24, 6],
];

// =============================================================
// V1 — Mission Control Dashboard
// =============================================================
const DashboardV1 = () => {
  const stats = [
    { label: 'TOTAL EXEC', value: '471', delta: '+24 24h', accent: 'var(--ink)' },
    { label: 'RUNNING', value: '290', delta: '12 queued', accent: 'var(--info)' },
    { label: 'COMPLETED', value: '148', delta: '94% rate', accent: 'var(--ok)' },
    { label: 'FAILED', value: '29', delta: '+3 24h', accent: 'var(--err)' },
    { label: 'COST 24H', value: '$822.20', delta: '$12.40/h', accent: 'var(--acc)' },
  ];
  // tiny sparkline
  const spark = (vals, color) => {
    const max = Math.max(...vals), min = Math.min(...vals);
    const w = 60, h = 18;
    const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * w},${h - ((v - min) / (max - min || 1)) * h}`).join(' ');
    return (
      <svg width={w} height={h} style={{ display: 'block' }}>
        <polyline fill="none" stroke={color} strokeWidth="1" points={pts} />
      </svg>
    );
  };
  const v1 = [12,15,11,18,22,19,28,25,30,29];
  const v2v = [8,9,7,11,15,12,18,16,20,22];
  return (
    <V1Frame active="dashboard" crumbs={['Dashboard']}
      actions={<button className="btn btn-line"><Icon name="refresh" size={11}/></button>}>
      <div style={{ flex: 1, padding: 14, display: 'flex', flexDirection: 'column', gap: 12, overflow: 'hidden' }}>
        {/* Stat strip */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
          {stats.map((s, i) => (
            <div key={i} style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 4, padding: '10px 12px' }}>
              <div className="uppercase-label" style={{ fontSize: 9 }}>{s.label}</div>
              <div style={{ fontSize: 22, fontWeight: 600, color: s.accent, fontFamily: 'var(--font-mono)', marginTop: 2, letterSpacing: '-0.02em' }}>
                {s.value}
              </div>
              <div style={{ fontSize: 10, color: 'var(--ink-3)', fontFamily: 'var(--font-mono)' }}>{s.delta}</div>
            </div>
          ))}
        </div>
        {/* Main grid */}
        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr 320px', gap: 8, minHeight: 0 }}>
          {/* Avg duration */}
          <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 4, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Icon name="clock" size={11} color="var(--ink-3)"/>
              <span className="uppercase-label">AVG DURATION BY WORKFLOW</span>
            </div>
            <div style={{ flex: 1, overflow: 'hidden' }}>
              {sampleWorkflows.slice(0, 12).map(([name, dur, cost, runs], i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', padding: '4px 12px', borderBottom: '1px solid var(--line)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                  <span style={{ flex: 1, color: 'var(--ink-2)' }} className="truncate">{name}</span>
                  <span style={{ width: 60, textAlign: 'right', color: 'var(--acc)' }}>{dur}s</span>
                  <span style={{ width: 50, textAlign: 'right', color: 'var(--ink-3)' }}>({runs})</span>
                </div>
              ))}
            </div>
          </div>
          {/* Cost */}
          <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 4, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Icon name="dollar" size={11} color="var(--ink-3)"/>
              <span className="uppercase-label">COST BY WORKFLOW</span>
            </div>
            <div style={{ flex: 1, overflow: 'hidden' }}>
              {sampleWorkflows.slice().sort((a, b) => b[2] - a[2]).slice(0, 12).map(([name, dur, cost, runs], i) => {
                const max = 376.91;
                return (
                  <div key={i} style={{ position: 'relative', padding: '4px 12px', borderBottom: '1px solid var(--line)', fontSize: 11, fontFamily: 'var(--font-mono)', display: 'flex', alignItems: 'center' }}>
                    <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${(cost / max) * 100}%`, background: 'color-mix(in srgb, var(--acc) 8%, transparent)' }}/>
                    <span style={{ flex: 1, color: 'var(--ink-2)', position: 'relative' }} className="truncate">{name}</span>
                    <span style={{ width: 70, textAlign: 'right', color: 'var(--acc)', position: 'relative' }}>${cost.toFixed(2)}</span>
                  </div>
                );
              })}
            </div>
          </div>
          {/* Right rail: live activity + sparklines */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 4 }}>
              <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="dot dot-run"/>
                <span className="uppercase-label">LIVE EXECUTIONS</span>
              </div>
              {[
                ['98f364f2', 'classification-judge', 'RUN', '12.3s'],
                ['ba7c221d', 'frontend-developer', 'RUN', '8.1s'],
                ['c7d342bd', 'resolve-pr-reviews', 'QUE', '—'],
                ['1b2c8b46', 'classification-judge', 'RUN', '4:12'],
                ['8f07c176', 'frontend-developer', 'ERR', '404s'],
              ].map((r, i) => (
                <div key={i} style={{ padding: '5px 12px', borderBottom: '1px solid var(--line)', fontSize: 10.5, fontFamily: 'var(--font-mono)', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: 'var(--acc)' }}>{r[0]}</span>
                  <span style={{ flex: 1, color: 'var(--ink-2)' }} className="truncate">{r[1]}</span>
                  <span style={{
                    fontSize: 9, color: r[2] === 'RUN' ? 'var(--info)' : r[2] === 'ERR' ? 'var(--err)' : 'var(--ink-3)',
                  }}>{r[2]}</span>
                  <span style={{ color: 'var(--ink-3)', width: 36, textAlign: 'right' }}>{r[3]}</span>
                </div>
              ))}
            </div>
            <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 4, padding: 10 }}>
              <div className="uppercase-label" style={{ marginBottom: 8 }}>EXEC RATE · 1h</div>
              {[
                ['Spawn rate', v1, 'var(--acc)', '28/min'],
                ['Completion', v2v, 'var(--ok)', '22/min'],
                ['Failure', [1,2,1,3,2,1,4,3,2,5], 'var(--err)', '5/min'],
              ].map((r, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                  <span style={{ flex: 1, fontSize: 10.5, color: 'var(--ink-2)' }}>{r[0]}</span>
                  {spark(r[1], r[2])}
                  <span className="mono" style={{ fontSize: 10, color: r[2], width: 50, textAlign: 'right' }}>{r[3]}</span>
                </div>
              ))}
            </div>
            <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 4, padding: 10, flex: 1 }}>
              <div className="uppercase-label" style={{ marginBottom: 8 }}>MODEL MIX · 24h</div>
              {[
                ['claude-sonnet', 138, '#5eead4'],
                ['claude-opus', 17, '#f59e0b'],
                ['claude-haiku', 2, '#818cf8'],
              ].map((m, i) => (
                <div key={i} style={{ marginBottom: 8 }}>
                  <div style={{ display: 'flex', fontSize: 10.5, fontFamily: 'var(--font-mono)' }}>
                    <span style={{ flex: 1, color: 'var(--ink-2)' }}>{m[0]}</span>
                    <span style={{ color: m[2] }}>{m[1]}</span>
                  </div>
                  <div style={{ height: 4, background: 'var(--bg-3)', marginTop: 3 }}>
                    <div style={{ width: `${(m[1] / 157) * 100}%`, height: '100%', background: m[2] }}/>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </V1Frame>
  );
};

// =============================================================
// V2 — Linear-clean Dashboard
// =============================================================
const DashboardV2 = () => {
  const cards = [
    { label: 'Executions today', value: '471', delta: '+12.3%', dir: 'up', sub: 'vs. yesterday' },
    { label: 'Active right now', value: '290', delta: '12 queued', dir: 'flat', sub: '149 agents busy' },
    { label: 'Completion rate', value: '94%', delta: '+1.2pt', dir: 'up', sub: '29 failed today' },
    { label: 'Spend today', value: '$822', delta: '$12.40/h', dir: 'flat', sub: 'budget: $1,500' },
  ];
  return (
    <V2Frame active="dashboard" title="Overview" crumbs={['Inomy', 'Overview']}
      actions={
        <>
          <button className="btn btn-line"><Icon name="filter" size={12}/> Last 24 hours</button>
          <button className="btn btn-line"><Icon name="download" size={12}/></button>
        </>
      }
      tabs={[
        { label: 'Overview', active: true },
        { label: 'Workflows', count: 12 },
        { label: 'Agents', count: 149 },
        { label: 'Cost' },
      ]}>
      <div style={{ flex: 1, padding: '20px 24px', overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          {cards.map((c, i) => (
            <div key={i} style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 10, padding: 14 }}>
              <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>{c.label}</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4 }}>
                <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-0.02em' }}>{c.value}</div>
                <div style={{ fontSize: 11, color: c.dir === 'up' ? 'var(--ok)' : 'var(--ink-3)', display: 'flex', alignItems: 'center', gap: 2 }}>
                  {c.dir === 'up' && <Icon name="arrow-up" size={10}/>}
                  {c.delta}
                </div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>{c.sub}</div>
            </div>
          ))}
        </div>
        {/* Big chart card */}
        <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 10, padding: 18, display: 'flex', flexDirection: 'column', gap: 10, height: 240 }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 500 }}>Execution volume</div>
              <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>Hourly, last 24h · grouped by status</div>
            </div>
            <div style={{ flex: 1 }}/>
            <div style={{ display: 'flex', gap: 12, fontSize: 11 }}>
              {[['Completed', 'var(--ok)'], ['Running', 'var(--acc)'], ['Failed', 'var(--err)']].map(([l, c], i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: c }}/>{l}</div>
              ))}
            </div>
          </div>
          {/* stacked bars */}
          <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: 4, padding: '0 4px' }}>
            {Array.from({ length: 24 }).map((_, i) => {
              const ok = 8 + Math.sin(i / 3) * 8 + Math.random() * 6;
              const run = 4 + Math.cos(i / 4) * 4 + Math.random() * 4;
              const er = Math.random() * 2.5;
              const total = ok + run + er;
              return (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column-reverse', height: '100%' }}>
                  <div style={{ height: `${(ok / 30) * 100}%`, background: 'var(--ok)', borderRadius: '0 0 2px 2px', minHeight: 2 }}/>
                  <div style={{ height: `${(run / 30) * 100}%`, background: 'var(--acc)', minHeight: 1 }}/>
                  <div style={{ height: `${(er / 30) * 100}%`, background: 'var(--err)', borderRadius: '2px 2px 0 0' }}/>
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--ink-3)', fontFamily: 'var(--font-mono)' }}>
            <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>now</span>
          </div>
        </div>
        {/* Two columns */}
        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, minHeight: 0 }}>
          <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 10, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center' }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>Top workflows by spend</div>
              <div style={{ flex: 1 }}/>
              <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>Last 24h</span>
            </div>
            <div style={{ flex: 1, overflow: 'hidden' }}>
              {sampleWorkflows.slice().sort((a, b) => b[2] - a[2]).slice(0, 6).map(([name, dur, cost, runs], i) => {
                const max = 376.91;
                return (
                  <div key={i} style={{ padding: '8px 16px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 22, height: 22, borderRadius: 6, background: 'var(--acc-dim)', color: 'var(--acc)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600 }}>{i + 1}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 500 }} className="truncate mono">{name}</div>
                      <div style={{ height: 3, background: 'var(--bg-2)', borderRadius: 2, marginTop: 4 }}>
                        <div style={{ width: `${(cost / max) * 100}%`, height: '100%', background: 'var(--acc)', borderRadius: 2 }}/>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div className="mono" style={{ fontSize: 13, fontWeight: 500 }}>${cost.toFixed(2)}</div>
                      <div style={{ fontSize: 10, color: 'var(--ink-3)' }}>{runs} runs</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 10, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center' }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>Recent activity</div>
              <div style={{ flex: 1 }}/>
              <a style={{ fontSize: 11, color: 'var(--acc)' }}>View all →</a>
            </div>
            <div style={{ flex: 1, overflow: 'hidden' }}>
              {[
                ['ok', 'frontend-developer', 'completed E2E test for variant flow', '2m ago', '$0.52'],
                ['run', 'classification-judge', 'running on 12 categories', 'now', '—'],
                ['warn', 'engineering-lead', 'asked for clarification', '4m ago', '$3.23'],
                ['err', 'pipeline-incident-watchdog', 'workflow not found', '8m ago', '—'],
                ['ok', 'workflow-builder-agent', 'shipped resolve-pr-reviews v2', '14m ago', '$9.23'],
                ['ok', 'scraped-data-validator', 'validated 1,204 rows', '22m ago', '$46.79'],
              ].map((r, i) => (
                <div key={i} style={{ padding: '8px 16px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className={`dot dot-${r[0] === 'run' ? 'run' : r[0] === 'err' ? 'err' : r[0] === 'warn' ? 'warn' : 'ok'}`}/>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12 }}>
                      <span className="mono" style={{ fontWeight: 500 }}>{r[1]}</span>
                      <span style={{ color: 'var(--ink-3)' }}> · {r[2]}</span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>{r[3]}</div>
                  </div>
                  <div className="mono" style={{ fontSize: 11, color: 'var(--ink-2)' }}>{r[4]}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </V2Frame>
  );
};

// =============================================================
// V3 — Operator (brutalist, table-heavy)
// =============================================================
const DashboardV3 = () => {
  return (
    <V3Frame active="dashboard" title="Dashboard" subtitle="Control plane overview" count="471 EXEC · 24H"
      actions={
        <>
          <button className="btn btn-line"><Icon name="refresh" size={11}/> Refresh</button>
          <button className="btn btn-line mono">⌘E export</button>
        </>
      }>
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Left: Big number columns */}
        <div style={{ flex: 1, padding: 16, display: 'flex', flexDirection: 'column', gap: 12, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 0, border: '1px solid var(--ink)', background: 'var(--bg-1)' }}>
            {[
              ['Total', '471', null],
              ['Running', '290', 'var(--info)'],
              ['Completed', '148', 'var(--ok)'],
              ['Failed', '29', 'var(--err)'],
              ['Cost', '$822', null],
            ].map((s, i) => (
              <div key={i} style={{ padding: '14px 16px', borderRight: i < 4 ? '1px solid var(--ink)' : 'none' }}>
                <div className="uppercase-label">{s[0]}</div>
                <div style={{ fontSize: 32, fontWeight: 700, fontFamily: 'var(--font-mono)', letterSpacing: '-0.04em', lineHeight: 1, marginTop: 4, color: s[2] || 'var(--ink)' }}>
                  {s[1]}
                </div>
              </div>
            ))}
          </div>
          {/* Two tables */}
          <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0, border: '1px solid var(--ink)', borderRight: 'none', minHeight: 0 }}>
            {[
              { title: 'BY DURATION', data: sampleWorkflows.slice().sort((a, b) => b[1] - a[1]), unit: (v) => `${v}s`, color: 'var(--info)' },
              { title: 'BY COST', data: sampleWorkflows.slice().sort((a, b) => b[2] - a[2]), unit: (v) => `$${v.toFixed(2)}`, color: 'var(--acc)' },
            ].map((tbl, ti) => (
              <div key={ti} style={{ display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--ink)', background: 'var(--bg-1)' }}>
                <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--ink)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg-2)' }}>
                  <div className="uppercase-label">{tbl.title}</div>
                  <Icon name="arrow-down" size={10} color="var(--ink-3)"/>
                </div>
                <div style={{ flex: 1, overflow: 'hidden' }}>
                  {tbl.data.slice(0, 12).map(([name, dur, cost, runs], i) => (
                    <div key={i} style={{ padding: '4px 10px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontFamily: 'var(--font-mono)' }}>
                      <span style={{ width: 16, color: 'var(--ink-4)' }}>{i + 1}</span>
                      <span style={{ flex: 1, color: 'var(--ink-2)' }} className="truncate">{name}</span>
                      <span style={{ color: tbl.color, fontWeight: 500 }}>{tbl.title === 'BY DURATION' ? tbl.unit(dur) : tbl.unit(cost)}</span>
                      <span style={{ width: 28, textAlign: 'right', color: 'var(--ink-3)' }}>{runs}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
        {/* Right column: detail rail */}
        <div style={{ width: 340, borderLeft: '1px solid var(--ink)', background: 'var(--bg-1)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--ink)', background: 'var(--bg-2)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="dot dot-run"/>
            <span className="uppercase-label">Live execution detail</span>
          </div>
          <div style={{ padding: 14, borderBottom: '1px solid var(--line)' }}>
            <div className="mono" style={{ fontSize: 11, color: 'var(--acc)' }}>98f364f2</div>
            <div style={{ fontSize: 14, fontWeight: 600, fontFamily: 'var(--font-mono)', marginTop: 2 }}>classification-judge</div>
            <div style={{ marginTop: 8, display: 'flex', gap: 12, fontSize: 11, fontFamily: 'var(--font-mono)' }}>
              <div><span style={{ color: 'var(--ink-3)' }}>elapsed </span>12.3s</div>
              <div><span style={{ color: 'var(--ink-3)' }}>cost </span>$0.04</div>
              <div><span style={{ color: 'var(--ink-3)' }}>tokens </span>14.2k</div>
            </div>
          </div>
          <div style={{ flex: 1, padding: 14, overflow: 'hidden', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
            <div className="uppercase-label" style={{ marginBottom: 8 }}>STREAM</div>
            {[
              ['12:42:18', 'agent', 'Reviewing 12 candidate categories…'],
              ['12:42:21', 'tool', 'mongodb.query → 412 rows'],
              ['12:42:24', 'agent', 'Computing similarity scores'],
              ['12:42:27', 'tool', 'opensearch.embed → ok'],
              ['12:42:30', 'agent', 'Top 3: Garden, Patio, Outdoor'],
              ['12:42:31', 'judge', 'consensus = Outdoor (0.91)'],
            ].map((r, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, padding: '3px 0', color: 'var(--ink-2)' }}>
                <span style={{ color: 'var(--ink-4)' }}>{r[0]}</span>
                <span style={{ color: r[1] === 'agent' ? 'var(--info)' : r[1] === 'judge' ? 'var(--acc)' : 'var(--ok)', width: 36 }}>{r[1]}</span>
                <span style={{ flex: 1 }}>{r[2]}</span>
              </div>
            ))}
          </div>
          <div style={{ padding: '10px 14px', borderTop: '1px solid var(--line)', display: 'flex', gap: 6 }}>
            <button className="btn btn-line" style={{ flex: 1 }}>Pause</button>
            <button className="btn btn-line" style={{ flex: 1 }}>Open</button>
            <button className="btn btn-primary" style={{ flex: 1 }}>Inspect</button>
          </div>
        </div>
      </div>
    </V3Frame>
  );
};

window.DashboardV1 = DashboardV1;
window.DashboardV2 = DashboardV2;
window.DashboardV3 = DashboardV3;
