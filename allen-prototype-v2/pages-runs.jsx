// Run trace + executions + interventions

function RunTracePage({ runId, execs, setRoute }) {
  const exec = execs.find(e => e.id === runId) || execs[0];
  const [activeNode, setActiveNode] = useState('tdd');
  const [logs, setLogs] = useState([]);

  // streaming logs
  useEffect(() => {
    const seed = [
      { ts:'16:27:48', lvl:'info', msg:'orchestrator started: feature-plan-and-implement' },
      { ts:'16:27:49', lvl:'tool', msg:'al:wait_for_delegation(intake-clarifier)' },
      { ts:'16:27:52', lvl:'info', msg:'intake-clarifier: ask is unambiguous, proceeding' },
      { ts:'16:27:55', lvl:'tool', msg:'al:delegate_to_agent(prd-writer)' },
      { ts:'16:28:21', lvl:'ok',   msg:'prd-writer ✓ produced PRD (1.2k tokens)' },
      { ts:'16:28:23', lvl:'tool', msg:'al:delegate_to_agent(hla-writer)' },
      { ts:'16:28:54', lvl:'ok',   msg:'hla-writer ✓ produced HLA (842 tokens)' },
      { ts:'16:29:01', lvl:'tool', msg:'al:delegate_to_agent(prd-auditor || hla-auditor)' },
      { ts:'16:29:14', lvl:'ok',   msg:'prd-auditor ✓ approved' },
      { ts:'16:29:18', lvl:'ok',   msg:'hla-auditor ✓ approved' },
      { ts:'16:29:22', lvl:'tool', msg:'al:delegate_to_agent(tdd-writer)' },
      { ts:'16:29:40', lvl:'info', msg:'tdd-writer: drafting test plan for pricing chain' },
    ];
    setLogs([]);
    let i = 0;
    const t = setInterval(() => {
      if (i < seed.length) {
        setLogs(l => [...l, seed[i]]);
        i++;
      } else {
        const lvls = [
          { lvl:'tool', msg:'Bash: pytest tests/pricing/ -k cart_gated -v' },
          { lvl:'info', msg:'... 12 collected' },
          { lvl:'ok',   msg:'12 passed in 4.31s' },
          { lvl:'tool', msg:'al:save_learning(cart_gated_chain)' },
          { lvl:'info', msg:'tdd-writer streaming section 3/4' },
        ];
        const pick = lvls[Math.floor(Math.random()*lvls.length)];
        setLogs(l => [...l, { ts: new Date().toTimeString().slice(0,8), ...pick }].slice(-40));
      }
    }, 800);
    return () => clearInterval(t);
  }, [runId]);

  const dag = [
    { id:'intake', nm:'intake-clarifier', state:'ok', meta:'12s · $0.04', icon:'chat' },
    { id:'prd',    nm:'prd-writer',       state:'ok', meta:'32s · $0.18', icon:'file' },
    { id:'hla',    nm:'hla-writer',       state:'ok', meta:'31s · $0.14', icon:'flow' },
    { id:'audit',  nm:'prd-auditor ‖ hla-auditor', state:'ok', meta:'13s · $0.11 · parallel', icon:'check' },
    { id:'tdd',    nm:'tdd-writer',       state:'run', meta:'streaming…', icon:'file' },
    { id:'gate',   nm:'plan-gate (human)', state:'wait', meta:'will pause', icon:'intervene' },
    { id:'impl',   nm:'developer-orchestrator',  state:'idle', meta:'queued', icon:'flow' },
    { id:'qa',     nm:'qa-runner',        state:'idle', meta:'queued', icon:'check' },
    { id:'sec',    nm:'security-reviewer', state:'idle', meta:'queued', icon:'bug' },
    { id:'pr',     nm:'pr-opener',        state:'idle', meta:'queued', icon:'pr' },
    { id:'sum',    nm:'summary-poster',   state:'idle', meta:'queued', icon:'chat' },
  ];

  return (
    <div className="content-wide">
      <div style={{padding:'12px 24px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:12}}>
        <button className="btn ghost sm" onClick={() => setRoute('executions')}><Icons.chevL size={14}/> All runs</button>
        <span className="mono" style={{fontWeight:600}}>{exec?.id}</span>
        <span className="muted">·</span>
        <span style={{fontWeight: 500}}>{exec?.wf}</span>
        <span className="chip info" style={{marginLeft: 8}}><Icons.spinner size={10}/> running</span>
        <div style={{marginLeft:'auto', display:'flex', gap: 6}}>
          <span className="chip mono">{exec?.dur.toFixed(0)}s</span>
          <span className="chip mono">${exec?.cost.toFixed(2)}</span>
          <button className="btn sm"><Icons.workspace size={12}/> Open workspace</button>
          <button className="btn sm" style={{color:'var(--err)'}}><Icons.x size={12}/> Cancel</button>
        </div>
      </div>

      <div className="run-grid" style={{flex: 1}}>
        <div className="run-pane left scroll-hide">
          <div className="card-head" style={{borderRadius:0, borderBottom:'1px solid var(--border)'}}>
            <h3>Trace</h3>
            <span className="sub">{dag.length} nodes</span>
          </div>
          <div className="dag">
            {dag.map((n, i) => {
              const I = Icons[n.icon];
              const active = activeNode === n.id;
              const cls = n.state === 'run' ? 'running' : '';
              return (
                <React.Fragment key={n.id}>
                  <div className={`dag-node ${cls} ${active ? 'active' : ''}`} onClick={() => setActiveNode(n.id)}>
                    <I size={14}/>
                    <div style={{flex: 1, minWidth: 0}}>
                      <div className="nm">{n.nm}</div>
                      <div className="meta">{n.meta}</div>
                    </div>
                    {n.state === 'ok' && <Icons.check size={14} style={{color:'var(--ok)'}}/>}
                    {n.state === 'run' && <Icons.spinner size={14} style={{color:'var(--accent)'}}/>}
                    {n.state === 'wait' && <span className="dot warn"/>}
                    {n.state === 'idle' && <span className="dot"/>}
                  </div>
                  {i < dag.length-1 && <div className="dag-connector" />}
                </React.Fragment>
              );
            })}
          </div>
        </div>

        <div style={{display:'flex', flexDirection:'column', minWidth: 0, overflow:'hidden'}}>
          <div className="tabs">
            <div className="tab active">Logs <span className="ct">{logs.length}</span></div>
            <div className="tab">Diff <span className="ct">42</span></div>
            <div className="tab">Tools <span className="ct">28</span></div>
            <div className="tab">Cost <span className="ct">$0.92</span></div>
          </div>
          <div className="log-stream scroll-hide">
            {logs.map((l, i) => (
              <div key={i} className={`log-line ${i === logs.length-1 ? 'cur' : ''}`}>
                <span className="ts">{l.ts || ''}</span>
                <span className={`lvl ${l.lvl}`}>{l.lvl.toUpperCase()}</span>
                <span className="msg">{l.msg}</span>
              </div>
            ))}
            <div className="log-line"><span className="ts"></span><span className="lvl info">···</span><span className="msg cursor"></span></div>
          </div>
        </div>

        <div className="run-pane right scroll-hide">
          <div className="card-head" style={{borderRadius:0, borderBottom:'1px solid var(--border)'}}>
            <h3>Context</h3>
          </div>
          <div style={{padding: '14px 16px'}}>
            <div className="muted-2 mono" style={{fontSize:10, textTransform:'uppercase', letterSpacing:'0.08em', marginBottom: 6}}>Repo</div>
            <div className="row" style={{marginBottom: 14}}>
              <Icons.repo size={14}/>
              <span className="mono" style={{fontSize:13}}>es-data-pipeline</span>
              <span className="chip">development</span>
            </div>
            <div className="muted-2 mono" style={{fontSize:10, textTransform:'uppercase', letterSpacing:'0.08em', marginBottom: 6}}>Linked</div>
            <div className="row" style={{marginBottom: 14}}>
              <Icons.linear size={14}/>
              <span className="mono" style={{fontSize:13}}>ENG-1453</span>
              <span className="muted" style={{fontSize: 12}}>Pricing Update: CART_GATED_PRICE</span>
            </div>
            <div className="muted-2 mono" style={{fontSize:10, textTransform:'uppercase', letterSpacing:'0.08em', marginBottom: 6}}>Workspace</div>
            <div className="row" style={{marginBottom: 14}}>
              <Icons.workspace size={14}/>
              <span className="mono" style={{fontSize:12}}>fix-eng-1453-…</span>
              <span className="chip ok"><span className="dot ok"/>active</span>
            </div>
            <div className="muted-2 mono" style={{fontSize:10, textTransform:'uppercase', letterSpacing:'0.08em', marginBottom: 6}}>Models</div>
            <div className="col">
              <div className="row"><span className="dot accent"/> <span className="mono" style={{fontSize:12}}>claude · sonnet</span> <span className="muted" style={{marginLeft:'auto', fontSize:11}}>orchestrator</span></div>
              <div className="row"><span className="dot info"/> <span className="mono" style={{fontSize:12}}>claude · opus</span> <span className="muted" style={{marginLeft:'auto', fontSize:11}}>auditor</span></div>
              <div className="row"><span className="dot"/> <span className="mono" style={{fontSize:12}}>claude · haiku</span> <span className="muted" style={{marginLeft:'auto', fontSize:11}}>routing</span></div>
            </div>

            <div style={{borderTop:'1px solid var(--border-2)', margin:'18px 0 12px'}}/>
            <div className="muted-2 mono" style={{fontSize:10, textTransform:'uppercase', letterSpacing:'0.08em', marginBottom: 8}}>Human gates</div>
            <div className="col">
              <div className="row" style={{padding:'8px 10px', background:'var(--warn-soft)', borderRadius:6}}>
                <Icons.intervene size={12} style={{color:'var(--warn)'}}/>
                <span style={{fontSize: 12, fontWeight:500}}>Plan approval</span>
                <span className="muted-2 mono" style={{fontSize:10, marginLeft:'auto'}}>upcoming</span>
              </div>
              <div className="row" style={{padding:'8px 10px', background:'var(--bg-2)', borderRadius:6}}>
                <Icons.intervene size={12}/>
                <span style={{fontSize: 12}} className="muted">PR merge</span>
                <span className="muted-2 mono" style={{fontSize:10, marginLeft:'auto'}}>after PR</span>
              </div>
            </div>

            <div style={{borderTop:'1px solid var(--border-2)', margin:'18px 0 12px'}}/>
            <button className="btn" style={{width:'100%', justifyContent:'center', marginBottom: 6}}>
              <Icons.intervene size={12}/> Intervene
            </button>
            <button className="btn ghost" style={{width:'100%', justifyContent:'center'}}>
              <Icons.download size={12}/> Download trace
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ===== EXECUTIONS =====
function ExecutionsPage({ execs, openRun }) {
  const [filter, setFilter] = useState('all');
  const filtered = filter === 'all' ? execs : execs.filter(e => e.status === filter);
  return (
    <div className="content scroll-hide">
      <div className="page-head">
        <div>
          <h2>Live runs</h2>
          <div className="sub muted">{execs.filter(e=>e.status==='running').length} running · {execs.filter(e=>e.status==='queued').length} queued · {execs.filter(e=>e.status==='completed').length} completed</div>
        </div>
        <div className="actions">
          <div className="row" style={{gap: 4, background:'var(--panel)', border:'1px solid var(--border)', borderRadius:8, padding:3}}>
            {['all','running','queued','completed'].map(s => (
              <button key={s} className={`btn ghost sm ${filter===s ? '' : ''}`}
                style={{ background: filter===s ? 'var(--accent-soft)' : 'transparent',
                         color: filter===s ? 'var(--accent-ink)' : 'var(--ink-3)', textTransform:'capitalize'}}
                onClick={() => setFilter(s)}>{s}</button>
            ))}
          </div>
          <button className="btn"><Icons.refresh size={14}/></button>
        </div>
      </div>

      <div className="card">
        <table className="tbl">
          <thead><tr>
            <th>ID</th><th>Workflow</th><th>Status</th><th>Duration</th><th>Cost</th><th>Started</th><th></th>
          </tr></thead>
          <tbody>
            {filtered.map(e => (
              <tr key={e.id} className="row" onClick={() => openRun(e.id)} style={{cursor:'pointer'}}>
                <td><span className="mono" style={{color:'var(--accent)', fontWeight:500}}>{e.id}</span></td>
                <td><span className="mono" style={{fontSize:12}}>{e.wf}</span></td>
                <td>
                  {e.status === 'running' && <span className="chip info"><Icons.spinner size={10}/> running</span>}
                  {e.status === 'queued' && <span className="chip warn"><span className="dot warn"/>queued</span>}
                  {e.status === 'completed' && <span className="chip ok"><Icons.check size={10}/>completed</span>}
                </td>
                <td><span className="mono">{e.dur > 0 ? `${e.dur.toFixed(1)}s` : '0.0s'}</span></td>
                <td><span className="mono" style={{color: e.cost > 0 ? 'var(--ink)' : 'var(--ink-4)'}}>${e.cost.toFixed(2)}</span></td>
                <td><span className="mono muted" style={{fontSize:12}}>4/25/2026, {e.started}</span></td>
                <td>
                  <div className="row" style={{gap: 4, justifyContent:'flex-end'}}>
                    {e.status === 'queued' && <button className="btn ghost sm" onClick={(ev) => ev.stopPropagation()}><Icons.play size={12}/></button>}
                    <button className="btn ghost sm" onClick={(ev) => ev.stopPropagation()}><Icons.download size={12}/></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ===== INTERVENTIONS =====
function InterventionsPage() {
  const [items] = useState(window.MOCK.INTERVENTIONS);
  const [sel, setSel] = useState(items[0].id);
  const cur = items.find(i => i.id === sel);
  return (
    <div className="content-wide" style={{display:'grid', gridTemplateColumns:'420px 1fr'}}>
      <div style={{borderRight:'1px solid var(--border)', overflowY:'auto', background:'var(--panel-2)'}} className="scroll-hide">
        <div style={{padding:'18px 20px', borderBottom:'1px solid var(--border)'}}>
          <h2 style={{margin:0, fontSize: 16}}>Interventions</h2>
          <div className="sub muted" style={{marginTop:4}}>{items.filter(i=>i.state==='pending').length} pending · {items.filter(i=>i.state==='answered').length} answered</div>
        </div>
        {items.map(iv => (
          <div key={iv.id} onClick={() => setSel(iv.id)}
               style={{padding:'14px 20px', borderBottom:'1px solid var(--border-2)', cursor:'pointer',
                       background: sel === iv.id ? 'var(--accent-soft)' : 'transparent'}}>
            <div className="row" style={{marginBottom: 4}}>
              <span className={`chip ${iv.sev}`}><span className={`dot ${iv.sev}`}/>{iv.kind}</span>
              {iv.state === 'pending'
                ? <span className="chip warn">pending</span>
                : <span className="chip ok"><Icons.check size={10}/>answered</span>}
              <span className="muted-2 mono" style={{fontSize:10, marginLeft:'auto'}}>{iv.age}</span>
            </div>
            <div style={{fontWeight:500, fontSize:13, marginBottom:4}}>{iv.ttl}</div>
            <div className="muted" style={{fontSize: 12, lineHeight: 1.4,
                 display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical', overflow:'hidden'}}>
              {iv.body}
            </div>
            <div className="muted-2 mono" style={{fontSize: 10, marginTop: 6}}>{iv.wf} · {iv.stage}</div>
          </div>
        ))}
      </div>
      <div className="scroll-hide" style={{overflowY:'auto', padding: '32px 40px'}}>
        {cur && (
          <div style={{maxWidth: 720}}>
            <div className="row" style={{marginBottom: 12}}>
              <span className={`chip ${cur.sev}`}><span className={`dot ${cur.sev}`}/>{cur.kind}</span>
              <span className="muted-2 mono" style={{fontSize:11}}>{cur.wf} · {cur.stage} · {cur.age}</span>
            </div>
            <h2 style={{margin:'0 0 14px', letterSpacing:'-0.02em'}}>{cur.ttl}</h2>
            <div style={{padding:'18px 20px', background: 'var(--panel)', border:'1px solid var(--border)', borderRadius: 12, lineHeight: 1.6, marginBottom: 24, fontSize: 14}}>
              {cur.body}
            </div>
            {cur.state === 'pending' ? (
              <>
                <div className="muted-2 mono" style={{fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8}}>Respond</div>
                <div className="col" style={{gap: 6, marginBottom: 18}}>
                  {cur.kind === 'Clarify Human' ? (<>
                    <button className="btn" style={{justifyContent:'flex-start', padding:'10px 14px'}}>(a) Allowlist is required — block new vendors</button>
                    <button className="btn" style={{justifyContent:'flex-start', padding:'10px 14px'}}>(b) Skip allowlist for new path, log usage</button>
                  </>) : (<>
                    <button className="btn primary" style={{justifyContent:'flex-start', padding:'10px 14px'}}><Icons.check size={14}/> Approve plan and continue</button>
                    <button className="btn" style={{justifyContent:'flex-start', padding:'10px 14px'}}><Icons.edit size={14}/> Request edits</button>
                    <button className="btn" style={{justifyContent:'flex-start', padding:'10px 14px', color:'var(--err)'}}><Icons.x size={14}/> Reject — stop run</button>
                  </>)}
                </div>
                <div className="chat-input">
                  <textarea placeholder="Add a note for the agent…"/>
                  <div className="row"><div className="right" style={{marginLeft:'auto'}}><button className="btn primary sm"><Icons.send size={12}/>Send</button></div></div>
                </div>
              </>
            ) : (
              <div className="row" style={{padding: '14px 18px', background:'var(--ok-soft)', borderRadius: 10, color: 'var(--ok)'}}>
                <Icons.check size={14}/> Answered 4 minutes ago. Run resumed.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

window.RunTracePage = RunTracePage;
window.ExecutionsPage = ExecutionsPage;
window.InterventionsPage = InterventionsPage;
