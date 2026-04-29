// remaining.jsx — compact variations for Repos, Linear, Workspaces, PRs, Executions, Interventions, Analytics, Jobs, MCP

const repos = [
  ['inomy-ai-service', ['Python', 'FastAPI', 'Flask'], 'dev', 'github.com/Kalpoi-poc/inomy-ai', 1],
  ['es-data-pipeline', ['TypeScript', 'JavaScript', 'Express'], 'development', 'github.com/Kalpoi-poc/es-data-p', 6],
  ['inomy-mono', ['TypeScript', 'JavaScript'], 'development', 'github.com/Kalpoi-poc/inomy-mor', 0],
  ['allen', ['TypeScript', 'JavaScript'], 'main', 'github.com/Kalpoi-poc/allen', 0],
  ['ip-seller-portal', ['TypeScript', 'JavaScript'], 'development', 'github.com/Kalpoi-poc/ip-seller', 0],
];

const tickets = [
  ['ENG-1449', 'Chat price history incorrectly shows LIMITED_DATA when less than 3 months of valid history…', ['type:bug', 'area:pipeline'], 'backlog', 'warn', '1d'],
  ['ENG-1374', 'Interior Designer UI Implementation', ['area:frontend', 'ws:interior-designer'], 'todo', 'idle', '1w'],
  ['ENG-1372', 'Testing & Quality Assurance', ['area:frontend', 'ws:interior-designer'], 'todo', 'idle', '1w'],
  ['ENG-1453', 'Pricing Update: Amazon CART_GATED_PRICE not handled — chronic 100% failure for cart-gated…', ['area:pipeline', 'data'], 'progress', 'run', '2d'],
  ['ENG-1480', '[Pricing] CART_GATED_PRICE unhandled after 12 failures + failedByType counter bug', ['area:pipeline', 'data'], 'backlog', 'warn', '2d'],
  ['ENG-1431', 'Data Transformation - error handling', ['area:pipeline', 'data'], 'progress', 'run', '2d'],
  ['ENG-1380', 'Define schema for new product category using sample products', ['type:feature', 'area:pipeline'], 'progress', 'run', '2d'],
  ['ENG-1340', 'E2E Tester Agent for Complete Furniture Flow', ['ws:interior-designer', 'area:agent'], 'progress', 'run', '1w'],
  ['ENG-1304', 'User mindset', [], 'todo', 'idle', '1w'],
  ['ENG-1422', 'Find Similar: ensure deterministic and consistent results for the same product', ['ws:unified-experience'], 'backlog', 'warn', '1w'],
];

const workspaces = [
  ['pr-612-fix/tier1-vertical-prefixes-eng-1455-te78kr', 'es-data-pipeline', 'fix/tier1-vertical-prefixes-eng-1455-te78kr → development', 13180, ['active', 'PR #612'], 2],
  ['pr-612-fix/tier1-vertical-prefixes-eng-1455-te78kr', 'es-data-pipeline', 'fix/tier1-vertical-prefixes-eng-1455-te78kr → development', 13182, ['active', 'PR #612'], 2],
  ['fix-tier1-vertical-prefixes-eng-1455-te78kr', 'es-data-pipeline', 'fix/tier1-vertical-prefixes-eng-1455-te78kr → development', 15201, ['active'], null],
  ['test/workspace', 'es-data-pipeline', 'test/workspace → development · services', 13070, ['running'], null],
  ['coderabbit-pr-570', 'es-data-pipeline', 'schema_queries_answerability → development', 15076, ['active'], 18],
  ['pr-570-schema_queries_answerability', 'es-data-pipeline', 'schema_queries_answerability → development', 13088, ['active', 'PR #570'], 42],
  ['feature-remove-category-pipeline-flow-tab-tdxzwd', 'es-data-pipeline', 'feature/remove-category-pipeline-flow-tab-tdxzwd → main', 15040, ['active'], null],
  ['feature/complete-db-sync', 'es-data-pipeline', 'feature/complete-db-sync → development', 15030, ['active'], null],
  ['ENG-1436 Furniture Enrichment: Re-run Stage 6F for stale durability scores + n', 'es-data-pipeline', 'Linear/eng-1436 → development', 15080, ['active'], null],
];

const prs = [
  [493, 'fix(bundle): preserve category budget in bundle_state merge when top-level has none', 'inomy-ai-service', 'fix/no-ticket-eis-1745634060300/bundle-state-budget-preserved-in-merge → dev', 'isharo-theo', '15m', 1, 6, 0, 'open'],
  [605, 'feat(set-scraping): use standard job infra; replace bypass dispatcher [OOA] [ENG-1438]', 'es-data-pipeline', 'feature/set-scraping-standard-job-infra → development', 'ashish-inomy', '1h', 84, 11770, 89, 'open'],
  [612, 'fix(pricing): expand tier1 verticalPrefixes to home-garden, health-beauty, sporting-goods (ENG-1455)', 'es-data-pipeline', 'fix/tier1-vertical-prefixes-eng-1455-te78kr → development', 'shreemantkumar65', '2h', 2, 11, 4, 'open'],
  [492, 'Clean up', 'inomy-ai-service', 'gp_search → dev', 'ajit-inomy', '2h', 188, 1593, 84931, 'open'],
  [489, 'feat(tests): interior designer tests + Gemini 3 Flash visual judge harness', 'inomy-ai-service', 'feat/interior-designer-tests-gemini-visual-judge → dev', 'shreemantkumar65', '20h', 45, 4403, 3, 'open'],
  [612, 'Adding thumbnails and intent config inclusion', 'inomy-mono', 'thumbnails-intent-config-inclusion → development', 'Saiteja-varma38', '1d', 7, 356, 37, 'open'],
];

const executions = [
  ['2d422acd', 'resolve-pr-reviews', 'queued', '0.0s', '$0.00', '28/04/2026, 18:00:00'],
  ['661cfa78', 'resolve-pr-reviews', 'queued', '0.0s', '$0.00', '28/04/2026, 18:00:00'],
  ['98f364f2', 'chat:spawn_agent/classification-judge', 'running', '0.0s', '$0.00', '28/04/2026, 18:00:00'],
  ['9dcf28f7', 'resolve-pr-reviews', 'queued', '0.0s', '$0.00', '28/04/2026, 17:45:00'],
  ['483575c2', 'resolve-pr-reviews', 'queued', '0.0s', '$0.00', '28/04/2026, 17:45:00'],
  ['c7d342bd', 'resolve-pr-reviews', 'queued', '0.0s', '$0.00', '28/04/2026, 17:30:00'],
  ['63f23a54', 'resolve-pr-reviews', 'queued', '0.0s', '$0.00', '28/04/2026, 17:30:00'],
  ['5f60fe67', 'chat:spawn_agent/classification-judge', 'failed', '11.2s', '$0.00', '28/04/2026, 17:30:00'],
  ['8f07c176', 'chat:spawn_agent/frontend-developer', 'failed', '404.5s', '$0.00', '28/04/2026, 17:15:00'],
  ['2c7dd6e7', 'resolve-pr-reviews', 'queued', '0.0s', '$0.00', '28/04/2026, 17:15:00'],
  ['8ce1fc19', 'resolve-pr-reviews', 'queued', '0.0s', '$0.00', '28/04/2026, 17:15:00'],
  ['ba7c221d', 'chat:spawn_agent/frontend-developer', 'completed', '175.1s', '$0.52', '28/04/2026, 17:11:03'],
  ['573c7e89', 'resolve-pr-reviews', 'queued', '0.0s', '$0.00', '28/04/2026, 17:00:00'],
  ['1b2c8b46', 'chat:spawn_agent/classification-judge', 'completed', '1231.3s', '$6.61', '28/04/2026, 17:00:00'],
];

