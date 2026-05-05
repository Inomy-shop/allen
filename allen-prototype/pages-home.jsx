// Home / Inbox + Chat pages

// ===== HOME =====
function HomePage({ setRoute, openRun, execs }) {
  const live = execs.filter(e => e.status === 'running');
  const queued = execs.filter(e => e.status === 'queued');
  const done = execs.filter(e => e.status === 'completed');
  const totalCost = execs.reduce((s,e) => s + e.cost, 0);

  const interventions = window.MOCK.INTERVENTIONS.filter(i => i.state === 'pending');

  return (
    <div className="content scroll-hide">
      <div className="page-head">
        <div>
          <h2>Good afternoon, Manish</h2>
          <div className="sub muted">3 things need you · 2 runs in flight · 1 PR ready for review</div>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => setRoute('workflows')}><Icons.flow size={14}/> Workflows</button>
          <button className="btn primary" onClick={() => setRoute('chat')}><Icons.sparkle size={14}/> Assign a task</button>
        </div>
      </div>

      <div className="kpi-grid" style={{marginBottom: 18}}>
        <div className="kpi">
          <div className="lab">In flight</div>
          <div className="val">{live.length}</div>
          <div className="delta up"><Icons.lightning size={12}/> {queued.length} queued</div>
        </div>
        <div className="kpi">
          <div className="lab">Awaiting you</div>
          <div className="val" style={{color:'var(--warn)'}}>{interventions.length}</div>
          <div className="delta">↳ {interventions.length} interventions</div>
        </div>
        <div className="kpi">
          <div className="lab">Completed today</div>
          <div className="val">{done.length}</div>
          <div className="delta up">+18% vs yesterday</div>
        </div>
        <div className="kpi">
          <div className="lab">Spend today</div>
          <div className="val">${totalCost.toFixed(2)}</div>
          <div className="delta muted">$0.38 avg / msg</div>
        </div>
      </div>

      <div className="grid-2" style={{gap: 18, marginBottom: 18}}>
        {/* Needs you */}
        <div className="card">
          <div className="card-head">
            <h3>Needs you</h3>
            <span className="sub">{interventions.length} pending</span>
            <div className="right">
              <button className="btn ghost sm" onClick={() => setRoute('interventions')}>View all <Icons.chevR size={12}/></button>
            </div>
          </div>
          <div>
            {interventions.map(iv => (
              <div key={iv.id} style={{padding:'14px 16px', borderTop:'1px solid var(--border-2)', cursor:'pointer'}}
                   onClick={() => setRoute('interventions')}>
                <div className="row" style={{marginBottom: 6}}>
                  <span className={`chip ${iv.sev}`}><span className={`dot ${iv.sev}`}/>{iv.kind}</span>
                  <span className="muted-2 mono" style={{fontSize:11}}>{iv.age} · {iv.wf}</span>
                </div>
                <div style={{fontWeight: 500, marginBottom: 4}}>{iv.ttl}</div>
                <div className="muted" style={{fontSize: 12, lineHeight: 1.5,
                     display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical', overflow:'hidden'}}>
                  {iv.body}
                </div>
              </div>
            ))}
            {interventions.length === 0 && <div className="empty">All clear</div>}
          </div>
        </div>

        {/* Live runs */}
        <div className="card">
          <div className="card-head">
            <h3>In flight</h3>
            <span className="sub">live</span>
            <div className="right">
              <span className="chip"><span className="dot accent pulse"/>{live.length} running</span>
              <button className="btn ghost sm" onClick={() => setRoute('executions')}>View all <Icons.chevR size={12}/></button>
            </div>
          </div>
          <div>
            {live.slice(0,3).map(e => (
              <div key={e.id} style={{padding:'14px 16px', borderTop:'1px solid var(--border-2)', cursor:'pointer'}}
                   onClick={() => openRun(e.id)}>
                <div className="row" style={{marginBottom: 6}}>
                  <span className="mono" style={{fontWeight:600, fontSize:12}}>{e.id}</span>
                  <span className="chip info"><Icons.spinner size={10}/> running</span>
                  <span className="muted-2 mono" style={{fontSize:11, marginLeft:'auto'}}>{e.dur.toFixed(0)}s · ${e.cost.toFixed(2)}</span>
                </div>
                <div style={{fontWeight:500, marginBottom: 8, fontSize: 13}}>{e.wf}</div>
                <div className="bar"><i className="live-stripe" style={{width: Math.min(95, 30 + e.dur/3) + '%'}} /></div>
              </div>
            ))}
            {queued.slice(0,2).map(e => (
              <div key={e.id} style={{padding:'12px 16px', borderTop:'1px solid var(--border-2)', cursor:'pointer'}}
                   onClick={() => openRun(e.id)}>
                <div className="row">
                  <span className="mono" style={{fontWeight:600, fontSize:12}}>{e.id}</span>
                  <span className="chip warn"><span className="dot warn"/>queued</span>
                  <span className="muted" style={{fontSize: 13, marginLeft:8}}>{e.wf}</span>
                  <span className="muted-2 mono" style={{fontSize:11, marginLeft:'auto'}}>{e.started}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid-2" style={{gap: 18}}>
        {/* Quick assign */}
        <div className="card">
          <div className="card-head">
            <h3>Quick assign</h3>
            <span className="sub">describe what you need; allen routes it</span>
          </div>
          <div className="card-body">
            <div className="chat-input" style={{background: 'var(--panel-2)'}}>
              <textarea
                placeholder="e.g. Fix ENG-1453 (CART_GATED_PRICE) on es-data-pipeline. Add tests. Draft a PR for review."
                onClick={() => setRoute('chat')}
                readOnly
              />
              <div className="row">
                <span className="pill"><Icons.repo size={11}/> es-data-pipeline</span>
                <span className="pill"><Icons.flow size={11}/> bug-investigate-and-fix</span>
                <span className="pill" style={{borderStyle:'solid'}}><Icons.linear size={11}/> ENG-1453</span>
                <div className="right">
                  <button className="btn primary sm" onClick={() => setRoute('chat')}>
                    <Icons.send size={12}/> Dispatch
                  </button>
                </div>
              </div>
            </div>
            <div className="prompts" style={{marginTop: 12}}>
              <div className="prompt-chip" onClick={() => setRoute('chat')}>📐 Plan ENG-1453</div>
              <div className="prompt-chip" onClick={() => setRoute('chat')}>🔍 Investigate flaky tests</div>
              <div className="prompt-chip" onClick={() => setRoute('chat')}>🧪 Resolve CodeRabbit on PR #598</div>
              <div className="prompt-chip" onClick={() => setRoute('chat')}>🗺️ Tour ip-seller-portal</div>
            </div>
          </div>
        </div>

        {/* Recent activity feed */}
        <div className="card">
          <div className="card-head">
            <h3>Activity</h3>
            <span className="sub">last 30 min</span>
            <div className="right"><button className="btn ghost sm">All <Icons.chevR size={12}/></button></div>
          </div>
          <div style={{padding: '4px 0'}}>
            {[
              { t:'just now', msg:<><b>impl-orchestrator</b> opened workspace <span className="mono">pr-570-schema_queries…</span></>, ico:'workspace' },
              { t:'2m', msg:<><b>plan-gate</b> requested approval for ENG-1453</>, ico:'intervene', sev:'warn' },
              { t:'4m', msg:<><b>qa-runner</b> ran 184 tests · <span style={{color:'var(--ok)'}}>184 passed</span></>, ico:'check' },
              { t:'6m', msg:<><b>security-reviewer</b> flagged 1 medium concern on diff</>, ico:'bug', sev:'warn' },
              { t:'10m', msg:<><b>resolve-pr-reviews</b> finished on PR #598 · <span className="mono">$5.61</span></>, ico:'pr' },
              { t:'14m', msg:<><b>code-rabbit-resolver</b> queued for PR #605</>, ico:'pr' },
              { t:'22m', msg:<><b>chat:classification-judge</b> completed · <span className="mono">$5.74</span></>, ico:'check' },
            ].map((a,i) => {
              const I = Icons[a.ico];
              return (
                <div key={i} className="row" style={{padding:'10px 16px', borderTop:'1px solid var(--border-2)', gap: 10}}>
                  <div style={{width:24, height:24, borderRadius:6, background:'var(--bg-2)', display:'grid', placeItems:'center',
                       color: a.sev === 'warn' ? 'var(--warn)' : 'var(--ink-3)'}}>
                    <I size={12}/>
                  </div>
                  <div style={{fontSize: 13, flex: 1}}>{a.msg}</div>
                  <div className="muted-2 mono" style={{fontSize: 11}}>{a.t}</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ===== CHAT =====
const CHAT_THREADS = [
  { id:'t1', ttl:'Fix CART_GATED_PRICE chain miss', sub:'feature-plan-and-implement', dot:'info', last:'now', active:true },
  { id:'t2', ttl:'Schema fitness analytics tab', sub:'feature-plan-and-implement', dot:'mute', last:'2h' },
  { id:'t3', ttl:'CodeRabbit comments on #598', sub:'resolve-pr-reviews', dot:'mute', last:'4h' },
  { id:'t4', ttl:'Tour the inomy-mono repo', sub:'unfamiliar-codebase-tour', dot:'mute', last:'1d' },
  { id:'t5', ttl:'Furniture stage 6F re-run', sub:'understand-and-plan', dot:'ok', last:'1d' },
];

function ChatPage({ setRoute, openRun }) {
  const [text, setText] = useState('');
  const [thread, setThread] = useState('t1');

  return (
    <div className="content-wide">
      <div className="chat-wrap">
        <div className="chat-main">
          <div style={{padding:'14px 28px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:12}}>
            <Icons.chat size={16}/>
            <div>
              <div style={{fontWeight: 600, fontSize: 14}}>Fix CART_GATED_PRICE chain miss</div>
              <div className="muted" style={{fontSize: 12}}>linked: <span className="chip" style={{verticalAlign:'middle'}}><Icons.linear size={10}/> ENG-1453</span> · <span className="chip"><Icons.repo size={10}/> es-data-pipeline</span></div>
            </div>
            <div style={{marginLeft:'auto', display:'flex', gap:6}}>
              <button className="btn ghost sm"><Icons.more size={14}/></button>
            </div>
          </div>

          <div className="chat-stream scroll-hide">
            <div className="chat-msg user">
              <div className="who">manish · 4:24 pm</div>
              <div className="body">Pricing on Amazon is failing for CART_GATED_PRICE — see ENG-1453. Investigate, propose a fix, implement on es-data-pipeline, run tests, open a PR. Pause for my approval before merging.</div>
            </div>

            <div className="chat-msg">
              <div className="who"><Icons.sparkle size={12}/> allen · 4:24 pm</div>
              <div className="body">
                <p>Got it. I'll dispatch the <b>feature-plan-and-implement</b> workflow targeting <span className="mono">es-data-pipeline / development</span>. Two human gates: one after planning, one before merge.</p>
                <div className="agent-card">
                  <div className="head">
                    <Icons.flow size={14} />
                    <span className="ttl">feature-plan-and-implement</span>
                    <span className="chip info"><Icons.spinner size={10}/> running</span>
                    <span className="meta" style={{marginLeft:'auto'}}>ae966eb9 · 154s · $0.92</span>
                  </div>
                  <div className="row" style={{flexWrap:'wrap', gap: 6, marginBottom: 10}}>
                    <span className="chip ok"><Icons.check size={10}/> intake</span>
                    <span className="chip ok"><Icons.check size={10}/> clarify</span>
                    <span className="chip ok"><Icons.check size={10}/> PRD</span>
                    <span className="chip ok"><Icons.check size={10}/> HLA</span>
                    <span className="chip info"><Icons.spinner size={10}/> TDD</span>
                    <span className="chip"><span className="dot"/> implement</span>
                    <span className="chip"><span className="dot"/> QA</span>
                    <span className="chip"><span className="dot"/> security</span>
                    <span className="chip"><span className="dot"/> open PR</span>
                  </div>
                  <button className="btn sm" onClick={() => openRun('ae966eb9')}>
                    <Icons.exec size={12}/> Open run trace
                  </button>
                </div>
              </div>
            </div>

            <div className="chat-msg">
              <div className="who"><Icons.intervene size={12}/> plan-gate · 4:28 pm</div>
              <div className="body">
                <p>I have a clarification before producing the PRD. Is the existing vendor allowlist a hard constraint for the new pricing path?</p>
                <div className="agent-card" style={{borderColor:'color-mix(in oklch, var(--warn) 35%, transparent)'}}>
                  <div className="head">
                    <Icons.intervene size={14} style={{color:'var(--warn)'}}/>
                    <span className="ttl">Awaiting answer</span>
                    <span className="chip warn">human gate</span>
                    <span className="meta" style={{marginLeft:'auto'}}>posted 2m ago</span>
                  </div>
                  <div className="col" style={{gap:6}}>
                    <button className="btn sm" style={{justifyContent:'flex-start'}}>(a) Allowlist is required — block new vendors</button>
                    <button className="btn sm" style={{justifyContent:'flex-start'}}>(b) Skip allowlist for new path, log usage</button>
                    <button className="btn ghost sm" style={{justifyContent:'flex-start', color:'var(--ink-3)'}}>Type a custom answer…</button>
                  </div>
                </div>
              </div>
            </div>

            <div className="chat-msg user">
              <div className="who">manish · 4:29 pm</div>
              <div className="body">(b) Skip allowlist for new path, log usage. Add a metric for unexpected vendors.</div>
            </div>

            <div className="chat-msg">
              <div className="who"><Icons.sparkle size={12}/> allen · 4:30 pm</div>
              <div className="body">
                <p>Acknowledged. Resuming the planning phase. I'll surface the next gate when the PRD + HLA + TDD are ready for your approval.</p>
                <p className="muted cursor" style={{fontSize: 12}}>Streaming PRD section 2 of 4</p>
              </div>
            </div>
          </div>

          <div className="chat-input-wrap">
            <div className="prompts">
              <div className="prompt-chip">+ link Linear ticket</div>
              <div className="prompt-chip">+ pick repo</div>
              <div className="prompt-chip">+ choose workflow</div>
            </div>
            <div className="chat-input">
              <textarea
                placeholder="Reply, ask a follow-up, or assign a new task…"
                value={text}
                onChange={e => setText(e.target.value)}
              />
              <div className="row">
                <span className="pill"><Icons.repo size={11}/> es-data-pipeline · development</span>
                <span className="pill"><Icons.flow size={11}/> feature-plan-and-implement</span>
                <span className="pill" style={{borderStyle:'solid'}}><Icons.linear size={11}/> ENG-1453</span>
                <div className="right">
                  <button className="btn ghost sm"><Icons.attach size={14}/></button>
                  <button className="btn primary sm">
                    <Icons.send size={12}/> Send
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <aside className="chat-side scroll-hide">
          <div className="chat-side-head">
            <h3>Threads</h3>
            <button className="btn ghost sm" style={{marginLeft:'auto'}}><Icons.plus size={14}/></button>
          </div>
          <div className="chat-side-list scroll-hide">
            {CHAT_THREADS.map(t => (
              <div key={t.id} className={`chat-thread ${t.id === thread ? 'active' : ''}`} onClick={() => setThread(t.id)}>
                <div className="ttl">{t.ttl}</div>
                <div className="meta">
                  <span className={`dot ${t.dot === 'mute' ? '' : t.dot}`} style={{display:'inline-block'}}/>
                  <span>{t.sub}</span>
                  <span style={{marginLeft:'auto'}}>{t.last}</span>
                </div>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

window.HomePage = HomePage;
window.ChatPage = ChatPage;
