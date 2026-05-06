// Mock data + live simulation

const NOW = new Date('2026-04-25T16:30:00');
const fmtTime = (d) => d.toTimeString().slice(0,5);
const ago = (mins) => mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.floor(mins/60)}h ago` : `${Math.floor(mins/1440)}d ago`;

const WORKFLOWS = [
  { id:'feature-plan-and-implement', desc:'End-to-end feature workflow: clarify the ask, produce PRD + HLA + TDD with per-doc agent audits, pause at one human gate for plan approval, then run implementation, QA, security review, PR, and final summary.', nodes: 14, runs:{ok:8, err:1, run:1}, valid: true, tag: 'flagship'},
  { id:'bug-investigate-and-fix', desc:'Lean bug fix workflow: investigate the root cause, distinguish from feature, propose fix, implement with tests, open PR.', nodes: 9, runs:{ok:14, err:2, run:0}, valid: true, tag: 'default' },
  { id:'resolve-pr-reviews', desc:'Reads CodeRabbit + human review comments and resolves them in a feature branch with a summary.', nodes: 7, runs:{ok:31, err:1, run:2}, valid: true, tag: 'default' },
  { id:'understand-and-plan', desc:'Lightweight planning-only workflow. Takes a task description plus a target repo and returns PRD + HLA without implementing.', nodes: 6, runs:{ok:22, err:0, run:0}, valid: true, tag: 'default'},
  { id:'unfamiliar-codebase-tour', desc:'Walks an unfamiliar codebase and produces a concise architectural map plus suggested entrypoints.', nodes: 5, runs:{ok:7, err:0, run:0}, valid: true, tag: 'explore' },
  { id:'frontend-experiment', desc:'PM-friendly: produce a small frontend prototype with copy and screenshots; doesn\'t touch production code.', nodes: 8, runs:{ok:11, err:1, run:0}, valid: true, tag: 'pm' },
  { id:'classification-judge-loop', desc:'Spawns a classification agent + a judge in parallel and reconciles disagreement.', nodes: 6, runs:{ok:36, err:3, run:1}, valid: true, tag: 'eval' },
  { id:'test-chat-loop', desc:'Real-LLM smoke test for the Human Intervention Protocol. Exercises the chat round-trip end-to-end.', nodes: 4, runs:{ok:18, err:0, run:0}, valid: true, tag: 'test' },
];

const TEAMS = [
  { id:'data-acq', name:'Data Acquisition', members: 11, lead:'Data Acquisition', desc:'Vendor onboarding, scraping rules, search optimization, and data collection from external sources.' },
  { id:'pipeline', name:'Data Pipeline', members: 7, lead:'Data Pipeline', desc:'Extraction, transformation, prompt tuning, and variant validation through the processing pipeline.' },
  { id:'quality', name:'Data Quality', members: 22, lead:'Data Quality', desc:'Continuous quality, durability scoring, and validation across all ingestion paths.' },
  { id:'eng', name:'Engineering', members: 14, lead:'Engineering Lead', desc:'Cross-cutting platform, infra, and integrations.' },
  { id:'exec', name:'Executive', members: 1, lead:'CEO', desc:'Org-wide coordination and tie-breaking.' },
  { id:'meta', name:'Meta — Builders', members: 6, lead:'Team Builder', desc:'Agents that build, configure, and improve other agents.' },
  { id:'ops', name:'Operations', members: 26, lead:'Operations', desc:'Monitoring, deployment, escalation handling, runbooks.' },
  { id:'product', name:'Product', members: 8, lead:'PM Lead', desc:'Discovery, scoping, prototyping, customer feedback synthesis.' },
];

const REPOS = [
  { id:'inomy-ai-service', tags:['python','fastapi','flask'], path:'/home/ubuntu/.allen/repositories/inomy-ai-service', branch:'dev', remote:'github.com/inomy-poc/inomy-ai…', runs: 1 },
  { id:'es-data-pipeline', tags:['typescript','javascript','express'], path:'/home/ubuntu/.allen/repositories/es-data-pipeline', branch:'development', remote:'github.com/inomy-poc/es-data-p…', runs: 4 },
  { id:'inomy-mono', tags:['typescript','javascript'], path:'/home/ubuntu/.allen/repositories/inomy-mono', branch:'development', remote:'github.com/inomy-poc/inomy-mono', runs: 0 },
  { id:'allen', tags:['typescript','javascript'], path:'/home/ubuntu/.allen/repositories/allen', branch:'main', remote:'github.com/inomy-poc/allen', runs: 0 },
  { id:'ip-seller-portal', tags:['typescript','javascript'], path:'/home/ubuntu/.allen/repositories/ip-seller-portal', branch:'development', remote:'github.com/inomy-poc/ip-seller', runs: 0 },
];

const TICKETS = [
  { id:'ENG-1453', sev:'err',  ttl:'Pricing Update: Amazon CART_GATED_PRICE not handled — chain miss', tags:['area:pipeline','daily','+2'], age:'4h', proj:'Pipeline Roadmap: Q2-Q3 2026' },
  { id:'ENG-1452', sev:'warn', ttl:'[Pricing] CART_GATED_PRICE unhandled after 12 failures + failed retry', tags:['area:pipeline','daily'], age:'5h', proj:'Pipeline Roadmap: Q2-Q3 2026' },
  { id:'ENG-1431', sev:'warn', ttl:'Data Transformation — error handling', tags:['area:pipeline'], age:'7h', proj:'Pipeline Roadmap: Q2-Q3 2026' },
  { id:'ENG-1188', sev:'warn', ttl:'Define schema for new product category using sample products', tags:['type:feature','area:pipeline'], age:'7h', proj:'Inomy Catalog Roadmap' },
  { id:'ENG-1449', sev:'warn', ttl:'Chat price history incorrectly shows LIMITED_DATA when less data is available', tags:['type:bug','area:pipeline','+1'], age:'1d', proj:'Shopping Agent Experience Improv…' },
  { id:'ENG-1340', sev:'ok',   ttl:'E2E Tester Agent for Complete Furniture Flow', tags:['ws:interior-designer','area:agent'], age:'1w', proj:'Furniture And Interior Designer …' },
  { id:'ENG-1344', sev:'mute', ttl:'User mindset', tags:[], age:'1w', proj:'Investor Demo' },
  { id:'ENG-1432', sev:'warn', ttl:'Find Similar: ensure deterministic and consistent results for the same input', tags:['ws:unified-experience'], age:'1w', proj:'Unified AI Shopping Assistant' },
  { id:'ENG-1434', sev:'warn', ttl:'Multi-category search with relevance across categories', tags:['ws:unified-experience'], age:'1w', proj:'Unified AI Shopping Assistant' },
  { id:'ENG-1433', sev:'warn', ttl:'Multi-category guidance and responses in normal chat', tags:['ws:unified-experience'], age:'1w', proj:'Unified AI Shopping Assistant' },
  { id:'ENG-1418', sev:'warn', ttl:'[Epic] Chat ↔ Board Bridge', tags:['area:frontend','ws:unified-experience'], age:'1w', proj:'Unified AI Shopping Assistant' },
  { id:'ENG-1420', sev:'warn', ttl:'[Epic] Persistent Selection & Journey Continuity', tags:['area:frontend','ws:unified-experience'], age:'1w', proj:'Unified AI Shopping Assistant' },
  { id:'ENG-1419', sev:'warn', ttl:'[Epic] Entry Point & Landing Page', tags:['area:frontend','ws:unified-experience'], age:'1w', proj:'Unified AI Shopping Assistant' },
];

const WORKSPACES = [
  { id:'test/pipeline-workspace', repo:'es-data-pipeline', branch:'development', port:15090, status:'running', changed: 0 },
  { id:'coderabbit-pr-570', repo:'es-data-pipeline', branch:'schema_queries_answerability → development', port:15070, status:'active', changed: 10 },
  { id:'pr-570-schema_queries_answerability', repo:'es-data-pipeline', branch:'schema_queries_answerability → development', port:15060, status:'active', changed: 42 },
  { id:'feature-remove-category-pipeline-flow-tab-tdzi5t', repo:'es-data-pipeline', branch:'feature/… → main', port:15050, status:'active', changed: 0 },
  { id:'feature-remove-category-pipeline-flow-tab-tdxzwd', repo:'es-data-pipeline', branch:'feature/… → main', port:15040, status:'active', changed: 0 },
  { id:'feature/complete-db-sync', repo:'es-data-pipeline', branch:'feature/complete-db-sync → development', port:15030, status:'active', changed: 0 },
  { id:'chore-remove-category-pipeline-flow-tab-tdwfga', repo:'es-data-pipeline', branch:'chore/… → main', port:15020, status:'active', changed: 0 },
  { id:'ENG-1436 — Furniture Enrichment: Re-run Stage 6F for stale durability scores + n…', repo:'es-data-pipeline', branch:'linear/eng-1436 → development', port:15000, status:'active', changed: 0 },
];

const PRS = [
  { num:'#598', ttl:'fix(pricing-update): ENG-1448 — per-vendor scoped circuit breaker + AbortController + transp…', repo:'es-data-pipeline', age:'4h', files: 13, plus:1276, minus:164, branch:'fix/eng-1448-vendor-scoped-circuit-breaker-20260424-154229 → development', author:'ashish-inomy', state:'open' },
  { num:'#605', ttl:'feat(set-scraping): use standard job infra; replace bypass dispatcher [OOA] [ENG-1438]', repo:'es-data-pipeline', age:'4h', files: 71, plus:10797, minus:84, branch:'feature/set-scraping-standard-job-infra → development', author:'ashish-inomy', state:'open' },
  { num:'#808', ttl:'Wiring the new ui to the ai service', repo:'inomy-mono', age:'5h', files: 36, plus:4374, minus:553, branch:'new-ui-wiring-to-ai-service → development', author:'Saitejavarma38', state:'open' },
  { num:'#482', ttl:'feat: multi-category parallel pipeline (MULTI_DISCOVERY) [OOA]', repo:'inomy-ai-service', age:'6h', files: 19, plus:2339, minus:634, branch:'feat/no-ticket-ais-1745583600009/multi-category-parallel-pipeline → dev', author:'ishans-theo', state:'open' },
  { num:'#597', ttl:'feat(ui): Dashboard nav restructure - Jobs Orchestration tab, Schema Fitness tab, Analytics sid…', repo:'es-data-pipeline', age:'1d', files: 7, plus:755, minus:34, branch:'feature/dashboard-nav-restructure → development', author:'shreemantkumar65', state:'open' },
  { num:'#595', ttl:'feat(ui): remove Category Pipeline Flow sidebar entry and route', repo:'es-data-pipeline', age:'1d', files: 5, plus:78, minus:62, branch:'feature/remove-category-pipeline-flow-tab-tdzi5t → development', author:'shreemantkumar65', state:'open' },
];

const EXECS_INIT = [
  { id:'a50be55c', wf:'chat:spawn_agent/classification-judge', status:'running', dur:0,    cost:0,    started:'4:30:00 PM' },
  { id:'20aada5a', wf:'resolve-pr-reviews',                     status:'queued',  dur:0,    cost:0,    started:'4:30:00 PM' },
  { id:'ae966eb9', wf:'feature-plan-and-implement',             status:'running', dur:154,  cost:0.92, started:'4:27:48 PM' },
  { id:'f7a853c4', wf:'resolve-pr-reviews',                     status:'queued',  dur:0,    cost:0,    started:'4:15:00 PM' },
  { id:'7053e95d', wf:'resolve-pr-reviews',                     status:'queued',  dur:0,    cost:0,    started:'4:00:01 PM' },
  { id:'fc18264a', wf:'chat:spawn_agent/classification-judge',  status:'completed', dur:1250.8, cost:5.74, started:'4:00:01 PM' },
  { id:'ebca6a1', wf:'resolve-pr-reviews',                      status:'queued',  dur:0,    cost:0,    started:'3:45:00 PM' },
  { id:'8c8c5077', wf:'chat:spawn_agent/classification-judge',  status:'completed', dur:1143.0, cost:6.13, started:'3:30:00 PM' },
  { id:'7c0a8e1c', wf:'resolve-pr-reviews',                     status:'queued',  dur:0,    cost:0,    started:'3:30:00 PM' },
  { id:'31adfffe', wf:'resolve-pr-reviews',                     status:'queued',  dur:0,    cost:0,    started:'3:15:00 PM' },
  { id:'ea3106a4', wf:'resolve-pr-reviews',                     status:'completed', dur:1147.6, cost:5.61, started:'3:00:02 PM' },
  { id:'06bedb9c', wf:'resolve-pr-reviews',                     status:'queued',  dur:0,    cost:0,    started:'3:00:01 PM' },
];

const INTERVENTIONS = [
  { id:'iv-001', kind:'Clarify Human', state:'pending', ttl:'Confirm whether vendor allowlist is a hard constraint',
    body:'The agent paused before producing the implementation plan. It found two valid interpretations: (a) only allow vendors in the existing allowlist, or (b) skip the allowlist for the new shopping flow but log usage. Please pick one.',
    wf:'feature-plan-and-implement', stage:'Clarify Human', age:'2m', sev:'warn' },
  { id:'iv-002', kind:'Plan Approval', state:'pending', ttl:'Approve PRD + HLA for ENG-1453 pricing fix',
    body:'PRD generated. HLA generated. TDD generated. Per-doc auditors approved. Awaiting human gate before implementation.',
    wf:'feature-plan-and-implement', stage:'Plan Gate', age:'4m', sev:'info' },
  { id:'iv-003', kind:'Question', state:'answered', ttl:'Clarify Human',
    body:'Currently persona evaluation has diverged right from what\'s implemented, so we need to fix those issues u only need to run to fix…',
    wf:'feature-plan-and-implement', stage:'Clarify Human', age:'8m', sev:'warn' },
  { id:'iv-004', kind:'Question', state:'answered', ttl:'Ask User',
    body:'The analyst needs clarification before it can plan. ORIGINAL TASK: I want to understand if the variant data scraped doesn\'t have url (confirm this first) and then is there benefit in including this data in the…',
    wf:'understand-and-plan', stage:'Ask User', age:'1d', sev:'info' },
];

// ===== live simulator: keep mutating execs +/- progress =====
function useLiveSimulation() {
  const [execs, setExecs] = useState(EXECS_INIT);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => {
      setTick(x => x + 1);
      setExecs(prev => prev.map(e => {
        if (e.status === 'running') {
          const dur = e.dur + 1.0;
          const cost = +(e.cost + 0.0036).toFixed(2);
          // 1% chance of completing
          if (Math.random() < 0.012 && dur > 30) {
            return { ...e, status: 'completed', dur, cost };
          }
          return { ...e, dur, cost };
        }
        // 1% chance to start a queued one
        if (e.status === 'queued' && Math.random() < 0.008) {
          return { ...e, status: 'running' };
        }
        return e;
      }));
    }, 1000);
    return () => clearInterval(t);
  }, []);
  return { execs, tick };
}

// per-team agent rosters — counts match TEAMS[i].members
const TEAM_AGENTS = {
  'data-acq': ['Vendor Onboarder','Scraping Rule Author','Search Query Optimizer','Vendor Category Mapper','Vendor Rule Healer','Pagination Specialist','New Product Discover','Vendor Auth Resolver','Search Source Picker','Robots TXT Reader','Vendor Pace Tuner'],
  'pipeline': ['Extraction Engineer','Prompt Tuner','Variant Validator','Schema Mapper','Pipeline Step Author','HTML Parser','LLM Aligner'],
  'quality':  ['Quality Auditor','Durability Scorer','Validation Runner','Schema Drift Watcher','Field Coverage Auditor','Spec Reconciler','Vendor Disagreement Judge','Outlier Hunter','Anomaly Tagger','Content Sanitizer','Spec Verifier','Rule Tester','Field Confidence Scorer','Test Set Curator','Eval Replayer','Snapshot Diff Bot','Schema Coverage Bot','LLM Eval Reviewer','Promoter','Rerun Scheduler','Data Sampler','Catalog Sampler'],
  'eng':      ['Platform Engineer','Infra Engineer','API Maintainer','Auth Engineer','Search Indexer','Search Query Eng','Embedding Engineer','Cache Engineer','Cost Watcher','Deployment Bot','Migration Author','Library Curator','Type-Safety Engineer','Build Optimizer'],
  'exec':     ['CEO'],
  'meta':     ['Team Builder','Agent Builder','Workflow Composer','Prompt Author','Skill Composer','Agent Improver'],
  'ops':      ['Monitor','Pager','Runbook Author','Escalator','SLO Watcher','Alert Tuner','Incident Commander','Postmortem Writer','Capacity Planner','Cost Auditor','Health Sentinel','Latency Probe','Error Budgeter','Synthetic Tester','Smoke Runner','Canary Runner','Rollback Bot','Deploy Promoter','Backup Author','Restore Tester','Disk Reaper','Log Tail Watcher','Trace Sampler','Anomaly Watcher','Quiet Hours','Weekend Sweeper'],
  'product':  ['PM Lead','Discovery Researcher','Feedback Synthesizer','Spec Author','Prototype Writer','Persona Author','UX Reviewer','Demo Curator'],
};

window.MOCK = { WORKFLOWS, TEAMS, REPOS, TICKETS, WORKSPACES, PRS, EXECS_INIT, INTERVENTIONS, TEAM_AGENTS };
window.useLiveSimulation = useLiveSimulation;
window.fmtTime = fmtTime;
window.ago = ago;
