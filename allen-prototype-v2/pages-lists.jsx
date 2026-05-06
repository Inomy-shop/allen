// Lists: workflows, agents, repos, linear, workspaces, PRs, analytics

function WorkflowsPage({ embed }) {
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

function AgentsPage({ embed }) {
  const [team, setTeam] = useState('overview');
  const teamObj = team === 'overview' ? null : window.MOCK.TEAMS.find(t=>t.id===team);
  return (
    <div className="content scroll-hide" style={{padding: '24px 28px'}}>
      <div className="page-head">
        <div className="ph-row">
          <div>
            <h2>{teamObj ? teamObj.name : 'Agents'}</h2>
            <div className="sub muted">
              {teamObj ? teamObj.desc : '149 agents across 13 teams'}
            </div>
          </div>
          <div className="row" style={{gap: 6}}>
            <button className="btn"><Icons.plus size={12}/>New team</button>
            <button className="btn primary"><Icons.plus size={12}/>Create agent</button>
          </div>
        </div>
        <nav className="topfilter-tabs scrollable">
          <button className={`tft ${team==='overview'?'active':''}`} onClick={()=>setTeam('overview')}>overview</button>
          {window.MOCK.TEAMS.map(t => (
            <button key={t.id} className={`tft ${team===t.id?'active':''}`} onClick={()=>setTeam(t.id)}>
              {t.name} <span className="tft-ct">{t.members}</span>
            </button>
          ))}
        </nav>
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
  );
}

function ReposPage({ embed }) {
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

// Dropdown — labeled button that opens a searchable popover.
// Scales to N items because everything past 6 is searchable, not horizontally scrolled.
function Dropdown({ label, value, options, onPick }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = React.useRef(null);

  React.useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  React.useEffect(() => { if (!open) setQ(''); }, [open]);

  const current = options.find(o => o.id === value);
  const filtered = options.filter(o => !q || o.label.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="dd-wrap" ref={ref}>
      <button className={`dd-btn ${open?'open':''}`} onClick={()=>setOpen(o=>!o)}>
        <span className="dd-l">{label}</span>
        <span className="dd-v">{current ? current.label : 'select…'}</span>
        <Icons.chevD size={12}/>
      </button>
      {open && (
        <div className="dd-pop">
          {options.length > 6 && (
            <div className="dd-search">
              <Icons.search size={12}/>
              <input
                autoFocus
                placeholder={`search ${label}…`}
                value={q}
                onChange={e=>setQ(e.target.value)}/>
            </div>
          )}
          <div className="dd-list">
            {filtered.map(o => (
              <button
                key={o.id}
                className={`dd-item ${value===o.id?'active':''} ${o.kind==='action'?'action':''}`}
                onClick={()=>{ onPick(o); if (o.kind !== 'action') setOpen(false); else setOpen(false); }}>
                <span className="dd-item-l">{o.label}</span>
                {o.ct != null && <span className="dd-item-c mono">{o.ct}</span>}
                {value===o.id && <Icons.check size={11}/>}
              </button>
            ))}
            {filtered.length === 0 && <div className="dd-empty">no matches</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// ScalableTabStrip — horizontal scrollable strip with fade gradient + "+more" overflow popover.
// Use when items are data-driven (boards, projects) — falls back to scroll, but the popover
// makes hidden items discoverable.
function ScalableTabStrip({ activeBoard, setBoard, createBoard, boards, projects }) {
  const stripRef = React.useRef(null);
  const [fadeL, setFadeL] = useState(false);
  const [fadeR, setFadeR] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const onScroll = React.useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    setFadeL(el.scrollLeft > 4);
    setFadeR(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  React.useEffect(() => {
    onScroll();
    const el = stripRef.current;
    if (!el) return;
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', onScroll); ro.disconnect(); };
  }, [boards.length, projects.length]);

  React.useEffect(() => {
    if (!moreOpen) return;
    const close = (e) => { if (!e.target.closest('.sts-more-pop') && !e.target.closest('.sts-more-btn')) setMoreOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [moreOpen]);

  const totalItems = boards.length + projects.length;

  return (
    <div className={`sts-wrap ${fadeL?'fade-l':''} ${fadeR?'fade-r':''}`}>
      <nav className="topfilter-tabs scrollable sts-strip" ref={stripRef}>
        {boards.map(b => (
          <button key={b.id} className={`tft ${activeBoard===b.id?'active':''}`} onClick={()=>setBoard(b.id)}>{b.nm}</button>
        ))}
        <button className="tft add" onClick={createBoard}><Icons.plus size={11}/> board</button>
        <span style={{width:18}}/>
        <span className="tft-label">projects</span>
        {projects.map(p => (
          <button key={p.id} className="tft">{p.nm} <span className="tft-ct">{p.ct}</span></button>
        ))}
      </nav>

      <button
        className={`sts-more-btn ${moreOpen?'open':''}`}
        title="all boards & projects"
        onClick={()=>setMoreOpen(o=>!o)}>
        <Icons.more size={12}/>
        <span>all</span>
        <span className="sts-more-ct">{totalItems}</span>
      </button>

      {moreOpen && (
        <div className="sts-more-pop">
          <div className="sts-pop-h">boards</div>
          {boards.map(b => (
            <button
              key={b.id}
              className={`sts-pop-item ${activeBoard===b.id?'active':''}`}
              onClick={() => { setBoard(b.id); setMoreOpen(false); }}>
              <Icons.linear size={11}/>
              <span>{b.nm}</span>
            </button>
          ))}
          <button className="sts-pop-item add" onClick={() => { createBoard(); setMoreOpen(false); }}>
            <Icons.plus size={11}/>
            <span>new board</span>
          </button>
          <div className="sts-pop-h">projects</div>
          {projects.map(p => (
            <button key={p.id} className="sts-pop-item">
              <Icons.flow size={11}/>
              <span>{p.nm}</span>
              <span className="sts-pop-ct">{p.ct}</span>
            </button>
          ))}
        </div>
      )}
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

function LinearPage({ openTask }) {
  const tickets = React.useMemo(() => hydrateTickets(window.MOCK.TICKETS), []);
  const [board, setBoard] = useState('all');
  const [project, setProject] = useState('all');
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
    { id:'p-unified',  nm:'Unified AI Shopping', ct: 32, match: 'unified' },
    { id:'p-llm',      nm:'LLM Benchmarking',     ct: 12, match: 'llm' },
    { id:'p-shop',     nm:'Shopping Experience',  ct: 21, match: 'shopping' },
    { id:'p-furn',     nm:'Furniture Designer',   ct: 19, match: 'furniture' },
    { id:'p-roadmap',  nm:'Pipeline Roadmap',     ct: 26, match: 'pipeline roadmap' },
    { id:'p-catalog',  nm:'Catalog Roadmap',      ct: 14, match: 'catalog' },
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
      if (project !== 'all') {
        const proj = projects.find(p => p.id === project);
        if (proj && !(t.proj || '').toLowerCase().includes(proj.match)) return false;
      }
      return true;
    });
  }, [tickets, assigneeFilter, prioFilter, search, board, project]);

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

  // Items for the dropdowns
  const boardOptions = [
    ...boards.map(b => ({ id: b.id, label: b.nm })),
    { id:'__new__', label:'+ new board', kind:'action', onPick: createBoard },
  ];
  const projectOptions = [
    { id: 'all', label: 'All projects' },
    ...projects.map(p => ({ id: p.id, label: p.nm, ct: p.ct })),
  ];

  return (
    <div className="content scroll-hide" style={{padding:'0', display:'flex', flexDirection:'column', height:'100%', overflow:'hidden'}}>
      <div className="page-head linear-head">
        <div className="ph-row">
          <div>
            <h2>tickets</h2>
            <div className="sub muted">linear · 200 issues · synced 2m ago</div>
          </div>
          <div className="row" style={{gap:6}}>
            <div className="view-toggle">
              <button className={view === 'board' ? 'active' : ''} onClick={() => setView('board')}><BoardIcon/> Board</button>
              <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}><ListIcon/> List</button>
            </div>
            <button className="btn"><Icons.refresh size={12}/></button>
            <button className="btn primary"><Icons.plus size={13}/> New issue</button>
          </div>
        </div>
      </div>

      <div className="linear-tabs-row">
        <div className="picker-row">
          <Dropdown
            label="board"
            value={board}
            options={boardOptions}
            onPick={(opt)=>{ if (opt.kind === 'action') opt.onPick(); else setBoard(opt.id); }}
          />
          <Dropdown
            label="project"
            value={project}
            options={projectOptions}
            onPick={(opt)=>setProject(opt.id)}
          />
        </div>
      </div>

      {/* === FILTER BAR === */}
      <div className="linear-filters" style={{padding:'10px 28px'}}>
        <div className="me-stack">
          <span className={`seg ${assigneeFilter === 'all' ? 'active' : ''}`} onClick={() => setAssigneeFilter('all')}>Anyone</span>
          <span className={`seg ${assigneeFilter === 'me' ? 'active' : ''}`} onClick={() => setAssigneeFilter('me')}>
            <UserAvatar size={14} init="M" me/> Me
          </span>
        </div>
        <span className="lf-sep"/>
        <span className="lf-label">Assignee</span>
        {LINEAR_PEOPLE.filter(p => !p.me).slice(0,4).map(p => (
          <span key={p.id} className={`lf-chip ${assigneeFilter === p.id ? 'active' : ''}`} onClick={() => setAssigneeFilter(assigneeFilter === p.id ? 'all' : p.id)}>
            <UserAvatar size={14} init={p.init}/> {p.nm}
          </span>
        ))}
        <span className="lf-sep"/>
        <span className="lf-label">Priority</span>
        {LINEAR_PRIO.map(p => (
          <span key={p.id} className={`lf-chip ${prioFilter.has(p.id) ? 'active' : ''}`} onClick={() => togglePrio(p.id)}>
            <span className={`lb-prio ${p.cls}`}/>{p.nm}
          </span>
        ))}
        <span style={{marginLeft:'auto'}}/>
        <div className="l-search-box" style={{width: 220}}>
          <Icons.search size={11}/>
          <input style={{background:'transparent',border:'none',outline:'none',flex:1,fontSize:12,color:'var(--ink)'}} placeholder="Search issues…" value={search} onChange={e=>setSearch(e.target.value)}/>
        </div>
      </div>

      {/* === BOARD === */}
      {view === 'board' && (
        <div className="linear-board scroll-hide" style={{flex:1, padding:'12px 24px'}}>
          {LINEAR_STATUSES.map(s => {
            const cards = filtered.filter(t => t.status === s.id);
            return (
              <div key={s.id} className="lb-col">
                <div className="lb-col-head">
                  <span style={{color: 'var(--ink-3)', fontSize: 13}}>{s.icon}</span>
                  <span>{s.nm}</span>
                  <span className="ct">{cards.length}</span>
                </div>
                <div className="lb-col-body">
                  {cards.map(t => {
                    const person = LINEAR_PEOPLE.find(p => p.id === t.assignee);
                    return (
                      <div key={t.id} className="lb-card">
                        <div className="lb-meta">
                          <span className={`lb-prio ${t.prio}`}/>
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
                        <button className="lb-dispatch" onClick={(e)=>{e.stopPropagation(); openTask && openTask('t-1453');}}>
                          <Icons.send size={10}/> dispatch to allen
                        </button>
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

      {view === 'list' && (
        <div className="linear-list scroll-hide" style={{flex:1, padding:'12px 24px'}}>
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
                      <button className="btn primary sm" onClick={(e)=>{e.stopPropagation(); openTask && openTask('t-1453');}}><Icons.send size={11}/> Dispatch</button>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
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
const SbsIcon = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="4" width="8" height="16" rx="1.5"/><rect x="13" y="4" width="8" height="16" rx="1.5"/></svg>;
const UnifiedIcon = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 12h18"/></svg>;
function DiffCell({ side, cell }) {
  const kind = cell?.kind || (cell ? 'context' : 'empty');
  return (
    <div className={`ws-sbs-cell ${side} ${kind}`}>
      <span className="ws-ln mono">{cell?.n ?? ''}</span>
      <span className="ws-mark mono">{cell?.marker ?? ' '}</span>
      <span className="ws-code mono">{cell?.text ?? ''}</span>
    </div>
  );
}

// Mock files + diffs + terminal output for workspace deep-dive
const WS_FILES = [
  { path:'pricing-update/handlers/amazon.ts',          status:'modified', plus:62, minus:18 },
  { path:'pricing-update/circuit-breaker.ts',          status:'new',      plus:184, minus:0 },
  { path:'pricing-update/types/chain.ts',              status:'modified', plus:8,  minus:2 },
  { path:'tests/pricing-update/gated.spec.ts',         status:'new',      plus:96, minus:0 },
  { path:'pricing-update/handlers/walmart.ts',         status:'modified', plus:14, minus:6 },
  { path:'pricing-update/index.ts',                    status:'modified', plus:9,  minus:3 },
  { path:'src/lib/abort-utils.ts',                     status:'new',      plus:42, minus:0 },
];
const WS_DIFFS = {
  'pricing-update/circuit-breaker.ts': [
    { type:'h', text:'@@ -0,0 +1,184 @@' },
    { type:'a', n:1,  text:"import { AbortController } from 'node:abort-controller';" },
    { type:'a', n:2,  text:"import { ChainState } from './types/chain';" },
    { type:'a', n:3,  text:"" },
    { type:'a', n:4,  text:"// Vendor-scoped circuit breaker — opens per-vendor on N failures." },
    { type:'a', n:5,  text:"// Recovers after `cooldownMs` with a half-open probe." },
    { type:'a', n:6,  text:"export class VendorScopedCircuitBreaker {" },
    { type:'a', n:7,  text:"  private failures = new Map<string, number>();" },
    { type:'a', n:8,  text:"  private openedAt  = new Map<string, number>();" },
    { type:'a', n:9,  text:"  private aborters  = new Map<string, AbortController>();" },
    { type:'a', n:10, text:"" },
    { type:'a', n:11, text:"  constructor(" },
    { type:'a', n:12, text:"    private threshold = 5," },
    { type:'a', n:13, text:"    private cooldownMs = 30_000," },
    { type:'a', n:14, text:"  ) {}" },
    { type:'a', n:15, text:"" },
    { type:'a', n:16, text:"  isOpen(vendor: string): boolean {" },
    { type:'a', n:17, text:"    const opened = this.openedAt.get(vendor);" },
    { type:'a', n:18, text:"    if (!opened) return false;" },
    { type:'a', n:19, text:"    if (Date.now() - opened > this.cooldownMs) {" },
    { type:'a', n:20, text:"      this.openedAt.delete(vendor);" },
    { type:'a', n:21, text:"      this.failures.delete(vendor);" },
    { type:'a', n:22, text:"      return false; // half-open" },
    { type:'a', n:23, text:"    }" },
    { type:'a', n:24, text:"    return true;" },
    { type:'a', n:25, text:"  }" },
    { type:'a', n:26, text:"" },
    { type:'a', n:27, text:"  recordFailure(vendor: string, state: ChainState) {" },
    { type:'a', n:28, text:"    if (state === 'GATED') return; // gated is expected, not a failure" },
    { type:'a', n:29, text:"    const next = (this.failures.get(vendor) ?? 0) + 1;" },
    { type:'a', n:30, text:"    this.failures.set(vendor, next);" },
    { type:'a', n:31, text:"    if (next >= this.threshold) this.openedAt.set(vendor, Date.now());" },
    { type:'a', n:32, text:"  }" },
    { type:'a', n:33, text:"" },
    { type:'a', n:34, text:"  abortInflight(vendor: string) {" },
    { type:'a', n:35, text:"    this.aborters.get(vendor)?.abort();" },
    { type:'a', n:36, text:"  }" },
    { type:'a', n:37, text:"}" },
  ],
  'pricing-update/handlers/amazon.ts': [
    { type:'h', text:'@@ -42,15 +42,59 @@ export async function handleAmazon(...) {' },
    { type:'c', n:42, text:"  const cb = breakerFor('amazon');" },
    { type:'c', n:43, text:"  if (cb.isOpen('amazon')) return { state: 'CIRCUIT_OPEN' };" },
    { type:'c', n:44, text:"" },
    { type:'r', n:45, text:"  const res = await fetchAmazon(input);" },
    { type:'a', n:45, text:"  const ctrl = new AbortController();" },
    { type:'a', n:46, text:"  cb.bindController('amazon', ctrl);" },
    { type:'a', n:47, text:"  const res = await fetchAmazon(input, { signal: ctrl.signal });" },
    { type:'c', n:48, text:"" },
    { type:'r', n:46, text:"  if (res.kind === 'error') {" },
    { type:'r', n:47, text:"    cb.recordFailure('amazon');" },
    { type:'r', n:48, text:"    return { state: 'ERROR' };" },
    { type:'r', n:49, text:"  }" },
    { type:'a', n:49, text:"  switch (res.kind) {" },
    { type:'a', n:50, text:"    case 'CART_GATED_PRICE':" },
    { type:'a', n:51, text:"      // Map CART_GATED_PRICE → GATED so chain doesn't miss." },
    { type:'a', n:52, text:"      log.info('amazon.cart_gated', { sku: input.sku });" },
    { type:'a', n:53, text:"      return { state: 'GATED', source: 'amazon' };" },
    { type:'a', n:54, text:"    case 'error':" },
    { type:'a', n:55, text:"      cb.recordFailure('amazon', 'ERROR');" },
    { type:'a', n:56, text:"      return { state: 'ERROR' };" },
    { type:'a', n:57, text:"    default:" },
    { type:'a', n:58, text:"      return res;" },
    { type:'a', n:59, text:"  }" },
    { type:'c', n:60, text:"}" },
  ],
  'pricing-update/types/chain.ts': [
    { type:'h', text:'@@ -3,6 +3,11 @@ export type ChainState =' },
    { type:'c', n:3, text:"  | 'OK'" },
    { type:'c', n:4, text:"  | 'EMPTY'" },
    { type:'c', n:5, text:"  | 'ERROR'" },
    { type:'a', n:6, text:"  | 'GATED'           // vendor returned a gated price (CART_GATED_PRICE)" },
    { type:'a', n:7, text:"  | 'CIRCUIT_OPEN'    // breaker is open for this vendor" },
    { type:'c', n:8, text:"  | 'TIMEOUT';" },
  ],
  'tests/pricing-update/gated.spec.ts': [
    { type:'h', text:'@@ -0,0 +1,96 @@' },
    { type:'a', n:1,  text:"import { describe, it, expect } from 'vitest';" },
    { type:'a', n:2,  text:"import { handleAmazon } from '../../pricing-update/handlers/amazon';" },
    { type:'a', n:3,  text:"" },
    { type:'a', n:4,  text:"describe('amazon CART_GATED_PRICE', () => {" },
    { type:'a', n:5,  text:"  it('maps gated to ChainState.GATED', async () => {" },
    { type:'a', n:6,  text:"    const res = await handleAmazon({ sku: 'B0FAKE', __mock: 'cart_gated' });" },
    { type:'a', n:7,  text:"    expect(res.state).toBe('GATED');" },
    { type:'a', n:8,  text:"    expect(res.source).toBe('amazon');" },
    { type:'a', n:9,  text:"  });" },
    { type:'a', n:10, text:"  it('does not count GATED as breaker failure', async () => {" },
    { type:'a', n:11, text:"    // … 7 more cases" },
    { type:'a', n:12, text:"  });" },
    { type:'a', n:13, text:"});" },
  ],
};

const WS_TERMINAL_SEED = [
  { stream:'sys',   t:'16:27:48', text:'$ allen exec --workflow=feature-plan-and-implement --task=ENG-1453' },
  { stream:'agent', t:'16:27:51', text:'[intake-clarifier] read 12 files in pricing-update/...' },
  { stream:'agent', t:'16:28:42', text:'[prd-writer] PRD draft ready (1.2k tokens, $0.11)' },
  { stream:'agent', t:'16:29:34', text:'[hla-writer] HLA: vendor-scoped breaker + AbortController; 13 files'},
  { stream:'agent', t:'16:31:01', text:'[plan-gate] awaiting human approval'},
  { stream:'sys',   t:'16:31:14', text:'plan approved by manish'},
  { stream:'agent', t:'16:31:20', text:'[impl-cortex] writing pricing-update/circuit-breaker.ts (new file)'},
  { stream:'agent', t:'16:31:54', text:'[impl-cortex] writing pricing-update/handlers/amazon.ts'},
  { stream:'agent', t:'16:32:09', text:'$ pnpm tsc --noEmit'},
  { stream:'out',   t:'16:32:11', text:'> tsc --noEmit'},
  { stream:'out',   t:'16:32:18', text:'pricing-update/handlers/amazon.ts:48:11 — overlap on ChainState narrowing'},
  { stream:'agent', t:'16:32:21', text:'[impl-cortex] tightening switch — adding default: return res'},
  { stream:'agent', t:'16:32:34', text:'$ pnpm tsc --noEmit'},
  { stream:'out',   t:'16:32:39', text:'… clean'},
  { stream:'agent', t:'16:32:40', text:'$ pnpm vitest run pricing-update'},
  { stream:'out',   t:'16:32:46', text:'  ✓ amazon CART_GATED_PRICE > maps gated to ChainState.GATED'},
  { stream:'out',   t:'16:32:46', text:'  ✓ amazon CART_GATED_PRICE > does not count GATED as breaker failure'},
  { stream:'out',   t:'16:32:51', text:'  Test Files  3 passed (3)'},
  { stream:'out',   t:'16:32:51', text:'  Tests       8 passed | 4 pending (12)'},
  { stream:'agent', t:'16:32:52', text:'[qa-runner] 8/12 passing — 4 still pending vendor-rule-healer fixture'},
];

// Convert unified diff (h/c/a/r lines) into side-by-side rows with paired add/remove.
function toSideBySide(unified) {
  const rows = [];
  let i = 0;
  while (i < unified.length) {
    const line = unified[i];
    if (line.type === 'h') { rows.push({ type:'header', text: line.text }); i++; continue; }
    if (line.type === 'c') {
      rows.push({ type:'context', left: { n:line.n, text:line.text }, right: { n:line.n, text:line.text } });
      i++; continue;
    }
    // pair contiguous removed/added lines into the same row
    const removed = [];
    const added = [];
    while (i < unified.length && unified[i].type === 'r') { removed.push(unified[i]); i++; }
    while (i < unified.length && unified[i].type === 'a') { added.push(unified[i]); i++; }
    if (removed.length === 0 && added.length === 0) { i++; continue; }
    const max = Math.max(removed.length, added.length);
    for (let j = 0; j < max; j++) {
      rows.push({
        type: 'changed',
        left:  removed[j] ? { n:removed[j].n, text:removed[j].text, marker:'−', kind:'removed' } : null,
        right: added[j]   ? { n:added[j].n,   text:added[j].text,   marker:'+', kind:'added'   } : null,
      });
    }
  }
  return rows;
}

// Workspace picker — wider popover, search, full names + branch + status pills
function WorkspacePicker({ workspaces, activeId, onPick }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = React.useRef(null);
  const active = workspaces.find(w => w.id === activeId) || workspaces[0];

  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const key = (e) => {
      if (e.key === 'Escape') setOpen(false);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'w') {
        e.preventDefault(); setOpen(o => !o);
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', key); };
  }, [open]);

  // ⌘W to open even when closed
  useEffect(() => {
    const key = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'w') {
        e.preventDefault(); setOpen(true);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  const filtered = workspaces.filter(w =>
    !q || w.id.toLowerCase().includes(q.toLowerCase()) || (w.branch||'').toLowerCase().includes(q.toLowerCase())
  );

  return (
    <div className="wsp-wrap" ref={ref}>
      <button className={`wsp-btn ${open?'open':''}`} onClick={()=>setOpen(o=>!o)} title="switch workspace (⌘W)">
        <Icons.workspace size={12}/>
        <span className="wsp-btn-name mono">{active.id}</span>
        <Icons.chevD size={11}/>
      </button>
      {open && (
        <div className="wsp-pop">
          <div className="wsp-search">
            <Icons.search size={12}/>
            <input
              autoFocus
              placeholder="search workspaces by name or branch…"
              value={q}
              onChange={e=>setQ(e.target.value)}/>
            <kbd className="wsp-kbd mono">⌘W</kbd>
          </div>
          <div className="wsp-list">
            {filtered.length === 0 && <div className="wsp-empty">no workspaces match "{q}"</div>}
            {filtered.map(w => (
              <button
                key={w.id}
                className={`wsp-row ${activeId===w.id?'active':''}`}
                onClick={()=>{ onPick(w.id); setOpen(false); }}>
                <span className="wsp-row-ic">
                  {w.status === 'running'
                    ? <span className="dot accent pulse"/>
                    : <span className="dot ok"/>}
                </span>
                <span className="wsp-row-body">
                  <span className="wsp-row-name mono">{w.id}</span>
                  <span className="wsp-row-meta">
                    <span className="wsp-row-branch mono">⎇ {w.branch}</span>
                    <span className="wsp-row-dot">·</span>
                    <span className="mono">{w.repo}</span>
                  </span>
                </span>
                <span className="wsp-row-tail">
                  {w.changed > 0 && <span className="chip warn mono" style={{fontSize:10}}>{w.changed} ch</span>}
                  {activeId===w.id && <Icons.check size={12}/>}
                </span>
              </button>
            ))}
          </div>
          <div className="wsp-foot">
            <span className="muted">{workspaces.length} workspaces</span>
            <span className="muted">↑↓ to navigate · ⏎ to select</span>
          </div>
        </div>
      )}
    </div>
  );
}

function WorkspacesPage({ embed }) {
  const ws = window.MOCK.WORKSPACES;
  // Default to the workspace tied to ENG-1453 (the demo task)
  const [activeId, setActiveId] = useState('pr-570-schema_queries_answerability');
  const active = ws.find(w => w.id === activeId) || ws[0];
  const [activeFile, setActiveFile] = useState(WS_FILES[0].path);
  const [terminalOpen, setTerminalOpen] = useState(true);
  const [logs, setLogs] = useState(WS_TERMINAL_SEED);
  const [diffMode, setDiffMode] = useState('sbs'); // 'unified' | 'sbs'
  const termRef = React.useRef(null);

  // Stream a few extra log lines so the terminal feels live
  useEffect(() => {
    const tail = [
      { stream:'agent', text:'[qa-runner] re-running pending suite…' },
      { stream:'out',   text:'  ✓ vendor-rule-healer > recovers after CIRCUIT_OPEN' },
      { stream:'out',   text:'  Tests  10 passed | 2 pending (12)' },
      { stream:'agent', text:'[sec-scout] auditing AbortController usage…' },
      { stream:'agent', text:'[sec-scout] no findings.' },
    ];
    let i = 0;
    const id = setInterval(() => {
      if (i >= tail.length) return;
      const now = new Date();
      const t = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
      setLogs(prev => [...prev, { ...tail[i], t }]);
      i++;
    }, 2200);
    return () => clearInterval(id);
  }, []);

  // auto-scroll terminal to bottom
  useEffect(() => {
    if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight;
  }, [logs.length]);

  const totalChanged = WS_FILES.length;
  const totalPlus = WS_FILES.reduce((s,f) => s + f.plus, 0);
  const totalMinus = WS_FILES.reduce((s,f) => s + f.minus, 0);
  const diff = WS_DIFFS[activeFile] || [];

  return (
    <div className="ws-shell" data-screen-label="workspaces">
      {/* TOP BAR — workspace selector + status */}
      <header className="ws-top">
        <div className="ws-top-l">
          <WorkspacePicker workspaces={ws} activeId={activeId} onPick={setActiveId}/>
          <span className="ws-meta">
            <span className="mono ws-branch">⎇ {active.branch}</span>
            <span className="ws-dot">·</span>
            <span className="mono">{active.repo}</span>
            <span className="ws-dot">·</span>
            <span className="mono">port {active.port}</span>
          </span>
        </div>
        <div className="ws-top-r">
          {active.status === 'running'
            ? <span className="chip info"><Icons.spinner size={10}/>agent running</span>
            : <span className="chip ok"><span className="dot ok"/>idle</span>}
          <span className="chip">{totalChanged} changed</span>
          <span className="chip ok mono">+{totalPlus}</span>
          <span className="chip warn mono">−{totalMinus}</span>
          <button className="btn ghost sm" title="Open in your IDE"><Icons.ext size={12}/> open</button>
          <button className="btn ghost sm" title="Sync"><Icons.refresh size={12}/></button>
          <button className="btn primary sm"><Icons.pr size={12}/> open PR</button>
        </div>
      </header>

      {/* MAIN — file tree | diff | (terminal at bottom) */}
      <div className="ws-main">
        <aside className="ws-tree scroll-hide">
          <div className="ws-tree-h">
            <span>files changed</span>
            <span className="mono ws-tree-ct">{WS_FILES.length}</span>
          </div>
          <div className="ws-tree-list">
            {WS_FILES.map(f => (
              <button
                key={f.path}
                className={`ws-file ${activeFile===f.path?'active':''}`}
                onClick={()=>setActiveFile(f.path)}>
                <span className={`ws-file-tag ${f.status}`}>{f.status === 'new' ? 'A' : 'M'}</span>
                <span className="ws-file-p">{f.path}</span>
                <span className="ws-file-d mono">
                  {f.plus  ? <span className="pos">+{f.plus}</span> : null}
                  {f.minus ? <span className="neg">−{f.minus}</span> : null}
                </span>
              </button>
            ))}
          </div>
        </aside>

        <section className="ws-diff scroll-hide">
          <div className="ws-diff-h">
            <Icons.file size={12}/>
            <span className="mono">{activeFile}</span>
            <div className="ws-diff-h-r">
              <div className="ws-diff-toggle">
                <button className={diffMode==='sbs'?'active':''} onClick={()=>setDiffMode('sbs')} title="side by side"><SbsIcon/> split</button>
                <button className={diffMode==='unified'?'active':''} onClick={()=>setDiffMode('unified')} title="unified"><UnifiedIcon/> unified</button>
              </div>
              <button className="btn ghost sm">copy path</button>
              <button className="btn ghost sm"><Icons.chat size={12}/> comment</button>
            </div>
          </div>
          <div className="ws-diff-body">
            {diff.length === 0 ? (
              <div className="ws-diff-empty">no diff for this file yet — agent hasn't touched it.</div>
            ) : diffMode === 'unified' ? (
              diff.map((line, i) => (
                <div key={i} className={`ws-line ${line.type}`}>
                  <span className="ws-ln mono">{line.type === 'h' ? '' : (line.n || '')}</span>
                  <span className="ws-mark mono">{line.type==='a'?'+':line.type==='r'?'−':line.type==='h'?'':' '}</span>
                  <span className="ws-code mono">{line.text}</span>
                </div>
              ))
            ) : (
              <div className="ws-sbs">
                {toSideBySide(diff).map((row, i) => {
                  if (row.type === 'header') return (
                    <div key={i} className="ws-sbs-header">
                      <span className="ws-code mono">{row.text}</span>
                    </div>
                  );
                  return (
                    <div key={i} className={`ws-sbs-row ${row.type}`}>
                      <DiffCell side="left"  cell={row.left}/>
                      <DiffCell side="right" cell={row.right}/>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      </div>

      {/* TERMINAL — fixed bottom drawer, collapsible */}
      <div className={`ws-term ${terminalOpen?'open':'closed'}`}>
        <div className="ws-term-h" onClick={()=>setTerminalOpen(o=>!o)}>
          <Icons.cmd size={12}/>
          <span>terminal · agent activity</span>
          <span className="ws-term-ct mono">{logs.length} lines</span>
          <div style={{flex:1}}/>
          <span className="chip info" onClick={(e)=>e.stopPropagation()}><span className="dot accent pulse"/>live</span>
          <button className="btn ghost sm" onClick={(e)=>{ e.stopPropagation(); setTerminalOpen(o=>!o); }} title={terminalOpen?'hide':'show'}>
            {terminalOpen ? <Icons.chevD size={12}/> : <Icons.chevR size={12} style={{transform:'rotate(-90deg)'}}/>}
          </button>
        </div>
        {terminalOpen && (
          <div className="ws-term-body" ref={termRef}>
            {logs.map((l, i) => (
              <div key={i} className={`ws-log ${l.stream}`}>
                <span className="ws-log-t mono">{l.t}</span>
                <span className={`ws-log-s ${l.stream} mono`}>{l.stream}</span>
                <span className="ws-log-x mono">{l.text}</span>
              </div>
            ))}
          </div>
        )}
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
