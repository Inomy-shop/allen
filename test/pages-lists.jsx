// Lists: workflows, agents, repos, linear, workspaces, PRs, analytics

function WorkflowsPage() {
  const [expanded, setExpanded] = useState('feature-plan-and-implement');
  return (
    <div className="content scroll-hide">
      <div className="page-head">
        <div>
          <h2>Workflows</h2>
          <div className="sub muted">{window.MOCK.WORKFLOWS.length} workflows · reusable, version-controlled</div>
        </div>
        <div className="actions">
          <button className="btn"><Icons.refresh size={14}/></button>
          <button className="btn primary"><Icons.plus size={14}/> New workflow</button>
        </div>
      </div>
      <div className="card">
        <table className="tbl">
          <thead><tr>
            <th style={{width:32}}></th><th>Name</th><th>Description</th><th>Nodes</th><th>Run stats</th><th></th>
          </tr></thead>
          <tbody>
            {window.MOCK.WORKFLOWS.map(w => (
              <React.Fragment key={w.id}>
                <tr className="row" onClick={() => setExpanded(expanded === w.id ? null : w.id)} style={{cursor:'pointer'}}>
                  <td>{expanded === w.id ? <Icons.chevD size={14}/> : <Icons.chevR size={14}/>}</td>
                  <td>
                    <div className="row">
                      <Icons.flow size={14} style={{color:'var(--accent)'}}/>
                      <span className="mono" style={{fontWeight:600}}>{w.id}</span>
                      {w.valid && <Icons.check size={12} style={{color:'var(--ok)'}}/>}
                      <span className="chip" style={{fontSize:10}}>v1</span>
                    </div>
                  </td>
                  <td className="muted" style={{fontSize:13, maxWidth: 420, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>{w.desc}</td>
                  <td><span className="chip mono">{w.nodes}</span></td>
                  <td>
                    <div className="row" style={{gap: 8}}>
                      <span className="chip ok mono"><Icons.check size={10}/>{w.runs.ok}</span>
                      <span className="chip err mono"><Icons.x size={10}/>{w.runs.err}</span>
                      <span className="chip info mono"><Icons.spinner size={10}/>{w.runs.run}</span>
                    </div>
                  </td>
                  <td>
                    <div className="row" style={{justifyContent:'flex-end', gap: 4}}>
                      <button className="btn primary sm" onClick={e=>e.stopPropagation()}><Icons.play size={11}/>Run</button>
                      <button className="btn ghost sm" onClick={e=>e.stopPropagation()}><Icons.edit size={12}/></button>
                      <button className="btn ghost sm" onClick={e=>e.stopPropagation()} style={{color:'var(--err)'}}><Icons.trash size={12}/></button>
                    </div>
                  </td>
                </tr>
                {expanded === w.id && (
                  <tr><td colSpan={6} style={{background:'var(--bg-2)', padding:'18px 24px'}}>
                    <div style={{display:'grid', gridTemplateColumns:'1fr 220px', gap: 24}}>
                      <div>
                        <div className="muted-2 mono" style={{fontSize:10, textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:6}}>Description</div>
                        <div style={{fontSize: 13, lineHeight: 1.6, marginBottom: 14}}>{w.desc}</div>
                        <div className="muted-2 mono" style={{fontSize:10, textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:6}}>Tags</div>
                        <span className="chip accent">{w.tag}</span>
                      </div>
                      <div>
                        <div className="muted-2 mono" style={{fontSize:10, textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:6}}>Validation</div>
                        <span className="chip ok"><Icons.check size={10}/>Valid · v1</span>
                        <div className="muted-2 mono" style={{fontSize:10, textTransform:'uppercase', letterSpacing:'0.08em', margin:'14px 0 6px'}}>Input schema</div>
                        <div className="muted" style={{fontSize:12}}>No inputs defined</div>
                      </div>
                    </div>
                  </td></tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AgentsPage() {
  const [team, setTeam] = useState('overview');
  return (
    <div className="content-wide" style={{display:'grid', gridTemplateColumns:'260px 1fr'}}>
      <div style={{borderRight:'1px solid var(--border)', overflowY:'auto', background:'var(--panel-2)'}} className="scroll-hide">
        <div style={{padding: '16px 18px', borderBottom: '1px solid var(--border)'}}>
          <div className="topbar-search" style={{width:'100%'}}>
            <Icons.search size={12}/><span style={{fontSize:12}}>Search teams or agents</span>
          </div>
        </div>
        <div style={{padding: 8}}>
          <div className={`nav-item ${team==='overview' ? 'active':''}`} onClick={()=>setTeam('overview')}>
            <Icons.analytics className="ico"/><span className="lbl">Overview</span>
          </div>
          <div className="nav-group-title" style={{padding:'12px 10px 6px'}}>Teams</div>
          {window.MOCK.TEAMS.map(t => (
            <div key={t.id} className={`nav-item ${team===t.id ? 'active':''}`} onClick={()=>setTeam(t.id)}>
              <Icons.agents className="ico"/>
              <div className="lbl">
                <div style={{fontWeight: 600}}>{t.name}</div>
                <div className="muted-2 mono" style={{fontSize: 10}}>{t.members} members · {t.lead}</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{position:'sticky', bottom: 0, background:'var(--panel-2)', borderTop:'1px solid var(--border)', padding: 10, display:'flex', gap: 6, flexDirection:'column'}}>
          <button className="btn primary" style={{justifyContent:'center'}}><Icons.plus size={12}/>Create agent</button>
          <button className="btn" style={{justifyContent:'center'}}><Icons.plus size={12}/>New team</button>
        </div>
      </div>
      <div className="scroll-hide" style={{overflowY: 'auto', padding: '24px 28px'}}>
        <div className="page-head">
          <div>
            <h2>{team === 'overview' ? 'Overview' : window.MOCK.TEAMS.find(t=>t.id===team)?.name}</h2>
            <div className="sub muted">
              {team === 'overview' ? '149 agents across 13 teams' : window.MOCK.TEAMS.find(t=>t.id===team)?.desc}
            </div>
          </div>
        </div>
        <div className="kpi-grid" style={{marginBottom: 18}}>
          <div className="kpi"><div className="lab">Agents</div><div className="val" style={{color:'var(--accent)'}}>149</div></div>
          <div className="kpi"><div className="lab">Teams</div><div className="val" style={{color:'var(--purple)'}}>13</div></div>
          <div className="kpi"><div className="lab">Assigned</div><div className="val" style={{color:'var(--ok)'}}>149</div></div>
          <div className="kpi"><div className="lab">Unassigned</div><div className="val muted">0</div></div>
        </div>
        <div className="grid-2" style={{marginBottom:18}}>
          <div className="card">
            <div className="card-head"><h3>Providers</h3></div>
            <div className="card-body">
              <div className="bar-row"><div className="nm">claude-cli</div><div className="b"><i style={{width:'100%'}}/></div><div className="ct">149</div></div>
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h3>Models</h3></div>
            <div className="card-body">
              <div className="bar-row"><div className="nm">sonnet</div><div className="b"><i style={{width:'90%'}}/></div><div className="ct">130</div></div>
              <div className="bar-row"><div className="nm">opus</div><div className="b"><i style={{width:'12%', background:'var(--purple)'}}/></div><div className="ct">17</div></div>
              <div className="bar-row"><div className="nm">haiku</div><div className="b"><i style={{width:'2%', background:'var(--info)'}}/></div><div className="ct">2</div></div>
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h3>Delegation graph</h3><span className="sub">organisation · 13 departments · 149 people</span></div>
          <div style={{padding: '4px 0'}}>
            {window.MOCK.TEAMS.map(t => (
              <div key={t.id} style={{padding: '14px 18px', borderTop: '1px solid var(--border-2)'}}>
                <div className="row" style={{marginBottom: 8}}>
                  <Icons.chevD size={14}/>
                  <span style={{fontWeight: 600}}>{t.name}</span>
                  <span className="muted" style={{fontSize: 12}}>{t.desc}</span>
                  <span className="chip accent" style={{marginLeft:'auto'}}><Icons.user size={10}/>{t.lead}</span>
                  <span className="chip mono">{t.members}</span>
                </div>
                <div style={{display:'flex', flexWrap:'wrap', gap: 6, paddingLeft: 22}}>
                  {Array.from({length: Math.min(t.members, 8)}).map((_,i) => (
                    <span key={i} className="chip"><Icons.agents size={10}/>{['New Product Discover','Pagination Specialist','Scraped Data Validator','Search Query Optimizer','Vendor Category Mapper','Vendor Rule Healer','Vendor Rule Onboarder','Extraction Quality Evaluator'][i % 8]}</span>
                  ))}
                  {t.members > 8 && <span className="chip muted">+{t.members - 8} more</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ReposPage() {
  return (
    <div className="content scroll-hide">
      <div className="page-head">
        <div>
          <h2>Repositories</h2>
          <div className="sub muted">{window.MOCK.REPOS.length} repos registered</div>
        </div>
        <div className="actions">
          <button className="btn"><Icons.refresh size={14}/></button>
          <button className="btn primary"><Icons.plus size={14}/>Add repo</button>
        </div>
      </div>
      <div className="col" style={{gap: 10}}>
        {window.MOCK.REPOS.map(r => (
          <div key={r.id} className="repo-card">
            <div style={{width:36, height:36, borderRadius:8, background:'var(--bg-2)', display:'grid', placeItems:'center', color:'var(--ink-3)'}}>
              <Icons.repo size={16}/>
            </div>
            <div style={{flex: 1, minWidth: 0}}>
              <div className="row" style={{marginBottom: 4}}>
                <span className="rname mono">{r.id}</span>
                {r.tags.map(t => <span key={t} className={`chip ${t==='python'?'info':t==='typescript'?'accent':t==='javascript'?'warn':'purple'}`}>{t}</span>)}
              </div>
              <div className="meta-row">
                <span>{r.path}</span>
                <span><Icons.branch size={11} style={{display:'inline', verticalAlign:'middle'}}/> {r.branch}</span>
                <span><Icons.ext size={11} style={{display:'inline', verticalAlign:'middle'}}/> {r.remote}</span>
                {r.runs > 0 && <span className="chip info"><Icons.spinner size={10}/>{r.runs} runs</span>}
              </div>
            </div>
            <button className="btn ghost sm"><Icons.more size={14}/></button>
          </div>
        ))}
      </div>
    </div>
  );
}

// Linear status columns
const LINEAR_STATUSES = [
  { id:'backlog',  nm:'Backlog',     icon: '○' },
  { id:'todo',     nm:'Todo',        icon: '◯' },
  { id:'progress', nm:'In Progress', icon: '◐' },
  { id:'review',   nm:'In Review',   icon: '◑' },
  { id:'done',     nm:'Done',        icon: '●' },
];

const LINEAR_PEOPLE = [
  { id:'me',     nm:'Manish',     init:'M', me: true },
  { id:'ashish', nm:'Ashish',     init:'A' },
  { id:'shree',  nm:'Shreemant',  init:'S' },
  { id:'sait',   nm:'Saiteja',    init:'ST' },
  { id:'ishan',  nm:'Ishan',      init:'I' },
];

const LINEAR_PRIO = [
  { id:'p1', nm:'Urgent', cls:'p1' },
  { id:'p2', nm:'High',   cls:'p2' },
  { id:'p3', nm:'Medium', cls:'p3' },
  { id:'p4', nm:'Low',    cls:'p4' },
];

// Hydrate tickets with status, priority, assignee
function hydrateTickets(raw) {
  const statusBySev = { err:'progress', warn:'todo', ok:'review', mute:'backlog' };
  return raw.map((t, i) => {
    const status = i === 0 ? 'progress' : i === 5 ? 'done' : i === 6 ? 'backlog' : statusBySev[t.sev] || 'backlog';
    const prio = t.sev === 'err' ? 'p1' : t.sev === 'warn' ? 'p2' : t.sev === 'ok' ? 'p3' : 'p4';
    const assignee = LINEAR_PEOPLE[i % LINEAR_PEOPLE.length].id;
    const due = i % 3 === 0 ? 'Apr 28' : i % 3 === 1 ? 'May 02' : null;
    return { ...t, status, prio, assignee, due };
  });
}

function LinearPage() {
  const tickets = React.useMemo(() => hydrateTickets(window.MOCK.TICKETS), []);
  const [board, setBoard] = useState('all');
  const [view, setView] = useState('board');
  const [assigneeFilter, setAssigneeFilter] = useState('all'); // 'all' | 'me' | personId
  const [prioFilter, setPrioFilter] = useState(new Set());
  const [search, setSearch] = useState('');

  // boards = saved views
  const [boards, setBoards] = useState([
    { id:'all',      nm:'All issues',        kind:'board', icon:'all' },
    { id:'mine',     nm:'My issues',         kind:'board', icon:'me' },
    { id:'pricing',  nm:'Pricing fixes',     kind:'board', icon:'flag' },
    { id:'frontend', nm:'Frontend',          kind:'board', icon:'flag' },
    { id:'pipeline', nm:'Pipeline',          kind:'board', icon:'flag' },
  ]);
  const projects = [
    { id:'p-unified',  nm:'Unified AI Shopping', ct: 32 },
    { id:'p-llm',      nm:'LLM Benchmarking',     ct: 12 },
    { id:'p-shop',     nm:'Shopping Experience',  ct: 21 },
    { id:'p-furn',     nm:'Furniture Designer',   ct: 19 },
    { id:'p-roadmap',  nm:'Pipeline Roadmap',     ct: 26 },
    { id:'p-catalog',  nm:'Catalog Roadmap',      ct: 14 },
  ];

  // apply board preset to filters
  useEffect(() => {
    if (board === 'mine') setAssigneeFilter('me');
    else if (board !== 'all') setAssigneeFilter('all');
  }, [board]);

  const filtered = React.useMemo(() => {
    return tickets.filter(t => {
      if (assigneeFilter === 'me' && t.assignee !== 'me') return false;
      if (assigneeFilter !== 'all' && assigneeFilter !== 'me' && t.assignee !== assigneeFilter) return false;
      if (prioFilter.size && !prioFilter.has(t.prio)) return false;
      if (search && !(t.ttl + t.id).toLowerCase().includes(search.toLowerCase())) return false;
      if (board === 'pricing' && !t.tags.some(x => /pricing|price/i.test(x)) && !/pricing|price/i.test(t.ttl)) return false;
      if (board === 'frontend' && !t.tags.some(x => /frontend/i.test(x))) return false;
      if (board === 'pipeline' && !t.tags.some(x => /pipeline/i.test(x))) return false;
      return true;
    });
  }, [tickets, assigneeFilter, prioFilter, search, board]);

  const togglePrio = (p) => {
    setPrioFilter(prev => {
      const n = new Set(prev);
      n.has(p) ? n.delete(p) : n.add(p);
      return n;
    });
  };

  const createBoard = () => {
    const nm = prompt('Board name?');
    if (!nm) return;
    const id = 'b-' + Math.random().toString(36).slice(2,7);
    setBoards(b => [...b, { id, nm, kind:'board', icon:'flag' }]);
    setBoard(id);
  };

  const activeBoardName = boards.find(b => b.id === board)?.nm || 'All issues';

  return (
    <div className="linear-shell">
      {/* === SIDEBAR === */}
      <aside className="linear-side scroll-hide">
        <div className="l-header">
          <span className="l-team-mark">IN</span>
          <div style={{flex:1, minWidth:0}}>
            <div className="l-team-name">Inomy</div>
            <div className="muted-2 mono" style={{fontSize: 10}}>200 issues</div>
          </div>
          <button className="btn ghost sm" title="Refresh"><Icons.refresh size={12}/></button>
        </div>

        <div className="l-search">
          <div className="l-search-box">
            <Icons.search size={11}/>
            <input
              style={{background:'transparent', border:'none', outline:'none', flex:1, fontSize:12, color:'var(--ink)'}}
              placeholder="Search issues…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="l-list">
          <div className="l-grp">
            <span>Boards</span>
            <span className="right"><button onClick={createBoard} title="New board"><Icons.plus size={11}/></button></span>
          </div>
          {boards.map(b => (
            <div key={b.id} className={`l-item ${board === b.id ? 'active' : ''}`} onClick={() => setBoard(b.id)}>
              <span className="l-ic">
                {b.icon === 'me' ? <UserAvatar size={14} init="M"/> :
                 b.icon === 'all' ? <Icons.linear size={13}/> :
                 <span style={{display:'inline-block', width:10, height:10, borderRadius:3, background:'var(--accent)', opacity: 0.7}}/>}
              </span>
              <span className="l-name">{b.nm}</span>
            </div>
          ))}
          <button className="l-add" onClick={createBoard}><Icons.plus size={12}/> New board</button>

          <div className="l-grp" style={{marginTop: 8}}><span>Projects</span></div>
          {projects.map(p => (
            <div key={p.id} className="l-item">
              <span className="l-ic"><span style={{display:'inline-block', width:8, height:8, borderRadius:'50%', background:'var(--info)'}}/></span>
              <span className="l-name">{p.nm}</span>
              <span className="l-ct">{p.ct}</span>
            </div>
          ))}

          <div className="l-grp" style={{marginTop: 8}}><span>Filters</span></div>
          <div className="l-item"><span className="l-ic"><Icons.bell size={12}/></span><span className="l-name">Subscribed</span></div>
          <div className="l-item"><span className="l-ic"><Icons.flow size={12}/></span><span className="l-name">Active workflows</span></div>
        </div>
      </aside>

      {/* === MAIN === */}
      <section className="linear-main">
        <div className="linear-head">
          <h2>{activeBoardName}</h2>
          <span className="lh-meta">{filtered.length} of {tickets.length}</span>
          <div className="lh-actions">
            <div className="view-toggle">
              <button className={view === 'board' ? 'active' : ''} onClick={() => setView('board')}>
                <BoardIcon/> Board
              </button>
              <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>
                <ListIcon/> List
              </button>
            </div>
            <button className="btn"><Icons.settings size={12}/></button>
            <button className="btn primary"><Icons.plus size={13}/> New issue</button>
          </div>
        </div>

        {/* === FILTER BAR === */}
        <div className="linear-filters">
          <div className="me-stack">
            <span className={`seg ${assigneeFilter === 'all' ? 'active' : ''}`} onClick={() => setAssigneeFilter('all')}>Anyone</span>
            <span className={`seg ${assigneeFilter === 'me' ? 'active' : ''}`} onClick={() => setAssigneeFilter('me')}>
              <UserAvatar size={14} init="M" me/> Me
            </span>
          </div>

          <span className="lf-sep"/>

          <span className="lf-label">Assignee</span>
          {LINEAR_PEOPLE.filter(p => !p.me).slice(0,4).map(p => (
            <span
              key={p.id}
              className={`lf-chip ${assigneeFilter === p.id ? 'active' : ''}`}
              onClick={() => setAssigneeFilter(assigneeFilter === p.id ? 'all' : p.id)}
              title={`Filter by ${p.nm}`}
            >
              <UserAvatar size={14} init={p.init}/> {p.nm}
            </span>
          ))}

          <span className="lf-sep"/>

          <span className="lf-label">Priority</span>
          {LINEAR_PRIO.map(p => (
            <span
              key={p.id}
              className={`lf-chip ${prioFilter.has(p.id) ? 'active' : ''}`}
              onClick={() => togglePrio(p.id)}
            >
              <span className={`lb-prio ${p.cls}`}/>{p.nm}
            </span>
          ))}

          <span style={{marginLeft:'auto'}}/>
          <span className="lf-chip"><Icons.refresh size={11}/> Sort: Priority</span>
        </div>

        {/* === BOARD === */}
        {view === 'board' && (
          <div className="linear-board scroll-hide">
            {LINEAR_STATUSES.map(s => {
              const cards = filtered.filter(t => t.status === s.id);
              return (
                <div key={s.id} className="lb-col">
                  <div className="lb-col-head">
                    <span style={{color: 'var(--ink-3)', fontSize: 13}}>{s.icon}</span>
                    <span>{s.nm}</span>
                    <span className="ct">{cards.length}</span>
                    <div className="right">
                      <button title="Add to column"><Icons.plus size={11}/></button>
                      <button title="More"><Icons.more size={11}/></button>
                    </div>
                  </div>
                  <div className="lb-col-body">
                    {cards.map(t => {
                      const person = LINEAR_PEOPLE.find(p => p.id === t.assignee);
                      return (
                        <div key={t.id} className="lb-card">
                          <div className="lb-meta">
                            <span className={`lb-prio ${t.prio}`} title={LINEAR_PRIO.find(p=>p.id===t.prio)?.nm}/>
                            <span className="lb-id">{t.id}</span>
                            <UserAvatar size={18} init={person?.init} me={person?.me} className="lb-assignee"/>
                          </div>
                          <div className="lb-ttl">{t.ttl}</div>
                          <div className="lb-foot">
                            {t.tags.slice(0,2).map((tg,i) => (
                              <span key={i} className={`lb-tag ${tg.startsWith('area:') ? 'area' : ''}`}>{tg}</span>
                            ))}
                            {t.due && <span className="lb-due" style={{marginLeft:'auto'}}>{t.due}</span>}
                          </div>
                        </div>
                      );
                    })}
                    <button className="lb-add"><Icons.plus size={11}/> Add issue</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* === LIST === */}
        {view === 'list' && (
          <div className="linear-list scroll-hide">
            {LINEAR_STATUSES.map(s => {
              const rows = filtered.filter(t => t.status === s.id);
              if (!rows.length) return null;
              return (
                <div key={s.id} className="ll-group">
                  <div className="ll-group-h">
                    <span style={{color: 'var(--ink-3)'}}>{s.icon}</span>
                    <span>{s.nm}</span>
                    <span className="ct">{rows.length}</span>
                  </div>
                  {rows.map(t => {
                    const person = LINEAR_PEOPLE.find(p => p.id === t.assignee);
                    return (
                      <div key={t.id} className="ll-row">
                        <span className={`lb-prio ${t.prio}`}/>
                        <span className="id">{t.id}</span>
                        <UserAvatar size={16} init={person?.init} me={person?.me}/>
                        <span className="ttl">{t.ttl}</span>
                        <span className="due">{t.due || ''}</span>
                        <button className="btn primary sm"><Icons.send size={11}/> Dispatch</button>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

// small helpers
function UserAvatar({ size = 18, init = '?', me = false, className = '' }) {
  const cls = me ? `lb-assignee me ${className}` : `lb-assignee ${className}`;
  return (
    <span className={cls} style={{
      width: size, height: size, fontSize: Math.max(9, size * 0.5)
    }}>{init}</span>
  );
}
const BoardIcon = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="6" height="18" rx="1.5"/><rect x="11" y="3" width="6" height="12" rx="1.5"/><rect x="19" y="3" width="2" height="8" rx="1"/></svg>;
const ListIcon = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M3 12h18M3 18h18"/></svg>;

function WorkspacesPage() {
  return (
    <div className="content scroll-hide">
      <div className="page-head">
        <div>
          <h2>Workspaces</h2>
          <div className="sub muted">{window.MOCK.WORKSPACES.length} active · isolated agent code environments</div>
        </div>
        <div className="actions">
          <button className="btn"><Icons.refresh size={14}/></button>
          <button className="btn primary"><Icons.plus size={14}/>New workspace</button>
        </div>
      </div>
      <div className="card" style={{marginBottom: 14}}>
        <div className="card-head">
          <Icons.repo size={14}/>
          <h3 className="mono" style={{textTransform:'uppercase'}}>es-data-pipeline</h3>
          <span className="sub">{window.MOCK.WORKSPACES.length} workspaces</span>
          <div className="right"><button className="btn ghost sm"><Icons.settings size={12}/>Config</button></div>
        </div>
        <div>
          {window.MOCK.WORKSPACES.map((w, i) => (
            <div key={w.id} className="ws-card" style={{borderRadius:0, borderLeft:'none', borderRight:'none', borderTop: i===0 ? 'none':'1px solid var(--border-2)', borderBottom:'none'}}>
              <input type="checkbox" />
              <div>
                <div className="row" style={{marginBottom: 2}}>
                  <Icons.workspace size={12} style={{color:'var(--accent)'}}/>
                  <span className="nm">{w.id}</span>
                  {w.status === 'running'
                    ? <span className="chip info"><Icons.spinner size={10}/>running</span>
                    : <span className="chip ok"><span className="dot ok"/>active</span>}
                  {w.changed > 0 && <span className="chip warn">{w.changed} changed</span>}
                </div>
                <div className="meta">{w.branch} · port {w.port}</div>
              </div>
              <button className="btn ghost sm"><Icons.ext size={12}/></button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PullRequestsPage() {
  const [tab, setTab] = useState('open');
  return (
    <div className="content scroll-hide">
      <div className="page-head">
        <div>
          <h2>Pull requests</h2>
          <div className="sub muted">21 results · synced from GitHub</div>
        </div>
        <div className="actions">
          <button className="btn"><Icons.sparkle size={14}/>Resolve CodeRabbit on all</button>
          <button className="btn"><Icons.refresh size={14}/>Sync from GitHub</button>
        </div>
      </div>
      <div className="tabs" style={{marginBottom: 14}}>
        {['open','merged','closed','all'].map(t => (
          <div key={t} className={`tab ${tab===t?'active':''}`} onClick={()=>setTab(t)} style={{textTransform:'capitalize'}}>
            {t} <span className="ct">{t==='open'?21:t==='merged'?184:t==='closed'?12:217}</span>
          </div>
        ))}
      </div>
      <div className="col" style={{gap: 10}}>
        {window.MOCK.PRS.map(p => (
          <div key={p.num} className="repo-card" style={{flexDirection:'column', alignItems:'stretch', gap: 0}}>
            <div className="row" style={{gap: 12}}>
              <Icons.pr size={16} style={{color:'var(--ok)'}}/>
              <span className="mono" style={{fontWeight:600, fontSize: 13}}>{p.num}</span>
              <span style={{fontWeight:500, fontSize: 14, flex:1, minWidth:0, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>{p.ttl}</span>
              <span className="chip ok">open</span>
            </div>
            <div className="meta-row" style={{marginTop: 8, marginLeft: 28}}>
              <span><Icons.repo size={11} style={{display:'inline', verticalAlign:'middle'}}/> {p.repo}</span>
              <span>·</span>
              <span>{p.age}</span>
              <span><Icons.file size={11} style={{display:'inline', verticalAlign:'middle'}}/> {p.files} files</span>
              <span style={{color:'var(--ok)'}}>+{p.plus}</span>
              <span style={{color:'var(--err)'}}>-{p.minus}</span>
              <span><Icons.branch size={11} style={{display:'inline', verticalAlign:'middle'}}/> {p.branch}</span>
              <span>by <b>{p.author}</b></span>
              <div style={{marginLeft:'auto', display:'flex', gap: 6}}>
                <button className="btn sm"><Icons.workspace size={11}/>Open workspace</button>
                <button className="btn sm"><Icons.sparkle size={11}/>Resolve CodeRabbit</button>
                <button className="btn ghost sm"><Icons.ext size={12}/></button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AnalyticsPage() {
  return (
    <div className="content scroll-hide">
      <div className="page-head">
        <div>
          <h2>Analytics</h2>
          <div className="sub muted">chat agent performance and tool usage · last 7 days</div>
        </div>
      </div>
      <div className="kpi-grid" style={{marginBottom: 18}}>
        <div className="kpi"><div className="lab">Messages</div><div className="val">100</div><div className="delta muted">24 conversations</div></div>
        <div className="kpi"><div className="lab">Total cost</div><div className="val" style={{color:'var(--accent)'}}>$37.56</div><div className="delta muted mono">$0.3756 / msg</div></div>
        <div className="kpi"><div className="lab">Avg response</div><div className="val">129.9s</div><div className="delta muted">per message</div></div>
        <div className="kpi"><div className="lab">Tool calls</div><div className="val" style={{color:'var(--purple)'}}>1,330</div><div className="delta muted">69 unique tools</div></div>
      </div>
      <div className="grid-2">
        <div className="card">
          <div className="card-head"><h3>Top tools</h3><span className="sub">by call count</span></div>
          <div className="card-body">
            {[
              ['Bash', 658, 'accent'],
              ['al:wait_for_delegation', 78, 'accent'],
              ['al:get_agent', 46, 'accent'],
              ['mcp__postgres__pg_exec…', 40, 'purple'],
              ['al:report_to_user', 38, 'accent'],
              ['al:delegate_to_agent', 36, 'accent'],
              ['al:wait_for_execution', 32, 'accent'],
              ['al:list_workflows', 24, 'accent'],
              ['Grep', 24, 'info'],
              ['al:save_learning', 20, 'accent'],
            ].map(([nm, ct, color]) => (
              <div key={nm} className="bar-row">
                <div className="nm">{nm}</div>
                <div className="b"><i style={{width: (ct/658*100)+'%', background: `var(--${color})`}}/></div>
                <div className="ct">{ct}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h3>Recent errors</h3><span className="sub">5 total</span></div>
          <div>
            {[
              ['4/25/2026', 'first what is by default provider getting used and'],
              ['4/23/2026', 'it\'s \'es-data-pipeline\' create v5 then v2 alias t'],
              ['4/23/2026', 'it\'s \'as-data-pipeline\' create v5 then v2 alias t'],
              ['4/23/2026', 'I want to create a workflow to test the integrated'],
              ['4/23/2026', 'I want to create a workflow to test the integrated'],
            ].map(([d, m], i) => (
              <div key={i} style={{padding: '12px 16px', borderTop: '1px solid var(--border-2)'}}>
                <div className="muted-2 mono" style={{fontSize: 10, marginBottom: 4}}>{d}</div>
                <div style={{fontSize: 13, color:'var(--err)'}}>{m}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

window.WorkflowsPage = WorkflowsPage;
window.AgentsPage = AgentsPage;
window.ReposPage = ReposPage;
window.LinearPage = LinearPage;
window.WorkspacesPage = WorkspacesPage;
window.PullRequestsPage = PullRequestsPage;
window.AnalyticsPage = AnalyticsPage;
