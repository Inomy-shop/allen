// V1 — Editorial landing
function LandingV1() {
  return (
    <div className="lp v1">
      <nav className="nav">
        <div className="brand"><span className="brand-mark">[a]</span><span>allen</span></div>
        <a>Docs</a><a>Workflows</a><a>Showcase</a><a>Blog</a>
        <div className="right">
          <a className="btn" href="#"><LPIcons.github size={14}/> 4.2k</a>
          <a className="btn primary" href="#">Get started <LPIcons.arrow/></a>
        </div>
      </nav>

      <section className="hero">
        <div className="eyebrow"><LPIcons.spark size={11}/> Open source · MIT</div>
        <h1>An <em>operating system</em> for agentic software development.</h1>
        <p className="lede">Allen is an org of agents that plans, writes, reviews, and ships code together — with you at the gates that matter. Reusable workflows, full traces, your infra.</p>
        <div className="cta-row">
          <a className="btn primary lg" href="#">Star on GitHub <LPIcons.github/></a>
          <a className="btn lg" href="#">Read the docs <LPIcons.arrow/></a>
        </div>
        <div className="install">
          <span><span style={{color:'oklch(0.62 0.18 258)'}}>$</span> curl allen.sh/install | sh</span>
          <span className="copy"><LPIcons.copy/></span>
        </div>
      </section>

      <div className="preview-wrap">
        <div className="preview">
          <div className="preview-bar">
            <div className="dot" style={{background:'oklch(0.78 0.18 25)'}}/>
            <div className="dot" style={{background:'oklch(0.85 0.14 75)'}}/>
            <div className="dot" style={{background:'oklch(0.78 0.14 155)'}}/>
            <div className="url">allen.local · home</div>
          </div>
          <ProductPreview/>
        </div>
      </div>

      <section className="pos">
        <div className="pos-grid">
          <div>
            <div className="pos-eye">What is allen</div>
            <h2>Not one agent. <em>An organization.</em></h2>
          </div>
          <div className="body">
            <p>Today's coding agents are individual contributors. They take a task, run, and stop. Allen models a real engineering org: a CEO that routes, departments that own domains, leads that delegate, and specialists that execute.</p>
            <p>You assign work like you would to a team. Allen plans, asks for approval at gates you define, runs in parallel, opens PRs, resolves review comments, and reports back.</p>
          </div>
        </div>
        <div className="pillars">
          <div className="pillar">
            <div className="num">01 / Workflows</div>
            <h3>Reusable, version-controlled</h3>
            <p>Like CI for agents. Define once, run everywhere. Pause for approval where it matters.</p>
          </div>
          <div className="pillar">
            <div className="num">02 / Trace</div>
            <h3>Inspect every tool call</h3>
            <p>Live logs, deterministic replay, cost per run. No black boxes.</p>
          </div>
          <div className="pillar">
            <div className="num">03 / Yours</div>
            <h3>Self-hosted, model-agnostic</h3>
            <p>Run on your infra with your secrets. BYO Claude, GPT, or local.</p>
          </div>
        </div>
      </section>

      <section className="org">
        <div className="org-head">
          <h2>The shape of <em>your engineering team</em>, in software.</h2>
          <div className="meta">13 departments<br/>149 agents<br/>live · streaming</div>
        </div>
        <div className="chart"><OrgChart theme="light"/></div>
      </section>

      <section className="compare">
        <div className="compare-inner">
          <h2>How allen compares.</h2>
          <CompareTable variant="v1"/>
        </div>
      </section>

      <footer className="footer">
        <div className="brand"><span className="brand-mark">[a]</span><span>allen</span></div>
        <div className="links"><a>Docs</a><a>GitHub</a><a>Discord</a><a>Blog</a><a>Changelog</a></div>
        <div className="copyr">MIT · v0.2 · inomy</div>
      </footer>
    </div>
  );
}

