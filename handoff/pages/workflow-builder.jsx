// workflow-builder.jsx — Visual workflow editor, four directions

// =============================================================================
// V4 — Aurora: editorial node graph with right inspector
// =============================================================================
const WorkflowBuilderV4 = () => {
  return (
    <V4Frame
      active="workflows"
      eyebrow="Workflow editor"
      title="Refund · CodeRabbit resolve"
      crumbs={['WORKFLOWS', 'REFUND-CODERABBIT-RESOLVE']}
      padded={false}
      actions={<>
        <button className="btn btn-line">Test run</button>
        <button className="btn btn-line"><Icon name="github" size={11}/>v4 · 2 days ago</button>
        <button className="btn btn-primary">Save & publish</button>
      </>}
    >
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* node palette */}
        <div style={{ width: 200, borderRight: '1px solid var(--line)', padding: '20px 16px', flexShrink: 0, background: 'var(--bg-1)' }}>
          <div className="uppercase-label" style={{ marginBottom: 10 }}>Nodes</div>
          {[
            { g: 'Trigger', items: [['Linear', 'linear'], ['Schedule', 'clock'], ['Webhook', 'globe']] },
            { g: 'Logic', items: [['If/else', 'flow'], ['Switch', 'flow'], ['Loop', 'refresh']] },
            { g: 'Agents', items: [['Run agent', 'people'], ['Tool call', 'mcp']] },
            { g: 'Code', items: [['Open PR', 'merge'], ['CodeRabbit', 'github']] },
            { g: 'Human', items: [['Approval', 'check'], ['Question', 'help']] },
          ].map((g, i) => (
            <div key={i} style={{ marginBottom: 14 }}>
              <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{g.g}</div>
              {g.items.map(([name, icon]) => (
                <div key={name} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
                  borderRadius: 8, fontSize: 12.5, color: 'var(--ink-2)', cursor: 'grab',
                  background: 'var(--bg-2)', marginBottom: 3,
                }}>
                  <Icon name={icon} size={11} color="var(--ink-3)"/>{name}
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* canvas */}
        <div style={{ flex: 1, position: 'relative', background:
          'radial-gradient(circle at 20px 20px, rgba(28,26,23,0.06) 1px, transparent 1px) 0 0/24px 24px, var(--bg)' }}>
          {/* nodes */}
          {[
            { id: 'trigger', x: 60, y: 80, t: 'Linear webhook', s: 'On issue tagged "refund"', icon: 'linear', color: '#5b4ae6' },
            { id: 'classify', x: 60, y: 220, t: 'Classify intent', s: 'GPT-4o · classify', icon: 'sparkle', color: '#5b4ae6' },
            { id: 'switch', x: 60, y: 360, t: 'Switch by category', s: '3 paths', icon: 'flow', color: '#837e72' },
            { id: 'agent1', x: 360, y: 280, t: 'Refund agent', s: 'Sonnet 4 · shopify tools', icon: 'people', color: '#5b4ae6' },
            { id: 'approval', x: 360, y: 420, t: 'Human approval', s: 'If amount > $200', icon: 'help', color: '#b45309' },
            { id: 'agent2', x: 660, y: 360, t: 'Issue refund', s: 'shopify.refund_order', icon: 'mcp', color: '#16794a' },
            { id: 'pr', x: 660, y: 480, t: 'Comment & close', s: 'linear.update', icon: 'merge', color: '#16794a' },
          ].map(n => (
            <div key={n.id} style={{
              position: 'absolute', left: n.x, top: n.y, width: 240,
              background: 'var(--bg-1)', border: `1px solid ${n.id === 'agent1' ? 'var(--acc)' : 'var(--line)'}`,
              borderRadius: 12, padding: 12, boxShadow: n.id === 'agent1' ? '0 0 0 4px rgba(91,74,230,0.12)' : '0 1px 3px rgba(0,0,0,0.04)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <div style={{ width: 22, height: 22, borderRadius: 6, background: `${n.color}22`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name={n.icon} size={11} color={n.color}/>
                </div>
                <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{n.t}</span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--ink-3)', paddingLeft: 30 }}>{n.s}</div>
            </div>
          ))}
          {/* edges */}
          <svg style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} width="100%" height="100%">
            <defs>
              <marker id="arr4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M0,0 L10,5 L0,10 z" fill="var(--ink-3)"/>
              </marker>
            </defs>
            {[
              ['M180,140 L180,220'],
              ['M180,290 L180,360'],
              ['M300,420 C400,420 360,360 360,360'],
              ['M300,440 C400,440 360,420 360,420'],
              ['M300,460 C420,500 360,500 360,500'],
              ['M600,330 C660,330 660,360 660,360'],
              ['M600,470 C660,470 660,500 660,500'],
            ].map((d, i) => (
              <path key={i} d={d[0]} stroke="var(--ink-3)" strokeWidth="1.5" fill="none" markerEnd="url(#arr4)" strokeDasharray={i === 4 ? '4 3' : null}/>
            ))}
          </svg>

          {/* zoom controls */}
          <div style={{ position: 'absolute', bottom: 16, left: 16, display: 'flex', gap: 4, padding: 4, background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 99 }}>
            {['−', '100%', '+'].map((t, i) => (
              <div key={i} style={{ padding: '4px 10px', fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--ink-2)', cursor: 'pointer', borderRadius: 99 }}>{t}</div>
            ))}
          </div>
        </div>

        {/* inspector */}
        <div style={{ width: 320, borderLeft: '1px solid var(--line)', flexShrink: 0, background: 'var(--bg-1)', padding: '20px 18px', overflow: 'auto' }}>
          <div className="mono" style={{ fontSize: 10, color: 'var(--acc)', letterSpacing: '0.1em', marginBottom: 4 }}>SELECTED · NODE</div>
          <div className="display" style={{ fontSize: 22, marginBottom: 14, lineHeight: 1.1 }}>Refund agent</div>

          <AuroraPill tone="run" dot>RUNNING IN 3 LIVE WORKFLOWS</AuroraPill>

          <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <div className="uppercase-label" style={{ marginBottom: 6 }}>Agent</div>
              <div style={{ padding: '8px 12px', borderRadius: 8, background: 'var(--bg-2)', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <div style={{ width: 22, height: 22, borderRadius: 6, background: 'linear-gradient(135deg,#f59e0b,#dc2626)' }}/>
                <span style={{ flex: 1 }}>refund-specialist</span>
                <Icon name="chevron-down" size={11} color="var(--ink-3)"/>
              </div>
            </div>
            <div>
              <div className="uppercase-label" style={{ marginBottom: 6 }}>Model</div>
              <div style={{ padding: '8px 12px', borderRadius: 8, background: 'var(--bg-2)', fontSize: 13 }}>claude-sonnet-4 · 200k ctx</div>
            </div>
            <div>
              <div className="uppercase-label" style={{ marginBottom: 6 }}>System prompt</div>
              <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--bg-2)', fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.5, fontFamily: 'var(--font-mono)' }}>
                You are a refund specialist for Inomy. Use shopify tools to issue refunds up to $200 without approval; escalate above…
              </div>
            </div>
            <div>
              <div className="uppercase-label" style={{ marginBottom: 6 }}>Tools enabled</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {['shopify.refund_order', 'shopify.find_order', 'linear.add_comment', 'slack.dm'].map(t => (
                  <AuroraTag key={t}>{t}</AuroraTag>
                ))}
              </div>
            </div>
            <div>
              <div className="uppercase-label" style={{ marginBottom: 6 }}>Timeout</div>
              <div style={{ padding: '8px 12px', borderRadius: 8, background: 'var(--bg-2)', fontSize: 13, fontFamily: 'var(--font-mono)' }}>5m 00s</div>
            </div>
            <div>
              <div className="uppercase-label" style={{ marginBottom: 6 }}>On error</div>
              <div style={{ display: 'flex', gap: 4 }}>
                {['Retry', 'Skip', 'Fail'].map((o, i) => (
                  <div key={o} style={{ flex: 1, padding: '6px', textAlign: 'center', fontSize: 11.5, borderRadius: 6,
                    background: i === 0 ? 'var(--ink)' : 'var(--bg-2)', color: i === 0 ? '#fff' : 'var(--ink-2)', cursor: 'pointer' }}>{o}</div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </V4Frame>
  );
};

// =============================================================================
// V1 — Mission Control: dense node graph terminal
// =============================================================================
const WorkflowBuilderV1 = () => (
  <V1Frame active="workflows" crumbs={['ALLEN', 'WORKFLOWS', 'refund-coderabbit-resolve', 'EDIT']}
    actions={<>
      <button className="btn btn-line mono" style={{fontSize:11}}><Icon name="play" size={10}/>TEST</button>
      <button className="btn btn-ghost mono" style={{fontSize:11}}>v4 · 2d</button>
      <button className="btn btn-primary mono" style={{fontSize:11}}>SAVE & DEPLOY</button>
    </>}>
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <div style={{ width: 180, borderRight: '1px solid var(--line)', padding: '8px 0', flexShrink: 0 }}>
        <div className="mono" style={{ padding: '4px 14px', fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.08em' }}>NODES</div>
        {[
          ['TRIGGERS', ['linear.webhook', 'cron', 'http']],
          ['LOGIC', ['if', 'switch', 'loop', 'parallel']],
          ['AGENTS', ['agent.run', 'tool.call']],
          ['CODE', ['repo.pr.open', 'pr.coderabbit']],
          ['HUMAN', ['hil.approve', 'hil.ask']],
        ].map(([g, items]) => (
          <div key={g} style={{ marginBottom: 8 }}>
            <div className="mono" style={{ padding: '4px 14px', fontSize: 9.5, color: 'var(--ink-3)', letterSpacing: '0.08em' }}>// {g}</div>
            {items.map(it => (
              <div key={it} className="mono" style={{ padding: '3px 14px', fontSize: 11, color: 'var(--ink-2)' }}>{it}</div>
            ))}
          </div>
        ))}
      </div>

      <div style={{ flex: 1, background:
        'radial-gradient(circle at 20px 20px, rgba(255,255,255,0.04) 1px, transparent 1px) 0 0/22px 22px, var(--bg)',
        position: 'relative' }}>
        {[
          { x: 30, y: 40, t: 'linear.webhook', s: 'tag=refund', c: 'var(--acc)' },
          { x: 30, y: 130, t: 'classify_intent', s: 'gpt-4o', c: 'var(--info)' },
          { x: 30, y: 220, t: 'switch.category', s: '3 cases', c: 'var(--ink-2)' },
          { x: 280, y: 180, t: 'agent.refund', s: 'sonnet-4', c: 'var(--acc)', active: true },
          { x: 280, y: 280, t: 'hil.approve', s: 'amt > $200', c: 'var(--warn)' },
          { x: 540, y: 230, t: 'tool.refund', s: 'shopify', c: 'var(--ok)' },
          { x: 540, y: 320, t: 'tool.comment', s: 'linear', c: 'var(--ok)' },
        ].map((n, i) => (
          <div key={i} className="mono" style={{
            position: 'absolute', left: n.x, top: n.y, width: 200,
            background: 'var(--bg-1)', border: `1px solid ${n.active ? n.c : 'var(--line)'}`,
            padding: '6px 10px', fontSize: 11,
            boxShadow: n.active ? `0 0 0 2px ${n.c}33` : 'none',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: n.c }}/>
              <span style={{ color: 'var(--ink)', flex: 1 }}>{n.t}</span>
            </div>
            <div style={{ color: 'var(--ink-3)', paddingLeft: 12, fontSize: 10 }}>{n.s}</div>
          </div>
        ))}
        <svg style={{ position: 'absolute', inset: 0 }} width="100%" height="100%">
          <path d="M130,75 L130,130" stroke="var(--ink-3)" strokeWidth="1" fill="none"/>
          <path d="M130,165 L130,220" stroke="var(--ink-3)" strokeWidth="1" fill="none"/>
          <path d="M230,250 C260,250 280,210 280,210" stroke="var(--ink-3)" strokeWidth="1" fill="none"/>
          <path d="M230,260 C260,260 280,310 280,310" stroke="var(--ink-3)" strokeWidth="1" fill="none"/>
          <path d="M480,210 C520,210 540,255 540,255" stroke="var(--acc)" strokeWidth="1" fill="none"/>
          <path d="M480,310 C520,310 540,345 540,345" stroke="var(--ink-3)" strokeWidth="1" fill="none"/>
        </svg>
      </div>

      <div style={{ width: 280, borderLeft: '1px solid var(--line)', flexShrink: 0, padding: 14, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
        <div style={{ color: 'var(--acc)', fontSize: 10, letterSpacing: '0.08em' }}># SELECTED</div>
        <div style={{ fontSize: 14, color: 'var(--ink)', margin: '4px 0 12px' }}>agent.refund</div>
        {[
          ['agent', 'refund-specialist'],
          ['model', 'sonnet-4'],
          ['ctx', '200k'],
          ['timeout', '5m'],
          ['on_err', 'retry(3)'],
          ['tools', '4'],
        ].map(([k, v]) => (
          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--line)' }}>
            <span style={{ color: 'var(--ink-3)' }}>{k}</span>
            <span style={{ color: 'var(--ink)' }}>{v}</span>
          </div>
        ))}
        <div style={{ marginTop: 14, color: 'var(--ink-3)', fontSize: 10 }}>// system_prompt</div>
        <div style={{ background: 'var(--bg-1)', padding: 10, marginTop: 4, fontSize: 10.5, color: 'var(--ink-2)', lineHeight: 1.5, border: '1px solid var(--line)' }}>
          You are a refund specialist for Inomy. Use shopify tools to issue refunds up to $200…
        </div>
      </div>
    </div>
  </V1Frame>
);

// =============================================================================
// V2 — Linear-clean: tidy node graph
// =============================================================================
const WorkflowBuilderV2 = () => (
  <V2Frame active="workflows" title="Refund · CodeRabbit resolve" crumbs={['Workflows', 'refund-coderabbit-resolve']}
    actions={<>
      <button className="btn btn-line">Test run</button>
      <button className="btn btn-line">v4 · saved</button>
      <button className="btn btn-primary">Publish</button>
    </>}>
    <div style={{ display: 'flex', flex: 1, minHeight: 0, padding: '14px 24px 20px', gap: 14 }}>
      <div style={{ width: 200, background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, padding: 12 }}>
        <input placeholder="Search nodes…" style={{ width: '100%', padding: '6px 10px', border: '1px solid var(--line)', borderRadius: 6, fontSize: 12, marginBottom: 12 }}/>
        {[
          { g: 'Trigger', it: ['Linear', 'Webhook', 'Cron'] },
          { g: 'Logic', it: ['If', 'Switch', 'Loop'] },
          { g: 'Agent', it: ['Run', 'Tool call'] },
          { g: 'Human', it: ['Approve', 'Ask'] },
        ].map(g => (
          <div key={g.g} style={{ marginBottom: 10 }}>
            <div className="uppercase-label" style={{ marginBottom: 4 }}>{g.g}</div>
            {g.it.map(i => (
              <div key={i} style={{ padding: '5px 8px', borderRadius: 4, fontSize: 12.5, color: 'var(--ink-2)', cursor: 'grab' }}>{i}</div>
            ))}
          </div>
        ))}
      </div>

      <div style={{ flex: 1, background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, position: 'relative', overflow: 'hidden',
        backgroundImage: 'radial-gradient(circle at 14px 14px, rgba(0,0,0,0.05) 1px, transparent 1px)', backgroundSize: '20px 20px' }}>
        {[
          { x: 50, y: 50, t: 'Linear webhook', s: 'tag = refund', i: 'linear' },
          { x: 50, y: 160, t: 'Classify intent', s: 'GPT-4o', i: 'sparkle' },
          { x: 50, y: 270, t: 'Switch', s: '3 cases', i: 'flow' },
          { x: 320, y: 220, t: 'Refund agent', s: 'sonnet-4', i: 'people', active: true },
          { x: 320, y: 330, t: 'Human approval', s: 'if > $200', i: 'help' },
          { x: 580, y: 270, t: 'Issue refund', s: 'shopify', i: 'mcp' },
          { x: 580, y: 380, t: 'Close issue', s: 'linear', i: 'merge' },
        ].map((n, i) => (
          <div key={i} style={{
            position: 'absolute', left: n.x, top: n.y, width: 220,
            background: '#fff', border: `1px solid ${n.active ? 'var(--acc)' : 'var(--line)'}`,
            borderRadius: 8, padding: 10, boxShadow: n.active ? '0 0 0 3px var(--acc-dim)' : '0 1px 2px rgba(0,0,0,0.03)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <Icon name={n.i} size={12} color="var(--acc)"/>
              <span style={{ fontSize: 12.5, fontWeight: 500, flex: 1 }}>{n.t}</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--ink-3)', paddingLeft: 19, marginTop: 2 }}>{n.s}</div>
          </div>
        ))}
      </div>

      <div style={{ width: 280, background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, padding: 14 }}>
        <div style={{ fontSize: 12, color: 'var(--acc)', fontWeight: 500, marginBottom: 4 }}>Selected node</div>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 14 }}>Refund agent</div>
        {[
          ['Agent', 'refund-specialist'],
          ['Model', 'claude-sonnet-4'],
          ['Tools', '4 enabled'],
          ['Timeout', '5 minutes'],
          ['On error', 'Retry × 3'],
        ].map(([k, v]) => (
          <div key={k} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{k}</div>
            <div style={{ fontSize: 13, marginTop: 2 }}>{v}</div>
          </div>
        ))}
      </div>
    </div>
  </V2Frame>
);

// =============================================================================
// V3 — Operator: code-like declarative editor
// =============================================================================
const WorkflowBuilderV3 = () => (
  <V3Frame active="workflows" title="Refund · CodeRabbit resolve" subtitle="Workflow editor · v4"
    actions={<>
      <button className="btn btn-line mono" style={{fontSize:11}}>discard</button>
      <button className="btn btn-line mono" style={{fontSize:11}}>test run</button>
      <button className="btn btn-primary mono" style={{fontSize:11}}>publish v5</button>
    </>}>
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      {/* tree */}
      <div style={{ width: 240, borderRight: '1px solid var(--line)', padding: '10px 12px', flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
        <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.06em', marginBottom: 8 }}>NODES / 7</div>
        {[
          ['▾', 'on_linear_webhook', 0],
          ['  ', 'classify_intent', 1],
          ['  ▾', 'switch_by_category', 1],
          ['    ', 'case: refund', 2],
          ['    ', '  → agent.refund', 3, true],
          ['    ', '  → hil.approve_if_>200', 3],
          ['    ', '  → tool.shopify.refund', 3],
          ['    ', '  → tool.linear.close', 3],
          ['    ', 'case: bug', 2],
          ['    ', 'case: question', 2],
        ].map((r, i) => (
          <div key={i} style={{
            padding: '3px 0', color: r[3] ? 'var(--ink-3)' : 'var(--ink-2)',
            background: r[3] ? 'var(--acc-dim)' : 'transparent',
          }}>
            <span style={{ color: 'var(--ink-3)' }}>{r[0]}</span>{r[1]}
          </div>
        ))}
      </div>

      {/* main editor */}
      <div style={{ flex: 1, padding: 16, overflow: 'auto', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', padding: 18, lineHeight: 1.7 }}>
          <div style={{ color: 'var(--ink-3)' }}># refund-coderabbit-resolve.workflow.yml</div>
          <div style={{ color: 'var(--ink-3)' }}># 7 nodes · 2 humans · v4 · last edited 2 days ago by Ashish</div>
          <div style={{ height: 8 }}/>
          <div><span style={{ color: 'var(--info)' }}>name</span>: <span style={{ color: 'var(--ok)' }}>"Refund · CodeRabbit resolve"</span></div>
          <div><span style={{ color: 'var(--info)' }}>version</span>: 4</div>
          <div><span style={{ color: 'var(--info)' }}>trigger</span>:</div>
          <div style={{ paddingLeft: 16 }}><span style={{ color: 'var(--info)' }}>type</span>: linear.webhook</div>
          <div style={{ paddingLeft: 16 }}><span style={{ color: 'var(--info)' }}>filter</span>: <span style={{ color: 'var(--ok)' }}>'tag == "refund"'</span></div>
          <div><span style={{ color: 'var(--info)' }}>steps</span>:</div>
          <div style={{ paddingLeft: 16 }}>- <span style={{ color: 'var(--info)' }}>id</span>: classify</div>
          <div style={{ paddingLeft: 32 }}><span style={{ color: 'var(--info)' }}>uses</span>: model.classify</div>
          <div style={{ paddingLeft: 32 }}><span style={{ color: 'var(--info)' }}>model</span>: gpt-4o</div>
          <div style={{ paddingLeft: 16, background: 'var(--acc-dim)', margin: '0 -8px', padding: '0 8px 0 24px', borderLeft: '3px solid var(--acc)' }}>
            <div>- <span style={{ color: 'var(--info)' }}>id</span>: refund_agent <span style={{ color: 'var(--ink-3)' }}># SELECTED</span></div>
            <div style={{ paddingLeft: 16 }}><span style={{ color: 'var(--info)' }}>uses</span>: agent.run</div>
            <div style={{ paddingLeft: 16 }}><span style={{ color: 'var(--info)' }}>agent</span>: refund-specialist</div>
            <div style={{ paddingLeft: 16 }}><span style={{ color: 'var(--info)' }}>model</span>: claude-sonnet-4</div>
            <div style={{ paddingLeft: 16 }}><span style={{ color: 'var(--info)' }}>timeout</span>: 5m</div>
            <div style={{ paddingLeft: 16 }}><span style={{ color: 'var(--info)' }}>tools</span>: [shopify.*, linear.add_comment]</div>
            <div style={{ paddingLeft: 16 }}><span style={{ color: 'var(--info)' }}>on_error</span>: retry(3)</div>
          </div>
          <div style={{ paddingLeft: 16 }}>- <span style={{ color: 'var(--info)' }}>id</span>: approval_gate</div>
          <div style={{ paddingLeft: 32 }}><span style={{ color: 'var(--info)' }}>uses</span>: hil.approve</div>
          <div style={{ paddingLeft: 32 }}><span style={{ color: 'var(--info)' }}>when</span>: <span style={{ color: 'var(--ok)' }}>'amount &gt; 200'</span></div>
          <div style={{ paddingLeft: 32 }}><span style={{ color: 'var(--info)' }}>route_to</span>: ashish</div>
        </div>
      </div>
    </div>
  </V3Frame>
);

Object.assign(window, { WorkflowBuilderV1, WorkflowBuilderV2, WorkflowBuilderV3, WorkflowBuilderV4 });
