// detail-views.jsx — ExecutionDetail, WorkspaceDetail, PRDetail
// 4 directions each, kept compact

// =============================================================================
// EXECUTION DETAIL: timeline + events + outputs
// =============================================================================
const EXEC_EVENTS = [
  { t: '00:00', kind: 'start', label: 'Run started', meta: 'triggered by linear.webhook · LIN-2843' },
  { t: '00:01', kind: 'tool', label: 'shopify.find_order', meta: 'order_id: 8472019', dur: '142ms', ok: true },
  { t: '00:01', kind: 'think', label: 'Classifying intent', meta: 'gpt-4o · 412 tokens', dur: '890ms' },
  { t: '00:02', kind: 'agent', label: 'Refund agent activated', meta: 'sonnet-4 · refund-specialist' },
  { t: '00:04', kind: 'tool', label: 'shopify.refund_order', meta: 'amount: $234.50', dur: '1.2s', ok: true },
  { t: '00:05', kind: 'human', label: 'Approval requested', meta: 'amount > threshold · waiting on Ashish', warn: true },
  { t: '02:14', kind: 'human', label: 'Approved by Ashish', meta: 'comment: looks good', ok: true },
  { t: '02:15', kind: 'tool', label: 'linear.add_comment', meta: 'LIN-2843 · refund issued', dur: '78ms', ok: true },
  { t: '02:15', kind: 'end', label: 'Run completed', meta: 'success · cost $0.12 · 2m 15s' },
];

const EvIcon = ({ kind }) => {
  const map = { start: 'play', tool: 'mcp', think: 'sparkle', agent: 'people', human: 'help', end: 'check' };
  return <Icon name={map[kind] || 'pulse'} size={11}/>;
};

