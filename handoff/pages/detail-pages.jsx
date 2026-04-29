// detail-pages.jsx — Role Manager, Learnings, ExecutionDetail, WorkspaceDetail, PRDetail
// All 4 directions per page, kept compact

// =============================================================================
// ROLE MANAGER
// =============================================================================
const ROLES = [
  { id: 'owner', n: 'Owner', desc: 'Full access · billing · destroy', members: 1, color: '#dc2626' },
  { id: 'admin', n: 'Admin', desc: 'Manage users · workflows · agents', members: 2, color: '#5b4ae6' },
  { id: 'engineer', n: 'Engineer', desc: 'Build agents · run workflows · merge PRs', members: 3, color: '#0284c7' },
  { id: 'reviewer', n: 'Reviewer', desc: 'Approve interventions · view runs', members: 4, color: '#16794a' },
  { id: 'viewer', n: 'Viewer', desc: 'Read-only across the workspace', members: 6, color: '#837e72' },
];
const PERMS = [
  { c: 'Workflows', items: [['Create', [1,1,1,0,0]], ['Edit', [1,1,1,0,0]], ['Run', [1,1,1,1,0]], ['Delete', [1,1,0,0,0]]] },
  { c: 'Agents', items: [['Create', [1,1,1,0,0]], ['Edit prompt', [1,1,1,0,0]], ['Change model', [1,1,0,0,0]]] },
  { c: 'Repos', items: [['Connect', [1,1,1,0,0]], ['Open PR', [1,1,1,0,0]], ['Merge', [1,1,1,0,0]]] },
  { c: 'Interventions', items: [['Approve', [1,1,1,1,0]], ['Override', [1,1,0,0,0]]] },
  { c: 'Settings', items: [['Members', [1,1,0,0,0]], ['Billing', [1,0,0,0,0]], ['MCP servers', [1,1,0,0,0]]] },
];