const interventions = [
  ['Plan Approval Gate', 'approved', 'All three design docs are produced and audited. Review and approve to start implementation. USER REQUEST: Requirements: http://localhost:4023/api/artifacts/d1bee4ff-8ce2-4537-8148-5fb3eef21233/content. Architecture…', 'feature-plan-and-implement', 'Plan Approval Gate', '1 day ago', 'Approved'],
  ['Clarify Human', 'question', 'The agent needs clarification before producing the PRD. Original request: Questions to answer: ["What do you want built? Please describe the feature, bug fix, or change you need in the es-data-pipeline repo — even a one-sentence summary is enough.', 'feature-plan-and-implement', 'Clarify Human', '1 day ago', 'Answered'],
  ['Clarify Human', 'question', 'The agent needs clarification before producing the PRD. Original request: Questions to answer: [\\"What feature or change do you want built? Please describe what the system should do, who benefits, and any constraints or context you have in mind.\\", "I…', 'feature-plan-and-implement', 'Clarify Human', '1 day ago', 'Answered'],
  ['Clarify Human', 'question', 'The agent needs clarification before producing the PRD. Original request: See currently persona evaluation has diverged right from what is implemented, so we need to fix this issues u only need to run to fix those. The prompts of judge should be…', 'feature-plan-and-implement', 'Clarify Human', '2 days ago', 'Answered'],
  ['Ask User', 'question', 'The analyst needs clarification before it can plan. ORIGINAL TASK: I want to understand the if the variant data scraped doesn\'t have ur (confirm this first) and then is there any benefit in including this data in opensearch, later, giving this to frontend…', 'understand-and-plan', 'Ask User', '3 days ago', 'Answered'],
];

const jobs = [
  ['Pipeline Incident Watchdog Hourly', 'WORKFLOW', '0 * * * *', 'Workflow: pipeline-incident-watchdog. Runs every hour. Scans jobs comp…', 'failed', '44m ago', '1h 15m', 43, 'err'],
  ['Classification Judge Every 30 Min', 'AGENT', '*/30 * * * *', 'Agent: classification-judge. Runs classification-judge every…', 'success', '14m ago', '15m', 97, 'ok'],
  ['GitHub PR Sync (every 30 min)', 'BUILT-IN SYSTEM', '*/30 * * * *', 'System: pr-sync-all. Refreshes the local pull-request…', 'success', '14m ago', '15m', 144, 'ok'],
  ['CodeRabbit Review Sweep', 'BUILT-IN SYSTEM', '*/15 * * * *', 'System: coderabbit-sweep. Every 15 minutes, scans open ven…', 'success', '14m ago', '8m', 657, 'ok'],
  ['MCP Bundle Cleanup', 'BUILT-IN SYSTEM', '0 * * * *', 'System: mcp-bundle-cleanup. Deletes uploaded MCP server bun…', 'success', '44m ago', '15m', 174, 'ok'],
  ['Repo Pull (every 30 min)', 'BUILT-IN SYSTEM', '*/30 * * * *', 'System: repo-pull-all. Pulls the latest changes from regi…', 'success', '14m ago', '15m', 347, 'ok'],
  ['Daily Repo Context Refresh', 'BUILT-IN SYSTEM', '0 5 * * *', 'System: repo-scan-if-changed. Re-scans every registered repo a…', 'success', '7h ago', '16h', 6, 'ok'],
];

const mcpServers = [
  ['aws-server', 'stdio', 41, 'repo · claude/mcp-servers/aws-server.mjs', 'ok'],
  ['github', 'stdio', 26, 'GitHub — repos, issues, PRs, code search', 'ok'],
  ['linear', 'stdio', 76, 'Linear — issues, projects, teams, comments', 'ok'],
  ['mongodb', 'stdio', 8, 'MongoDB — query collections, schema inference, aggregations', 'ok'],
  ['opensearch-server', 'stdio', 8, 'repo · claude/mcp-servers/opensearch-server.mjs', 'ok'],
  ['oxylabs-server', 'stdio', 7, 'repo · claude/mcp-servers/oxylabs-server.mjs', 'ok'],
  ['pipeline-api-server', 'stdio', 91, 'repo · claude/mcp-servers/api-caller-server.mjs', 'ok'],
  ['postgres', 'stdio', 19, 'PostgreSQL — schema management, queries, performance analysis', 'ok'],
];

// ====================== REPOS ======================
const ReposV1 = () => (
  <V1Frame active="repos" crumbs={['Build', 'Repositories']}
    actions={<><span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>5 REGISTERED</span><button className="btn btn-primary"><Icon name="plus" size={11}/> ADD REPO</button></>}>
    <div style={{ flex: 1, padding: 14, overflow: 'hidden' }}>
      {repos.map((r, i) => (
        <div key={i} style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 4, padding: 14, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 14 }}>
          <Icon name="repo" size={18} color="var(--acc)"/>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span className="mono" style={{ fontSize: 14, fontWeight: 600 }}>{r[0]}</span>
              {r[1].map((t, j) => <span key={j} className="chip" style={{ background: ['#fde68a30', '#bfdbfe30', '#bbf7d030'][j % 3], color: ['#fbbf24', '#60a5fa', '#4ade80'][j % 3] }}>{t}</span>)}
            </div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
              /home/ubuntu/.allen/repositories/{r[0]} · <Icon name="merge" size={9}/> {r[2]} · <Icon name="external" size={9}/> {r[3]} · {r[4]} runs
            </div>
          </div>
          <button className="btn btn-line"><Icon name="refresh" size={11}/></button>
          <button className="btn btn-line"><Icon name="dot-menu" size={11}/></button>
        </div>
      ))}
    </div>
  </V1Frame>
);

const ReposV2 = () => (
  <V2Frame active="repos" title="Repositories" crumbs={['Code', 'Repositories']}
    actions={<><button className="btn btn-line"><Icon name="github" size={12}/> Sync</button><button className="btn btn-primary"><Icon name="plus" size={12}/> Add repo</button></>}>
    <div style={{ flex: 1, padding: '20px 24px', overflow: 'hidden', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, alignContent: 'flex-start' }}>
      {repos.map((r, i) => (
        <div key={i} style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--bg-2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="repo" size={16} color="var(--acc)"/></div>
            <div style={{ flex: 1 }}>
              <div className="mono" style={{ fontWeight: 600, fontSize: 14 }}>{r[0]}</div>
              <div style={{ fontSize: 11, color: 'var(--ink-3)' }} className="mono">{r[2]} · {r[4]} runs</div>
            </div>
            <span className="dot dot-ok"/>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{r[1].map((t, j) => <span key={j} className="chip">{t}</span>)}</div>
          <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)', display: 'flex', alignItems: 'center', gap: 4 }}><Icon name="github" size={10}/> {r[3]}</div>
        </div>
      ))}
    </div>
  </V2Frame>
);