const ExecutionDetailV4 = () => (
  <V4Frame active="executions" eyebrow="Run · run_8f3a91bc · 2m 15s" title="Refund · order #8472019"
    crumbs={['EXECUTIONS', 'RUN_8F3A91BC']} padded={false}
    actions={<>
      <AuroraPill tone="ok" dot>completed</AuroraPill>
      <button className="btn btn-line"><Icon name="refresh" size={11}/>Re-run</button>
      <button className="btn btn-line"><Icon name="download" size={11}/>Trace</button>
      <button className="btn btn-line"><Icon name="external" size={11}/>Linear</button>
    </>}>
    <div style={{ display: 'flex', flex: 1, minHeight: 0, padding: '20px 32px 28px', gap: 18 }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14, overflow: 'auto' }}>
        <AuroraCard padded style={{ padding: 18 }}>
          <div style={{ display: 'flex', gap: 24 }}>
            <AuroraStat label="Workflow" value="refund-coderabbit-resolve"/>
            <AuroraStat label="Duration" value="2m 15s" sub="incl. 2m 9s wait"/>
            <AuroraStat label="Cost" value="$0.12" sub="142k tokens"/>
            <AuroraStat label="Steps" value="9" sub="0 errors · 1 HIL"/>
          </div>
        </AuroraCard>

        {/* Timeline */}
        <AuroraCard padded={false} style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)' }}>
            <div className="display" style={{ fontSize: 18 }}>Timeline</div>
          </div>
          <div style={{ position: 'relative' }}>
            <div style={{ position: 'absolute', left: 60, top: 18, bottom: 18, width: 1, background: 'var(--line)' }}/>
            {EXEC_EVENTS.map((e, i) => {
              const c = e.kind === 'human' ? 'var(--warn)' : e.kind === 'end' || e.ok ? 'var(--ok)' : e.kind === 'agent' ? 'var(--acc)' : 'var(--ink-3)';
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', padding: '12px 18px', gap: 14 }}>
                  <span className="mono" style={{ width: 50, fontSize: 11, color: 'var(--ink-3)', textAlign: 'right', paddingTop: 4 }}>{e.t}</span>
                  <div style={{ width: 24, height: 24, borderRadius: '50%', background: 'var(--bg-1)', border: `1.5px solid ${c}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: c }}>
                    <EvIcon kind={e.kind}/>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 500 }}>{e.label}</div>
                    <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>{e.meta}</div>
                  </div>
                  {e.dur && <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', alignSelf: 'flex-start', paddingTop: 4 }}>{e.dur}</span>}
                </div>
              );
            })}
          </div>
        </AuroraCard>
      </div>

      {/* Right: I/O */}
      <div style={{ width: 360, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 14, overflow: 'auto' }}>
        <AuroraCard padded style={{ padding: 16 }}>
          <div className="uppercase-label" style={{ marginBottom: 8 }}>Input</div>
          <div style={{ background: 'var(--bg-2)', borderRadius: 8, padding: 12, fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--ink-2)', lineHeight: 1.55 }}>
            {`{
  "issue": "LIN-2843",
  "title": "Customer requesting refund",
  "tag": "refund",
  "customer": {
    "id": "cust_19vN",
    "email": "anu@example.com"
  }
}`}
          </div>
        </AuroraCard>
        <AuroraCard padded style={{ padding: 16 }}>
          <div className="uppercase-label" style={{ marginBottom: 8 }}>Output</div>
          <div style={{ background: 'var(--bg-2)', borderRadius: 8, padding: 12, fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--ink-2)', lineHeight: 1.55 }}>
            {`{
  "status": "refunded",
  "order_id": "8472019",
  "amount": 234.50,
  "currency": "USD",
  "linear_comment": "lin_c_8473"
}`}
          </div>
        </AuroraCard>
        <AuroraCard padded style={{ padding: 16 }}>
          <div className="uppercase-label" style={{ marginBottom: 8 }}>Cost breakdown</div>
          {[['gpt-4o (classify)', '$0.018'], ['sonnet-4 (agent)', '$0.094'], ['shopify tools', '$0.000'], ['linear tools', '$0.000']].map(([k, v]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: 12, borderBottom: '1px solid var(--line)' }}>
              <span style={{ color: 'var(--ink-3)' }}>{k}</span><span className="mono">{v}</span>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0 0', fontSize: 13, fontWeight: 500 }}>
            <span>Total</span><span className="mono">$0.112</span>
          </div>
        </AuroraCard>
      </div>
    </div>
  </V4Frame>
);

const ExecutionDetailV1 = () => (
  <V1Frame active="executions" crumbs={['ALLEN', 'EXEC', 'run_8f3a91bc']}
    actions={<><span className="pill pill-ok mono" style={{fontSize:9}}>OK</span><button className="btn btn-line mono" style={{fontSize:11}}>RE-RUN</button><button className="btn btn-line mono" style={{fontSize:11}}>TRACE.JSON</button></>}>
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <div style={{ flex: 1, padding: 14, overflow: 'auto', borderRight: '1px solid var(--line)' }}>
        <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.06em', marginBottom: 10 }}>RUN.LOG / refund-coderabbit-resolve / run_8f3a91bc</div>
        <div className="mono" style={{ fontSize: 11, lineHeight: 1.7 }}>
          {EXEC_EVENTS.map((e, i) => {
            const c = e.warn ? 'var(--warn)' : e.ok ? 'var(--ok)' : e.kind === 'end' ? 'var(--acc)' : 'var(--ink-2)';
            return (
              <div key={i} style={{ display: 'flex', gap: 12, padding: '3px 0' }}>
                <span style={{ color: 'var(--ink-3)', width: 50 }}>{e.t}</span>
                <span style={{ color: c, width: 70 }}>[{e.kind.toUpperCase()}]</span>
                <span style={{ color: 'var(--ink)', flex: 1 }}>{e.label}</span>
                {e.dur && <span style={{ color: 'var(--ink-3)' }}>{e.dur}</span>}
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ width: 320, padding: 14, fontFamily: 'var(--font-mono)' }}>
        <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.06em', marginBottom: 6 }}>SUMMARY</div>
        {[['workflow', 'refund-coderabbit-resolve'], ['version', 'v4'], ['status', 'completed', 'ok'], ['duration', '2m 15s'], ['steps', '9'], ['errors', '0'], ['cost', '$0.112'], ['tokens', '142,381'], ['hil', '1 (approved)']].map(([k, v, t]) => (
          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '3px 0', borderBottom: '1px solid var(--line)' }}>
            <span style={{ color: 'var(--ink-3)' }}>{k}</span>
            <span style={{ color: t === 'ok' ? 'var(--ok)' : 'var(--ink)' }}>{v}</span>
          </div>
        ))}
        <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.06em', marginTop: 14, marginBottom: 6 }}>OUTPUT</div>
        <pre style={{ fontSize: 10.5, background: 'var(--bg-1)', padding: 10, border: '1px solid var(--line)', color: 'var(--ink-2)', whiteSpace: 'pre-wrap', margin: 0 }}>{`{ status: "refunded",
  amount: 234.50,
  order_id: "8472019" }`}</pre>
      </div>
    </div>
  </V1Frame>
);

const ExecutionDetailV2 = () => (
  <V2Frame active="executions" title="Refund · order #8472019" crumbs={['Activity', 'Run']}
    tabs={[{label:'Timeline', active:true},{label:'Trace'},{label:'Inputs'},{label:'Outputs'},{label:'Cost'}]}
    actions={<><span className="pill pill-ok">completed</span><button className="btn btn-line">Re-run</button></>}>
    <div style={{ display: 'flex', flex: 1, minHeight: 0, padding: '14px 24px', gap: 14 }}>
      <div style={{ flex: 1, background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, padding: 18, overflow: 'auto' }}>
        <div style={{ display: 'flex', gap: 28, marginBottom: 18, paddingBottom: 14, borderBottom: '1px solid var(--line)' }}>
          {[['Duration', '2m 15s'], ['Cost', '$0.12'], ['Steps', '9'], ['Errors', '0']].map(([k, v]) => (
            <div key={k}><div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{k}</div><div style={{ fontSize: 18, fontWeight: 600, marginTop: 2 }}>{v}</div></div>
          ))}
        </div>
        <div style={{ position: 'relative' }}>
          <div style={{ position: 'absolute', left: 50, top: 8, bottom: 8, width: 1, background: 'var(--line)' }}/>
          {EXEC_EVENTS.map((e, i) => {
            const c = e.warn ? 'var(--warn)' : e.ok ? 'var(--ok)' : e.kind === 'end' ? 'var(--acc)' : 'var(--ink-3)';
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'flex-start', padding: '8px 0', gap: 12 }}>
                <span style={{ width: 42, fontSize: 11, color: 'var(--ink-3)', fontFamily: 'var(--font-mono)', paddingTop: 4 }}>{e.t}</span>
                <div style={{ width: 18, height: 18, borderRadius: '50%', background: 'var(--bg-1)', border: `2px solid ${c}`, flexShrink: 0, marginTop: 3 }}/>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{e.label}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--ink-3)', marginTop: 1 }}>{e.meta}</div>
                </div>
                {e.dur && <span style={{ fontSize: 11, color: 'var(--ink-3)', fontFamily: 'var(--font-mono)', paddingTop: 4 }}>{e.dur}</span>}
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ width: 280, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, padding: 14 }}>
          <div className="uppercase-label" style={{ marginBottom: 8 }}>Output</div>
          <pre style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--ink-2)', whiteSpace: 'pre-wrap', margin: 0, lineHeight: 1.55 }}>{`{
  status: "refunded",
  amount: 234.50,
  order_id: "8472019"
}`}</pre>
        </div>
      </div>
    </div>
  </V2Frame>
);

const ExecutionDetailV3 = () => (
  <V3Frame active="executions" title="run_8f3a91bc" subtitle="refund-coderabbit-resolve · v4 · 2m 15s · OK"
    actions={<><button className="btn btn-line mono" style={{fontSize:11}}>RE-RUN</button><button className="btn btn-line mono" style={{fontSize:11}}>EXPORT</button></>}>
    <div style={{ flex: 1, overflow: 'auto' }}>
      <table className="mono" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
        <thead>
          <tr style={{ borderBottom: '2px solid var(--ink)', background: 'var(--bg-1)', color: 'var(--ink-3)', fontSize: 10, letterSpacing: '0.06em' }}>
            <th style={{ padding: '8px 14px', textAlign: 'left' }}>T</th>
            <th style={{ padding: '8px 14px', textAlign: 'left' }}>KIND</th>
            <th style={{ padding: '8px 14px', textAlign: 'left' }}>EVENT</th>
            <th style={{ padding: '8px 14px', textAlign: 'left' }}>META</th>
            <th style={{ padding: '8px 14px', textAlign: 'right' }}>DUR</th>
          </tr>
        </thead>
        <tbody>
          {EXEC_EVENTS.map((e, i) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--line)' }}>
              <td style={{ padding: '6px 14px', color: 'var(--ink-3)' }}>{e.t}</td>
              <td style={{ padding: '6px 14px', textTransform: 'uppercase', color: e.warn ? 'var(--warn)' : e.ok ? 'var(--ok)' : 'var(--ink-2)' }}>{e.kind}</td>
              <td style={{ padding: '6px 14px', fontWeight: 500 }}>{e.label}</td>
              <td style={{ padding: '6px 14px', color: 'var(--ink-3)' }}>{e.meta}</td>
              <td style={{ padding: '6px 14px', textAlign: 'right', color: 'var(--ink-3)' }}>{e.dur || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </V3Frame>
);

// =============================================================================
// WORKSPACE DETAIL: file tree + terminal + preview tabs
// =============================================================================
const WS_FILES = [
  { p: 'src/', d: 1 },
  { p: '  api/', d: 1 },
  { p: '    refunds.ts', d: 0, mod: true },
  { p: '    orders.ts', d: 0 },
  { p: '  components/', d: 1 },
  { p: '    RefundDialog.tsx', d: 0, sel: true },
  { p: '    Cart.tsx', d: 0 },
  { p: '  lib/', d: 1 },
  { p: '    shopify.ts', d: 0 },
  { p: '  pages/', d: 1 },
  { p: 'tests/', d: 1 },
  { p: 'package.json', d: 0 },
];

const WorkspaceDetailV4 = () => (
  <V4Frame active="workspaces" eyebrow="Sandbox · ws_pr_2843 · 38m alive" title="inomy/storefront · refund-flow-fix"
    crumbs={['SANDBOXES', 'WS_PR_2843']} padded={false}
    actions={<>
      <AuroraPill tone="run" dot>agent active</AuroraPill>
      <button className="btn btn-line"><Icon name="terminal" size={11}/>Terminal</button>
      <button className="btn btn-line"><Icon name="external" size={11}/>Open in VS Code</button>
      <button className="btn btn-primary">Open PR</button>
    </>}>
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      {/* file tree */}
      <div style={{ width: 240, borderRight: '1px solid var(--line)', flexShrink: 0, padding: '14px 0', overflow: 'auto', background: 'var(--bg-1)' }}>
        <div className="uppercase-label" style={{ padding: '0 16px 8px' }}>Files · 12</div>
        {WS_FILES.map((f, i) => (
          <div key={i} style={{
            padding: `4px 16px 4px ${16 + f.p.match(/^\s*/)[0].length * 4}px`,
            fontSize: 12.5, color: f.sel ? 'var(--ink)' : 'var(--ink-2)',
            background: f.sel ? 'var(--bg-2)' : 'transparent',
            borderLeft: f.sel ? '2px solid var(--acc)' : '2px solid transparent',
            display: 'flex', alignItems: 'center', gap: 6,
            fontFamily: f.d ? 'var(--font-sans)' : 'var(--font-mono)',
          }}>
            <Icon name={f.d ? 'box' : 'edit'} size={10} color={f.sel ? 'var(--acc)' : 'var(--ink-3)'}/>
            <span style={{ flex: 1 }}>{f.p.trim()}</span>
            {f.mod && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--warn)' }}/>}
          </div>
        ))}
      </div>

      {/* main: code + terminal */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--line)', background: 'var(--bg-1)' }}>
          {['RefundDialog.tsx', 'refunds.ts', 'shopify.ts'].map((t, i) => (
            <div key={t} style={{
              padding: '10px 14px', fontSize: 12.5,
              borderRight: '1px solid var(--line)',
              borderBottom: i === 0 ? '2px solid var(--acc)' : 'none',
              color: i === 0 ? 'var(--ink)' : 'var(--ink-3)',
              fontWeight: i === 0 ? 500 : 400, marginBottom: -1,
              fontFamily: 'var(--font-mono)',
            }}>{t}</div>
          ))}
        </div>

        {/* code */}
        <div style={{ flex: 1, padding: 18, overflow: 'auto', fontFamily: 'var(--font-mono)', fontSize: 12.5, lineHeight: 1.65, background: 'var(--bg-1)' }}>
          {[
            { ln: 23, t: <><span style={{color:'var(--ink-3)'}}>import</span> {'{'} <span style={{color:'var(--info)'}}>useState</span> {'}'} <span style={{color:'var(--ink-3)'}}>from</span> <span style={{color:'var(--ok)'}}>'react'</span></> },
            { ln: 24, t: <><span style={{color:'var(--ink-3)'}}>import</span> {'{'} <span style={{color:'var(--info)'}}>refundOrder</span> {'}'} <span style={{color:'var(--ink-3)'}}>from</span> <span style={{color:'var(--ok)'}}>'@/lib/shopify'</span></> },
            { ln: 25, t: '' },
            { ln: 26, t: <><span style={{color:'var(--ink-3)'}}>export function</span> <span style={{color:'var(--info)'}}>RefundDialog</span>({'{'} order {'}'}: Props) {'{'}</> },
            { ln: 27, hl: 'add', t: <>  <span style={{color:'var(--ink-3)'}}>const</span> [reason, setReason] = useState({"<string | null>"}({'null'}))</> },
            { ln: 28, hl: 'add', t: <>  <span style={{color:'var(--ink-3)'}}>const</span> [confirming, setConfirming] = useState({'(false)'})</> },
            { ln: 29, t: '' },
            { ln: 30, t: '  async function handleConfirm() {' },
            { ln: 31, hl: 'rm', t: '    await refundOrder(order.id)' },
            { ln: 32, hl: 'add', t: '    if (!reason) { setConfirming(true); return }' },
            { ln: 33, hl: 'add', t: '    await refundOrder(order.id, { reason })' },
            { ln: 34, t: '  }' },
          ].map((l, i) => (
            <div key={i} style={{
              display: 'flex', gap: 14,
              background: l.hl === 'add' ? 'rgba(22,121,74,0.08)' : l.hl === 'rm' ? 'rgba(185,28,28,0.06)' : 'transparent',
              borderLeft: l.hl ? `2px solid ${l.hl === 'add' ? 'var(--ok)' : 'var(--err)'}` : '2px solid transparent',
              paddingLeft: 8, marginLeft: -10,
            }}>
              <span style={{ color: 'var(--ink-3)', width: 28, textAlign: 'right' }}>{l.ln}</span>
              <span>{l.hl === 'add' ? '+ ' : l.hl === 'rm' ? '- ' : '  '}{l.t}</span>
            </div>
          ))}
        </div>

        {/* terminal */}
        <div style={{ height: 200, borderTop: '1px solid var(--line)', background: '#1c1a17', color: '#e6e4dd', fontFamily: 'var(--font-mono)', fontSize: 11.5, padding: 14, overflow: 'auto', lineHeight: 1.65 }}>
          <div style={{ display: 'flex', gap: 14, marginBottom: 8, color: '#aaa698' }}>
            <span style={{ borderBottom: '1px solid #5b4ae6', color: '#fff' }}>terminal</span>
            <span>logs</span>
            <span>preview</span>
            <span>tests <span style={{ color: '#16794a' }}>● 12 passing</span></span>
          </div>
          <div><span style={{ color: '#5b4ae6' }}>~/storefront ❯</span> npm test -- RefundDialog</div>
          <div style={{ color: '#aaa698' }}>{'>'} jest --testPathPattern=RefundDialog</div>
          <div style={{ color: '#16794a' }}>PASS  src/components/__tests__/RefundDialog.test.tsx</div>
          <div style={{ color: '#aaa698' }}>  RefundDialog</div>
          <div style={{ color: '#16794a' }}>    ✓ requires reason before confirming (43ms)</div>
          <div style={{ color: '#16794a' }}>    ✓ shows confirmation dialog (28ms)</div>
          <div style={{ color: '#16794a' }}>    ✓ calls refundOrder with reason (51ms)</div>
          <div><span style={{ color: '#5b4ae6' }}>~/storefront ❯</span> <span style={{ background: '#5b4ae633', padding: '0 2px' }}>▌</span></div>
        </div>
      </div>
    </div>
  </V4Frame>
);

const WorkspaceDetailV1 = () => (
  <V1Frame active="workspaces" crumbs={['ALLEN', 'WS', 'ws_pr_2843']}
    actions={<><span className="mono" style={{fontSize:10,color:'var(--acc)'}}>● AGENT ACTIVE</span><button className="btn btn-line mono" style={{fontSize:11}}>SSH</button><button className="btn btn-primary mono" style={{fontSize:11}}>OPEN PR</button></>}>
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <div style={{ width: 200, borderRight: '1px solid var(--line)', padding: '8px 0', flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
        <div className="mono" style={{ padding: '0 14px 6px', fontSize: 10, color: 'var(--ink-3)' }}>// FILES</div>
        {WS_FILES.map((f, i) => (
          <div key={i} style={{
            padding: `2px 14px 2px ${14 + f.p.match(/^\s*/)[0].length * 4}px`,
            color: f.sel ? 'var(--acc)' : f.mod ? 'var(--warn)' : 'var(--ink-2)',
            background: f.sel ? 'color-mix(in srgb, var(--acc) 12%, transparent)' : 'transparent',
          }}>{f.p.trim()}{f.mod && ' M'}</div>
        ))}
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--line)', display: 'flex', gap: 14, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
          <span style={{ color: 'var(--acc)', borderBottom: '1px solid var(--acc)' }}>RefundDialog.tsx</span>
          <span style={{ color: 'var(--ink-3)' }}>refunds.ts M</span>
          <span style={{ color: 'var(--ink-3)' }}>shopify.ts</span>
        </div>
        <div style={{ flex: 1, padding: 14, fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--ink-2)', lineHeight: 1.7, overflow: 'auto' }}>
          <div style={{ color: 'var(--ink-3)' }}>// src/components/RefundDialog.tsx</div>
          <div style={{ color: 'var(--ink-3)' }}>// 47 lines · agent.refund modified 23 mins ago</div>
          <div style={{ height: 6 }}/>
          {['  const [reason, setReason] = useState<string | null>(null)', '  const [confirming, setConfirming] = useState(false)', '', '  async function handleConfirm() {', '-   await refundOrder(order.id)', '+   if (!reason) { setConfirming(true); return }', '+   await refundOrder(order.id, { reason })', '  }'].map((l, i) => (
            <div key={i} style={{
              color: l.startsWith('+') ? 'var(--ok)' : l.startsWith('-') ? 'var(--err)' : 'var(--ink-2)',
              background: l.startsWith('+') ? 'rgba(22,121,74,0.1)' : l.startsWith('-') ? 'rgba(185,28,28,0.08)' : 'transparent',
            }}>{(i+27).toString().padStart(3, ' ')}  {l}</div>
          ))}
        </div>
        <div style={{ height: 180, borderTop: '1px solid var(--line)', background: 'var(--bg)', padding: 10, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--ink-2)', lineHeight: 1.7, overflow: 'auto' }}>
          <div style={{ color: 'var(--acc)' }}>$ npm test RefundDialog</div>
          <div style={{ color: 'var(--ink-3)' }}>{'>'} jest src/components/__tests__/RefundDialog.test.tsx</div>
          <div style={{ color: 'var(--ok)' }}>PASS  RefundDialog (3 tests, 122ms)</div>
          <div style={{ color: 'var(--ok)' }}>  ✓ requires reason before confirming</div>
          <div style={{ color: 'var(--ok)' }}>  ✓ shows confirmation dialog</div>
          <div style={{ color: 'var(--ok)' }}>  ✓ calls refundOrder with reason</div>
          <div><span style={{ color: 'var(--acc)' }}>$ </span>▌</div>
        </div>
      </div>
    </div>
  </V1Frame>
);

const WorkspaceDetailV2 = () => (
  <V2Frame active="workspaces" title="inomy/storefront · refund-flow-fix" crumbs={['Sandboxes', 'ws_pr_2843']}
    tabs={[{label:'Files', active:true},{label:'Terminal'},{label:'Preview'},{label:'Tests', count:12}]}
    actions={<><span className="pill pill-run">agent active</span><button className="btn btn-primary">Open PR</button></>}>
    <div style={{ display: 'flex', flex: 1, minHeight: 0, padding: 14, gap: 12 }}>
      <div style={{ width: 220, background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, padding: 10, overflow: 'auto', fontSize: 12.5 }}>
        {WS_FILES.map((f, i) => (
          <div key={i} style={{
            padding: `3px 8px 3px ${8 + f.p.match(/^\s*/)[0].length * 6}px`,
            color: f.sel ? 'var(--acc)' : 'var(--ink-2)',
            background: f.sel ? 'var(--acc-dim)' : 'transparent',
            borderRadius: 4,
          }}>{f.p.trim()}{f.mod && ' •'}</div>
        ))}
      </div>
      <div style={{ flex: 1, background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, padding: 16, overflow: 'auto', fontFamily: 'var(--font-mono)', fontSize: 12.5, lineHeight: 1.65 }}>
        <div style={{ color: 'var(--ink-3)', marginBottom: 6 }}>RefundDialog.tsx · 47 lines</div>
        {[ '  const [reason, setReason] = useState<string | null>(null)', '  const [confirming, setConfirming] = useState(false)', '', '  async function handleConfirm() {', '-   await refundOrder(order.id)', '+   if (!reason) { setConfirming(true); return }', '+   await refundOrder(order.id, { reason })', '  }'].map((l, i) => (
          <div key={i} style={{
            color: l.startsWith('+') ? 'var(--ok)' : l.startsWith('-') ? 'var(--err)' : 'var(--ink-2)',
            background: l.startsWith('+') ? 'rgba(5,150,105,0.08)' : l.startsWith('-') ? 'rgba(220,38,38,0.06)' : 'transparent',
            paddingLeft: 4, borderRadius: 2,
          }}>{l}</div>
        ))}
      </div>
    </div>
  </V2Frame>
);

const WorkspaceDetailV3 = () => (
  <V3Frame active="workspaces" title="ws_pr_2843" subtitle="inomy/storefront · branch refund-flow-fix · 38m alive · agent: refund-specialist"
    actions={<>
      <button className="btn btn-line mono" style={{fontSize:11}}>TERMINAL</button>
      <button className="btn btn-line mono" style={{fontSize:11}}>SSH</button>
      <button className="btn btn-primary mono" style={{fontSize:11}}>OPEN PR →</button>
    </>}>
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <div style={{ width: 220, borderRight: '1px solid var(--line)', padding: '8px 0', fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
        <div className="mono" style={{ padding: '0 14px 6px', fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.06em' }}>FILES / 12 / 1 MOD</div>
        {WS_FILES.map((f, i) => (
          <div key={i} style={{
            padding: `2px 14px 2px ${14 + f.p.match(/^\s*/)[0].length * 4}px`,
            color: f.sel ? 'var(--ink)' : f.mod ? 'var(--warn)' : 'var(--ink-2)',
            background: f.sel ? 'var(--acc-dim)' : 'transparent',
            fontWeight: f.sel ? 600 : 400, borderLeft: f.sel ? '3px solid var(--acc)' : '3px solid transparent',
          }}>{f.p.trim()}{f.mod ? ' [M]' : ''}</div>
        ))}
      </div>
      <div style={{ flex: 1, padding: 14, fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.7, overflow: 'auto' }}>
        <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.06em', marginBottom: 8 }}>SRC/COMPONENTS/REFUNDDIALOG.TSX · 47 LINES · 1 HUNK</div>
        <pre style={{ margin: 0, lineHeight: 1.7 }}>
{`@@ -27,7 +27,9 @@
   const [confirming, setConfirming] = useState(false)
+  const [reason, setReason] = useState<string | null>(null)

   async function handleConfirm() {
-    await refundOrder(order.id)
+    if (!reason) { setConfirming(true); return }
+    await refundOrder(order.id, { reason })
   }`}
        </pre>
      </div>
    </div>
  </V3Frame>
);

// =============================================================================
// PR DETAIL
// =============================================================================
const PR_FILES = [
  { p: 'src/components/RefundDialog.tsx', a: 8, d: 1, sel: true },
  { p: 'src/api/refunds.ts', a: 14, d: 4 },
  { p: 'src/lib/shopify.ts', a: 6, d: 0 },
  { p: 'src/components/__tests__/RefundDialog.test.tsx', a: 32, d: 0 },
];

const PR_COMMENTS = [
  { who: 'CodeRabbit', avatar: 'CR', hue: 200, time: '12m ago', text: 'Consider extracting the reason validation into a separate hook for reuse in CancelDialog.', tag: 'suggestion' },
  { who: 'Ashish', avatar: 'AS', hue: 28, time: '8m ago', text: '@CodeRabbit good point — but let\'s ship this first and refactor in #2851.', tag: null },
  { who: 'CodeRabbit', avatar: 'CR', hue: 200, time: '6m ago', text: 'Acknowledged · marking as deferred.', tag: 'resolved' },
];

const PRDetailV4 = () => (
  <V4Frame active="prs" eyebrow="Pull request · #2843 · refund-flow-fix → main" title="Require refund reason before confirm"
    crumbs={['PRS', '#2843']} padded={false}
    actions={<>
      <AuroraPill tone="ok" dot>checks passing</AuroraPill>
      <button className="btn btn-line"><Icon name="github" size={11}/>View on GitHub</button>
      <button className="btn btn-primary">Merge & resolve LIN-2843</button>
    </>}>
    <div style={{ display: 'flex', flex: 1, minHeight: 0, padding: '20px 32px 28px', gap: 18 }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14, overflow: 'auto' }}>
        <AuroraCard padded style={{ padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <AuroraAvatar name="refund-specialist" hue={250} size={32}/>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 500 }}>refund-specialist <span style={{ color: 'var(--ink-3)', fontWeight: 400 }}>opened this PR</span></div>
              <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 2 }}>From sandbox <span className="mono">ws_pr_2843</span> · 38 minutes ago</div>
            </div>
          </div>
          <div style={{ fontSize: 13.5, color: 'var(--ink-2)', lineHeight: 1.6 }}>
            Closes <a className="mono" style={{ color: 'var(--acc)' }}>LIN-2843</a>. The refund dialog now blocks confirmation until a reason is provided, surfacing a confirmation step. Added 3 new tests covering the validation path. Backend <span className="mono">/api/refunds</span> now persists <span className="mono">reason</span> to the audit log.
          </div>
        </AuroraCard>

        <AuroraCard padded={false} style={{ padding: 0 }}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div className="display" style={{ fontSize: 18 }}>Files</div>
            <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>4 files · +60 −5</span>
            <div style={{ flex: 1 }}/>
            <button className="btn btn-line" style={{ fontSize: 11, padding: '4px 10px' }}>Split</button>
            <button className="btn btn-line" style={{ fontSize: 11, padding: '4px 10px' }}>Unified</button>
          </div>
          {PR_FILES.map((f, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '10px 18px',
              borderBottom: i < PR_FILES.length - 1 ? '1px solid var(--line)' : 'none',
              background: f.sel ? 'var(--bg-2)' : 'transparent', cursor: 'pointer',
            }}>
              <Icon name="edit" size={11} color="var(--ink-3)"/>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, flex: 1 }}>{f.p}</span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--ok)' }}>+{f.a}</span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--err)' }}>−{f.d}</span>
              <Icon name="chevron-down" size={10} color="var(--ink-3)"/>
            </div>
          ))}
        </AuroraCard>

        {/* CodeRabbit comments thread */}
        <AuroraCard padded style={{ padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <div className="display" style={{ fontSize: 18 }}>Conversation</div>
            <AuroraPill tone="idle">3 comments · all resolved</AuroraPill>
          </div>
          {PR_COMMENTS.map((c, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: i < PR_COMMENTS.length - 1 ? '1px solid var(--line)' : 'none' }}>
              <AuroraAvatar name={c.who} hue={c.hue} size={30}/>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{c.who}</span>
                  <span style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>{c.time}</span>
                  {c.tag && <AuroraPill tone={c.tag === 'resolved' ? 'ok' : 'idle'}>{c.tag}</AuroraPill>}
                </div>
                <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.55 }}>{c.text}</div>
              </div>
            </div>
          ))}
        </AuroraCard>
      </div>

      {/* sidebar */}
      <div style={{ width: 280, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <AuroraCard padded style={{ padding: 16 }}>
          <div className="uppercase-label" style={{ marginBottom: 8 }}>Checks</div>
          {[['CI · Tests', 'ok', '12 passing'], ['CI · Build', 'ok', '34s'], ['CodeRabbit', 'ok', 'all resolved'], ['Vercel preview', 'ok', 'deployed']].map(([n, s, sub]) => (
            <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--ok)' }}/>
              <span style={{ flex: 1, fontSize: 12.5 }}>{n}</span>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>{sub}</span>
            </div>
          ))}
        </AuroraCard>

        <AuroraCard padded style={{ padding: 16 }}>
          <div className="uppercase-label" style={{ marginBottom: 8 }}>Reviewers</div>
          {[['Ashish', 28, 'approved'], ['CodeRabbit', 200, 'commented']].map(([n, h, st]) => (
            <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 0' }}>
              <AuroraAvatar name={n} hue={h} size={22}/>
              <span style={{ flex: 1, fontSize: 12.5 }}>{n}</span>
              <AuroraPill tone={st === 'approved' ? 'ok' : 'idle'}>{st}</AuroraPill>
            </div>
          ))}
        </AuroraCard>

        <AuroraCard padded style={{ padding: 16 }}>
          <div className="uppercase-label" style={{ marginBottom: 8 }}>Linked</div>
          <div style={{ fontSize: 12.5, padding: '6px 0', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="linear" size={11} color="var(--acc)"/><span style={{ flex: 1 }}>LIN-2843 Customer requesting refund</span>
          </div>
          <div style={{ fontSize: 12.5, padding: '6px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="play" size={11} color="var(--acc)"/><span style={{ flex: 1, fontFamily: 'var(--font-mono)' }}>run_8f3a91bc</span>
          </div>
        </AuroraCard>
      </div>
    </div>
  </V4Frame>
);

const PRDetailV1 = () => (
  <V1Frame active="prs" crumbs={['ALLEN', 'PR', '#2843']}
    actions={<><span className="pill pill-ok mono" style={{fontSize:9}}>CHECKS OK</span><button className="btn btn-primary mono" style={{fontSize:11}}>MERGE & CLOSE LIN-2843</button></>}>
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <div style={{ flex: 1, padding: 14, overflow: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11.5, borderRight: '1px solid var(--line)' }}>
        <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.06em', marginBottom: 8 }}>PR #2843 · refund-flow-fix → main · +60 −5 · 4 files</div>
        <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', padding: 10, marginBottom: 10 }}>
          <div style={{ color: 'var(--ink)' }}>Require refund reason before confirm</div>
          <div style={{ color: 'var(--ink-3)', marginTop: 2, fontSize: 10.5 }}>opened by refund-specialist · 38m ago · closes LIN-2843</div>
        </div>
        {PR_FILES.map((f, i) => (
          <div key={i} style={{ padding: '6px 10px', borderBottom: '1px solid var(--line)', display: 'flex', gap: 12, fontSize: 11, background: f.sel ? 'color-mix(in srgb, var(--acc) 8%, transparent)' : 'transparent' }}>
            <span style={{ flex: 1 }}>{f.p}</span>
            <span style={{ color: 'var(--ok)' }}>+{f.a}</span>
            <span style={{ color: 'var(--err)' }}>−{f.d}</span>
          </div>
        ))}
        <div style={{ height: 14 }}/>
        <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.06em', marginBottom: 6 }}>// COMMENTS / 3</div>
        {PR_COMMENTS.map((c, i) => (
          <div key={i} style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', padding: '8px 10px', marginBottom: 6 }}>
            <div style={{ color: c.who === 'CodeRabbit' ? 'var(--info)' : 'var(--acc)' }}>{c.who} <span style={{ color: 'var(--ink-3)' }}>· {c.time} {c.tag && '· ' + c.tag}</span></div>
            <div style={{ color: 'var(--ink-2)', marginTop: 2 }}>{c.text}</div>
          </div>
        ))}
      </div>
      <div style={{ width: 260, padding: 14, fontFamily: 'var(--font-mono)' }}>
        <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', marginBottom: 6 }}>CHECKS</div>
        {['ci.tests · 12 ok', 'ci.build · 34s ok', 'coderabbit · resolved', 'vercel · deployed'].map((s, i) => (
          <div key={i} style={{ fontSize: 11, padding: '3px 0', color: 'var(--ok)' }}>● {s}</div>
        ))}
        <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', marginTop: 14, marginBottom: 6 }}>LINKED</div>
        <div style={{ fontSize: 11, padding: '3px 0', color: 'var(--ink-2)' }}>LIN-2843</div>
        <div style={{ fontSize: 11, padding: '3px 0', color: 'var(--ink-2)' }}>run_8f3a91bc</div>
      </div>
    </div>
  </V1Frame>
);

const PRDetailV2 = () => (
  <V2Frame active="prs" title="Require refund reason before confirm" crumbs={['Pull requests', '#2843']}
    tabs={[{label:'Conversation', active:true, count:3},{label:'Files', count:4},{label:'Checks'},{label:'Commits', count:7}]}
    actions={<><span className="pill pill-ok">checks ok</span><button className="btn btn-primary">Merge</button></>}>
    <div style={{ display: 'flex', flex: 1, minHeight: 0, padding: 14, gap: 14 }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10, overflow: 'auto' }}>
        {PR_COMMENTS.map((c, i) => (
          <div key={i} style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8 }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)', background: 'var(--bg-2)', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <div style={{ width: 22, height: 22, borderRadius: '50%', background: c.who === 'CodeRabbit' ? '#0284c7' : '#5e6ad2', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10 }}>{c.avatar}</div>
              <span style={{ fontWeight: 500 }}>{c.who}</span>
              <span style={{ color: 'var(--ink-3)' }}>commented · {c.time}</span>
              <div style={{ flex: 1 }}/>
              {c.tag && <span className={`pill pill-${c.tag === 'resolved' ? 'ok' : 'idle'}`}>{c.tag}</span>}
            </div>
            <div style={{ padding: '12px 14px', fontSize: 13, color: 'var(--ink-2)' }}>{c.text}</div>
          </div>
        ))}
      </div>
      <div style={{ width: 240, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, padding: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 8 }}>Reviewers</div>
          {[['Ashish', 'approved'], ['CodeRabbit', 'commented']].map(([n, st]) => (
            <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
              <div style={{ width: 18, height: 18, borderRadius: '50%', background: '#5e6ad2' }}/>
              <span style={{ flex: 1, fontSize: 12 }}>{n}</span>
              <span className={`pill pill-${st === 'approved' ? 'ok' : 'idle'}`}>{st}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  </V2Frame>
);

const PRDetailV3 = () => (
  <V3Frame active="prs" title="#2843 · Require refund reason before confirm" subtitle="refund-flow-fix → main · +60 −5 · 4 files · 7 commits"
    actions={<>
      <button className="btn btn-line mono" style={{fontSize:11}}>← BACK</button>
      <button className="btn btn-primary mono" style={{fontSize:11}}>MERGE & CLOSE LIN-2843</button>
    </>}>
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <div style={{ flex: 1, padding: 0, overflow: 'auto' }}>
        <table className="mono" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
          <thead><tr style={{ borderBottom: '2px solid var(--ink)', background: 'var(--bg-1)', fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.06em' }}>
            <th style={{ padding: '8px 14px', textAlign: 'left' }}>FILE</th>
            <th style={{ padding: '8px 14px', textAlign: 'right' }}>+</th>
            <th style={{ padding: '8px 14px', textAlign: 'right' }}>−</th>
            <th style={{ padding: '8px 14px', textAlign: 'right' }}>STATUS</th>
          </tr></thead>
          <tbody>{PR_FILES.map((f, i) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--line)', background: f.sel ? 'var(--acc-dim)' : 'transparent' }}>
              <td style={{ padding: '6px 14px' }}>{f.p}</td>
              <td style={{ padding: '6px 14px', textAlign: 'right', color: 'var(--ok)' }}>+{f.a}</td>
              <td style={{ padding: '6px 14px', textAlign: 'right', color: 'var(--err)' }}>−{f.d}</td>
              <td style={{ padding: '6px 14px', textAlign: 'right', color: 'var(--ok)' }}>OK</td>
            </tr>))}
          </tbody>
        </table>
        <div style={{ padding: '14px 18px' }}>
          <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.06em', marginBottom: 8 }}>COMMENTS / 3 / ALL RESOLVED</div>
          {PR_COMMENTS.map((c, i) => (
            <div key={i} style={{ borderLeft: '2px solid var(--line)', padding: '6px 12px', marginBottom: 8, fontSize: 12, fontFamily: 'var(--font-mono)' }}>
              <div style={{ color: c.who === 'CodeRabbit' ? 'var(--info)' : 'var(--acc)' }}>{c.who} <span style={{ color: 'var(--ink-3)' }}>· {c.time}</span></div>
              <div style={{ color: 'var(--ink-2)', marginTop: 2 }}>{c.text}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  </V3Frame>
);

Object.assign(window, {
  ExecutionDetailV1, ExecutionDetailV2, ExecutionDetailV3, ExecutionDetailV4,
  WorkspaceDetailV1, WorkspaceDetailV2, WorkspaceDetailV3, WorkspaceDetailV4,
  PRDetailV1, PRDetailV2, PRDetailV3, PRDetailV4,
});