const RoleManagerV4 = () => (
  <V4Frame active="dashboard" eyebrow="Workspace · Settings" title="Roles & permissions"
    crumbs={['SETTINGS', 'ROLES']} padded={false}
    actions={<><button className="btn btn-line"><Icon name="external" size={11}/>Audit log</button><button className="btn btn-primary"><Icon name="plus" size={11}/>New role</button></>}>
    <div style={{ display: 'flex', flex: 1, minHeight: 0, padding: '20px 32px 28px', gap: 18 }}>
      {/* Roles list */}
      <div style={{ width: 260, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {ROLES.map((r, i) => (
          <AuroraCard key={r.id} padded={false} style={{ padding: 14, border: i === 1 ? '1.5px solid var(--ink)' : '1px solid var(--line)', cursor: 'pointer' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: r.color }}/>
              <span style={{ fontWeight: 500, fontSize: 14 }}>{r.n}</span>
              <div style={{ flex: 1 }}/>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>{r.members}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.45 }}>{r.desc}</div>
          </AuroraCard>
        ))}
      </div>

      {/* Permission matrix */}
      <AuroraCard padded={false} style={{ flex: 1, padding: 0, overflow: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '220px repeat(5, 1fr)', position: 'sticky', top: 0, background: 'var(--bg-1)', borderBottom: '1px solid var(--line)' }}>
          <div style={{ padding: '14px 16px' }}>
            <div className="display" style={{ fontSize: 18 }}>Permissions</div>
            <div className="uppercase-label">{PERMS.reduce((s, c) => s + c.items.length, 0)} actions</div>
          </div>
          {ROLES.map(r => (
            <div key={r.id} style={{ padding: '16px 12px', textAlign: 'center', borderLeft: '1px solid var(--line)' }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: r.color, margin: '0 auto 6px' }}/>
              <div style={{ fontSize: 12.5, fontWeight: 500 }}>{r.n}</div>
            </div>
          ))}
        </div>
        {PERMS.map(c => (
          <div key={c.c}>
            <div className="uppercase-label" style={{ padding: '14px 16px 6px', background: 'var(--bg-2)' }}>{c.c}</div>
            {c.items.map(([n, vals]) => (
              <div key={n} style={{ display: 'grid', gridTemplateColumns: '220px repeat(5, 1fr)', borderBottom: '1px solid var(--line)' }}>
                <div style={{ padding: '10px 16px', fontSize: 13 }}>{n}</div>
                {vals.map((v, i) => (
                  <div key={i} style={{ padding: '10px 12px', textAlign: 'center', borderLeft: '1px solid var(--line)' }}>
                    {v ? <Icon name="check" size={14} color={ROLES[i].color}/> : <span style={{ color: 'var(--ink-4)', fontSize: 13 }}>—</span>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ))}
      </AuroraCard>
    </div>
  </V4Frame>
);

const RoleManagerV1 = () => (
  <V1Frame active="dashboard" crumbs={['ALLEN', 'CONFIG', 'ROLES']}
    actions={<button className="btn btn-primary mono" style={{fontSize:11}}>+ ROLE</button>}>
    <div style={{ flex: 1, padding: 16, overflow: 'auto', fontFamily: 'var(--font-mono)' }}>
      <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.06em', marginBottom: 8 }}>RBAC.MATRIX / 5 ROLES · 16 ACTIONS · 16 USERS</div>
      <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '180px repeat(5, 1fr)', borderBottom: '1px solid var(--line)', background: 'var(--bg-2)' }}>
          <div style={{ padding: '8px 12px', fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.08em' }}>ACTION</div>
          {ROLES.map(r => (
            <div key={r.id} style={{ padding: '8px 12px', fontSize: 10.5, color: 'var(--ink-2)', borderLeft: '1px solid var(--line)', textAlign: 'center' }}>
              {r.n.toUpperCase()}<span style={{ color: 'var(--ink-3)', marginLeft: 4 }}>·{r.members}</span>
            </div>
          ))}
        </div>
        {PERMS.flatMap(c => c.items.map(([n, vals], j) => (
          <div key={`${c.c}-${n}`} style={{ display: 'grid', gridTemplateColumns: '180px repeat(5, 1fr)', borderBottom: '1px solid var(--line)' }}>
            <div style={{ padding: '6px 12px', fontSize: 11.5, color: j === 0 ? 'var(--ink)' : 'var(--ink-2)' }}>
              <span style={{ color: 'var(--ink-3)' }}>{j === 0 ? c.c.toLowerCase() + '.' : <span style={{ opacity: 0 }}>{c.c.toLowerCase() + '.'}</span>}</span>{n.toLowerCase()}
            </div>
            {vals.map((v, i) => (
              <div key={i} style={{ padding: '6px 12px', textAlign: 'center', borderLeft: '1px solid var(--line)', fontSize: 12, color: v ? 'var(--ok)' : 'var(--ink-4)' }}>
                {v ? '✓' : '·'}
              </div>
            ))}
          </div>
        )))}
      </div>
    </div>
  </V1Frame>
);

const RoleManagerV2 = () => (
  <V2Frame active="dashboard" title="Roles & permissions" crumbs={['Settings', 'Roles']}
    tabs={[{ label: 'Roles', active: true, count: 5 }, { label: 'Members', count: 16 }, { label: 'Audit log' }]}>
    <div style={{ flex: 1, padding: '16px 24px', overflow: 'auto' }}>
      <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--line)', background: 'var(--bg-2)' }}>
              <th style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 500, color: 'var(--ink-3)' }}>Permission</th>
              {ROLES.map(r => (
                <th key={r.id} style={{ padding: '10px 8px', textAlign: 'center', fontSize: 11, color: 'var(--ink-3)' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: r.color }}/>{r.n}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PERMS.flatMap(c => [
              <tr key={c.c} style={{ background: 'var(--bg-2)' }}><td colSpan={6} style={{ padding: '7px 14px', fontSize: 11, color: 'var(--ink-3)', fontWeight: 500 }}>{c.c}</td></tr>,
              ...c.items.map(([n, vals]) => (
                <tr key={`${c.c}-${n}`} style={{ borderBottom: '1px solid var(--line)' }}>
                  <td style={{ padding: '8px 14px' }}>{n}</td>
                  {vals.map((v, i) => (
                    <td key={i} style={{ padding: '8px', textAlign: 'center' }}>
                      {v ? <Icon name="check" size={13} color={ROLES[i].color}/> : <span style={{ color: 'var(--ink-4)' }}>—</span>}
                    </td>
                  ))}
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>
    </div>
  </V2Frame>
);

const RoleManagerV3 = () => (
  <V3Frame active="dashboard" title="Roles" subtitle="Access control · 5 roles · 16 users" count="5 ROLES"
    actions={<button className="btn btn-primary mono" style={{fontSize:11}}>NEW ROLE</button>}>
    <div style={{ flex: 1, overflow: 'auto', padding: 0 }}>
      <table className="mono" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
        <thead>
          <tr style={{ borderBottom: '2px solid var(--ink)', background: 'var(--bg-1)' }}>
            <th style={{ padding: '8px 14px', textAlign: 'left', fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.06em' }}>ACTION</th>
            {ROLES.map(r => (
              <th key={r.id} style={{ padding: '8px', textAlign: 'center', fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.06em' }}>
                {r.n.toUpperCase()}<br/><span style={{ color: 'var(--ink-3)', fontWeight: 400 }}>n={r.members}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {PERMS.flatMap(c => c.items.map(([n, vals]) => (
            <tr key={`${c.c}-${n}`} style={{ borderBottom: '1px solid var(--line)' }}>
              <td style={{ padding: '6px 14px' }}><span style={{ color: 'var(--ink-3)' }}>{c.c.toLowerCase()}.</span>{n.toLowerCase().replace(' ', '_')}</td>
              {vals.map((v, i) => (
                <td key={i} style={{ padding: '6px', textAlign: 'center', color: v ? ROLES[i].color : 'var(--ink-4)', fontWeight: v ? 700 : 400 }}>{v ? 'YES' : '—'}</td>
              ))}
            </tr>
          )))}
        </tbody>
      </table>
    </div>
  </V3Frame>
);

// =============================================================================
// LEARNINGS
// =============================================================================
const LEARNINGS = [
  { id: 'L-148', title: 'Refund agent should escalate orders > 30 days old', cat: 'agent.refund', conf: 0.94, used: 23, src: 'intervention #1284', age: '3h ago' },
  { id: 'L-147', title: 'CodeRabbit comments tagged "nitpick" can be auto-resolved', cat: 'workflow.coderabbit', conf: 0.89, used: 156, src: 'pattern detection', age: '1d ago' },
  { id: 'L-146', title: 'Use shopify.find_order before refund — saves a tool call', cat: 'agent.refund', conf: 0.97, used: 89, src: 'eval analysis', age: '2d ago' },
  { id: 'L-145', title: 'Linear issues with no description need clarifying question', cat: 'agent.triage', conf: 0.81, used: 34, src: 'intervention #1276', age: '4d ago' },
  { id: 'L-144', title: 'Bundle PR review and merge into one workflow when CodeRabbit passes', cat: 'workflow', conf: 0.92, used: 67, src: 'pattern detection', age: '1w ago' },
  { id: 'L-143', title: 'Avoid running migrations during US business hours', cat: 'system', conf: 0.99, used: 12, src: 'incident postmortem', age: '2w ago' },
];

const LearningsV4 = () => (
  <V4Frame active="learnings" eyebrow="Allen learns from every run" title="Learnings"
    crumbs={['MONITOR', 'LEARNINGS']}
    actions={<><button className="btn btn-line"><Icon name="filter" size={11}/>Category</button><button className="btn btn-line"><Icon name="download" size={11}/>Export</button></>}>
    <div style={{ display: 'flex', gap: 18, flex: 1, minHeight: 0 }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14, overflow: 'auto' }}>
        {/* hero summary */}
        <AuroraCard padded style={{ padding: 22, background: 'linear-gradient(135deg, var(--bg-1), var(--acc-dim))' }}>
          <div style={{ display: 'flex', gap: 28 }}>
            <AuroraStat label="Active learnings" value="148" sub="across 12 workflows" big/>
            <div style={{ width: 1, background: 'var(--line)' }}/>
            <AuroraStat label="Applied this week" value="892" delta="+34%" deltaDir="up" sub="vs prior week"/>
            <div style={{ width: 1, background: 'var(--line)' }}/>
            <AuroraStat label="Confidence avg" value="0.91" sub="across all categories"/>
          </div>
        </AuroraCard>

        {LEARNINGS.map((l, i) => (
          <AuroraCard key={l.id} padded style={{ padding: 18, border: i === 0 ? '1.5px solid var(--acc)' : '1px solid var(--line)' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--acc-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Icon name="sparkle" size={16} color="var(--acc)"/>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                  <AuroraTag>{l.id}</AuroraTag>
                  <AuroraTag>{l.cat}</AuroraTag>
                  <AuroraPill tone={l.conf > 0.9 ? 'ok' : 'idle'}>conf {l.conf.toFixed(2)}</AuroraPill>
                  <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>· {l.age} · from {l.src}</span>
                </div>
                <div className="display" style={{ fontSize: 18, lineHeight: 1.3, marginBottom: 6 }}>{l.title}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 12, color: 'var(--ink-3)' }}>
                  <span>Applied {l.used}× since creation</span>
                  <span>·</span>
                  <a style={{ color: 'var(--acc)' }}>View source intervention →</a>
                  <div style={{ flex: 1 }}/>
                  <button className="btn btn-line" style={{ fontSize: 11, padding: '4px 10px' }}>Edit</button>
                  <button className="btn btn-line" style={{ fontSize: 11, padding: '4px 10px' }}>Disable</button>
                </div>
              </div>
            </div>
          </AuroraCard>
        ))}
      </div>

      <div style={{ width: 280, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <AuroraCard padded style={{ padding: 16 }}>
          <div className="uppercase-label" style={{ marginBottom: 10 }}>By category</div>
          {[
            ['agent.refund', 42, '#5b4ae6'],
            ['workflow.coderabbit', 28, '#0284c7'],
            ['agent.triage', 23, '#16794a'],
            ['workflow', 19, '#b45309'],
            ['system', 12, '#837e72'],
          ].map(([n, c, color]) => (
            <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }}/>
              <span style={{ flex: 1, fontSize: 12.5 }}>{n}</span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>{c}</span>
            </div>
          ))}
        </AuroraCard>
        <AuroraCard padded style={{ padding: 16 }}>
          <div className="uppercase-label" style={{ marginBottom: 10 }}>This week</div>
          <div style={{ fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.55 }}>
            <span className="display" style={{ fontSize: 26 }}>+12</span> new learnings, <span className="display" style={{ fontSize: 26 }}>3</span> superseded older ones, and <span className="display" style={{ fontSize: 26 }}>2</span> were rejected after review.
          </div>
        </AuroraCard>
      </div>
    </div>
  </V4Frame>
);

const LearningsV1 = () => (
  <V1Frame active="learnings" crumbs={['ALLEN', 'MONITOR', 'LEARNINGS']}
    actions={<><span className="mono" style={{fontSize:10,color:'var(--ink-3)'}}>148 ACTIVE · 12 NEW THIS WK</span><button className="btn btn-line mono" style={{fontSize:11}}>EXPORT</button></>}>
    <div style={{ flex: 1, padding: 14, overflow: 'auto', fontFamily: 'var(--font-mono)' }}>
      <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.06em', marginBottom: 8 }}>LEARNINGS / SORT: AGE DESC / CONF &gt; 0.7</div>
      {LEARNINGS.map((l, i) => (
        <div key={l.id} style={{ display: 'grid', gridTemplateColumns: '60px 110px 1fr 80px 60px 90px', gap: 12, padding: '8px 12px', fontSize: 11.5, borderBottom: '1px solid var(--line)', alignItems: 'center', background: i === 0 ? 'color-mix(in srgb, var(--acc) 5%, transparent)' : 'transparent' }}>
          <span style={{ color: 'var(--acc)' }}>{l.id}</span>
          <span style={{ color: 'var(--ink-3)' }}>{l.cat}</span>
          <span style={{ color: 'var(--ink)' }}>{l.title}</span>
          <span style={{ color: l.conf > 0.9 ? 'var(--ok)' : 'var(--warn)' }}>conf {l.conf.toFixed(2)}</span>
          <span style={{ color: 'var(--ink-2)', textAlign: 'right' }}>{l.used}×</span>
          <span style={{ color: 'var(--ink-3)', fontSize: 10, textAlign: 'right' }}>{l.age}</span>
        </div>
      ))}
    </div>
  </V1Frame>
);

const LearningsV2 = () => (
  <V2Frame active="learnings" title="Learnings" crumbs={['Monitor', 'Learnings']}
    tabs={[{label:'All', active:true, count:148},{label:'New', count:12},{label:'Disabled', count:6}]}
    actions={<button className="btn btn-line"><Icon name="filter" size={11}/>Filter</button>}>
    <div style={{ flex: 1, padding: '14px 24px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {LEARNINGS.map((l, i) => (
        <div key={l.id} style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, padding: 14, display: 'flex', gap: 12 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--acc-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name="sparkle" size={13} color="var(--acc)"/>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
              <span style={{ fontSize: 11, color: 'var(--ink-3)', fontFamily: 'var(--font-mono)' }}>{l.id}</span>
              <span className="chip">{l.cat}</span>
              <span className="pill pill-ok">conf {l.conf.toFixed(2)}</span>
              <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>· {l.age}</span>
            </div>
            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 2 }}>{l.title}</div>
            <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>Applied {l.used}× · from {l.src}</div>
          </div>
        </div>
      ))}
    </div>
  </V2Frame>
);

const LearningsV3 = () => (
  <V3Frame active="learnings" title="Learnings" subtitle="What Allen has learned" count="148 ACTIVE"
    actions={<button className="btn btn-line mono" style={{fontSize:11}}>EXPORT CSV</button>}>
    <div style={{ flex: 1, overflow: 'auto' }}>
      <table className="mono" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
        <thead>
          <tr style={{ borderBottom: '2px solid var(--ink)', color: 'var(--ink-3)', fontSize: 10, letterSpacing: '0.06em', background: 'var(--bg-1)' }}>
            <th style={{ padding: '8px 14px', textAlign: 'left' }}>ID</th>
            <th style={{ padding: '8px 14px', textAlign: 'left' }}>CATEGORY</th>
            <th style={{ padding: '8px 14px', textAlign: 'left' }}>STATEMENT</th>
            <th style={{ padding: '8px 14px', textAlign: 'right' }}>CONF</th>
            <th style={{ padding: '8px 14px', textAlign: 'right' }}>USED</th>
            <th style={{ padding: '8px 14px', textAlign: 'left' }}>SOURCE</th>
            <th style={{ padding: '8px 14px', textAlign: 'right' }}>AGE</th>
          </tr>
        </thead>
        <tbody>
          {LEARNINGS.map(l => (
            <tr key={l.id} style={{ borderBottom: '1px solid var(--line)' }}>
              <td style={{ padding: '7px 14px', color: 'var(--acc)', fontWeight: 500 }}>{l.id}</td>
              <td style={{ padding: '7px 14px', color: 'var(--ink-3)' }}>{l.cat}</td>
              <td style={{ padding: '7px 14px' }}>{l.title}</td>
              <td style={{ padding: '7px 14px', textAlign: 'right', color: l.conf > 0.9 ? 'var(--ok)' : 'var(--warn)' }}>{l.conf.toFixed(2)}</td>
              <td style={{ padding: '7px 14px', textAlign: 'right' }}>{l.used}</td>
              <td style={{ padding: '7px 14px', color: 'var(--ink-3)' }}>{l.src}</td>
              <td style={{ padding: '7px 14px', textAlign: 'right', color: 'var(--ink-3)' }}>{l.age}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </V3Frame>
);

Object.assign(window, { RoleManagerV1, RoleManagerV2, RoleManagerV3, RoleManagerV4, LearningsV1, LearningsV2, LearningsV3, LearningsV4 });
