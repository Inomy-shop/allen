// Shared landing page components: org chart, preview, icons

const LPIcons = {
  github: ({size=16}) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-2.16c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.74-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.18 1.18a11 11 0 015.79 0c2.21-1.49 3.18-1.18 3.18-1.18.62 1.58.23 2.75.11 3.04.74.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.4-5.25 5.68.41.36.78 1.05.78 2.12v3.14c0 .31.21.67.8.55 4.56-1.52 7.85-5.83 7.85-10.91C23.5 5.65 18.35.5 12 .5z"/>
    </svg>
  ),
  arrow: ({size=14}) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 5l7 7-7 7"/></svg>,
  copy: ({size=12}) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>,
  check: ({size=12}) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7"/></svg>,
  x: ({size=12}) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>,
  star: ({size=14}) => <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.6 7.7H22l-6.5 4.7 2.5 7.6L12 17.3 5.9 22l2.5-7.6L2 9.7h7.4z"/></svg>,
  spark: ({size=14}) => <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>,
};

// === Product preview (used in hero of v1, v3) ===
function ProductPreview() {
  return (
    <div className="preview-body">
      <div className="preview-side">
        <div className="pgrp">Inbox</div>
        <div className="pitem"><span className="pdot"/>home</div>
        <div className="pitem active"><span className="pdot"/>chat<span className="badge">3</span></div>
        <div className="pitem"><span className="pdot"/>interventions<span className="badge">8</span></div>
        <div className="pgrp">Work</div>
        <div className="pitem"><span className="pdot"/>live runs<span className="badge">14</span></div>
        <div className="pitem"><span className="pdot"/>workspaces<span className="badge">10</span></div>
        <div className="pitem"><span className="pdot"/>pull requests<span className="badge">21</span></div>
        <div className="pgrp">Build</div>
        <div className="pitem"><span className="pdot"/>workflows<span className="badge">12</span></div>
        <div className="pitem"><span className="pdot"/>agents<span className="badge">149</span></div>
      </div>
      <div className="preview-main">
        <div style={{display:'flex', alignItems:'center', gap: 10, marginBottom: 14}}>
          <div style={{fontSize: 14, fontWeight: 600}}>Good afternoon, Manish</div>
          <div style={{marginLeft:'auto', fontFamily:'JetBrains Mono', fontSize: 10, color:'oklch(0.55 0.012 250)', display:'flex', gap:6, alignItems:'center'}}>
            <span style={{width:6, height:6, borderRadius:'50%', background:'oklch(0.62 0.18 258)'}}/>2 live · 8 awaiting
          </div>
        </div>
        <div className="preview-kpis">
          <div className="preview-kpi"><div className="l">In flight</div><div className="v">2</div></div>
          <div className="preview-kpi"><div className="l">Awaiting</div><div className="v" style={{color:'oklch(0.62 0.16 75)'}}>8</div></div>
          <div className="preview-kpi"><div className="l">Done today</div><div className="v">14</div></div>
          <div className="preview-kpi"><div className="l">Spend</div><div className="v">$24.18</div></div>
        </div>
        <div className="preview-row">
          <div className="preview-card">
            <h4>Needs you</h4>
            <div className="preview-run"><span className="st warn">gate</span><span className="nm">Approve PRD for ENG-1453</span></div>
            <div className="preview-run"><span className="st warn">ask</span><span className="nm">Vendor allowlist constraint?</span></div>
            <div className="preview-run"><span className="st warn">gate</span><span className="nm">Merge PR #598</span></div>
          </div>
          <div className="preview-card">
            <h4>Live runs</h4>
            <div className="preview-run"><span className="id">ae966</span><span className="nm">feature-plan-and-implement</span><span className="st run">154s</span></div>
            <div className="preview-run"><span className="id">a50be</span><span className="nm">classification-judge</span><span className="st run">22s</span></div>
            <div className="preview-run"><span className="id">ea310</span><span className="nm">resolve-pr-reviews</span><span className="st ok">done</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}

// === Org chart (used in all 3 variants) ===
function OrgChart({ theme = 'light' }) {
  const dark = theme === 'dark';
  const node = (label, role, role2) => (
    <div style={{
      border: `1px solid ${dark ? 'oklch(0.30 0.013 255)' : 'oklch(0.85 0.005 80)'}`,
      background: dark ? 'oklch(0.16 0.012 255)' : 'white',
      borderRadius: 8, padding: '10px 12px',
      minWidth: 130, textAlign: 'center', fontSize: 11.5,
    }}>
      <div style={{fontWeight: 600, marginBottom: 2}}>{label}</div>
      <div style={{fontFamily:'JetBrains Mono', fontSize: 9, color: dark ? 'oklch(0.62 0.012 255)' : 'oklch(0.55 0.012 250)'}}>{role}</div>
      {role2 && <div style={{fontFamily:'JetBrains Mono', fontSize: 9, color: dark ? 'oklch(0.62 0.012 255)' : 'oklch(0.55 0.012 250)'}}>{role2}</div>}
    </div>
  );
  const edge = dark ? 'oklch(0.30 0.013 255)' : 'oklch(0.78 0.005 80)';
  return (
    <div style={{position:'relative'}}>
      {/* CEO */}
      <div style={{display:'flex', justifyContent:'center', marginBottom: 8}}>
        <div style={{
          background: 'oklch(0.62 0.18 258)', color: 'white',
          padding: '12px 18px', borderRadius: 8, fontSize: 13, fontWeight: 600,
          textAlign:'center', minWidth: 150,
        }}>
          <div>CEO orchestrator</div>
          <div style={{fontFamily:'JetBrains Mono', fontSize: 9, opacity: 0.85, marginTop: 2}}>routes · coordinates</div>
        </div>
      </div>
      {/* line */}
      <div style={{height: 18, borderLeft: `1px dashed ${edge}`, width: 1, margin: '0 auto'}}/>
      {/* horizontal connector */}
      <div style={{position:'relative', maxWidth: 1000, margin:'0 auto', display:'flex', justifyContent:'space-between'}}>
        <div style={{position:'absolute', left: '8%', right: '8%', top: 0, height: 1, borderTop: `1px dashed ${edge}`}}/>
        {[0,1,2,3,4,5].map(i => (
          <div key={i} style={{width: 1, height: 18, borderLeft: `1px dashed ${edge}`}}/>
        ))}
      </div>
      {/* department row */}
      <div style={{display:'grid', gridTemplateColumns:'repeat(6, 1fr)', gap: 12, maxWidth: 1000, margin: '0 auto'}}>
        {node('Product', 'PM Lead', '8 agents')}
        {node('Engineering', 'Eng Lead', '14 agents')}
        {node('Data Quality', 'QA Lead', '22 agents')}
        {node('Pipeline', 'Pipeline Lead', '7 agents')}
        {node('Operations', 'Ops Lead', '26 agents')}
        {node('Meta', 'Team Builder', '6 agents')}
      </div>
      {/* line down */}
      <div style={{display:'grid', gridTemplateColumns:'repeat(6, 1fr)', maxWidth: 1000, margin:'8px auto 0'}}>
        {[0,1,2,3,4,5].map(i => (
          <div key={i} style={{display:'flex', justifyContent:'center'}}>
            <div style={{width: 1, height: 14, borderLeft: `1px dashed ${edge}`}}/>
          </div>
        ))}
      </div>
      {/* leaf agents */}
      <div style={{display:'grid', gridTemplateColumns:'repeat(6, 1fr)', gap: 12, maxWidth: 1000, margin: '0 auto'}}>
        {[
          ['scope-writer','prd-auditor'],
          ['developer','tdd-writer'],
          ['validator','dedup-judge'],
          ['extractor','prompt-tuner'],
          ['monitor','runbook-exec'],
          ['agent-builder','team-builder'],
        ].map(([a,b], i) => (
          <div key={i} style={{display:'flex', flexDirection:'column', gap: 6}}>
            <div style={{
              fontFamily:'JetBrains Mono', fontSize: 10,
              border: `1px solid ${dark ? 'oklch(0.30 0.013 255)' : 'oklch(0.92 0.005 80)'}`,
              background: dark ? 'oklch(0.20 0.013 255)' : 'oklch(0.985 0.003 80)',
              padding: '5px 8px', borderRadius: 5, textAlign: 'center',
              color: dark ? 'oklch(0.85 0.008 255)' : 'oklch(0.30 0.012 250)',
            }}>{a}</div>
            <div style={{
              fontFamily:'JetBrains Mono', fontSize: 10,
              border: `1px solid ${dark ? 'oklch(0.30 0.013 255)' : 'oklch(0.92 0.005 80)'}`,
              background: dark ? 'oklch(0.20 0.013 255)' : 'oklch(0.985 0.003 80)',
              padding: '5px 8px', borderRadius: 5, textAlign: 'center',
              color: dark ? 'oklch(0.85 0.008 255)' : 'oklch(0.30 0.012 250)',
            }}>{b}</div>
          </div>
        ))}
      </div>

      {/* Live activity ribbon below */}
      <div style={{marginTop: 28, paddingTop: 18, borderTop: `1px dashed ${edge}`}}>
        <div style={{fontFamily:'JetBrains Mono', fontSize: 10, textTransform:'uppercase', letterSpacing:'0.12em',
          color: dark ? 'oklch(0.85 0.14 258)' : 'oklch(0.55 0.012 250)', marginBottom: 12}}>
          live activity · last 60 seconds
        </div>
        <LiveActivity theme={theme}/>
      </div>
    </div>
  );
}

function LiveActivity({ theme = 'light' }) {
  const [lines, setLines] = React.useState([
    { agent: 'developer', dept: 'engineering', msg: 'wrote tests/pricing/cart_gated.py', t: '2s' },
    { agent: 'prd-auditor', dept: 'product', msg: 'approved PRD for ENG-1453', t: '5s' },
    { agent: 'extractor', dept: 'pipeline', msg: 'al:delegate_to_agent(prompt-tuner)', t: '8s' },
    { agent: 'validator', dept: 'data quality', msg: '184 records validated · 3 flagged', t: '12s' },
    { agent: 'agent-builder', dept: 'meta', msg: 'spawned new agent: vendor-rule-healer', t: '16s' },
  ]);
  React.useEffect(() => {
    const pool = [
      ['developer', 'engineering', 'opened workspace pr-598-pricing'],
      ['security-reviewer', 'engineering', 'flagged 1 medium concern on diff'],
      ['scope-writer', 'product', 'drafted PRD section 3 of 4'],
      ['dedup-judge', 'data quality', 'reconciled 12 disagreements'],
      ['runbook-exec', 'operations', 'restarted scrape-worker-7'],
      ['tdd-writer', 'engineering', 'drafted test plan for pricing chain'],
      ['team-builder', 'meta', 'reviewed staffing for product team'],
    ];
    const t = setInterval(() => {
      const p = pool[Math.floor(Math.random()*pool.length)];
      setLines(prev => [{ agent: p[0], dept: p[1], msg: p[2], t: 'now' }, ...prev.slice(0,4)]);
    }, 1800);
    return () => clearInterval(t);
  }, []);
  const dark = theme === 'dark';
  return (
    <div style={{display:'flex', flexDirection:'column', gap: 4, fontFamily:'JetBrains Mono', fontSize: 11.5}}>
      {lines.map((l, i) => (
        <div key={l.t + i} style={{
          display:'grid', gridTemplateColumns:'140px 110px 1fr 50px', gap: 14,
          padding: '6px 12px', borderRadius: 5,
          background: i === 0 ? (dark ? 'oklch(0.32 0.10 258 / 0.30)' : 'oklch(0.95 0.04 258)') : 'transparent',
          opacity: 1 - i * 0.15,
          transition: 'opacity 300ms',
          color: dark ? 'oklch(0.85 0.008 255)' : 'oklch(0.30 0.012 250)',
        }}>
          <span style={{color: dark ? 'oklch(0.85 0.14 258)' : 'oklch(0.45 0.18 258)', fontWeight: 500}}>{l.agent}</span>
          <span style={{color: dark ? 'oklch(0.62 0.012 255)' : 'oklch(0.55 0.012 250)'}}>{l.dept}</span>
          <span>{l.msg}</span>
          <span style={{textAlign:'right', color: dark ? 'oklch(0.55 0.012 255)' : 'oklch(0.62 0.012 250)'}}>{l.t}</span>
        </div>
      ))}
    </div>
  );
}

// === Comparison data ===
const COMPARE_ROWS = [
  ['Multiple agents collaborating', { allen: 'y', devin: 'n', cursor: 'n', codex: 'n' }, 'Org of agents with delegation, audits, and human gates.'],
  ['Open source', { allen: 'y', devin: 'n', cursor: 'n', codex: 'n' }, 'MIT — fork it, extend it, run it.'],
  ['Bring your own model', { allen: 'y', devin: 'p', cursor: 'p', codex: 'n' }, 'Claude / GPT / local — model-agnostic.'],
  ['Reusable workflows', { allen: 'y', devin: 'p', cursor: 'n', codex: 'n' }, 'Version-controlled, like CI but for agents.'],
  ['Human-in-the-loop gates', { allen: 'y', devin: 'p', cursor: 'n', codex: 'n' }, 'Approve plans before code is written.'],
  ['Live trace + replay', { allen: 'y', devin: 'p', cursor: 'n', codex: 'n' }, 'Every run is inspectable down to the tool call.'],
  ['Linear / GitHub / Slack', { allen: 'y', devin: 'y', cursor: 'p', codex: 'p' }, 'Native two-way sync.'],
  ['Self-hosted', { allen: 'y', devin: 'n', cursor: 'n', codex: 'n' }, 'Runs on your infra, your secrets.'],
];

function CompareTable({ variant }) {
  const cell = (k) => k === 'y' ? <span className="y"><LPIcons.check/></span> : k === 'p' ? <span className="p">partial</span> : <span className="n"><LPIcons.x/></span>;
  return (
    <table className="ctbl">
      <thead><tr>
        <th></th>
        <th className="us">allen</th>
        <th>Devin</th>
        <th>Cursor agents</th>
        <th>OpenAI Codex</th>
      </tr></thead>
      <tbody>
        {COMPARE_ROWS.map(([label, vals], i) => (
          <tr key={i}>
            <td className="row-label">{label}</td>
            <td className="us">{cell(vals.allen)}</td>
            <td>{cell(vals.devin)}</td>
            <td>{cell(vals.cursor)}</td>
            <td>{cell(vals.codex)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

window.LPIcons = LPIcons;
window.ProductPreview = ProductPreview;
window.OrgChart = OrgChart;
window.LiveActivity = LiveActivity;
window.CompareTable = CompareTable;