// V2 — Operator dark
function LandingV2() {
  const seed = React.useMemo(() => [
    {ts:'16:30:01', lvl:'info', msg:<>orchestrator started: <b>feature-plan-and-implement</b></>},
    {ts:'16:30:02', lvl:'tool', msg:'al:delegate_to_agent(intake-clarifier)'},
    {ts:'16:30:05', lvl:'ok',   msg:'intake-clarifier ✓ ask is unambiguous'},
    {ts:'16:30:06', lvl:'tool', msg:'al:delegate_to_agent(prd-writer)'},
    {ts:'16:30:32', lvl:'ok',   msg:'prd-writer ✓ produced PRD (1.2k tokens)'},
    {ts:'16:30:33', lvl:'tool', msg:'al:delegate_to_agent(hla-writer || tdd-writer) [parallel]'},
    {ts:'16:31:04', lvl:'ok',   msg:'hla-writer ✓ produced HLA'},
    {ts:'16:31:11', lvl:'ok',   msg:'tdd-writer ✓ produced test plan'},
    {ts:'16:31:12', lvl:'warn', msg:<>plan-gate <b>requested approval</b> — waiting for human</>},
  ], []);
  const [logs, setLogs] = React.useState(() => seed.slice(0, 1));
  React.useEffect(() => {
    const t = setInterval(() => {
      setLogs(prev => {
        if (prev.length >= seed.length) return prev;
        const next = seed[prev.length];
        if (!next) return prev;
        return [...prev, next];
      });
    }, 420);
    return () => clearInterval(t);
  }, [seed]);

  return (
    <div className="lp v2 v2-grid">
      <nav className="nav">
        <div className="brand"><span className="brand-mark">[a]</span><span>allen</span></div>
        <a>docs</a><a>workflows</a><a>roadmap</a>
        <div className="right">
          <span className="badge-live"><span className="pulse-dot"/>149 agents · 14 live</span>
          <a className="btn" href="#"><LPIcons.github size={13}/> 4,234</a>
          <a className="btn primary" href="#">$ install <LPIcons.arrow size={12}/></a>
        </div>
      </nav>

      <section className="hero">
        <div className="hero-grid">
          <div>
            <div className="eyebrow"><span className="pulse-dot"/> open source · MIT · self-host</div>
            <h1>Ship features with <span className="accent">an org of agents</span>, not a single chatbot.</h1>
            <p className="lede">Allen is an agentic operating system for software teams. Assign in chat, watch agents plan, code, review, and open PRs — then approve at the gates you define.</p>
            <div className="cta-row">
              <a className="btn primary lg" href="#"><LPIcons.github size={14}/> Star on GitHub</a>
              <a className="btn lg" href="#">Read the docs <LPIcons.arrow size={13}/></a>
              <span className="install"><span className="prompt">$</span> curl allen.sh/install | sh</span>
            </div>
          </div>
          <div className="console">
            <div className="console-bar">
              <span style={{width:9, height:9, borderRadius:'50%', background:'oklch(0.78 0.18 25)'}}/>
              <span style={{width:9, height:9, borderRadius:'50%', background:'oklch(0.85 0.14 75)'}}/>
              <span style={{width:9, height:9, borderRadius:'50%', background:'oklch(0.78 0.14 155)'}}/>
              <span className="ttl" style={{marginLeft: 12}}>run · ae966eb9 · feature-plan-and-implement</span>
              <span style={{color:'oklch(0.85 0.14 258)'}}>● running 154s · $0.92</span>
            </div>
            <div className="console-tabs">
              <span className="console-tab active">trace</span>
              <span className="console-tab">logs · {logs.length}</span>
              <span className="console-tab">diff · 42</span>
              <span className="console-tab">cost</span>
            </div>
            <div className="console-body">
              {logs.map((l, i) => (
                <div className="log-row" key={i}>
                  <span className="ts">{l.ts}</span>
                  <span className={`lvl ${l.lvl}`}>{l.lvl.toUpperCase()}</span>
                  <span className="msg">{l.msg}</span>
                </div>
              ))}
              <div className="log-row"><span className="ts"></span><span className="lvl info"></span><span className="msg cursor"></span></div>
            </div>
          </div>
        </div>
      </section>

      <section className="strip">
        <div className="strip-inner">
          <span className="strip-label">Connects to</span>
          <span className="mono" style={{fontSize:13}}>github</span>
          <span className="mono" style={{fontSize:13}}>linear</span>
          <span className="mono" style={{fontSize:13}}>slack</span>
          <span className="mono" style={{fontSize:13}}>claude</span>
          <span className="mono" style={{fontSize:13}}>openai</span>
          <span className="mono" style={{fontSize:13}}>postgres</span>
        </div>
      </section>

      <section className="pos">
        <div className="pos-eye">What is allen</div>
        <h2>One agent ships features. <span style={{color:'oklch(0.85 0.14 258)'}}>An org of agents</span> ships products.</h2>
        <p className="lede2">Most coding agents are individual contributors. Allen models a real engineering org — a CEO that routes, departments that own domains, leads that delegate, specialists that execute, and humans at the gates.</p>
        <div className="pillars">
          <div className="pillar">
            <div className="num">01 // workflows</div>
            <h3>CI for agents</h3>
            <p>Reusable, version-controlled, with explicit human gates and parallelism.</p>
          </div>
          <div className="pillar">
            <div className="num">02 // trace</div>
            <h3>Every tool call, inspectable</h3>
            <p>Live logs, replay, cost. Bring receipts to the standup.</p>
          </div>
          <div className="pillar">
            <div className="num">03 // yours</div>
            <h3>Self-hosted, model-agnostic</h3>
            <p>Your infra, your secrets, your model. BYO Claude, GPT, or local.</p>
          </div>
        </div>
      </section>

      <section className="org">
        <div className="org-head">
          <h2>The org chart, live.</h2>
          <div className="meta">13 departments · 149 agents<br/>delegating in real time</div>
        </div>
        <div className="chart"><OrgChart theme="dark"/></div>
      </section>

      <section className="compare">
        <h2>How allen compares.</h2>
        <CompareTable variant="v2"/>
      </section>

      <footer className="footer">
        <div className="brand"><span className="brand-mark">[a]</span><span>allen</span></div>
        <div className="links"><a>docs</a><a>github</a><a>discord</a><a>blog</a></div>
        <div className="copyr">MIT · v0.2 · built by inomy</div>
      </footer>
    </div>
  );
}

