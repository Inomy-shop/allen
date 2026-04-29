// chat.jsx — Chat page, three variations

const conversations = [
  { id: 1, title: 'I want to structure the tabs on the UI of the ESD', agent: 'Codex', time: '23h', msgs: 28, active: true, status: 'err' },
  { id: 2, title: 'Can you read the chat code?', agent: 'Codex', time: '22h', msgs: 8, status: 'ok' },
  { id: 3, title: '@es-data-pipeline I want to add tier1 prefix support…', agent: 'Codex', time: '24h', msgs: 13 },
  { id: 4, title: '@es-data-pipeline I want to add a new validator', agent: 'Codex', time: '24h', msgs: 13 },
  { id: 5, title: '@es-data-pipeline https://github.com/k…', agent: 'Claude', time: '13h', msgs: 6 },
  { id: 6, title: 'So I did an audit of our pipeline and found three…', agent: 'Claude', time: '5d', msgs: 28 },
  { id: 7, title: 'In the ES data pipeline, the variant counter…', agent: 'Claude', time: '1h', msgs: 28 },
];

const messages = [
  { from: 'assistant', time: '17:43', body: 'I implemented an early-exit branch in the engineering-lead workflow that routes back to frontend-developer.', tracking: 'esdp-nav-rewire-2026-04-28-03' },
  { from: 'you', time: '17:44', body: "why don't you assign the task to codex?" },
  { from: 'assistant', time: '17:44', dur: '22.1s', body: <>
    Because <code>Codex</code> is the agent you're already talking to here, not a separate Allen team agent I can delegate to.
    {'\n\n'}In this setup:
    <ul style={{ paddingLeft: 18, margin: '6px 0' }}>
      <li><code>delegate_to_agent</code> can only send work to registered Allen agents like <code>engineering-lead</code>, <code>frontend-developer</code>, <code>backend-developer</code>, etc.</li>
      <li>there is no separate delegate target named <code>codex</code> in the available agent graph</li>
      <li>if you want "Codex to do it," the practical equivalent is either:</li>
    </ul>
    – implement it directly in this session, or<br/>
    – route it to the narrowest matching engineering agent, which here is <code>frontend-developer</code>.
    {'\n\n'}Given the failed <code>engineering-lead</code> run, the clean next move is to assign it directly to <code>frontend-developer</code> or I can do the patch myself here.
  </>, tracking: 'esdp-nav-rewire-2026-04-28-04' },
  { from: 'you', time: '17:46', body: 'no but those agents cannot use codex?' },
  { from: 'assistant', time: '17:46', error: 'Codex exited with code 1' },
];

// Inline code style helper for v1
const inlineCodeV1 = (text) => <code style={{ background: 'var(--bg-3)', color: 'var(--acc)', padding: '1px 5px', borderRadius: 3, fontFamily: 'var(--font-mono)', fontSize: 11 }}>{text}</code>;

