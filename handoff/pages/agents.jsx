// agents.jsx — Agents & Teams page

const teams = [
  { name: 'Data Acquisition', members: 11, lead: 'Data Acquisition', color: '#5eead4' },
  { name: 'Data Pipeline', members: 7, lead: 'Data Pipeline', color: '#22d3ee' },
  { name: 'Data Quality', members: 22, lead: 'Data Quality', color: '#818cf8' },
  { name: 'Engineering', members: 14, lead: 'Engineering Lead', color: '#f472b6' },
  { name: 'Executive', members: 1, lead: 'CEO', color: '#fbbf24' },
  { name: 'Meta — Builders', members: 6, lead: 'Team Builder', color: '#a78bfa' },
  { name: 'Operations', members: 26, lead: 'Operations', color: '#34d399' },
  { name: 'Product', members: 5, lead: 'Product Manager', color: '#fb7185' },
  { name: 'Product Strategy', members: 27, lead: 'Product Strategy', color: '#60a5fa' },
  { name: 'Quality', members: 4, lead: 'QA Lead', color: '#fbbf24' },
  { name: 'Search & Catalog', members: 9, lead: 'Search Catalog', color: '#22d3ee' },
  { name: 'Shared Services', members: 17, lead: 'Shared Services', color: '#a78bfa' },
];

const agentsByTeam = {
  'Data Acquisition': ['New Product Discover', 'Pagination Specialist', 'Scraped Data Validator', 'Search Query Optimizer', 'Search Query Optimizer Judge', 'Vendor Category Mapper', 'Vendor Rule Healer', 'Vendor Rule Healer Judge', 'Vendor Rule Onboarder', 'Vendor Rule Onboarder Judge'],
  'Data Pipeline': ['Extraction Quality Evaluator', 'Extraction Quality Evaluator Judge', 'Prompt Tuner', 'Prompt Tuner Judge', 'Variant Scraped Data Validator', 'Variant Scraped Data Validator Judge'],
  'Data Quality': ['Brand Dedup Detector', 'Classification Judge', 'Cross Category Analyzer', 'Data Reporter', 'Data Reporter Judge', 'Execution Reviewer', 'Failure Analyst', 'Field Completeness Analyzer', 'Field Completeness Analyzer Judge', 'Grouping Quality Evaluator', 'Grouping Quality Evaluator Judge', 'Quality Analysis Orchestrator', 'Quality Investigator', 'Quality Investigator Judge', 'Quality Patrol', 'Quality Patrol Judge', 'Rejection Pattern Analyzer'],
};