const ReposV3 = () => (
  <V3Frame active="repos" title="Repositories" subtitle="registered code targets" count={`${repos.length} REPOS`}
    actions={<><button className="btn btn-line mono">SYNC ALL</button><button className="btn btn-primary mono">+ REPO</button></>}>
    <div style={{ flex: 1, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        <thead><tr style={{ background: 'var(--bg-1)', borderBottom: '1px solid var(--ink)' }}>
          {['#', 'NAME', 'PATH', 'STACK', 'BRANCH', 'REMOTE', 'RUNS', ''].map((h, i) => (
            <th key={i} style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, letterSpacing: '0.08em', color: 'var(--ink-3)', borderRight: i < 7 ? '1px solid var(--line)' : 'none' }}>{h}</th>
          ))}
        </tr></thead>
        <tbody>
          {repos.map((r, i) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--line)', background: 'var(--bg-1)' }}>
              <td style={{ padding: '10px 12px', color: 'var(--ink-4)', borderRight: '1px solid var(--line)' }}>{String(i + 1).padStart(2, '0')}</td>
              <td style={{ padding: '10px 12px', fontWeight: 600, borderRight: '1px solid var(--line)' }}>{r[0]}</td>
              <td style={{ padding: '10px 12px', color: 'var(--ink-3)', borderRight: '1px solid var(--line)' }}>~/.allen/repos/{r[0]}</td>
              <td style={{ padding: '10px 12px', borderRight: '1px solid var(--line)' }}>{r[1].join(' · ')}</td>
              <td style={{ padding: '10px 12px', color: 'var(--acc)', borderRight: '1px solid var(--line)' }}>{r[2]}</td>
              <td style={{ padding: '10px 12px', color: 'var(--ink-3)', borderRight: '1px solid var(--line)' }}>{r[3]}</td>
              <td style={{ padding: '10px 12px', textAlign: 'center', borderRight: '1px solid var(--line)' }}>{r[4]}</td>
              <td style={{ padding: '4px 8px' }}><button className="btn btn-line" style={{ fontSize: 10 }}>SYNC</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </V3Frame>
);

// ====================== LINEAR ======================
const statusIcon = (s) => ({ run: '◐', warn: '◔', idle: '○', ok: '●' }[s] || '○');
const statusColor = (s) => ({ run: 'var(--info)', warn: 'var(--warn)', idle: 'var(--ink-3)', ok: 'var(--ok)' }[s]);

const LinearV1 = () => (
  <V1Frame active="linear" crumbs={['Build', 'Linear', 'All projects']}>
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      <div style={{ width: 240, borderRight: '1px solid var(--line)', background: 'var(--bg-1)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)' }}>
          <div className="mono" style={{ fontSize: 12, color: 'var(--acc)' }}>● inomy · 200 issues</div>
        </div>
        <div className="uppercase-label" style={{ padding: '8px 12px 4px' }}>PROJECTS</div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          {['All projects', 'Unified AI Shopping Assistant', 'LLM Benchmarking', 'Shopping Agent Experience Improv…', 'Furniture and Interior Designer …', 'Proactive agents', 'Inomy Catalog Roadmap', 'Data Transformation Loss Detecti…', 'Seller Portal — Information & In…', 'Furniture Integration', 'Org of agents', 'New architecture and roadmap', 'Investor Deck', 'Pipeline Roadmap: Q2-Q3 2026', 'Pipeline Agent Organization', 'Inomy Hub Hackathon'].map((p, i) => (
            <div key={i} style={{ padding: '4px 12px', display: 'flex', alignItems: 'center', gap: 6, background: i === 0 ? 'color-mix(in srgb, var(--acc) 8%, transparent)' : 'transparent', borderLeft: i === 0 ? '2px solid var(--acc)' : '2px solid transparent', fontSize: 11 }}>
              <span className="dot dot-idle" style={{ width: 5, height: 5, background: ['var(--acc)', 'var(--info)', 'var(--ok)', 'var(--warn)', 'var(--err)'][i % 5] }}/>
              <span className="mono" style={{ color: i === 0 ? 'var(--acc)' : 'var(--ink-2)', flex: 1 }} className="truncate">{p}</span>
              {i === 0 && <span className="mono" style={{ color: 'var(--ink-3)', fontSize: 10 }}>200</span>}
            </div>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-1)' }}>
          <span className="uppercase-label">BACKLOG · 18</span>
          <Icon name="chevron-down" size={10} color="var(--ink-3)"/>
        </div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          {tickets.map((t, i) => (
            <div key={i} style={{ padding: '6px 14px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, fontSize: 11.5 }}>
              <span style={{ color: statusColor(t[4]), fontSize: 12 }}>{statusIcon(t[4])}</span>
              <span className="mono" style={{ color: 'var(--acc)', width: 70 }}>{t[0]}</span>
              <span style={{ flex: 1, color: 'var(--ink-2)' }} className="truncate">{t[1]}</span>
              {t[2].map((tag, j) => <span key={j} className="chip" style={{ fontSize: 10 }}>{tag}</span>)}
              <span className="mono" style={{ color: 'var(--info)', fontSize: 10 }}>⌁ Dispatch</span>
              <span style={{ color: 'var(--ink-3)', fontSize: 10, fontFamily: 'var(--font-mono)', width: 50, textAlign: 'right' }}>{t[5]} ago</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  </V1Frame>
);

const LinearV2 = () => (
  <V2Frame active="linear" title="Linear" crumbs={['Code', 'Linear']}
    actions={<><button className="btn btn-line"><Icon name="filter" size={12}/></button><button className="btn btn-primary"><Icon name="play" size={11}/> Dispatch selected</button></>}
    tabs={[{ label: 'All', count: 200, active: true }, { label: 'My issues' }, { label: 'Active', count: 12 }, { label: 'Done' }]}>
    <div style={{ flex: 1, padding: '16px 24px', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, fontSize: 12, color: 'var(--ink-3)' }}>
        <span>Project:</span>
        <button className="btn btn-line">All projects ▾</button>
        <span>Group by:</span>
        <button className="btn btn-line">Status ▾</button>
        <div style={{ flex: 1 }}/>
        <span>{tickets.length} of 200 issues</span>
      </div>
      <div style={{ flex: 1, background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
        <div style={{ padding: '8px 14px', background: 'var(--bg-2)', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon name="chevron-down" size={11} color="var(--ink-3)"/>
          <span style={{ fontSize: 12, fontWeight: 600 }}>Backlog</span>
          <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>18 issues</span>
        </div>
        {tickets.map((t, i) => (
          <div key={i} style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}>
            <span style={{ color: statusColor(t[4]), fontSize: 14 }}>{statusIcon(t[4])}</span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', width: 70 }}>{t[0]}</span>
            <span style={{ flex: 1, fontSize: 13 }} className="truncate">{t[1]}</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {t[2].slice(0, 2).map((tag, j) => <span key={j} className="chip">{tag}</span>)}
            </div>
            <span style={{ fontSize: 11, color: 'var(--ink-3)', width: 50, textAlign: 'right' }}>{t[5]}</span>
            <button className="btn btn-line" style={{ padding: '3px 8px', fontSize: 11 }}><Icon name="play" size={10}/> Dispatch</button>
          </div>
        ))}
      </div>
    </div>
  </V2Frame>
);

const LinearV3 = () => (
  <V3Frame active="linear" title="Linear" subtitle="200 issues · inomy" count="BACKLOG 18"
    actions={<><button className="btn btn-line mono">GROUP: STATUS</button><button className="btn btn-line mono">FILTER</button><button className="btn btn-primary mono">DISPATCH ▶</button></>}>
    <div style={{ flex: 1, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        <thead><tr style={{ background: 'var(--bg-1)', borderBottom: '1px solid var(--ink)' }}>
          {['', 'ID', 'TITLE', 'TAGS', 'AGE', ''].map((h, i) => <th key={i} style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.08em', borderRight: i < 5 ? '1px solid var(--line)' : 'none' }}>{h}</th>)}
        </tr></thead>
        <tbody>
          {tickets.map((t, i) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--line)', background: 'var(--bg-1)' }}>
              <td style={{ padding: '8px 12px', color: statusColor(t[4]), borderRight: '1px solid var(--line)', fontSize: 14 }}>{statusIcon(t[4])}</td>
              <td style={{ padding: '8px 12px', color: 'var(--acc)', fontWeight: 600, borderRight: '1px solid var(--line)' }}>{t[0]}</td>
              <td style={{ padding: '8px 12px', borderRight: '1px solid var(--line)', maxWidth: 0 }} className="truncate">{t[1]}</td>
              <td style={{ padding: '8px 12px', color: 'var(--ink-3)', borderRight: '1px solid var(--line)' }}>{t[2].join(' · ')}</td>
              <td style={{ padding: '8px 12px', color: 'var(--ink-3)', borderRight: '1px solid var(--line)', width: 60 }}>{t[5]}</td>
              <td style={{ padding: '4px 8px', width: 100 }}><button className="btn btn-line mono" style={{ fontSize: 10 }}>▶ DISPATCH</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </V3Frame>
);

// ====================== WORKSPACES ======================
const WorkspacesV1 = () => (
  <V1Frame active="workspaces" crumbs={['Develop', 'Workspaces']}
    actions={<><span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>11 ACTIVE</span><button className="btn btn-primary"><Icon name="plus" size={11}/> NEW</button></>}>
    <div style={{ flex: 1, padding: 14, overflow: 'hidden' }}>
      <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 4, marginBottom: 8 }}>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="repo" size={11} color="var(--acc)"/>
          <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>es-data-pipeline</span>
          <span style={{ fontSize: 10, color: 'var(--ink-3)' }}>9 workspaces</span>
          <span style={{ flex: 1 }}/>
          <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}><Icon name="settings" size={10}/> Config</span>
        </div>
        {workspaces.slice(0, 7).map((w, i) => (
          <div key={i} style={{ padding: '7px 12px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, fontSize: 11.5 }}>
            <input type="checkbox" style={{ accentColor: 'var(--acc)' }}/>
            <Icon name="merge" size={10} color="var(--ink-3)"/>
            <span className="mono" style={{ color: 'var(--ink-2)', flex: 1 }} className="truncate">{w[0]}</span>
            {w[4].map((s, j) => <span key={j} className={`pill ${s === 'running' ? 'pill-run' : s.startsWith('PR') ? 'pill-warn' : 'pill-ok'}`}>{s}</span>)}
            {w[5] != null && <span className="mono" style={{ color: 'var(--info)', fontSize: 10 }}>{w[5]} changed</span>}
            <span className="mono" style={{ color: 'var(--ink-3)', fontSize: 10 }}>port {w[3]}</span>
          </div>
        ))}
      </div>
      <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 4 }}>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="repo" size={11} color="var(--acc)"/>
          <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>allen</span>
          <span style={{ fontSize: 10, color: 'var(--ink-3)' }}>1 workspace</span>
        </div>
        <div style={{ padding: '7px 12px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 11.5 }}>
          <input type="checkbox"/>
          <Icon name="merge" size={10} color="var(--ink-3)"/>
          <span className="mono" style={{ flex: 1 }}>fix-cron-auth-for-agent-and-workflow-dispatc-te1qb1</span>
          <span className="pill pill-ok">active</span>
        </div>
      </div>
    </div>
  </V1Frame>
);

const WorkspacesV2 = () => (
  <V2Frame active="workspaces" title="Sandboxes" crumbs={['Code', 'Sandboxes']}
    actions={<><button className="btn btn-line"><Icon name="filter" size={12}/></button><button className="btn btn-primary"><Icon name="plus" size={12}/> New sandbox</button></>}
    tabs={[{ label: 'All', count: 11, active: true }, { label: 'Mine' }, { label: 'With PRs', count: 4 }]}>
    <div style={{ flex: 1, padding: '16px 24px', overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600 }}>
        <Icon name="repo" size={14} color="var(--acc)"/> es-data-pipeline <span style={{ fontSize: 11, color: 'var(--ink-3)', fontWeight: 400 }}>· 9 sandboxes</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
        {workspaces.slice(0, 6).map((w, i) => (
          <div key={i} style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icon name="box" size={13} color="var(--acc)"/>
              <span className="mono" style={{ flex: 1, fontSize: 12.5, fontWeight: 500 }} className="truncate">{w[0]}</span>
              {w[4].map((s, j) => <span key={j} className={`pill ${s === 'running' ? 'pill-run' : s.startsWith('PR') ? 'pill-warn' : 'pill-ok'}`}>{s}</span>)}
            </div>
            <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)' }} className="truncate">{w[2]}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 11, color: 'var(--ink-3)' }}>
              <span className="mono">:{w[3]}</span>
              {w[5] != null && <span className="mono" style={{ color: 'var(--info)' }}>+{w[5]} changed</span>}
              <div style={{ flex: 1 }}/>
              <button className="btn btn-line" style={{ padding: '2px 8px', fontSize: 11 }}>Open</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  </V2Frame>
);

const WorkspacesV3 = () => (
  <V3Frame active="workspaces" title="Sandboxes" subtitle="active dev workspaces" count={`${workspaces.length} ACTIVE`}
    actions={<><button className="btn btn-line mono">GROUP: REPO</button><button className="btn btn-primary mono">+ SANDBOX</button></>}>
    <div style={{ flex: 1, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
        <thead><tr style={{ background: 'var(--bg-1)', borderBottom: '1px solid var(--ink)' }}>
          {['', 'NAME', 'REPO', 'BRANCH', 'PORT', 'CHG', 'STATUS', ''].map((h, i) => <th key={i} style={{ padding: '8px 10px', textAlign: 'left', fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.08em', borderRight: i < 7 ? '1px solid var(--line)' : 'none' }}>{h}</th>)}
        </tr></thead>
        <tbody>
          {workspaces.map((w, i) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--line)', background: 'var(--bg-1)' }}>
              <td style={{ padding: '6px 10px', borderRight: '1px solid var(--line)' }}><input type="checkbox"/></td>
              <td style={{ padding: '6px 10px', fontWeight: 600, borderRight: '1px solid var(--line)', maxWidth: 0 }} className="truncate">{w[0]}</td>
              <td style={{ padding: '6px 10px', color: 'var(--ink-3)', borderRight: '1px solid var(--line)' }}>{w[1]}</td>
              <td style={{ padding: '6px 10px', color: 'var(--acc)', borderRight: '1px solid var(--line)', maxWidth: 200 }} className="truncate">{w[2]}</td>
              <td style={{ padding: '6px 10px', borderRight: '1px solid var(--line)' }}>{w[3]}</td>
              <td style={{ padding: '6px 10px', color: 'var(--info)', borderRight: '1px solid var(--line)' }}>{w[5] || '—'}</td>
              <td style={{ padding: '6px 10px', borderRight: '1px solid var(--line)' }}>{w[4].join(' ')}</td>
              <td style={{ padding: '4px 8px' }}><button className="btn btn-line mono" style={{ fontSize: 10 }}>OPEN</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </V3Frame>
);

// ====================== PRs ======================
const PRsV1 = () => (
  <V1Frame active="prs" crumbs={['Develop', 'Pull Requests']}
    actions={<><button className="btn btn-line"><Icon name="github" size={11}/> SYNC</button><button className="btn btn-primary">RESOLVE CR</button></>}>
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 4, padding: '8px 14px', borderBottom: '1px solid var(--line)', background: 'var(--bg-1)' }}>
        {['open · 23', 'merged · 12', 'closed · 4', 'all · 39'].map((t, i) => (
          <span key={i} className="mono" style={{ padding: '3px 10px', fontSize: 11, borderRadius: 3, background: i === 0 ? 'color-mix(in srgb, var(--acc) 14%, transparent)' : 'transparent', color: i === 0 ? 'var(--acc)' : 'var(--ink-3)' }}>{t}</span>
        ))}
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {prs.map((p, i) => (
          <div key={i} style={{ padding: '8px 14px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 12, fontSize: 12 }}>
            <Icon name="merge" size={12} color="var(--acc)"/>
            <span className="mono" style={{ color: 'var(--acc)' }}>#{p[0]}</span>
            <span style={{ flex: 1, color: 'var(--ink)' }} className="truncate">{p[1]}</span>
            <span className="pill pill-ok">{p[9]}</span>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', minWidth: 200 }}>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>{p[2]} · by {p[4]}</span>
              <div style={{ display: 'flex', gap: 8, fontSize: 10, fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                <span style={{ color: 'var(--ink-3)' }}>⏱ {p[5]} ago</span>
                <span style={{ color: 'var(--ink-3)' }}>📄 {p[6]} files</span>
                <span style={{ color: 'var(--ok)' }}>+{p[7]}</span>
                <span style={{ color: 'var(--err)' }}>-{p[8]}</span>
              </div>
            </div>
            <button className="btn btn-line" style={{ fontSize: 10.5 }}><Icon name="box" size={10}/> WS</button>
            <button className="btn btn-line" style={{ fontSize: 10.5 }}>CR</button>
          </div>
        ))}
      </div>
    </div>
  </V1Frame>
);

const PRsV2 = () => (
  <V2Frame active="prs" title="Pull requests" crumbs={['Code', 'Pull requests']}
    actions={<><button className="btn btn-line"><Icon name="github" size={12}/> Sync from GitHub</button><button className="btn btn-primary">Resolve CodeRabbit</button></>}
    tabs={[{ label: 'Open', count: 23, active: true }, { label: 'Merged', count: 12 }, { label: 'Closed', count: 4 }, { label: 'All' }]}>
    <div style={{ flex: 1, padding: '16px 24px', overflow: 'hidden' }}>
      <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 10 }}>
        {prs.map((p, i) => (
          <div key={i} style={{ padding: '14px 16px', borderBottom: i < prs.length - 1 ? '1px solid var(--line)' : 'none', display: 'flex', alignItems: 'flex-start', gap: 14 }}>
            <Icon name="merge" size={16} color="var(--acc)"/>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 500 }}>#{p[0]} {p[1]}</span>
                <span className="pill pill-ok">open</span>
              </div>
              <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 4 }} className="truncate">{p[2]} · {p[3]}</div>
              <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--ink-3)' }} className="mono">
                <span>by {p[4]}</span>
                <span>{p[5]} ago</span>
                <span>{p[6]} files</span>
                <span style={{ color: 'var(--ok)' }}>+{p[7]}</span>
                <span style={{ color: 'var(--err)' }}>−{p[8]}</span>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <button className="btn btn-line" style={{ fontSize: 11 }}><Icon name="box" size={11}/> Open workspace</button>
              <button className="btn btn-line" style={{ fontSize: 11 }}>Resolve CodeRabbit</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  </V2Frame>
);

const PRsV3 = () => (
  <V3Frame active="prs" title="Pull Requests" subtitle="open · merged · closed" count="23 OPEN"
    actions={<><button className="btn btn-line mono">SYNC GH</button><button className="btn btn-primary mono">RESOLVE ALL CR</button></>}>
    <div style={{ flex: 1, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
        <thead><tr style={{ background: 'var(--bg-1)', borderBottom: '1px solid var(--ink)' }}>
          {['#', 'TITLE', 'REPO', 'AUTHOR', 'AGE', 'FILES', '+', '−', ''].map((h, i) => <th key={i} style={{ padding: '8px 10px', textAlign: 'left', fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.08em', borderRight: i < 8 ? '1px solid var(--line)' : 'none' }}>{h}</th>)}
        </tr></thead>
        <tbody>
          {prs.map((p, i) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--line)', background: 'var(--bg-1)' }}>
              <td style={{ padding: '7px 10px', color: 'var(--acc)', fontWeight: 600, borderRight: '1px solid var(--line)' }}>#{p[0]}</td>
              <td style={{ padding: '7px 10px', borderRight: '1px solid var(--line)', maxWidth: 0 }} className="truncate">{p[1]}</td>
              <td style={{ padding: '7px 10px', color: 'var(--ink-3)', borderRight: '1px solid var(--line)' }}>{p[2]}</td>
              <td style={{ padding: '7px 10px', color: 'var(--ink-3)', borderRight: '1px solid var(--line)' }}>{p[4]}</td>
              <td style={{ padding: '7px 10px', color: 'var(--ink-3)', borderRight: '1px solid var(--line)' }}>{p[5]}</td>
              <td style={{ padding: '7px 10px', textAlign: 'right', borderRight: '1px solid var(--line)' }}>{p[6]}</td>
              <td style={{ padding: '7px 10px', color: 'var(--ok)', textAlign: 'right', borderRight: '1px solid var(--line)' }}>{p[7]}</td>
              <td style={{ padding: '7px 10px', color: 'var(--err)', textAlign: 'right', borderRight: '1px solid var(--line)' }}>{p[8]}</td>
              <td style={{ padding: '4px 8px' }}><button className="btn btn-line mono" style={{ fontSize: 10 }}>WS</button> <button className="btn btn-line mono" style={{ fontSize: 10 }}>CR</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </V3Frame>
);

// ====================== EXECUTIONS ======================
const execStatusPill = (s) => {
  const map = { queued: 'pill-queued', running: 'pill-run', failed: 'pill-err', completed: 'pill-ok' };
  return <span className={`pill ${map[s]}`}>{s}</span>;
};

const ExecutionsV1 = () => (
  <V1Frame active="executions" crumbs={['Monitor', 'Executions']}
    actions={<>
      <span style={{ fontSize: 11, color: 'var(--ink-3)' }} className="mono">FILTER: ALL TYPES · ALL STATUSES</span>
      <button className="btn btn-line"><Icon name="search" size={11}/></button>
    </>}>
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '110px 280px 110px 80px 80px 1fr 80px', padding: '6px 14px', borderBottom: '1px solid var(--line)', background: 'var(--bg-1)' }}>
        {['ID', 'WORKFLOW', 'STATUS', 'DURATION', 'COST', 'STARTED', 'ACTIONS'].map((h, i) => <div key={i} className="uppercase-label">{h}</div>)}
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {executions.slice(0, 14).map((e, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '110px 280px 110px 80px 80px 1fr 80px', padding: '5px 14px', borderBottom: '1px solid var(--line)', alignItems: 'center', fontSize: 11.5, fontFamily: 'var(--font-mono)' }}>
            <span style={{ color: 'var(--acc)' }}>{e[0]}</span>
            <span style={{ color: 'var(--ink-2)' }} className="truncate">{e[1]}</span>
            {execStatusPill(e[2])}
            <span style={{ color: 'var(--ink-2)' }}>{e[3]}</span>
            <span style={{ color: 'var(--ink-2)' }}>{e[4]} <span style={{ color: 'var(--ink-3)' }}>EST</span></span>
            <span style={{ color: 'var(--ink-3)' }}>{e[5]}</span>
            <span style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <Icon name="play" size={11} color="var(--ink-3)"/>
              <Icon name="download" size={11} color="var(--ink-3)"/>
            </span>
          </div>
        ))}
      </div>
    </div>
  </V1Frame>
);

const ExecutionsV2 = () => (
  <V2Frame active="executions" title="Activity" crumbs={['Workspace', 'Activity']}
    actions={<><button className="btn btn-line"><Icon name="filter" size={12}/> All types</button><button className="btn btn-line"><Icon name="filter" size={12}/> All statuses</button></>}
    tabs={[{ label: 'Live', count: 290, active: true }, { label: 'Today' }, { label: 'Failed', count: 29 }]}>
    <div style={{ flex: 1, padding: '16px 24px', overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, fontSize: 12, color: 'var(--ink-3)' }}>
        <Icon name="search" size={12}/> Search id, workflow, node…
      </div>
      <div style={{ flex: 1, background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
        {executions.slice(0, 12).map((e, i) => (
          <div key={i} style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className={`dot dot-${e[2] === 'running' ? 'run' : e[2] === 'failed' ? 'err' : e[2] === 'completed' ? 'ok' : 'idle'}`}/>
            <span className="mono" style={{ color: 'var(--acc)', fontSize: 12, width: 80 }}>{e[0]}</span>
            <span style={{ flex: 1, fontSize: 12.5 }} className="truncate mono">{e[1]}</span>
            {execStatusPill(e[2])}
            <span className="mono" style={{ fontSize: 11, color: 'var(--ink-2)', width: 60, textAlign: 'right' }}>{e[3]}</span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--ink-2)', width: 60, textAlign: 'right' }}>{e[4]}</span>
            <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>{e[5].split(',')[1]}</span>
          </div>
        ))}
      </div>
    </div>
  </V2Frame>
);

const ExecutionsV3 = () => (
  <V3Frame active="executions" title="Executions" subtitle="real-time agent runs" count="471 / 290 RUN"
    actions={<><button className="btn btn-line mono">FOLLOW LIVE</button><button className="btn btn-line mono">FILTER</button></>}>
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
          <thead><tr style={{ background: 'var(--bg-1)', borderBottom: '1px solid var(--ink)' }}>
            {['ID', 'WORKFLOW', 'STATUS', 'DUR', 'COST', 'STARTED'].map((h, i) => <th key={i} style={{ padding: '8px 10px', textAlign: 'left', fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.08em', borderRight: i < 5 ? '1px solid var(--line)' : 'none' }}>{h}</th>)}
          </tr></thead>
          <tbody>
            {executions.map((e, i) => (
              <tr key={i} style={{ borderBottom: '1px solid var(--line)', background: i === 2 ? 'var(--acc-dim)' : 'var(--bg-1)' }}>
                <td style={{ padding: '5px 10px', color: 'var(--acc)', borderRight: '1px solid var(--line)' }}>{e[0]}</td>
                <td style={{ padding: '5px 10px', borderRight: '1px solid var(--line)', maxWidth: 0 }} className="truncate">{e[1]}</td>
                <td style={{ padding: '5px 10px', borderRight: '1px solid var(--line)' }}>{execStatusPill(e[2])}</td>
                <td style={{ padding: '5px 10px', color: 'var(--ink-2)', borderRight: '1px solid var(--line)' }}>{e[3]}</td>
                <td style={{ padding: '5px 10px', color: 'var(--ink-2)', borderRight: '1px solid var(--line)' }}>{e[4]}</td>
                <td style={{ padding: '5px 10px', color: 'var(--ink-3)' }}>{e[5]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ width: 320, borderLeft: '1px solid var(--ink)', background: 'var(--bg-1)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--ink)', background: 'var(--bg-2)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="dot dot-run"/><span className="uppercase-label">98f364f2 · LIVE</span>
        </div>
        <div style={{ padding: 12, flex: 1, fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.7 }}>
          <div style={{ color: 'var(--ink-3)' }}>workflow</div><div style={{ marginBottom: 6 }}>chat:spawn_agent/classification-judge</div>
          <div style={{ color: 'var(--ink-3)' }}>node</div><div style={{ marginBottom: 6, color: 'var(--info)' }}>judge.classify(0/12)</div>
          <div style={{ color: 'var(--ink-3)' }}>elapsed</div><div style={{ marginBottom: 6 }}>12.3s</div>
          <div style={{ color: 'var(--ink-3)' }}>tokens</div><div style={{ marginBottom: 6 }}>14,228 in · 2,104 out</div>
          <div style={{ color: 'var(--ink-3)', marginTop: 12 }}>STREAM</div>
          <div style={{ color: 'var(--ink-2)' }}>&gt; computing similarity…<br/>&gt; mongodb.query → 412<br/>&gt; opensearch.embed ok<br/>&gt; top-3: Garden, Patio, Outdoor<br/>&gt; consensus = Outdoor (0.91)</div>
        </div>
      </div>
    </div>
  </V3Frame>
);

// ====================== INTERVENTIONS ======================
const InterventionsV1 = () => (
  <V1Frame active="interventions" crumbs={['Monitor', 'Interventions']}
    actions={<>
      <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>0 PEND · 5 ANS · 5 TOTAL</span>
      <button className="btn btn-line"><Icon name="refresh" size={11}/> REFRESH</button>
    </>}>
    <div style={{ flex: 1, padding: 14, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ padding: '6px 12px', background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="search" size={11} color="var(--ink-3)"/>
        <span style={{ fontSize: 11, color: 'var(--ink-3)' }} className="mono">Search title, workflow, stage, user request…</span>
      </div>
      <div className="uppercase-label">HISTORY · 5</div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {interventions.map((it, i) => (
          <div key={i} style={{ padding: '10px 12px', borderLeft: `2px solid ${it[1] === 'approved' ? 'var(--ok)' : 'var(--warn)'}`, background: 'var(--bg-1)', border: '1px solid var(--line)', borderLeft: `3px solid ${it[1] === 'approved' ? 'var(--ok)' : 'var(--warn)'}`, borderRadius: 4, marginBottom: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <Icon name={it[1] === 'approved' ? 'check' : 'help'} size={12} color={it[1] === 'approved' ? 'var(--ok)' : 'var(--warn)'}/>
              <span style={{ fontWeight: 600, fontSize: 12.5 }}>{it[0]}</span>
              <span className={`pill ${it[1] === 'approved' ? 'pill-ok' : 'pill-warn'}`}>{it[1] === 'approved' ? 'Approved' : 'Question'}</span>
              <span style={{ flex: 1 }}/>
              <Icon name="dot-menu" size={11} color="var(--ink-3)"/>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--ink-2)', marginBottom: 4, lineHeight: 1.5 }} className="truncate">{it[2]}</div>
            <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)', display: 'flex', gap: 10 }}>
              <span><Icon name="flow" size={9}/> {it[3]}</span>
              <span>· {it[4]}</span>
              <span>· <Icon name="clock" size={9}/> {it[5]}</span>
              <span>· ✓ {it[6]} · {it[5]}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  </V1Frame>
);

const InterventionsV2 = () => (
  <V2Frame active="interventions" title="Needs review" crumbs={['Workspace', 'Needs review']}
    actions={<button className="btn btn-line"><Icon name="refresh" size={12}/> Refresh</button>}
    tabs={[{ label: 'Pending', count: 0 }, { label: 'Answered', count: 5, active: true }, { label: 'All', count: 5 }]}>
    <div style={{ flex: 1, padding: '16px 24px', overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {interventions.map((it, i) => (
        <div key={i} style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 10, padding: 14, display: 'flex', gap: 12 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: it[1] === 'approved' ? 'color-mix(in srgb, var(--ok) 20%, transparent)' : 'color-mix(in srgb, var(--warn) 20%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name={it[1] === 'approved' ? 'check' : 'help'} size={15} color={it[1] === 'approved' ? 'var(--ok)' : 'var(--warn)'}/>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{it[0]}</span>
              <span className={`pill ${it[1] === 'approved' ? 'pill-ok' : 'pill-warn'}`}>{it[1] === 'approved' ? 'Approved' : 'Question'}</span>
              <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>{it[5]}</span>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.5, marginBottom: 6, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{it[2]}</div>
            <div style={{ display: 'flex', gap: 10, fontSize: 11, color: 'var(--ink-3)', alignItems: 'center' }}>
              <span className="chip"><Icon name="flow" size={10}/> {it[3]}</span>
              <span>{it[4]}</span>
              <div style={{ flex: 1 }}/>
              <span style={{ color: 'var(--ok)' }}>✓ {it[6]}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  </V2Frame>
);

const InterventionsV3 = () => (
  <V3Frame active="interventions" title="Interventions" subtitle="human-in-the-loop · 5 history" count="0 PEND"
    actions={<><button className="btn btn-line mono">FILTER</button><button className="btn btn-line mono">REFRESH</button></>}>
    <div style={{ flex: 1, overflow: 'hidden' }}>
      {interventions.map((it, i) => (
        <div key={i} style={{ borderBottom: '1px solid var(--line)', display: 'flex', background: 'var(--bg-1)' }}>
          <div style={{ width: 6, background: it[1] === 'approved' ? 'var(--ok)' : 'var(--warn)' }}/>
          <div style={{ flex: 1, padding: '14px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', width: 24 }}>{String(i + 1).padStart(2, '0')}</span>
              <span style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{it[0].toUpperCase()}</span>
              <span className={`pill ${it[1] === 'approved' ? 'pill-ok' : 'pill-warn'}`}>{it[1].toUpperCase()}</span>
              <span style={{ flex: 1 }}/>
              <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>{it[3]} · {it[4]} · {it[5]}</span>
            </div>
            <div style={{ paddingLeft: 32, fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.5 }} className="truncate">{it[2]}</div>
          </div>
        </div>
      ))}
    </div>
  </V3Frame>
);

// ====================== ANALYTICS ======================
const AnalyticsV1 = () => (
  <V1Frame active="analytics" crumbs={['Monitor', 'Analytics']}>
    <div style={{ flex: 1, padding: 14, display: 'flex', flexDirection: 'column', gap: 10, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        {[['Spend 7d', '$5,842', 'var(--acc)'], ['Spend 30d', '$24,109', 'var(--acc)'], ['Tokens 24h', '14.2M', 'var(--info)'], ['p95 Duration', '1,124s', 'var(--warn)']].map((s, i) => (
          <div key={i} style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 4, padding: '10px 14px' }}>
            <div className="uppercase-label">{s[0]}</div>
            <div className="mono" style={{ fontSize: 24, fontWeight: 600, color: s[2], marginTop: 2, letterSpacing: '-0.02em' }}>{s[1]}</div>
          </div>
        ))}
      </div>
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8, minHeight: 0 }}>
        <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 4, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)' }}>
            <span className="uppercase-label">SPEND · 30 DAYS</span>
          </div>
          <div style={{ flex: 1, padding: 14, display: 'flex', alignItems: 'flex-end', gap: 3 }}>
            {Array.from({ length: 30 }).map((_, i) => {
              const h = 20 + Math.sin(i / 3) * 30 + Math.random() * 30 + i * 1.2;
              return <div key={i} style={{ flex: 1, height: `${h}%`, background: `linear-gradient(180deg, var(--acc), color-mix(in srgb, var(--acc) 30%, transparent))`, minHeight: 4 }}/>;
            })}
          </div>
        </div>
        <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 4, padding: 12, display: 'flex', flexDirection: 'column' }}>
          <div className="uppercase-label" style={{ marginBottom: 8 }}>SPEND BY MODEL</div>
          {[['opus', 8420, '#fbbf24'], ['sonnet', 14123, '#5eead4'], ['haiku', 1566, '#818cf8']].map((m, i) => (
            <div key={i} style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                <span style={{ flex: 1, color: m[2] }}>{m[0]}</span>
                <span style={{ fontWeight: 600 }}>${m[1].toLocaleString()}</span>
              </div>
              <div style={{ height: 6, background: 'var(--bg-3)', marginTop: 4, borderRadius: 3 }}>
                <div style={{ width: `${(m[1] / 24109) * 100}%`, height: '100%', background: m[2], borderRadius: 3 }}/>
              </div>
            </div>
          ))}
          <div className="uppercase-label" style={{ marginBottom: 8, marginTop: 8 }}>LEARNINGS · 12</div>
          {['Always cache opensearch results for 5min', 'Prefer haiku for category-mover task', 'classification-judge needs 2-shot examples'].map((l, i) => (
            <div key={i} style={{ fontSize: 11, color: 'var(--ink-2)', padding: '4px 0', borderTop: '1px solid var(--line)', display: 'flex', gap: 6 }}>
              <Icon name="sparkle" size={10} color="var(--acc)"/>
              <span>{l}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  </V1Frame>
);

const AnalyticsV2 = () => (
  <V2Frame active="analytics" title="Analytics" crumbs={['Insight', 'Analytics']}
    tabs={[{ label: 'Overview', active: true }, { label: 'Spend' }, { label: 'Performance' }, { label: 'Learnings', count: 12 }]}>
    <div style={{ flex: 1, padding: '16px 24px', overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        {[['Spend (30d)', '$24,109', '+12%'], ['Tokens (24h)', '14.2M', '+3%'], ['Avg duration', '1,124s', '−4%'], ['Save rate', '94%', '+1.2pt']].map((s, i) => (
          <div key={i} style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>{s[0]}</div>
            <div style={{ fontSize: 24, fontWeight: 600, marginTop: 4, letterSpacing: '-0.02em' }}>{s[1]}</div>
            <div style={{ fontSize: 11, color: 'var(--ok)', marginTop: 2 }}>{s[2]} vs prev period</div>
          </div>
        ))}
      </div>
      <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 10, padding: 18, height: 220 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 500 }}>Spend over time</div>
          <div style={{ flex: 1 }}/>
          <div style={{ display: 'flex', gap: 12, fontSize: 11 }}>
            {[['Opus', '#fbbf24'], ['Sonnet', 'var(--acc)'], ['Haiku', '#818cf8']].map(([l, c], i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: c }}/>{l}</div>
            ))}
          </div>
        </div>
        <div style={{ height: 150, display: 'flex', alignItems: 'flex-end', gap: 4 }}>
          {Array.from({ length: 30 }).map((_, i) => {
            const a = 20 + Math.sin(i / 4) * 15 + Math.random() * 15;
            const b = 30 + Math.cos(i / 5) * 15 + Math.random() * 20;
            const c = Math.random() * 8;
            return (
              <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column-reverse' }}>
                <div style={{ height: a, background: 'var(--acc)', borderRadius: '0 0 2px 2px' }}/>
                <div style={{ height: b, background: '#fbbf24' }}/>
                <div style={{ height: c, background: '#818cf8', borderRadius: '2px 2px 0 0' }}/>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ flex: 1, background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 10, padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="sparkle" size={14} color="var(--acc)"/> Recent learnings</div>
        {['Always cache opensearch.embed results for 5 minutes', 'Prefer haiku for category-mover task — 8x cheaper, same output', 'classification-judge requires 2-shot examples for 12+ categories'].map((l, i) => (
          <div key={i} style={{ padding: '8px 0', borderTop: i > 0 ? '1px solid var(--line)' : 'none', fontSize: 12.5, color: 'var(--ink-2)', display: 'flex', gap: 8 }}>
            <span style={{ color: 'var(--acc)' }}>✦</span>
            <span style={{ flex: 1 }}>{l}</span>
            <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>2d ago</span>
          </div>
        ))}
      </div>
    </div>
  </V2Frame>
);

const AnalyticsV3 = () => (
  <V3Frame active="analytics" title="Analytics" subtitle="cost · perf · learnings" count="30D">
    <div style={{ flex: 1, padding: 16, display: 'flex', flexDirection: 'column', gap: 0, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 0, border: '1px solid var(--ink)', background: 'var(--bg-1)' }}>
        {[['SPEND 30D', '$24,109'], ['TOKENS 24H', '14.2M'], ['P95 DUR', '1,124s'], ['SAVE RATE', '94%']].map((s, i) => (
          <div key={i} style={{ padding: '14px 16px', borderRight: i < 3 ? '1px solid var(--ink)' : 'none' }}>
            <div className="uppercase-label">{s[0]}</div>
            <div style={{ fontSize: 26, fontWeight: 700, fontFamily: 'var(--font-mono)', letterSpacing: '-0.03em', marginTop: 4 }}>{s[1]}</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 12, flex: 1, display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 0, border: '1px solid var(--ink)', minHeight: 0 }}>
        <div style={{ borderRight: '1px solid var(--ink)', background: 'var(--bg-1)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--ink)', background: 'var(--bg-2)' }} className="uppercase-label">SPEND · 30D</div>
          <div style={{ flex: 1, padding: 12, display: 'flex', alignItems: 'flex-end', gap: 2 }}>
            {Array.from({ length: 30 }).map((_, i) => {
              const h = 20 + Math.sin(i / 3) * 30 + Math.random() * 30 + i * 1.4;
              return <div key={i} style={{ flex: 1, height: `${h}%`, background: 'var(--ink)' }}/>;
            })}
          </div>
        </div>
        <div style={{ background: 'var(--bg-1)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--ink)', background: 'var(--bg-2)' }} className="uppercase-label">LEARNINGS · 12</div>
          {['Always cache opensearch.embed for 5min', 'Prefer haiku for category-mover (8x cheaper)', 'classification-judge needs 2-shot examples', 'Skip judge for runs < 200 tokens', 'Frontend-dev needs MCP github tool'].map((l, i) => (
            <div key={i} style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)', fontFamily: 'var(--font-mono)', fontSize: 11, display: 'flex', gap: 8 }}>
              <span style={{ color: 'var(--acc)', width: 14 }}>✦{i+1}</span>
              <span style={{ flex: 1 }}>{l}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  </V3Frame>
);

// ====================== JOBS + MCP ======================
const JobsV1 = () => (
  <V1Frame active="jobs" crumbs={['Monitor', 'Scheduled Jobs']}
    actions={<><span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>7 CONFIGURED</span><button className="btn btn-primary"><Icon name="plus" size={11}/> NEW JOB</button></>}>
    <div style={{ flex: 1, padding: 14, overflow: 'hidden' }}>
      {jobs.map((j, i) => (
        <div key={i} style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderLeft: `3px solid ${j[8] === 'err' ? 'var(--err)' : 'var(--ok)'}`, borderRadius: 4, padding: 12, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 12 }}>
          <Icon name="clock" size={13} color="var(--ink-3)"/>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>{j[0]}</span>
              {j[1].split(' ').map((t, k) => <span key={k} className="chip">{t}</span>)}
            </div>
            <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>{j[2]} · {j[3]}</div>
            {j[8] === 'err' && <div style={{ color: 'var(--err)', fontSize: 11, marginTop: 4, fontFamily: 'var(--font-mono)' }}>Workflow "pipeline-incident-watchdog" not found</div>}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, minWidth: 220, fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>
            <div style={{ display: 'flex', gap: 12 }}>
              <span><span style={{ color: 'var(--ink-3)' }}>last </span><span style={{ color: j[8] === 'err' ? 'var(--err)' : 'var(--ok)' }}>{j[4].toUpperCase()}</span> {j[5]}</span>
              <span><span style={{ color: 'var(--ink-3)' }}>next </span>{j[6]}</span>
              <span><span style={{ color: 'var(--ink-3)' }}>runs </span>{j[7]}</span>
            </div>
          </div>
          <div style={{ width: 32, height: 18, borderRadius: 99, background: 'var(--acc)', position: 'relative' }}>
            <div style={{ position: 'absolute', right: 2, top: 2, width: 14, height: 14, borderRadius: '50%', background: '#fff' }}/>
          </div>
        </div>
      ))}
    </div>
  </V1Frame>
);

const JobsV2 = () => (
  <V2Frame active="jobs" title="Schedules" crumbs={['Build', 'Schedules']}
    actions={<button className="btn btn-primary"><Icon name="plus" size={12}/> New schedule</button>}
    tabs={[{ label: 'All', count: 7, active: true }, { label: 'Failing', count: 1 }, { label: 'Built-in', count: 5 }]}>
    <div style={{ flex: 1, padding: '16px 24px', overflow: 'hidden', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, alignContent: 'flex-start' }}>
      {jobs.map((j, i) => (
        <div key={i} style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="clock" size={14} color="var(--acc)"/>
            <span style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>{j[0]}</span>
            <span className={`pill pill-${j[8] === 'err' ? 'err' : 'ok'}`}>{j[4]}</span>
            <div style={{ width: 28, height: 16, borderRadius: 99, background: 'var(--acc)', position: 'relative' }}>
              <div style={{ position: 'absolute', right: 2, top: 2, width: 12, height: 12, borderRadius: '50%', background: '#fff' }}/>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {j[1].split(' ').map((t, k) => <span key={k} className="chip">{t}</span>)}
          </div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>{j[2]} · {j[3].slice(0, 60)}…</div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', display: 'flex', gap: 12 }}>
            <span>last {j[5]}</span><span>next {j[6]}</span><span>{j[7]} runs</span>
          </div>
        </div>
      ))}
    </div>
  </V2Frame>
);

const JobsV3 = () => (
  <V3Frame active="jobs" title="Scheduled Jobs / MCP" subtitle="cron · servers" count="7 / 8">
    <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', overflow: 'hidden' }}>
      <div style={{ borderRight: '1px solid var(--ink)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--ink)', background: 'var(--bg-2)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="uppercase-label">SCHEDULES · 7</span>
          <span style={{ flex: 1 }}/>
          <button className="btn btn-line mono" style={{ fontSize: 10 }}>+ NEW</button>
        </div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          {jobs.map((j, i) => (
            <div key={i} style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-1)', fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
              <span style={{ color: j[8] === 'err' ? 'var(--err)' : 'var(--ok)' }}>{j[8] === 'err' ? '✗' : '●'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }} className="truncate">{j[0]}</div>
                <div style={{ color: 'var(--ink-3)', fontSize: 10 }}>{j[2]}</div>
              </div>
              <span style={{ color: 'var(--ink-3)', fontSize: 10 }}>last {j[5]}</span>
              <span style={{ color: 'var(--ink-3)', fontSize: 10 }}>{j[7]}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--ink)', background: 'var(--bg-2)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="uppercase-label">MCP SERVERS · 8</span>
          <span style={{ flex: 1 }}/>
          <button className="btn btn-line mono" style={{ fontSize: 10 }}>+ ADD</button>
        </div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          {mcpServers.map((m, i) => (
            <div key={i} style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-1)', fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
              <Icon name="mcp" size={13} color="var(--acc)"/>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 600 }}>{m[0]}</span>
                  <span style={{ color: 'var(--ink-3)', fontSize: 10 }}>{m[1]} · {m[2]} tools</span>
                </div>
                <div style={{ color: 'var(--ink-3)', fontSize: 10 }} className="truncate">{m[3]}</div>
              </div>
              <span style={{ color: 'var(--ok)' }}>● connected</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  </V3Frame>
);

// ====================== MCP standalone ======================
const McpV1 = () => (
  <V1Frame active="jobs" crumbs={['Settings', 'MCP Servers']}
    actions={<button className="btn btn-primary"><Icon name="plus" size={11}/> ADD</button>}>
    <div style={{ flex: 1, padding: 14, overflow: 'hidden' }}>
      <div style={{ marginBottom: 10, fontSize: 11, color: 'var(--ink-3)' }}>Connect external tools to the Allen Chat agent via Model Context Protocol servers.</div>
      <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 4 }}>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="mcp" size={13} color="var(--acc)"/>
          <span className="uppercase-label">CONFIGURED SERVERS</span>
          <span style={{ flex: 1 }}/>
          <span style={{ fontSize: 10, color: 'var(--ink-3)' }} className="mono">env in .env with ALLEN_ prefix · restart after editing</span>
        </div>
        {mcpServers.map((m, i) => (
          <div key={i} style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
            <Icon name="chevron" size={11} color="var(--ink-3)"/>
            <Icon name="mcp" size={13} color="var(--acc)"/>
            <span className="mono" style={{ fontWeight: 600 }}>{m[0]}</span>
            <span style={{ fontSize: 10, color: 'var(--ink-3)' }} className="mono">{m[1]} · {m[2]} tools</span>
            <span style={{ flex: 1, fontSize: 10.5, color: 'var(--ink-3)' }} className="mono truncate">{m[3]}</span>
            <span className="pill pill-ok">connected</span>
            <Icon name="refresh" size={11} color="var(--ink-3)"/>
            <Icon name="settings" size={11} color="var(--ink-3)"/>
            <Icon name="trash" size={11} color="var(--ink-3)"/>
          </div>
        ))}
      </div>
    </div>
  </V1Frame>
);

const McpV2 = () => (
  <V2Frame active="jobs" title="MCP Servers" crumbs={['Settings', 'MCP Servers']}
    actions={<button className="btn btn-primary"><Icon name="plus" size={12}/> Add server</button>}>
    <div style={{ flex: 1, padding: '16px 24px', overflow: 'hidden', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, alignContent: 'flex-start' }}>
      {mcpServers.map((m, i) => (
        <div key={i} style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 10, padding: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: 8, background: 'var(--acc-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="mcp" size={16} color="var(--acc)"/></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="mono" style={{ fontWeight: 600, fontSize: 13 }}>{m[0]}</span>
              <span className="chip">{m[1]}</span>
              <span className="chip">{m[2]} tools</span>
            </div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }} className="truncate">{m[3]}</div>
          </div>
          <span className="pill pill-ok">connected</span>
        </div>
      ))}
    </div>
  </V2Frame>
);

const McpV3 = () => (
  <V3Frame active="jobs" title="MCP Servers" subtitle="model context protocol" count={`${mcpServers.length} ACTIVE`}
    actions={<button className="btn btn-primary mono">+ ADD SERVER</button>}>
    <div style={{ flex: 1, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        <thead><tr style={{ background: 'var(--bg-1)', borderBottom: '1px solid var(--ink)' }}>
          {['NAME', 'TYPE', 'TOOLS', 'PATH / DESCRIPTION', 'STATUS', ''].map((h, i) => <th key={i} style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.08em', borderRight: i < 5 ? '1px solid var(--line)' : 'none' }}>{h}</th>)}
        </tr></thead>
        <tbody>
          {mcpServers.map((m, i) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--line)', background: 'var(--bg-1)' }}>
              <td style={{ padding: '10px 12px', fontWeight: 600, borderRight: '1px solid var(--line)' }}>{m[0]}</td>
              <td style={{ padding: '10px 12px', color: 'var(--ink-3)', borderRight: '1px solid var(--line)' }}>{m[1]}</td>
              <td style={{ padding: '10px 12px', borderRight: '1px solid var(--line)' }}>{m[2]}</td>
              <td style={{ padding: '10px 12px', color: 'var(--ink-3)', borderRight: '1px solid var(--line)', maxWidth: 0 }} className="truncate">{m[3]}</td>
              <td style={{ padding: '10px 12px', color: 'var(--ok)', borderRight: '1px solid var(--line)' }}>● CONNECTED</td>
              <td style={{ padding: '4px 8px' }}><button className="btn btn-line mono" style={{ fontSize: 10 }}>EDIT</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </V3Frame>
);

Object.assign(window, {
  ReposV1, ReposV2, ReposV3, LinearV1, LinearV2, LinearV3,
  WorkspacesV1, WorkspacesV2, WorkspacesV3, PRsV1, PRsV2, PRsV3,
  ExecutionsV1, ExecutionsV2, ExecutionsV3, InterventionsV1, InterventionsV2, InterventionsV3,
  AnalyticsV1, AnalyticsV2, AnalyticsV3, JobsV1, JobsV2, JobsV3, McpV1, McpV2, McpV3,
});