// =============================================================
// V1 — Mission Control Chat
// =============================================================
const ChatV1 = () => (
  <V1Frame active="chat" crumbs={['Chat', 'I want to structure the tabs on…']}
    actions={<><span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>3/3 · $0.06</span></>}>
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      {/* conversations */}
      <div style={{ width: 240, borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column', background: 'var(--bg-1)' }}>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="uppercase-label" style={{ flex: 1 }}>CONVERSATIONS</span>
          <Icon name="plus" size={12} color="var(--acc)"/>
        </div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          {conversations.map(c => (
            <div key={c.id} style={{
              padding: '8px 12px', borderBottom: '1px solid var(--line)',
              background: c.active ? 'color-mix(in srgb, var(--acc) 8%, transparent)' : 'transparent',
              borderLeft: c.active ? '2px solid var(--acc)' : '2px solid transparent',
              cursor: 'pointer',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className={`dot dot-${c.status === 'err' ? 'err' : c.status === 'ok' ? 'ok' : 'idle'}`}/>
                <span style={{ flex: 1, fontSize: 12, color: c.active ? 'var(--ink)' : 'var(--ink-2)', fontWeight: c.active ? 500 : 400 }} className="truncate">{c.title}</span>
              </div>
              <div style={{ fontSize: 10, color: 'var(--ink-3)', marginTop: 3, fontFamily: 'var(--font-mono)' }}>
                {c.agent} · {c.time} · {c.msgs} msg
              </div>
            </div>
          ))}
        </div>
      </div>
      {/* main */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{ flex: 1, padding: '14px 24px', overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {messages.slice(0, 4).map((m, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: m.from === 'you' ? 'row-reverse' : 'row', gap: 10, alignItems: 'flex-start' }}>
              <div style={{ width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                background: m.from === 'you' ? 'linear-gradient(135deg,#5eead4,#818cf8)' : 'var(--bg-3)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 600 }}>
                {m.from === 'you' ? 'A' : '∿'}
              </div>
              <div style={{ maxWidth: m.from === 'you' ? 360 : '70%' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 4, justifyContent: m.from === 'you' ? 'flex-end' : 'flex-start' }}>
                  <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>
                    {m.from === 'you' ? 'YOU' : 'Assistant'} · {m.time}{m.dur ? ` · ${m.dur}` : ''}
                  </span>
                </div>
                <div style={{
                  background: m.from === 'you' ? 'color-mix(in srgb, var(--acc) 14%, transparent)' : 'var(--bg-1)',
                  border: '1px solid var(--line)', borderRadius: 6, padding: '8px 12px', fontSize: 12, lineHeight: 1.55,
                  color: m.from === 'you' ? 'var(--ink)' : 'var(--ink-2)',
                  whiteSpace: 'pre-wrap',
                }}>
                  {m.body}
                </div>
                {m.tracking && (
                  <div style={{ marginTop: 4, fontSize: 10, color: 'var(--ink-3)', fontFamily: 'var(--font-mono)' }}>
                    Tracking ID: {m.tracking}
                  </div>
                )}
              </div>
            </div>
          ))}
          <div style={{ alignSelf: 'flex-start', display: 'inline-flex', gap: 8, padding: '6px 10px', background: 'color-mix(in srgb, var(--err) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--err) 30%, transparent)', borderRadius: 4, fontSize: 11, color: 'var(--err)', fontFamily: 'var(--font-mono)' }}>
            <Icon name="x" size={11}/> Codex exited with code 1
          </div>
        </div>
        {/* input */}
        <div style={{ borderTop: '1px solid var(--line)', padding: 12, background: 'var(--bg-1)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: 10, border: '1px solid var(--line-2)', borderRadius: 6, background: 'var(--bg)' }}>
            <Icon name="chat" size={13} color="var(--ink-3)" />
            <div style={{ flex: 1, fontSize: 12, color: 'var(--ink-3)' }}>Message Codex… use @ to mention an agent or # for a workflow</div>
            <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', background: 'var(--bg-3)', padding: '2px 5px', borderRadius: 3 }}>↵ send</span>
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            {['Assistant', 'Agent Builder', 'Brainstormer', 'ESD', 'Engineering Lead', 'PR Review Bot', 'Product Manager', 'QA Lead', 'Team Builder', 'Workflow Builder'].map((a, i) => (
              <span key={i} className="chip" style={{ background: i === 0 ? 'color-mix(in srgb, var(--acc) 14%, transparent)' : 'var(--bg-3)', color: i === 0 ? 'var(--acc)' : 'var(--ink-3)' }}>{a}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  </V1Frame>
);

// =============================================================
// V2 — Linear-clean Chat
// =============================================================
const ChatV2 = () => (
  <V2Frame active="chat" title="Tabs on the ESD" crumbs={['Inbox', 'Tabs on the ESD']}
    actions={
      <>
        <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>$0.06 · 3/3 messages</span>
        <button className="btn btn-line"><Icon name="dot-menu" size={12}/></button>
      </>
    }>
    <div style={{ flex: 1, display: 'flex', minHeight: 0, padding: '0 24px 0', gap: 16 }}>
      <div style={{ width: 260, padding: '12px 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 500, flex: 1 }}>Conversations</span>
          <button className="btn btn-line" style={{ padding: '3px 6px' }}><Icon name="plus" size={11}/></button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', borderRadius: 6, background: 'var(--bg-1)', border: '1px solid var(--line)', fontSize: 12, color: 'var(--ink-3)' }}>
          <Icon name="search" size={11}/>
          <span>Search…</span>
        </div>
        <div style={{ flex: 1, overflow: 'hidden', marginTop: 4 }}>
          {conversations.map(c => (
            <div key={c.id} style={{
              padding: '8px 10px', borderRadius: 6, marginBottom: 2,
              background: c.active ? 'var(--bg-1)' : 'transparent',
              border: c.active ? '1px solid var(--line)' : '1px solid transparent',
              cursor: 'pointer',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <span style={{ fontSize: 12, fontWeight: 500, flex: 1, color: c.active ? 'var(--ink)' : 'var(--ink-2)' }} className="truncate">{c.title}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="chip" style={{ fontSize: 10 }}>{c.agent}</span>
                <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>{c.time} · {c.msgs}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, paddingTop: 12 }}>
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {messages.slice(1, 4).map((m, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <div style={{ width: 28, height: 28, borderRadius: 8, flexShrink: 0,
                background: m.from === 'you' ? 'linear-gradient(135deg,#5e6ad2,#06b6d4)' : 'var(--bg-2)',
                border: '1px solid var(--line)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600 }}>
                {m.from === 'you' ? 'A' : <AllenLogo size={14} color="var(--ink)"/>}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{m.from === 'you' ? 'You' : 'Codex'}</span>
                  <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>{m.time}{m.dur ? ` · ${m.dur}` : ''}</span>
                  {m.tracking && <span className="chip" style={{ fontSize: 10 }}>{m.tracking}</span>}
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--ink)', whiteSpace: 'pre-wrap' }}>
                  {m.body}
                </div>
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--bg-2)', border: '1px solid var(--line)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><AllenLogo size={14}/></div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'color-mix(in srgb, var(--err) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--err) 25%, transparent)', borderRadius: 8, fontSize: 12, color: 'var(--err)' }}>
              <Icon name="x" size={12}/> Codex exited with code 1
              <button className="btn btn-line" style={{ marginLeft: 8, padding: '2px 8px', fontSize: 11 }}>Retry</button>
            </div>
          </div>
        </div>
        <div style={{ paddingBottom: 16, paddingTop: 10 }}>
          <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 12, padding: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
            <div style={{ fontSize: 13, color: 'var(--ink-3)', minHeight: 36 }}>Reply to Codex…</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <button className="btn btn-line" style={{ fontSize: 11 }}>@ mention agent</button>
              <button className="btn btn-line" style={{ fontSize: 11 }}># workflow</button>
              <button className="btn btn-line" style={{ fontSize: 11 }}>+ context</button>
              <div style={{ flex: 1 }}/>
              <span style={{ fontSize: 11, color: 'var(--ink-3)' }} className="mono">⌘↵</span>
              <button className="btn btn-primary">Send</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </V2Frame>
);

// =============================================================
// V3 — Operator Chat (single-pane, dense)
// =============================================================
const ChatV3 = () => (
  <V3Frame active="chat" title="Tabs on the ESD" subtitle={`Conversation · 28 msg · agent: Codex`}
    actions={
      <>
        <button className="btn btn-line mono">RETRY</button>
        <button className="btn btn-line mono">EXPORT</button>
        <button className="btn btn-primary mono">+ NEW</button>
      </>
    }>
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <div style={{ width: 280, borderRight: '1px solid var(--ink)', background: 'var(--bg-1)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--ink)', background: 'var(--bg-2)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon name="search" size={11}/>
          <input style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--ink)' }} placeholder="filter conversations…"/>
          <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>{conversations.length}</span>
        </div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          {conversations.map((c, i) => (
            <div key={c.id} style={{
              padding: '7px 12px', borderBottom: '1px solid var(--line)',
              background: c.active ? 'var(--bg)' : 'transparent',
              borderLeft: c.active ? '3px solid var(--acc)' : '3px solid transparent',
              cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 2,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', width: 18 }}>{String(i + 1).padStart(2, '0')}</span>
                <span style={{ flex: 1, fontSize: 12, fontWeight: c.active ? 600 : 400 }} className="truncate">{c.title}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 24, fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--ink-3)' }}>
                <span>{c.agent}</span><span>·</span><span>{c.time}</span><span>·</span><span>{c.msgs}m</span>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{ flex: 1, overflow: 'hidden', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {messages.slice(0, 4).map((m, i) => (
            <div key={i} style={{ borderLeft: '2px solid var(--ink)', paddingLeft: 12 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                <span style={{ fontWeight: 600, color: m.from === 'you' ? 'var(--acc)' : 'var(--ink)' }}>{m.from === 'you' ? '> YOU' : '> CODEX'}</span>
                <span style={{ color: 'var(--ink-3)' }}>{m.time}{m.dur ? ` · ${m.dur}` : ''}</span>
                {m.tracking && <span style={{ color: 'var(--ink-3)' }}>· id={m.tracking}</span>}
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{m.body}</div>
            </div>
          ))}
          <div style={{ borderLeft: '2px solid var(--err)', paddingLeft: 12, color: 'var(--err)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            ! ERR · Codex exited with code 1
          </div>
        </div>
        <div style={{ borderTop: '1px solid var(--ink)', background: 'var(--bg-1)', padding: 0 }}>
          <div style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            <span style={{ color: 'var(--acc)' }}>~/inomy/main$</span>
            <input style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: 13, fontFamily: 'inherit', color: 'var(--ink)' }} placeholder="message · @agent · #workflow · /command"/>
            <span style={{ color: 'var(--ink-3)' }}>⌘↵ send</span>
          </div>
          <div style={{ borderTop: '1px solid var(--line)', padding: '6px 16px', display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--ink-3)' }}>
            <span>AGENT:</span>
            {['assistant', 'agent-builder', 'brainstormer', 'esd', 'eng-lead', 'pr-review-bot', 'pm', 'qa-lead', 'team-builder', 'workflow-builder'].map((a, i) => (
              <span key={i} style={{ color: i === 0 ? 'var(--ink)' : 'var(--ink-3)', fontWeight: i === 0 ? 600 : 400, borderBottom: i === 0 ? '1px solid var(--acc)' : '1px solid transparent', paddingBottom: 1, cursor: 'pointer' }}>{a}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  </V3Frame>
);

window.ChatV1 = ChatV1;
window.ChatV2 = ChatV2;
window.ChatV3 = ChatV3;