// V3 — Swiss / mega wordmark / diagram-led
function LandingV3() {
  return (
    <div className="lp v3">
      <nav className="nav">
        <div className="brand"><span className="brand-mark">[a]</span><span>ALLEN</span></div>
        <a>Docs</a><a>Workflows</a><a>Showcase</a>
        <div className="right">
          <a className="btn" href="#"><LPIcons.github size={14}/> Star</a>
          <a className="btn primary" href="#">Install <LPIcons.arrow/></a>
        </div>
      </nav>

      <section className="hero">
        <div className="hero-tag">
          <span className="tag accent">v0.2</span>
          <span className="tag">Open source · MIT</span>
          <span className="meta">EST. 2026 · inomy · runs anywhere</span>
        </div>
        <h1 className="mega">ALLEN<span className="of">/an org of agents.</span></h1>
      </section>

      <div className="hero-bottom">
        <div className="hero-lede">
          The agentic operating system for software development. Plan, code, review, ship — with a hierarchy of agents that mirrors your team, and humans at the gates that matter.
        </div>
        <div className="hero-stats">
          <div className="hero-stat"><div className="n">149</div><div className="l">Agents</div></div>
          <div className="hero-stat"><div className="n">13</div><div className="l">Departments</div></div>
          <div className="hero-stat"><div className="n">4.2k</div><div className="l">GitHub stars</div></div>
        </div>
      </div>

      <div className="cta-row">
        <a className="btn primary lg" href="#"><LPIcons.github/> Star on GitHub</a>
        <a className="btn lg" href="#">Read the docs <LPIcons.arrow/></a>
        <a className="btn accent lg" href="#">Try the demo →</a>
      </div>

      <section className="chart-section">
        <div className="chart-frame">
          <div className="chart-bar">
            <span className="live-dot"/>
            <span>LIVE · 14 agents in flight · 8 awaiting human · streaming from production demo</span>
            <span style={{marginLeft:'auto'}}>{new Date().toLocaleTimeString()}</span>
          </div>
          <div className="chart-pad"><OrgChart theme="light"/></div>
        </div>
      </section>

      <section className="pos">
        <div className="pos-grid">
          <div>
            <div className="pos-eye">What is allen</div>
            <div className="pos-num">01</div>
          </div>
          <div>
            <h2>One agent ships features. An org of agents ships products.</h2>
            <p>Most coding assistants are individual contributors — they take a task and stop. Allen models a real engineering organization: a CEO orchestrator that routes, leads that delegate, specialists that execute, auditors that approve, and humans at the gates.</p>
            <p>Assign work like you would to a teammate. Allen plans the work, pauses for your approval, parallelizes execution, opens PRs, resolves review comments, and reports back.</p>
          </div>
        </div>
        <div className="pillars">
          <div className="pillar">
            <div className="num">01</div>
            <h3>Workflows are first-class.</h3>
            <p>Reusable, version-controlled, declarative. Like CI for agents.</p>
          </div>
          <div className="pillar">
            <div className="num">02</div>
            <h3>Trace everything.</h3>
            <p>Every tool call, every token, every cost. Replay any run.</p>
          </div>
          <div className="pillar">
            <div className="num">03</div>
            <h3>Self-hosted, model-agnostic.</h3>
            <p>Your infra, your model, your secrets. MIT.</p>
          </div>
        </div>
      </section>

      <section className="compare">
        <div className="compare-head">
          <h2>How allen compares.</h2>
          <span className="mono" style={{fontSize: 12, marginLeft:'auto', color:'oklch(0.40 0.012 250)'}}>updated · apr 2026</span>
        </div>
        <CompareTable variant="v3"/>
      </section>

      <footer className="footer">
        <div className="brand"><span className="brand-mark">[a]</span><span>ALLEN</span></div>
        <div className="links"><a>Docs</a><a>GitHub</a><a>Discord</a><a>Blog</a></div>
        <div className="copyr">MIT · v0.2 · inomy</div>
      </footer>
    </div>
  );
}

window.LandingV1 = LandingV1;
window.LandingV2 = LandingV2;
window.LandingV3 = LandingV3;