// V1 — Mission Control (org-graph + sidebar)
const AgentsV1 = () => (
  <V1Frame active="agents" crumbs={['Build', 'Agents & Teams']}
    actions={<>
      <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>149 AGENTS · 13 TEAMS</span>
      <button className="btn btn-primary"><Icon name="plus" size={11}/> NEW</button>
    </>}>
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      <div style={{ width: 240, borderRight: '1px solid var(--line)', background: 'var(--bg-1)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon name="search" size={11} color="var(--ink-3)"/>
          <span style={{ fontSize: 11, color: 'var(--ink-3)', fontFamily: 'var(--font-mono)' }}>filter agents…</span>
        </div>
        <div style={{ padding: '6px 12px', background: 'color-mix(in srgb, var(--acc) 8%, transparent)', borderLeft: '2px solid var(--acc)', fontSize: 11.5 }}>
          <div className="mono" style={{ color: 'var(--acc)' }}>Overview</div>
        </div>
        <div className="uppercase-label" style={{ padding: '8px 12px 4px' }}>TEAMS</div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          {teams.map((t, i) => (
            <div key={i} style={{ padding: '5px 12px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, cursor: 'pointer', borderBottom: '1px solid var(--line)' }}>
              <div style={{ width: 8, height: 8, borderRadius: 2, background: t.color }}/>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="mono" style={{ color: 'var(--ink-2)' }}>{t.name}</div>
                <div style={{ fontSize: 10, color: 'var(--ink-3)' }}>{t.members} · {t.lead}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, padding: 14, display: 'flex', flexDirection: 'column', gap: 12, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          {[['AGENTS', '149', 'var(--acc)'], ['TEAMS', '13', 'var(--info)'], ['ASSIGNED', '149', 'var(--ok)'], ['UNASSIGNED', '0', 'var(--warn)']].map((s, i) => (
            <div key={i} style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 4, padding: '10px 14px' }}>
              <div className="uppercase-label">{s[0]}</div>
              <div className="mono" style={{ fontSize: 26, fontWeight: 600, color: s[2], marginTop: 2, letterSpacing: '-0.02em' }}>{s[1]}</div>
            </div>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {[['PROVIDERS', [['claude-cli', 149]]], ['MODELS', [['sonnet', 138, '#5eead4'], ['opus', 17, '#fbbf24'], ['haiku', 2, '#818cf8']]]].map((c, i) => (
            <div key={i} style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 4, padding: 12 }}>
              <div className="uppercase-label" style={{ marginBottom: 6 }}>{c[0]}</div>
              {c[1].map((row, j) => (
                <div key={j} style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 12, padding: '2px 0' }}>
                  {row[2] && <div style={{ width: 8, height: 8, borderRadius: 2, background: row[2] }}/>}
                  <span style={{ flex: 1, color: row[2] || 'var(--acc)' }}>{row[0]}</span>
                  <span style={{ color: 'var(--ink-2)' }}>{row[1]}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 4, flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="flow" size={11} color="var(--acc)"/>
            <span className="uppercase-label">DELEGATION GRAPH</span>
            <span style={{ flex: 1 }}/>
            <span style={{ fontSize: 10, color: 'var(--ink-3)', fontFamily: 'var(--font-mono)' }}>13 departments · 149 people</span>
          </div>
          <div style={{ flex: 1, overflow: 'hidden', padding: '8px 12px' }}>
            {Object.entries(agentsByTeam).slice(0, 3).map(([team, agents], i) => (
              <div key={i} style={{ paddingBottom: 8, marginBottom: 8, borderBottom: '1px solid var(--line)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                  <Icon name="people" size={11} color="var(--acc)"/>
                  <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>{team}</span>
                  <span style={{ fontSize: 10, color: 'var(--ink-3)' }}>{agents.length}</span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {agents.slice(0, 7).map((a, j) => (
                    <span key={j} className="chip" style={{ fontSize: 10 }}>● {a}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  </V1Frame>
);

// V2 — Linear-clean: people-directory style
const AgentsV2 = () => (
  <V2Frame active="agents" title="Agents" crumbs={['Build', 'Agents']}
    actions={<>
      <button className="btn btn-line"><Icon name="filter" size={12}/> All teams</button>
      <button className="btn btn-primary"><Icon name="plus" size={12}/> New agent</button>
    </>}
    tabs={[{ label: 'Directory', active: true }, { label: 'Teams', count: 13 }, { label: 'Delegation graph' }, { label: 'Models' }]}>
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <div style={{ width: 220, borderRight: '1px solid var(--line)', padding: '12px 16px' }}>
        <div className="uppercase-label" style={{ marginBottom: 8 }}>TEAMS</div>
        {teams.slice(0, 10).map((t, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderRadius: 6, marginBottom: 1, fontSize: 12.5, background: i === 2 ? 'var(--bg-2)' : 'transparent', cursor: 'pointer' }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: t.color }}/>
            <span style={{ flex: 1, color: i === 2 ? 'var(--ink)' : 'var(--ink-2)', fontWeight: i === 2 ? 500 : 400 }} className="truncate">{t.name}</span>
            <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>{t.members}</span>
          </div>
        ))}
      </div>
      <div style={{ flex: 1, padding: '20px 24px', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
          <h2 style={{ fontSize: 16, margin: 0, fontWeight: 600 }}>Data Quality</h2>
          <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>22 members · led by QA Lead</span>
          <span style={{ flex: 1 }}/>
          <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>Data analysis, failure investigation, rejection patterns, field completeness, and cross-category integrity.</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          {agentsByTeam['Data Quality'].slice(0, 12).map((a, i) => (
            <div key={i} style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 30, height: 30, borderRadius: 8, background: 'linear-gradient(135deg, var(--acc), #06b6d4)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
                {a.split(' ').map(w => w[0]).slice(0, 2).join('')}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 500 }} className="truncate">{a}</div>
                <div style={{ fontSize: 11, color: 'var(--ink-3)' }} className="mono">sonnet · 4 runs/day</div>
              </div>
              <span className="dot dot-ok"/>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 18, fontSize: 13, fontWeight: 600, color: 'var(--ink-2)' }}>Engineering · 14 members</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 8 }}>
          {['Frontend Developer', 'Backend Developer', 'Engineering Lead', 'Code Reviewer', 'Architect', 'DevOps Engineer'].map((a, i) => (
            <div key={i} style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 30, height: 30, borderRadius: 8, background: 'linear-gradient(135deg, #f472b6, #fb7185)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
                {a.split(' ').map(w => w[0]).slice(0, 2).join('')}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12.5, fontWeight: 500 }} className="truncate">{a}</div>
                <div style={{ fontSize: 11, color: 'var(--ink-3)' }} className="mono">opus · 12 runs/day</div>
              </div>
              <span className="dot dot-ok"/>
            </div>
          ))}
        </div>
      </div>
    </div>
  </V2Frame>
);

// V3 — Operator: org-graph as ASCII tree
const AgentsV3 = () => (
  <V3Frame active="agents" title="Agents & Teams" subtitle="org · delegation · models" count="149 / 13"
    actions={<>
      <button className="btn btn-line mono">VIEW: ORG TREE</button>
      <button className="btn btn-line mono">EXPORT GRAPH</button>
      <button className="btn btn-primary mono">+ AGENT</button>
    </>}>
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <div style={{ flex: 1, padding: 16, overflow: 'hidden', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.7 }}>
        <div style={{ background: 'var(--bg-1)', border: '1px solid var(--ink)', padding: 16, height: '100%', overflow: 'hidden' }}>
          <div style={{ borderBottom: '1px dashed var(--ink)', paddingBottom: 6, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: 'var(--acc)', fontWeight: 600 }}>┌─ inomy/main</span>
            <span style={{ color: 'var(--ink-3)' }}>149 agents · 13 teams</span>
          </div>
          {teams.slice(0, 6).map((t, i) => {
            const list = agentsByTeam[t.name] || [`${t.lead}`, `${t.lead} Judge`, '+8 more'];
            return (
              <div key={i} style={{ marginBottom: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: 'var(--ink-3)' }}>├─</span>
                  <div style={{ width: 8, height: 8, background: t.color }}/>
                  <span style={{ fontWeight: 600 }}>{t.name}</span>
                  <span style={{ color: 'var(--ink-3)' }}>· {t.members} ·</span>
                  <span style={{ color: 'var(--acc)' }}>{t.lead}</span>
                </div>
                <div style={{ paddingLeft: 24, color: 'var(--ink-2)', fontSize: 11.5 }}>
                  <span style={{ color: 'var(--ink-3)' }}>│  └─ </span>
                  {list.slice(0, 6).join(' · ')}
                  {list.length > 6 && <span style={{ color: 'var(--ink-3)' }}> · +{list.length - 6}</span>}
                </div>
              </div>
            );
          })}
          <div style={{ color: 'var(--ink-3)' }}>└─ ... 7 more teams</div>
        </div>
      </div>
      <div style={{ width: 300, borderLeft: '1px solid var(--ink)', background: 'var(--bg-1)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--ink)', background: 'var(--bg-2)' }}>
          <div className="uppercase-label">MODEL DISTRIBUTION</div>
        </div>
        {[['sonnet', 138, 'var(--info)'], ['opus', 17, 'var(--warn)'], ['haiku', 2, 'var(--acc)']].map((m, i) => (
          <div key={i} style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', fontFamily: 'var(--font-mono)', fontSize: 13 }}>
              <span style={{ color: m[2], flex: 1, fontWeight: 600 }}>{m[0]}</span>
              <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.02em' }}>{m[1]}</span>
            </div>
            <div style={{ height: 4, background: 'var(--bg-2)', marginTop: 6, border: '1px solid var(--line)' }}>
              <div style={{ width: `${(m[1] / 157) * 100}%`, height: '100%', background: m[2] }}/>
            </div>
          </div>
        ))}
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--ink)', background: 'var(--bg-2)', marginTop: 4 }}>
          <div className="uppercase-label">PROVIDERS</div>
        </div>
        <div style={{ padding: '10px 14px', fontFamily: 'var(--font-mono)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="dot dot-ok"/>
          <span style={{ color: 'var(--acc)', flex: 1 }}>claude-cli</span>
          <span style={{ fontWeight: 600 }}>149</span>
        </div>
        <div style={{ flex: 1 }}/>
        <div style={{ padding: '10px 14px', borderTop: '1px solid var(--ink)', background: 'var(--bg-2)', display: 'flex', gap: 4 }}>
          <button className="btn btn-line mono" style={{ flex: 1 }}>+ TEAM</button>
          <button className="btn btn-primary mono" style={{ flex: 1 }}>+ AGENT</button>
        </div>
      </div>
    </div>
  </V3Frame>
);

window.AgentsV1 = AgentsV1; window.AgentsV2 = AgentsV2; window.AgentsV3 = AgentsV3;
