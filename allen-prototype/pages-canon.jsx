// New canonical pages: My work, Inbox, Threads, Task, Settings, Activity
// Built around JTBD-2 + JTBD-4: one task page, one inbox, one history of threads.

const { useState: nUseState, useEffect: nUseEffect, useMemo: nUseMemo } = React;

// ===== shared status pill =====
function StatusPill({ s }) {
  const map = {
    planning:    { lbl: 'planning',     cls: 'pill-plan' },
    implementing:{ lbl: 'implementing', cls: 'pill-impl' },
    testing:     { lbl: 'testing',      cls: 'pill-test' },
    review:      { lbl: 'in review',    cls: 'pill-review' },
    blocked:     { lbl: 'blocked',      cls: 'pill-blocked' },
    waiting:     { lbl: 'waiting on you', cls: 'pill-waiting' },
    queued:      { lbl: 'queued',       cls: 'pill-queued' },
    merged:      { lbl: 'merged',       cls: 'pill-merged' },
    failed:      { lbl: 'failed',       cls: 'pill-failed' },
    archived:    { lbl: 'archived',     cls: 'pill-archived' },
  };
  const m = map[s] || { lbl: s, cls: '' };
  return <span className={`pill ${m.cls}`}>{m.lbl}</span>;
}

// progress bar 0-100
function ProgBar({ v, hue }) {
  return (
    <div className="prog-bar">
      <div className="prog-fill" style={{ width: v+'%', background: hue || 'var(--accent)'}}></div>
    </div>
  );
}

// ===== rich content rendering — markdown-ish inline + block helpers =====
// Inline: `code`, **bold**, *italic*. Tokenizer that doesn't allow nesting.
function renderInline(text) {
  if (text == null) return null;
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*)/g;
  const out = [];
  let last = 0, m, key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(<React.Fragment key={key++}>{text.slice(last, m.index)}</React.Fragment>);
    const tok = m[0];
    if (tok.startsWith('`'))      out.push(<code key={key++} className="ic">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('**')) out.push(<strong key={key++}>{tok.slice(2, -2)}</strong>);
    else                           out.push(<em key={key++}>{tok.slice(1, -1)}</em>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(<React.Fragment key={key++}>{text.slice(last)}</React.Fragment>);
  return out;
}
function renderBlocks(blocks) {
  if (!blocks) return null;
  return blocks.map((b, i) => {
    if (b.type === 'h2')      return <h2 key={i} className="cm-h2">{renderInline(b.text)}</h2>;
    if (b.type === 'h3')      return <h3 key={i} className="cm-h3">{renderInline(b.text)}</h3>;
    if (b.type === 'p')       return <p  key={i} className="cm-p">{renderInline(b.text)}</p>;
    if (b.type === 'callout') return <div key={i} className="cm-callout">{renderInline(b.text)}</div>;
    if (b.type === 'code')    return <pre key={i} className="cm-code"><code>{b.text}</code></pre>;
    if (b.type === 'ul') return (
      <ul key={i} className="cm-ul">
        {b.items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}
      </ul>
    );
    if (b.type === 'ol') return (
      <ol key={i} className="cm-ol">
        {b.items.map((it, j) => (
          <li key={j}>
            {typeof it === 'string'
              ? renderInline(it)
              : (<>{renderInline(it.text)}{it.sub && (
                  <ul className="cm-ul-sub">{it.sub.map((s, k) => <li key={k}>{renderInline(s)}</li>)}</ul>
                )}</>)}
          </li>
        ))}
      </ol>
    );
    if (b.type === 'table') return (
      <div key={i} className="cm-tbl-wrap">
        <table className="cm-tbl">
          <thead><tr>{b.cols.map((c, j) => <th key={j}>{renderInline(c)}</th>)}</tr></thead>
          <tbody>
            {b.rows.map((row, j) => (
              <tr key={j}>{row.map((cell, k) => <td key={k}>{renderInline(cell)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
    return null;
  });
}

// ===== mock task data — synthesized from execs + tickets =====
const TASK_FIXTURES = {
  't-1453': {
    id: 't-1453', ticket: 'ENG-1453', title: 'Pricing Update: Amazon CART_GATED_PRICE not handled — chain miss',
    repo: 'es-data-pipeline', workflow: 'feature-plan-and-implement', owner: 'you',
    status: 'implementing', progress: 58, eta: '~14m', cost: 0.92, branch: 'fix/eng-1448-vendor-scoped-circuit-breaker',
    pr: { num: '#598', state: 'open', plus: 1276, minus: 164, files: 13 },
    chat: [
      { who: 'you',   ts: '4:18 PM', text: "Investigate ENG-1453 — Amazon's CART_GATED_PRICE response isn't being handled. We're getting chain misses." },
      { who: 'allen', ts: '4:18 PM', text: 'Spinning up `feature-plan-and-implement` against `es-data-pipeline @ development`. Will pause for plan review.' },
      { who: 'allen', ts: '4:21 PM', text: 'PRD ready. Identified 3 affected handlers and a missing branch in `pricing-update/handlers/amazon.ts`.' },
      { who: 'allen', ts: '4:24 PM', text: 'HLA proposes a vendor-scoped circuit breaker with AbortController. Estimated 13 files, 4 new tests.' },
      { who: 'you',   ts: '4:26 PM', text: 'Approve plan. Add an integration test for the gated state.' },
      { who: 'allen', ts: '4:27 PM', text: 'Plan approved. Dispatching impl-cortex + qa-runner.' },
      { who: 'allen', ts: '4:32 PM', text: 'Implementation in progress: 7 of 13 files modified. Tests being written in parallel.' },
    ],
    steps: [
      { id: 'intake',  name: 'intake & clarify',     state: 'ok',   actor: 'intake-clarifier', dur: '12s',  cost: 0.04 },
      { id: 'prd',     name: 'PRD',                  state: 'ok',   actor: 'prd-writer',       dur: '38s',  cost: 0.11 },
      { id: 'hla',     name: 'HLA',                  state: 'ok',   actor: 'hla-writer',       dur: '52s',  cost: 0.18 },
      { id: 'gate',    name: 'plan approval',        state: 'ok',   actor: 'you',              dur: '2m',   cost: 0 },
      { id: 'impl',    name: 'implementation',       state: 'run',  actor: 'impl-cortex',      dur: '4m',   cost: 0.31, sub: '7/13 files' },
      { id: 'qa',      name: 'tests & lint',         state: 'run',  actor: 'qa-runner',        dur: '2m',   cost: 0.18, sub: '8 of 12 passing' },
      { id: 'sec',     name: 'security audit',       state: 'wait', actor: 'sec-scout',        dur: '—',    cost: 0 },
      { id: 'pr',      name: 'open PR',              state: 'wait', actor: 'pr-bot',           dur: '—',    cost: 0 },
      { id: 'summary', name: 'summary & handoff',    state: 'wait', actor: 'allen',            dur: '—',    cost: 0 },
    ],
  },
  't-1432': {
    id: 't-1432', ticket: 'ENG-1432', title: 'Find Similar: ensure deterministic and consistent results for the same input',
    repo: 'es-data-pipeline', workflow: 'understand-and-plan', owner: 'you',
    status: 'waiting', progress: 35, eta: 'on you', cost: 0.21, branch: '—',
    pr: null,
    chat: [
      { who: 'you',   ts: '3:50 PM', text: 'Plan the find-similar determinism work. No implementation yet.' },
      { who: 'allen', ts: '3:50 PM', text: 'Running understand-and-plan. Will produce PRD + HLA.' },
      { who: 'allen', ts: '3:58 PM', text: 'Plan ready. Two design choices need your input: cache key strategy and tie-breaking on equal scores. See plan tab.' },
    ],
    steps: [
      { id: 'intake', name: 'intake & clarify', state: 'ok',   actor: 'intake-clarifier', dur: '8s',  cost: 0.03 },
      { id: 'prd',    name: 'PRD',              state: 'ok',   actor: 'prd-writer',       dur: '42s', cost: 0.10 },
      { id: 'hla',    name: 'HLA',              state: 'ok',   actor: 'hla-writer',       dur: '58s', cost: 0.08 },
      { id: 'gate',   name: 'design decision',  state: 'wait-you', actor: 'you',          dur: '—',   cost: 0, sub: '2 questions' },
    ],
  },
  't-spec-enrich': {
    id: 't-spec-enrich', ticket: 'ENG-1502', title: 'Manufacturer spec sheet enrichment for top-selling products',
    repo: 'inomy-ai-service', workflow: 'understand-and-plan', owner: 'you',
    status: 'planning', progress: 30, eta: 'on you', cost: 5.50, branch: '—',
    pr: null,
    chat: [
      { who: 'you', ts: '1:07 PM', text: "for some of the state top selling products so one struggle we have is that we don't know the exact specs that comes from manufacturer for those products. The right way to do would be to find the manufacturer spec sheet so we can answer user questions, more reliable instead of just relying on the retailers data and once we have done the grouping and variant, we know the exact product so we can go and fetch for that and install it and use it to answer any detail level questions can you propose and approach how can we do it? It's likely to be a combination of web search and enrichment. we can start with the products in each sheet because they're generally the best selling products." },
      { who: 'allen', ts: '1:07 PM', blocks: [
        { type: 'h2', text: 'Manufacturer Spec Sheet Enrichment — Proposed Approach' },
        { type: 'h3', text: 'Why this matters' },
        { type: 'p',  text: "Retailer-extracted specs are noisy: vendors omit fields, mistype values, copy-paste across SKUs, and disagree with each other. Once **grouping + variant resolution** has nailed down the exact manufacturer SKU/MPN, the manufacturer's own spec sheet is the **ground truth**. Using it lets us answer detail questions confidently and reconcile vendor disagreements." },
        { type: 'h3', text: 'Stage 0 — Trigger & Scope' },
        { type: 'ul', items: [
          "**Input**: a `product_group_id` that has passed grouping + variant enrichment (i.e. we know `brand`, `mpn`, `variant_axis_values`, `series`).",
          "**Scope V1**: top-selling products per category (the \"sheet\" you mentioned). Rank by `popularity_score` / vendor count / price-tier coverage and pick top N (e.g. 100–500 per category).",
          "**Re-enrichment cadence**: once per product, plus a periodic refresh (e.g. every 90 days) for active listings — manufacturers do silently update spec PDFs.",
        ]},
        { type: 'h3', text: 'Stage 1 — Source Discovery (Web Search)' },
        { type: 'p',  text: 'Goal: find the **canonical manufacturer page** for the exact MPN.' },
        { type: 'ol', items: [
          { text: '**Query construction** from grouped product:', sub: [
            '`"{brand} {mpn} site:{brand_domain}"`',
            '`"{brand} {mpn} specifications"`',
            '`"{brand} {model_name} datasheet filetype:pdf"`',
          ]},
          "**Brand domain registry** — maintain a `brand_domains` table (`LG → lg.com`, `Samsung → samsung.com/us`, `Sony → sony.com`, etc.) seeded from `product_configs.brand_list` plus a one-time crawl. Heavily improves precision.",
          "**Search providers**: Oxylabs `universal` source for Google / Bing SERPs. Fall back to DuckDuckGo when a brand is rate-limited.",
          { text: '**Candidate scoring** — for each result rank by:', sub: [
            'Domain matches the brand domain registry (+strong signal)',
            'URL or title contains the exact MPN (+strong signal)',
            'Page type: product page > spec page > PDF > review > retailer',
            'Penalize aggregator/SEO-farm domains (cnet, bestbuy, walmart, …)',
          ]},
          "**Output**: top 1–3 candidate URLs per product persisted in a new `manufacturer_sources` collection so we don't re-search later.",
        ]},
        { type: 'h3', text: 'Stage 2 — Spec Extraction (Enrichment)' },
        { type: 'p',  text: 'Goal: turn the manufacturer URL into structured fields aligned to `product_schemas`.' },
        { type: 'ol', items: [
          "**Fetcher** — Oxylabs `fetch_html` (with `render=true` for SPA brand sites like Samsung / LG). For PDFs, use a PDF-to-text step (pdfplumber / Gemini multimodal directly on the file).",
          "**Spec block isolation** — strip navigation/footer; locate `Specifications` / `Tech Specs` / `What's in the box` sections. Most brand sites have a stable container (`#specs`, `[data-section=\"specifications\"]`).",
          "**LLM-aligned extraction** — feed the cleaned spec section + the schema for that category to Gemini (same `product_schemas` we already use). The LLM is told: \"Map manufacturer-stated values onto these fields. Leave missing fields missing — expose a real schema gap.\"",
        ]},
        { type: 'p',  text: 'Persist into a new `enriched_product.manufacturer_spec` JSON column (or a parallel collection) so we can A/B against vendor-only enrichment without losing the original.' },
        { type: 'h3', text: 'Stage 4 — Storage & Surfacing' },
        { type: 'ul', items: [
          "`manufacturer_spec_sheets` collection: `{ product_group_id, brand, mpn, source_url, source_type: page|pdf, fetched_at, raw_html_s3, parsed_specs, schema_version }`.",
          "`enriched_product`: add `manufacturer_spec_status`, `manufacturer_source_url`, per-field `*_source` markers.",
          '**OpenSearch**: index manufacturer-confirmed values into a sibling field (`spec.refresh_rate.manufacturer`) so search relevance can boost manufacturer-verified hits and the UI can render a "Verified by manufacturer" badge.',
        ]},
        { type: 'h3', text: 'Stage 5 — Pipeline Wiring' },
        { type: 'p',  text: 'New stage `manufacturer_enrichment` running after `variant_enrichment` and before `image_embedding` / `opensearch_indexing`:' },
        { type: 'code', text: '... → product_grouping → variant_enrichment → manufacturer_enrichment → opensearch_indexing' },
        { type: 'p',  text: 'Per-category toggle in `product_configs.adaptive_pipeline.manufacturer_enrichment_enabled` so we roll it out category-by-category, starting with the high-stakes ones (TVs, monitors, laptops, appliances).' },
      ]},
      { who: 'you', ts: '1:11 PM', text: 'should we use Google search or should we just use something like Tavily or exa? What do you recommend?' },
      { who: 'allen', ts: '1:11 PM', blocks: [
        { type: 'h2', text: 'Search Provider Recommendation' },
        { type: 'h3', text: 'TL;DR' },
        { type: 'callout', text: '**Use Tavily as primary, Exa as the discovery/fallback companion, Google (via Oxylabs) only as an escape hatch.**' },
        { type: 'p',  text: "Don't roll your own Google SERP scraping for this. The work to rerank, dedupe, strip SEO farms, and keep up with anti-bot changes is exactly what Tavily/Exa already solve." },
        { type: 'h3', text: 'How they compare for *this specific task* (canonical manufacturer page for a known MPN)' },
        { type: 'table',
          cols: ['Dimension', 'Google (Oxylabs SERP)', 'Tavily', 'Exa'],
          rows: [
            ['Exact MPN keyword match', 'Excellent (freshest index)', 'Excellent (rides Google/Bing under the hood)', "Mediocre — neural search isn't ideal for part numbers"],
            ['`include_domains=[lg.com]` style filters', 'Manual (`site:` operator)', '**Native, first-class**', 'Native'],
            ['Returns scored + reranked results', 'No, raw SERP', 'Yes', 'Yes (semantic score)'],
            ['Returns content snippet/extract in same call', 'No (separate fetch)', 'Yes (`include_raw_content`)', 'Yes (`get_contents`)'],
          ]
        },
      ]},
    ],
    steps: [
      { id: 'intake',  name: 'intake & clarify',     state: 'ok',   actor: 'intake-clarifier', dur: '14s', cost: 0.05 },
      { id: 'prd',     name: 'PRD',                  state: 'ok',   actor: 'prd-writer',       dur: '1m',  cost: 0.18 },
      { id: 'hla',     name: 'HLA — pipeline shape', state: 'ok',   actor: 'hla-writer',       dur: '1m',  cost: 0.22 },
      { id: 'gate',    name: 'plan approval',        state: 'wait-you', actor: 'you',          dur: '—',   cost: 0, sub: 'awaiting your sign-off on Stages 1–5' },
      { id: 'impl',    name: 'implementation',       state: 'wait', actor: 'impl-cortex',      dur: '—',   cost: 0 },
      { id: 'qa',      name: 'tests & lint',         state: 'wait', actor: 'qa-runner',        dur: '—',   cost: 0 },
      { id: 'pr',      name: 'open PR',              state: 'wait', actor: 'pr-bot',           dur: '—',   cost: 0 },
    ],
  },
  't-1340': {
    id: 't-1340', ticket: 'ENG-1340', title: 'E2E Tester Agent for Complete Furniture Flow',
    repo: 'inomy-mono', workflow: 'feature-plan-and-implement', owner: 'you',
    status: 'merged', progress: 100, eta: 'done', cost: 4.18, branch: 'feat/e2e-furniture-tester',
    pr: { num: '#562', state: 'merged', plus: 2104, minus: 211, files: 24 },
    chat: [
      { who: 'you',   ts: 'Apr 18', text: 'Build an E2E tester agent for the furniture flow.' },
      { who: 'allen', ts: 'Apr 18', text: 'Done — 24 files, 2104+/211−. Merged to development.' },
    ],
    steps: [
      { id: 'all', name: 'completed', state: 'ok', actor: 'allen', dur: '23m', cost: 4.18 },
    ],
  },
};

const INBOX_FIXTURES = [
  { id: 'i-1', kind: 'gate', task: 't-1432', title: 'Design decision needed', sub: 'cache key + tie-breaking', age: '32m', urgency: 'high' },
  { id: 'i-2', kind: 'review', task: 't-1453', title: 'PR #598 ready for your review', sub: '13 files · +1276/−164', age: '1m', urgency: 'high' },
  { id: 'i-3', kind: 'blocked', task: 't-1188', title: 'Schema definition stalled', sub: 'cannot reach vendor sample API', age: '2h', urgency: 'med' },
  { id: 'i-4', kind: 'question', task: 't-1419', title: 'Landing-page copy clarification', sub: 'who is the audience?', age: '4h', urgency: 'med' },
  { id: 'i-5', kind: 'mention', task: 't-1418', title: '@you tagged in chat ↔ board bridge', sub: 'allen wants your input', age: '6h', urgency: 'low' },
  { id: 'i-6', kind: 'review', task: 't-1437', title: 'PR #605 conflicts on dev', sub: '71 files · merge conflict', age: '8h', urgency: 'high' },
  { id: 'i-7', kind: 'gate', task: 't-1434', title: 'Plan approval — multi-category search', sub: 'PRD + HLA ready', age: '1d', urgency: 'med' },
  { id: 'i-8', kind: 'mention', task: 't-1420', title: 'Persistent selection epic', sub: 'allen needs scoping signal', age: '1d', urgency: 'low' },
];

const THREAD_FIXTURES = [
  // ongoing
  { id: 't-spec-enrich', title: 'Manufacturer spec sheet enrichment', sub: 'understand-and-plan', when: '8m ago', status: 'planning', progress: 30, ticket: 'ENG-1502', repo: 'inomy-ai-service', pr: null },
  { id: 't-1453', title: 'Pricing CART_GATED fix', sub: 'feature-plan-and-implement', when: '12m ago', status: 'implementing', progress: 58, ticket: 'ENG-1453', repo: 'es-data-pipeline', pr: '#2841' },
  { id: 't-1432', title: 'Find Similar determinism plan', sub: 'understand-and-plan', when: '40m ago', status: 'waiting', progress: 35, ticket: 'ENG-1432', repo: 'es-search', pr: null },
  { id: 't-1437', title: 'Set scraping standard job infra', sub: 'feature-plan-and-implement', when: '4h ago', status: 'review', progress: 92, ticket: 'ENG-1438', repo: 'es-scrapers', pr: '#2839' },
  { id: 't-1188', title: 'Schema for new product category', sub: 'understand-and-plan', when: '7h ago', status: 'blocked', progress: 22, ticket: 'ENG-1188', repo: 'es-data-pipeline', pr: null },
  { id: 't-1419', title: 'Landing page entry point epic', sub: 'understand-and-plan', when: '1w ago', status: 'planning', progress: 48, ticket: 'ENG-1419', repo: 'es-frontend', pr: null },
  // recently completed (last 7 days)
  { id: 't-1340', title: 'E2E tester for furniture flow', sub: 'feature-plan-and-implement', when: 'yesterday', status: 'merged', progress: 100, ticket: 'ENG-1340', repo: 'es-frontend', pr: '#2810' },
  { id: 't-1488', title: 'Pricing rollup nightly job', sub: 'feature-plan-and-implement', when: '2d ago', status: 'merged', progress: 100, ticket: 'ENG-1488', repo: 'es-data-pipeline', pr: '#2862' },
  { id: 't-1411', title: 'Vendor onboarding wizard auth fix', sub: 'bug-investigate-and-fix', when: '3d ago', status: 'merged', progress: 100, ticket: 'ENG-1411', repo: 'es-data-pipeline', pr: '#2854' },
  { id: 't-1399', title: 'CodeRabbit suggestions on #2839', sub: 'resolve-pr-reviews', when: '5d ago', status: 'failed', progress: 60, ticket: 'ENG-1399', repo: 'es-scrapers', pr: '#2841' },
  // history (older / archived)
  { id: 't-1207', title: 'Brand_domains seed table', sub: 'understand-and-plan', when: '3w ago', status: 'archived', progress: 100, ticket: 'ENG-1207', repo: 'es-data-pipeline', pr: '#2701' },
  { id: 't-1156', title: 'Catalog peek service v0', sub: 'feature-plan-and-implement', when: '4w ago', status: 'archived', progress: 100, ticket: 'ENG-1156', repo: 'inomy-ai-service', pr: '#2655' },
  { id: 't-1098', title: 'Sonnet → Sonnet 4.6 prompt audit', sub: 'understand-and-plan', when: '6w ago', status: 'archived', progress: 100, ticket: 'ENG-1098', repo: 'inomy-ai-service', pr: null },
  { id: 't-1062', title: 'Find-similar early prototype', sub: 'frontend-experiment', when: '2mo ago', status: 'archived', progress: 100, ticket: 'ENG-1062', repo: 'es-frontend', pr: '#2530' },
];

// ===== MY WORK =====
function MyWorkPage({ openTask, setRoute }) {
  const needsYou = INBOX_FIXTURES.filter(i => i.urgency === 'high').slice(0, 4);
  const inflight = THREAD_FIXTURES.filter(t => ['implementing','planning','testing','waiting','blocked'].includes(t.status));
  const recent = THREAD_FIXTURES.filter(t => ['merged','archived','failed'].includes(t.status));

  return (
    <div className="content scroll-hide" data-screen-label="my-work">
      <div className="mw-greet">
        <div className="mw-hello">
          <h1>good afternoon, ashish</h1>
          <p className="sub">{needsYou.length} need you · {inflight.length} in flight · {recent.length} merged this week</p>
        </div>
        <Composer onDispatch={(text) => { openTask('t-1453');}} />
      </div>

      {needsYou.length > 0 && (
        <section className="mw-sec">
          <header className="mw-sec-h">
            <h3>needs you</h3>
            <button className="link" onClick={() => setRoute('inbox')}>inbox →</button>
          </header>
          <div className="mw-needs">
            {needsYou.map(it => (
              <button key={it.id} className="mw-need" onClick={() => openTask(it.task)}>
                <span className={`need-kind ${it.kind}`}>{it.kind}</span>
                <span className="need-title">{it.title}</span>
                <span className="need-sub">{it.sub}</span>
                <span className="need-age">{it.age}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="mw-sec">
        <header className="mw-sec-h">
          <h3>in flight</h3>
          <span className="mw-sec-meta">{inflight.length}</span>
        </header>
        <div className="mw-flight">
          {inflight.map(t => (
            <button key={t.id} className="mw-flight-row" onClick={() => openTask(t.id)}>
              <div className="r-refs">
                <span className="r-ref linear">{t.ticket}</span>
                {t.pr && <span className="r-ref gh">{t.pr}</span>}
              </div>
              <div className="r-ttl">
                <div className="r-line">{t.title}</div>
                <div className="r-sub">{t.sub} · {t.repo} · {t.when}</div>
              </div>
              <div className="r-prog">
                <ProgBar v={t.progress}/>
                <span className="r-pct">{t.progress}%</span>
              </div>
              <StatusPill s={t.status}/>
            </button>
          ))}
        </div>
      </section>

      <section className="mw-sec">
        <header className="mw-sec-h">
          <h3>recent</h3>
          <button className="link" onClick={() => setRoute('threads')}>all threads →</button>
        </header>
        <div className="mw-recent">
          {recent.map(t => (
            <button key={t.id} className="mw-recent-row" onClick={() => openTask(t.id)}>
              <div className="r-refs">
                <span className="r-ref linear">{t.ticket}</span>
                {t.pr && <span className="r-ref gh">{t.pr}</span>}
              </div>
              <div className="r-ttl"><div className="r-line">{t.title}</div><div className="r-sub">{t.repo} · {t.when}</div></div>
              <StatusPill s={t.status}/>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

// Models grouped by provider — same shape used in chat composer footer
const MODEL_GROUPS = [
  { id:'codex', label:'Codex (CLI)', accent:'ok', items: [
    { id:'gpt-5.5', label:'gpt-5.5', isDefault: true },
    { id:'gpt-5.4', label:'gpt-5.4' },
    { id:'o3', label:'o3' },
    { id:'o4-mini', label:'o4-mini' },
    { id:'codex-mini', label:'codex-mini' },
  ]},
  { id:'claude', label:'Claude (CLI)', accent:'purple', items: [
    { id:'sonnet', label:'sonnet' },
    { id:'opus', label:'opus' },
    { id:'haiku', label:'haiku' },
  ]},
];
const THINKING_LEVELS = [
  { id:'low',    label:'Low' },
  { id:'medium', label:'Medium' },
  { id:'high',   label:'High (default)', isDefault: true },
];
function findModel(id) {
  for (const g of MODEL_GROUPS) {
    const m = g.items.find(it => it.id === id);
    if (m) return { group: g, model: m };
  }
  return { group: MODEL_GROUPS[0], model: MODEL_GROUPS[0].items[0] };
}

function ComposerControls({ model, setModel, thinking, setThinking, repos, setRepos, agent, setAgent }) {
  const { group, model: modelObj } = findModel(model);
  const thinkObj = THINKING_LEVELS.find(t => t.id === thinking) || THINKING_LEVELS[2];

  return (
    <div className="cmp-ctls">
      <ModelPickerBtn current={`${group.label} / ${modelObj.label}`} onPick={setModel} active={model} groupAccent={group.accent}/>
      <ThinkingPickerBtn current={thinkObj.label} onPick={setThinking} active={thinking}/>
      <RepoPickerBtn repos={repos} setRepos={setRepos}/>
      {setAgent !== undefined && <AgentPickerBtn agent={agent} setAgent={setAgent}/>}
      <button className="cmp-ic" title="attach"><Icons.attach size={14}/></button>
    </div>
  );
}

function ModelPickerBtn({ current, onPick, active, groupAccent }) {
  const [open, setOpen] = nUseState(false);
  const ref = React.useRef(null);
  nUseEffect(() => {
    if (!open) return;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  // current is "Group / model"
  const [groupLabel, modelLabel] = current.split(' / ');

  return (
    <div className="cmp-pick" ref={ref}>
      <button className={`cmp-pill ${open?'open':''}`} onClick={()=>setOpen(o=>!o)}>
        <span className={`cmp-grp ${groupAccent || ''}`}>{groupLabel}</span>
        <span className="cmp-sep">/</span>
        <span className="cmp-val">{modelLabel}</span>
        <Icons.chevD size={11}/>
      </button>
      {open && (
        <div className="cmp-pop above">
          {MODEL_GROUPS.map(g => (
            <div key={g.id} className="cmp-grp-section">
              <div className={`cmp-grp-h ${g.accent || ''}`}>{g.label}</div>
              {g.items.map(it => (
                <button
                  key={it.id}
                  className={`cmp-opt ${active === it.id ? 'active' : ''}`}
                  onClick={()=>{ onPick(it.id); setOpen(false); }}>
                  <span>{it.label}</span>
                  {active === it.id && <Icons.check size={11}/>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ThinkingPickerBtn({ current, onPick, active }) {
  const [open, setOpen] = nUseState(false);
  const ref = React.useRef(null);
  nUseEffect(() => {
    if (!open) return;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div className="cmp-pick" ref={ref}>
      <button className={`cmp-pill ${open?'open':''}`} onClick={()=>setOpen(o=>!o)}>
        <Icons.sparkle size={11}/>
        <span className="cmp-val">{current}</span>
        <Icons.chevD size={11}/>
      </button>
      {open && (
        <div className="cmp-pop above">
          {THINKING_LEVELS.map(t => (
            <button
              key={t.id}
              className={`cmp-opt ${active === t.id ? 'active' : ''}`}
              onClick={()=>{ onPick(t.id); setOpen(false); }}>
              <span>{t.label}</span>
              {active === t.id && <Icons.check size={11}/>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const REPO_LIST = [
  { id:'__auto__', label:'auto', sub:'allen picks based on the task', isAuto: true },
  ...((window.MOCK && window.MOCK.REPOS) || []).map(r => ({ id: r.id, label: r.id, sub: `${r.branch} · ${r.tags.slice(0,2).join(', ')}` })),
];

function RepoPickerBtn({ repos, setRepos }) {
  const [open, setOpen] = nUseState(false);
  const [q, setQ] = nUseState('');
  const ref = React.useRef(null);
  nUseEffect(() => {
    if (!open) return;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const isAuto = repos.length === 1 && repos[0] === '__auto__';
  const label = isAuto
    ? 'auto'
    : repos.length === 0
      ? 'pick repo'
      : repos.length === 1
        ? repos[0]
        : `${repos.length} repos`;

  const toggle = (id) => {
    if (id === '__auto__') {
      setRepos(['__auto__']);
      setOpen(false);
      return;
    }
    setRepos(prev => {
      const next = prev.filter(r => r !== '__auto__'); // selecting a real repo turns off auto
      if (next.includes(id)) return next.filter(r => r !== id);
      return [...next, id];
    });
  };

  const filtered = REPO_LIST.filter(r => !q || r.label.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="cmp-pick" ref={ref}>
      <button className={`cmp-pill ${open?'open':''} ${isAuto?'auto':''}`} onClick={()=>setOpen(o=>!o)} title="pick repo(s)">
        <Icons.repo size={11}/>
        <span className="cmp-val">{label}</span>
        <Icons.chevD size={11}/>
      </button>
      {open && (
        <div className="cmp-pop above wide">
          <div className="cmp-search">
            <Icons.search size={11}/>
            <input autoFocus placeholder="search repos…" value={q} onChange={e=>setQ(e.target.value)}/>
          </div>
          <div className="cmp-pop-body">
            {filtered.map(r => {
              const isSel = repos.includes(r.id);
              return (
                <button
                  key={r.id}
                  className={`cmp-opt repo ${isSel?'active':''} ${r.isAuto?'auto':''}`}
                  onClick={()=>toggle(r.id)}>
                  <span className="cmp-cb">{isSel ? '✓' : r.isAuto ? '✦' : ''}</span>
                  <span className="cmp-opt-body">
                    <span className="cmp-opt-l">{r.label}</span>
                    <span className="cmp-opt-s">{r.sub}</span>
                  </span>
                </button>
              );
            })}
            {filtered.length === 0 && <div className="dd-empty">no matches</div>}
          </div>
          {!isAuto && repos.length > 0 && (
            <div className="cmp-pop-foot">
              <span className="muted">{repos.length} selected</span>
              <button className="cmp-link" onClick={()=>{ setRepos(['__auto__']); setOpen(false); }}>reset to auto</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AgentPickerBtn({ agent, setAgent }) {
  const [open, setOpen] = nUseState(false);
  const ref = React.useRef(null);
  nUseEffect(() => {
    if (!open) return;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const opts = [
    { id:'assistant', label:'Assistant', sub:'general purpose' },
    { id:'planner',   label:'Planner',   sub:'PRD + HLA only' },
    { id:'reviewer',  label:'Reviewer',  sub:'review existing PR' },
  ];
  const cur = opts.find(o => o.id === agent) || opts[0];

  return (
    <div className="cmp-pick agent" ref={ref}>
      <button className={`cmp-pill ${open?'open':''}`} onClick={()=>setOpen(o=>!o)}>
        <Icons.user size={11}/>
        <span className="cmp-val">{cur.label}</span>
        <Icons.chevD size={11}/>
      </button>
      {open && (
        <div className="cmp-pop above">
          {opts.map(o => (
            <button
              key={o.id}
              className={`cmp-opt ${agent === o.id ? 'active' : ''}`}
              onClick={()=>{ setAgent(o.id); setOpen(false); }}>
              <span className="cmp-opt-body">
                <span className="cmp-opt-l">{o.label}</span>
                <span className="cmp-opt-s">{o.sub}</span>
              </span>
              {agent === o.id && <Icons.check size={11}/>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Composer({ onDispatch, compact }) {
  const [v, setV] = nUseState('');
  const [model, setModel] = nUseState('gpt-5.5');
  const [thinking, setThinking] = nUseState('high');
  const [repos, setRepos] = nUseState(['__auto__']);
  const [agent, setAgent] = nUseState('assistant');

  const send = () => { if (v.trim()) { onDispatch(v); setV(''); } };

  return (
    <div className={`composer v2 ${compact?'compact':''}`}>
      <textarea
        placeholder="message allen…"
        value={v}
        onChange={e => setV(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }}}
      />
      <div className="composer-foot">
        <ComposerControls
          model={model} setModel={setModel}
          thinking={thinking} setThinking={setThinking}
          repos={repos} setRepos={setRepos}
          agent={agent} setAgent={setAgent}
        />
        <div className="cf-spacer"/>
        <span className="cf-hint">shift+enter for new line</span>
        <button className={`cmp-send ${v.trim()?'on':''}`} onClick={send} title="send"><Icons.send size={13}/></button>
      </div>
    </div>
  );
}

// ===== INBOX =====
function InboxPage({ openTask }) {
  const [filter, setFilter] = nUseState('all');
  const items = INBOX_FIXTURES.filter(i => filter === 'all' || i.kind === filter);
  const groups = {
    high: items.filter(i => i.urgency === 'high'),
    med: items.filter(i => i.urgency === 'med'),
    low: items.filter(i => i.urgency === 'low'),
  };
  return (
    <div className="content scroll-hide" data-screen-label="inbox">
      <div className="page-head">
        <h1>inbox</h1>
        <p className="sub">{INBOX_FIXTURES.length} things waiting on you</p>
      </div>
      <div className="filter-row">
        {['all','gate','review','question','blocked','mention'].map(k => (
          <button key={k} className={`fchip ${filter===k?'active':''}`} onClick={()=>setFilter(k)}>{k}</button>
        ))}
      </div>
      {Object.entries(groups).filter(([_,arr])=>arr.length>0).map(([k, arr]) => (
        <section key={k} className="ib-grp">
          <h4 className="grp-h">{k === 'high' ? 'urgent' : k === 'med' ? 'today' : 'fyi'} <span className="ct">{arr.length}</span></h4>
          <div className="ib-list">
            {arr.map(it => (
              <button key={it.id} className="ib-row" onClick={()=>openTask(it.task)}>
                <span className={`ib-kind ${it.kind}`}>{it.kind}</span>
                <div className="ib-body">
                  <div className="ib-title">{it.title}</div>
                  <div className="ib-sub">{it.sub}</div>
                </div>
                <span className="ib-age">{it.age}</span>
                <div className="ib-acts">
                  <button className="btn sm" onClick={(e)=>{e.stopPropagation(); openTask(it.task);}}>open</button>
                </div>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// ===== THREADS =====
function ThreadsPage({ openTask }) {
  const [q, setQ] = nUseState('');
  const [tab, setTab] = nUseState('ongoing');

  const ONGOING = ['implementing','planning','testing','blocked','waiting','review','queued'];
  const RECENT  = ['merged','failed'];                   // recently finished — last 7 days
  // History = everything else (archived + older completed)

  const matchQ = (t) => !q || t.title.toLowerCase().includes(q.toLowerCase()) || t.ticket.toLowerCase().includes(q.toLowerCase());

  const ongoing = THREAD_FIXTURES.filter(t => ONGOING.includes(t.status)).filter(matchQ);
  const recent  = THREAD_FIXTURES.filter(t => RECENT.includes(t.status)).filter(matchQ);
  const history = THREAD_FIXTURES.filter(t => !ONGOING.includes(t.status) && !RECENT.includes(t.status)).filter(matchQ);
  // history fallback — if nothing's archived, treat older 'merged' as history too
  const showHistory = history.length === 0 ? recent.slice(2) : history;

  const TABS = [
    { k:'ongoing',  l:'ongoing',           ct: ongoing.length },
    { k:'recent',   l:'recently completed', ct: recent.length },
    { k:'history',  l:'history',           ct: showHistory.length },
  ];

  const items = tab === 'ongoing' ? ongoing : tab === 'recent' ? recent : showHistory;

  return (
    <div className="content scroll-hide" data-screen-label="threads">
      <div className="page-head">
        <div className="ph-row">
          <div>
            <h1>threads</h1>
            <p className="sub">every conversation with allen, with what came of it</p>
          </div>
        </div>
        <nav className="topfilter-tabs" style={{marginTop:14}}>
          {TABS.map(t => (
            <button key={t.k} className={`tft ${tab===t.k?'active':''}`} onClick={()=>setTab(t.k)}>
              {t.l} <span className="tft-ct">{t.ct}</span>
            </button>
          ))}
        </nav>
      </div>
      <div className="th-search">
        <input placeholder="search threads / tickets…" value={q} onChange={e=>setQ(e.target.value)}/>
      </div>
      <div className="th-list">
        {items.length === 0 && <div className="task-empty">no threads here</div>}
        {items.map(t => (
          <button key={t.id} className="th-row" onClick={()=>openTask(t.id)}>
            <div className="r-refs">
              <span className="r-ref linear">{t.ticket}</span>
              {t.pr && <span className="r-ref gh">{t.pr}</span>}
            </div>
            <div className="th-body">
              <div className="th-title">{t.title}</div>
              <div className="th-sub">{t.sub} · {t.repo} · {t.when}</div>
            </div>
            <ProgBar v={t.progress}/>
            <StatusPill s={t.status}/>
          </button>
        ))}
      </div>
    </div>
  );
}

// ===== TASK PAGE — chat as the primary surface =====
function TaskPage({ taskId, setRoute, openTask }) {
  const t = TASK_FIXTURES[taskId] || TASK_FIXTURES['t-1453'];
  const [reply, setReply] = nUseState('');
  const [railOpen, setRailOpen] = nUseState(true);
  const [model, setModel] = nUseState('gpt-5.5');
  const [thinking, setThinking] = nUseState('high');
  const [repos, setRepos] = nUseState(t.repo ? [t.repo] : ['__auto__']);
  const [agent, setAgent] = nUseState('assistant');

  const stepsDone = t.steps.filter(s => s.state === 'ok').length;
  const stepsTotal = t.steps.length;

  // Build an enriched message stream that interleaves chat + system events + inline cards
  const stream = nUseMemo(() => buildStream(t), [t]);

  return (
    <div className={`chat-page ${railOpen?'rail-open':'rail-closed'}`} data-screen-label="task">
      <main className="chat-main">
        <header className="chat-head">
          <div className="ch-bc">
            <button className="link" onClick={()=>setRoute('mywork')}>← my work</button>
            <span className="bc-tk">{t.ticket}</span>
            <span className="bc-d">·</span>
            <span className="bc-repo">{t.repo}</span>
          </div>
          <h1 className="chat-title">{t.title}</h1>
          <div className="ch-meta">
            <StatusPill s={t.status}/>
            <span className="ch-meta-item">{t.workflow}</span>
            <span className="ch-meta-item">${t.cost.toFixed(2)}</span>
            <span className="ch-meta-item">{stepsDone} of {stepsTotal} done</span>
            {!railOpen && (
              <button className="ch-rail-toggle" onClick={()=>setRailOpen(true)} title="Show details">
                details →
              </button>
            )}
          </div>
        </header>

        <div className="chat-stream">
          {stream.map((m, i) => <StreamItem key={i} m={m} t={t}/>)}
        </div>

        <div className="chat-composer-wrap">
          <div className="chat-composer">
            <textarea
              placeholder="message allen…"
              value={reply}
              onChange={e=>setReply(e.target.value)}
              rows={1}
              onInput={e => { e.target.style.height='auto'; e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px'; }}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); setReply(''); }}}
            />
            <div className="cc-foot">
              <ComposerControls
                model={model} setModel={setModel}
                thinking={thinking} setThinking={setThinking}
                repos={repos} setRepos={setRepos}
                agent={agent} setAgent={setAgent}
              />
              <div className="cf-spacer"/>
              <span className="cf-hint">shift+enter for new line</span>
              <button className={`cmp-send ${reply.trim()?'on':''}`} onClick={()=>setReply('')} title="send"><Icons.send size={13}/></button>
            </div>
          </div>
        </div>
      </main>

      {railOpen && (
        <aside className="chat-rail">
          <div className="cr-head">
            <h5>this task</h5>
            <button className="cr-close" onClick={()=>setRailOpen(false)} title="Hide">✕</button>
          </div>

          <section className="cr-progress">
            <div className="cr-prog-row"><span>progress</span><span className="mono">{t.progress}%</span></div>
            <ProgBar v={t.progress}/>
            <div className="cr-prog-row sub"><span>eta</span><span className="mono">{t.eta}</span></div>
          </section>

          <section className="cr-section">
            <h6>references</h6>
            <a className="cr-ref" href="#">
              <span className="cr-ref-ic linear">L</span>
              <span className="cr-ref-body">
                <span className="cr-ref-id">{t.ticket}</span>
                <span className="cr-ref-sub">linear · in progress</span>
              </span>
            </a>
            {t.pr && (
              <a className="cr-ref" href="#">
                <span className="cr-ref-ic gh">⌥</span>
                <span className="cr-ref-body">
                  <span className="cr-ref-id">{t.pr.num} <span className={`cr-ref-tag ${t.pr.state}`}>{t.pr.state}</span></span>
                  <span className="cr-ref-sub">{t.pr.files} files · +{t.pr.plus}/−{t.pr.minus}</span>
                </span>
              </a>
            )}
            <a className="cr-ref" href="#">
              <span className="cr-ref-ic repo">⎇</span>
              <span className="cr-ref-body">
                <span className="cr-ref-id">{t.branch === '—' ? 'no branch yet' : t.branch}</span>
                <span className="cr-ref-sub">{t.repo}</span>
              </span>
            </a>
          </section>

          <section className="cr-section">
            <h6>steps <span className="cr-ct">{stepsDone}/{stepsTotal}</span></h6>
            <div className="cr-steps">
              {t.steps.map((s) => (
                <div key={s.id} className={`step ${s.state}`}>
                  <div className="step-dot">
                    {s.state === 'ok' && '✓'}
                    {s.state === 'run' && <span className="spin">●</span>}
                    {s.state === 'wait' && '○'}
                    {s.state === 'wait-you' && '?'}
                    {s.state === 'fail' && '✕'}
                  </div>
                  <div className="step-body">
                    <div className="step-name">{s.name}</div>
                    <div className="step-meta">{s.actor} · {s.dur}{s.cost ? ` · $${s.cost.toFixed(2)}` : ''}</div>
                    {s.sub && <div className="step-sub">{s.sub}</div>}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="cr-section">
            <h6>actions</h6>
            <div className="cr-acts">
              <button className="btn ghost sm">pause</button>
              <button className="btn ghost sm">archive</button>
              {t.status === 'waiting' && <button className="btn primary sm">resolve →</button>}
              {t.pr && t.status === 'implementing' && <button className="btn primary sm">review PR</button>}
            </div>
          </section>
        </aside>
      )}
    </div>
  );
}

// Build a chat stream that interleaves system events + chat + inline plan/code/PR cards
function buildStream(t) {
  const out = [];
  // first message — always the original ask
  out.push({ kind:'msg', who:'you', ts: t.chat[0].ts, text: t.chat[0].text, blocks: t.chat[0].blocks });
  out.push({ kind:'system', text: `Allen routed this to ${t.workflow} on ${t.repo}.`, ts: t.chat[0].ts });

  // Pull selected chat lines, interleave plan/code/PR cards based on step states
  const planDone = t.steps.find(s=>s.id==='hla')?.state === 'ok';
  const implRunning = t.steps.find(s=>s.id==='impl')?.state === 'run';
  const implDone = t.steps.find(s=>s.id==='impl')?.state === 'ok';

  // chat msgs after the first
  for (let i = 1; i < t.chat.length; i++) {
    const m = t.chat[i];
    out.push({ kind:'msg', who:m.who, ts:m.ts, text:m.text, blocks:m.blocks });
    // after PRD/HLA are mentioned, drop the plan card
    if (planDone && m.text && m.text.includes('HLA proposes')) {
      out.push({ kind:'plan-card', ts:m.ts });
    }
    // after impl starts streaming, drop the code card
    if ((implRunning || implDone) && m.text && m.text.includes('Implementation in progress')) {
      out.push({ kind:'code-card', ts:m.ts });
    }
  }

  // PR card if exists
  if (t.pr) {
    out.push({ kind:'pr-card', ts: t.chat[t.chat.length-1].ts });
  }

  // ticket bridge: if waiting on user, drop a question card
  const waitYou = t.steps.find(s => s.state === 'wait-you');
  if (waitYou) {
    out.push({ kind:'gate-card', ts:'just now', step: waitYou });
  }

  return out;
}

function StreamItem({ m, t }) {
  if (m.kind === 'system') {
    return (
      <div className="ch-sys">
        <span className="ch-sys-line"></span>
        <span className="ch-sys-text">{m.text}</span>
        <span className="ch-sys-line"></span>
      </div>
    );
  }
  if (m.kind === 'msg') {
    return (
      <div className={`ch-msg ${m.who}`}>
        <div className="ch-avatar">{m.who === 'you' ? 'M' : m.who === 'allen' ? 'a' : '?'}</div>
        <div className="ch-msg-body">
          <div className="ch-msg-head">
            <span className="ch-msg-who">{m.who === 'you' ? 'manish' : m.who}</span>
            <span className="ch-msg-ts">{m.ts}</span>
          </div>
          <div className="ch-msg-text">
            {m.blocks ? renderBlocks(m.blocks) : m.text}
          </div>
        </div>
      </div>
    );
  }
  if (m.kind === 'plan-card') {
    return (
      <div className="ch-msg allen">
        <div className="ch-avatar">a</div>
        <div className="ch-msg-body">
          <div className="ch-card plan-card">
            <div className="ch-card-h">
              <span className="cc-tag">plan</span>
              <span className="cc-title">implementation plan ready</span>
              <button className="cc-collapse">expand</button>
            </div>
            <div className="ch-card-b">
              <p className="cc-summary">vendor-scoped circuit breaker, 13 files affected, 4 new tests. PRD + HLA both written.</p>
              <ul className="cc-list">
                <li>add <code>VendorScopedCircuitBreaker</code> with AbortController</li>
                <li>map <code>CART_GATED_PRICE</code> → <code>GATED</code> ChainState</li>
                <li>cache fallback with TTL</li>
                <li>integration test for gated state</li>
              </ul>
              <div className="cc-acts">
                <button className="btn primary sm">approve plan</button>
                <button className="btn sm">request changes</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (m.kind === 'code-card') {
    return (
      <div className="ch-msg allen">
        <div className="ch-avatar">a</div>
        <div className="ch-msg-body">
          <div className="ch-card code-card">
            <div className="ch-card-h">
              <span className="cc-tag impl">implementation</span>
              <span className="cc-title">7 of 13 files modified</span>
              <span className="cc-pct"><span className="dot pulse accent"></span> live</span>
            </div>
            <div className="ch-card-b">
              <div className="cc-files">
                <div className="cc-file"><span className="cf-n">pricing-update/handlers/amazon.ts</span><span className="cf-p">+62</span><span className="cf-m">−18</span></div>
                <div className="cc-file"><span className="cf-n">pricing-update/circuit-breaker.ts</span><span className="cf-new">new</span><span className="cf-p">+184</span></div>
                <div className="cc-file"><span className="cf-n">pricing-update/types/chain.ts</span><span className="cf-p">+8</span><span className="cf-m">−2</span></div>
                <div className="cc-file"><span className="cf-n">tests/pricing-update/gated.spec.ts</span><span className="cf-new">new</span><span className="cf-p">+96</span></div>
                <div className="cc-file muted"><span className="cf-n">… 9 more files in progress</span></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (m.kind === 'pr-card') {
    return (
      <div className="ch-msg allen">
        <div className="ch-avatar">a</div>
        <div className="ch-msg-body">
          <div className="ch-card pr-card-inline">
            <div className="ch-card-h">
              <span className="cc-tag pr">pull request</span>
              <span className="cc-title">{t.pr.num} {t.pr.state}</span>
            </div>
            <div className="ch-card-b">
              <div className="cc-pr-meta">{t.pr.files} files · <span className="pos">+{t.pr.plus}</span> / <span className="neg">−{t.pr.minus}</span> · branch <code>{t.branch}</code></div>
              <div className="cc-acts">
                <button className="btn primary sm">review on github</button>
                <button className="btn sm">approve & merge</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (m.kind === 'gate-card') {
    return (
      <div className="ch-msg allen">
        <div className="ch-avatar">a</div>
        <div className="ch-msg-body">
          <div className="ch-card gate-card">
            <div className="ch-card-h">
              <span className="cc-tag waiting">waiting on you</span>
              <span className="cc-title">{m.step.name}</span>
            </div>
            <div className="ch-card-b">
              <p className="cc-summary">{m.step.sub || 'allen needs your input to proceed.'}</p>
              <div className="cc-acts">
                <button className="btn primary sm">answer →</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
  return null;
}

// ===== ORG SETTINGS — 2-pane shell, scalable left rail =====
// Left rail = scrollable category list (no horizontal-tab scaling problem at 6+ items).
// Categories: workflows · teams & agents · repos · workspaces · integrations · members.
// Billing removed — not configuration of the org's machinery.
function OrgSettingsPage({ setRoute }) {
  const [section, setSection] = nUseState('teams-agents');
  const SECTIONS = [
    { k: 'workflows',    l: 'workflows',     desc: 'how work flows through agents',          ct: window.MOCK.WORKFLOWS.length },
    { k: 'teams-agents', l: 'teams & agents', desc: 'departments and the agents that live there', ct: window.MOCK.TEAMS.length },
    { k: 'repos',        l: 'repos',         desc: 'connected source repositories',          ct: window.MOCK.REPOS.length },
    { k: 'workspaces',   l: 'workspaces',    desc: 'live cloud dev environments',            ct: window.MOCK.WORKSPACES.length },
    { k: 'integrations', l: 'integrations',  desc: 'linear · github · slack · …',            ct: 3 },
    { k: 'members',      l: 'members',       desc: 'people in this org',                     ct: 23 },
  ];

  return (
    <div className="org-shell" data-screen-label="org-settings">
      <aside className="org-rail scroll-hide">
        <div className="org-rail-head">
          <h1 className="org-rail-title">library</h1>
          <p className="org-rail-sub">workflows, agents, and integrations the org uses</p>
        </div>
        <nav className="org-rail-list">
          {SECTIONS.map(s => (
            <button
              key={s.k}
              className={`org-rail-item ${section===s.k?'active':''}`}
              onClick={()=>setSection(s.k)}>
              <span className="ori-l">{s.l}</span>
              <span className="ori-ct">{s.ct}</span>
              <span className="ori-d">{s.desc}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="org-pane scroll-hide">
        {section === 'workflows'    && <WorkflowsPage embed/>}
        {section === 'teams-agents' && <TeamsAgentsPage/>}
        {section === 'repos'        && <ReposPage embed/>}
        {section === 'workspaces'   && <WorkspacesPage embed/>}
        {section === 'integrations' && <IntegrationsStub/>}
        {section === 'members'      && <MembersStub/>}
      </main>
    </div>
  );
}

function IntegrationsStub() {
  const items = [
    { nm:'Linear', sub:'tickets sync', state:'connected' },
    { nm:'GitHub', sub:'repos · PRs · webhooks', state:'connected' },
    { nm:'Slack',  sub:'notifications · @allen mentions', state:'connected' },
  ];
  return (
    <div style={{padding:'24px 28px'}}>
      <div className="page-head"><h2>integrations</h2><p className="sub">3 connected · all healthy</p></div>
      <div className="pref-list" style={{maxWidth:720}}>
        {items.map(i => (
          <div key={i.nm} className="pref-row">
            <span className="pref-k">{i.nm}<div className="muted" style={{fontSize:11, marginTop:2, fontWeight:400}}>{i.sub}</div></span>
            <span className="pref-v"><span className="pill pill-merged">{i.state}</span></span>
          </div>
        ))}
      </div>
    </div>
  );
}
function MembersStub() {
  return (
    <div style={{padding:'24px 28px'}}>
      <div className="page-head"><h2>members</h2><p className="sub">23 members across 8 teams</p></div>
      <div className="task-empty">members directory · invite, role, team assignment.</div>
    </div>
  );
}

// ===== TEAMS & AGENTS — unified 2-pane =====
// Left = scrollable team list (with search). Right = selected team's detail + agents.
// Scales naturally to 50+ teams and 100+ agents per team.
function TeamsAgentsPage() {
  const TEAMS = window.MOCK.TEAMS;
  const TEAM_AGENTS = window.MOCK.TEAM_AGENTS || {};
  const [activeId, setActiveId] = nUseState(TEAMS[0]?.id);
  const [q, setQ] = nUseState('');
  const filtered = TEAMS.filter(t =>
    !q || t.name.toLowerCase().includes(q.toLowerCase()) || t.lead.toLowerCase().includes(q.toLowerCase())
  );
  const active = TEAMS.find(t => t.id === activeId) || TEAMS[0];
  const agents = TEAM_AGENTS[active.id] || [];

  const totalAgents = TEAMS.reduce((s, t) => s + t.members, 0);

  return (
    <div className="ta-shell">
      <aside className="ta-list scroll-hide">
        <div className="ta-list-head">
          <div className="ta-list-meta">
            <span className="ta-h">teams</span>
            <span className="ta-h-ct">{TEAMS.length} · {totalAgents} agents</span>
          </div>
          <div className="ta-search">
            <Icons.search size={12}/>
            <input
              placeholder="search teams or leads…"
              value={q}
              onChange={e=>setQ(e.target.value)} />
          </div>
        </div>
        <div className="ta-list-body">
          {filtered.length === 0 && <div className="ta-empty">no teams match "{q}"</div>}
          {filtered.map(t => (
            <button
              key={t.id}
              className={`ta-row ${activeId===t.id?'active':''}`}
              onClick={()=>setActiveId(t.id)}>
              <div className="ta-row-h">
                <span className="ta-row-n">{t.name}</span>
                <span className="ta-row-c">{t.members}</span>
              </div>
              <div className="ta-row-s">{t.lead}</div>
            </button>
          ))}
        </div>
        <div className="ta-list-foot">
          <button className="btn sm"><Icons.plus size={11}/> new team</button>
        </div>
      </aside>

      <section className="ta-detail scroll-hide">
        <header className="ta-d-head">
          <div>
            <h2 className="ta-d-title">{active.name}</h2>
            <p className="ta-d-sub">{active.desc}</p>
          </div>
          <div className="ta-d-acts">
            <button className="btn sm"><Icons.edit size={11}/> edit</button>
            <button className="btn primary sm"><Icons.plus size={11}/> add agent</button>
          </div>
        </header>

        <div className="ta-d-meta">
          <div className="ta-d-meta-i"><span className="lab">lead</span><span className="val">{active.lead}</span></div>
          <div className="ta-d-meta-i"><span className="lab">agents</span><span className="val mono">{active.members}</span></div>
          <div className="ta-d-meta-i"><span className="lab">id</span><span className="val mono">{active.id}</span></div>
        </div>

        <div className="ta-d-section">
          <div className="ta-d-section-h">
            <h3>agents <span className="ta-ct">{agents.length}</span></h3>
            <div className="row" style={{gap:6}}>
              <input className="ta-mini-search" placeholder="filter…" />
              <button className="btn ghost sm"><Icons.refresh size={11}/></button>
            </div>
          </div>
          <div className="ta-agent-list">
            {agents.map((nm, i) => (
              <div key={i} className="ta-agent">
                <div className="ta-agent-ic"><Icons.agents size={12}/></div>
                <div className="ta-agent-body">
                  <div className="ta-agent-n">{nm}</div>
                  <div className="ta-agent-m mono">{['sonnet','sonnet','opus','sonnet','haiku'][i % 5]} · {Math.floor(2 + (i*7) % 50)} runs · ${(0.04 + (i*0.013) % 1.4).toFixed(2)} avg</div>
                </div>
                <span className={`pill ${i % 7 === 0 ? 'pill-waiting' : 'pill-merged'}`}>{i % 7 === 0 ? 'idle' : 'active'}</span>
                <button className="btn ghost sm"><Icons.more size={12}/></button>
              </div>
            ))}
            {agents.length === 0 && <div className="task-empty">no agents in this team yet</div>}
          </div>
        </div>
      </section>
    </div>
  );
}

// ===== PERSONAL SETTINGS — preferences =====
function SettingsPage({ setRoute, theme, setTheme }) {
  const [tab, setTab] = nUseState('account');
  return (
    <div className="content scroll-hide" data-screen-label="settings">
      <div className="page-head">
        <h1>settings</h1>
        <p className="sub">your preferences</p>
        <nav className="topfilter-tabs">
          {[['account','account'],['appearance','appearance'],['shortcuts','shortcuts'],['notifications','notifications']].map(([k,l]) => (
            <button key={k} className={`tft ${tab===k?'active':''}`} onClick={()=>setTab(k)}>{l}</button>
          ))}
        </nav>
      </div>
      <div className="settings-body" style={{padding:'20px 32px', maxWidth: 720}}>
        {tab === 'account' && (
          <div className="pref-list">
            <div className="pref-row"><span className="pref-k">name</span><span className="pref-v">Manish</span></div>
            <div className="pref-row"><span className="pref-k">email</span><span className="pref-v">manish@inomy.shop</span></div>
            <div className="pref-row"><span className="pref-k">role</span><span className="pref-v">admin</span></div>
            <div className="pref-row"><span className="pref-k">workspaces</span><span className="pref-v">Allen, Inomy</span></div>
          </div>
        )}
        {tab === 'appearance' && (
          <div className="pref-list">
            <div className="pref-row">
              <span className="pref-k">theme</span>
              <span className="pref-v">
                <button className={`pref-seg ${theme==='light'?'active':''}`} onClick={()=>setTheme&&setTheme('light')}>light</button>
                <button className={`pref-seg ${theme==='dark'?'active':''}`} onClick={()=>setTheme&&setTheme('dark')}>dark</button>
                <button className="pref-seg">system</button>
              </span>
            </div>
            <div className="pref-row"><span className="pref-k">density</span><span className="pref-v">comfortable · compact</span></div>
            <div className="pref-row"><span className="pref-k">sidebar</span><span className="pref-v">full · icons · hidden</span></div>
          </div>
        )}
        {tab === 'shortcuts' && (
          <div className="pref-list">
            <div className="pref-row"><span className="pref-k">⌘ K</span><span className="pref-v">command palette</span></div>
            <div className="pref-row"><span className="pref-k">⌘ N</span><span className="pref-v">new chat</span></div>
            <div className="pref-row"><span className="pref-k">⌘ /</span><span className="pref-v">focus composer</span></div>
            <div className="pref-row"><span className="pref-k">G then I</span><span className="pref-v">go to inbox</span></div>
            <div className="pref-row"><span className="pref-k">G then M</span><span className="pref-v">go to my work</span></div>
          </div>
        )}
        {tab === 'notifications' && (
          <div className="pref-list">
            <div className="pref-row"><span className="pref-k">when allen needs me</span><span className="pref-v">in-app · slack · email</span></div>
            <div className="pref-row"><span className="pref-k">when a PR is ready to review</span><span className="pref-v">in-app · slack</span></div>
            <div className="pref-row"><span className="pref-k">when my run finishes</span><span className="pref-v">in-app</span></div>
            <div className="pref-row"><span className="pref-k">daily digest</span><span className="pref-v">9:00 am</span></div>
          </div>
        )}
      </div>
    </div>
  );
}

// ===== ACTIVITY (lead view) =====
// ===== ACTIVITY — what's happening right now (running, recent, queued, in-motion threads) =====
function ActivityPage({ execs, openTask }) {
  const running = execs.filter(e => e.status === 'running');
  const recent = execs.slice(0, 8);

  return (
    <div className="content scroll-hide" data-screen-label="activity">
      <div className="page-head">
        <div className="ph-row">
          <div>
            <h1>activity</h1>
            <p className="sub">what's running, queued, and just finished across the org</p>
          </div>
          <div className="row" style={{gap:6}}>
            <button className="btn"><Icons.refresh size={12}/></button>
          </div>
        </div>
      </div>

      <div className="an-body">
        <section className="an-section">
          <header className="an-h">
            <h3><Icons.play size={12}/> running now <span className="an-h-ct">{running.length}</span></h3>
            <a className="an-h-link" onClick={(e)=>e.preventDefault()} href="#">view all →</a>
          </header>
          {running.length === 0 ? (
            <div className="an-empty">no executions running.</div>
          ) : (
            <div className="an-runlist">
              {running.map(e => (
                <div key={e.id} className="an-run">
                  <span className="mono an-run-id">{e.id.slice(0,8)}</span>
                  <span className="an-run-wf">{e.wf}</span>
                  <StatusPill s="implementing"/>
                  <span className="mono">{e.dur.toFixed(1)}s</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="an-section">
          <header className="an-h">
            <h3><Icons.exec size={12}/> recent executions</h3>
            <a className="an-h-link" onClick={(e)=>e.preventDefault()} href="#">view all →</a>
          </header>
          <div className="an-runlist">
            {recent.map(e => (
              <div key={e.id} className="an-run">
                <span className="mono an-run-id">{e.id.slice(0,8)}</span>
                <span className="an-run-wf">{e.wf}</span>
                <span className={`pill ${e.status === 'completed' ? 'pill-merged' : e.status === 'running' ? 'pill-impl' : 'pill-queued'}`}>{e.status === 'completed' ? 'completed' : e.status === 'running' ? 'running' : 'queued'}</span>
                <span className="mono">{e.dur > 0 ? `${e.dur.toFixed(1)}s` : '—'}</span>
                <span className="muted mono">1d ago</span>
              </div>
            ))}
          </div>
        </section>

        <section className="an-section">
          <header className="an-h">
            <h3><Icons.flow size={12}/> tasks in motion</h3>
          </header>
          <div className="th-list" style={{padding:0}}>
            {THREAD_FIXTURES.filter(t=>['implementing','planning','testing','blocked','waiting'].includes(t.status)).map(t => (
              <button key={t.id} className="th-row" onClick={()=>openTask(t.id)}>
                <div className="r-refs">
                  <span className="r-ref linear">{t.ticket}</span>
                  {t.pr && <span className="r-ref gh">{t.pr}</span>}
                </div>
                <div className="th-body">
                  <div className="th-title">{t.title}</div>
                  <div className="th-sub">{t.sub} · {t.repo} · {t.when}</div>
                </div>
                <ProgBar v={t.progress}/>
                <StatusPill s={t.status}/>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

// ===== LEARNINGS — captured insights, preferences, mistakes =====
const LEARNINGS = [
  { id:'l-1', type:'preference', scope:'global', conf:0.95,
    text: 'When raising PRs for es-data-pipeline pricing-update fixes, target the development branch unless the user explicitly specifies another base branch.',
    sources:['chat','auto-extracted'], confirms:3, contradictions:1, status:'active', source:'manual', age:'2d ago' },
  { id:'l-2', type:'preference', scope:'global', conf:0.95,
    text: 'For Category Health matrix designs, use leaf categories as rows, group only by L1 sticky bands, sort leaves within each L1 by largest absolute loss first, allow L1 bands to collapse into aggregate rows, avoid L2 nesting, scope v1 to vendors only, and render unknown/non-applicable/never-scraped cells as 0 for now.',
    sources:['chat','auto-extracted'], confirms:3, contradictions:1, status:'active', source:'manual', age:'3d ago' },
  { id:'l-3', type:'preference', scope:'global', conf:0.95,
    text: "When creating tickets for scraper stuck-job fixes, make query-level timeout/cancellation the primary requirement: processQuery that exceeds timeout must abort its internal work and subprocesses so no further work continues after the query is dropped; logging improvements are secondary.",
    sources:['chat','auto-extracted'], confirms:3, contradictions:0, status:'active', source:'manual', age:'4d ago' },
  { id:'l-4', type:'mistake', scope:'global', conf:0.95,
    text: 'When investigating Allen chat context bugs, separate cross-chat ask_user routing from artifact root drift; direct agent runs can incorrectly inherit a parallel chat because no explicit context is passed and legacy getAnyActiveSession fallback attaches them to whichever chat is active.',
    sources:['chat','auto-extracted'], confirms:3, contradictions:0, status:'active', source:'manual', age:'4d ago' },
  { id:'l-5', type:'preference', scope:'global', conf:0.95,
    text: 'For Allen logging work, do not change existing agent logs, chat logs, execution logs, or any MongoDB-persisted log behavior. Only add non-persistent server/service/API logs, and optionally ship Allen service logs to CloudWatch from deployment when enabled.',
    sources:['chat','auto-extracted'], confirms:3, contradictions:0, status:'active', source:'manual', age:'6d ago' },
  { id:'l-6', type:'decision', scope:'team:pipeline', conf:0.88,
    text: "Adopt Tavily as the primary web search provider for spec-sheet enrichment, with Exa as discovery/fallback companion. Don't roll a custom Google SERP scraper.",
    sources:['chat'], confirms:2, contradictions:0, status:'active', source:'auto', age:'8m ago' },
  { id:'l-7', type:'mistake', scope:'global', conf:0.78,
    text: 'Avoid amending commits that have already been pushed to a remote branch shared with reviewers — create a follow-up commit instead.',
    sources:['code-review'], confirms:5, contradictions:0, status:'active', source:'auto', age:'1w ago' },
];

function LearningsPage() {
  const [tab, setTab] = nUseState('learnings');
  const [scope, setScope] = nUseState('all');
  const [type, setType] = nUseState('all');
  const [status, setStatus] = nUseState('active');
  const [q, setQ] = nUseState('');

  const filtered = LEARNINGS.filter(l => {
    if (scope !== 'all' && l.scope !== scope) return false;
    if (type !== 'all' && l.type !== type) return false;
    if (status !== 'all' && l.status !== status) return false;
    if (q && !l.text.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="content scroll-hide" data-screen-label="learnings">
      <div className="page-head">
        <div className="ph-row">
          <div>
            <h1>learnings</h1>
            <p className="sub">captured preferences, decisions, and mistakes — fed back into agent runs</p>
          </div>
          <div className="row" style={{gap:6}}>
            <button className="btn"><Icons.refresh size={12}/></button>
            <button className="btn primary sm"><Icons.plus size={12}/> add learning</button>
          </div>
        </div>
        <nav className="topfilter-tabs" style={{marginTop:14}}>
          <button className={`tft ${tab==='learnings'?'active':''}`} onClick={()=>setTab('learnings')}>learnings</button>
          <button className={`tft ${tab==='evolution'?'active':''}`} onClick={()=>setTab('evolution')}>evolution</button>
        </nav>
      </div>

      {tab === 'learnings' && (
        <div className="lrn-body">
          <div className="lrn-filters">
            <select className="lrn-select" value={scope} onChange={e=>setScope(e.target.value)}>
              <option value="all">All scopes</option>
              <option value="global">Global</option>
              <option value="team:pipeline">Team: pipeline</option>
              <option value="team:eng">Team: eng</option>
            </select>
            <select className="lrn-select" value={type} onChange={e=>setType(e.target.value)}>
              <option value="all">All types</option>
              <option value="preference">Preference</option>
              <option value="decision">Decision</option>
              <option value="mistake">Mistake</option>
            </select>
            <select className="lrn-select" value={status} onChange={e=>setStatus(e.target.value)}>
              <option value="active">Active</option>
              <option value="draft">Draft</option>
              <option value="archived">Archived</option>
              <option value="all">All</option>
            </select>
            <div className="lrn-search">
              <Icons.search size={12}/>
              <input placeholder="search learnings…" value={q} onChange={e=>setQ(e.target.value)}/>
            </div>
            <div style={{flex:1}}/>
            <span className="lrn-count">{filtered.length} of {LEARNINGS.length}</span>
          </div>

          <div className="lrn-list">
            {filtered.map(l => (
              <article key={l.id} className="lrn-card">
                <header className="lrn-h">
                  <span className={`lrn-type ${l.type}`}>{l.type}</span>
                  <span className="lrn-scope">{l.scope}</span>
                  <div style={{flex:1}}/>
                  <div className="lrn-conf">
                    <div className="lrn-conf-bar"><i style={{width: (l.conf*100)+'%'}}/></div>
                    <span className="lrn-conf-v mono">{l.conf.toFixed(2)}</span>
                  </div>
                </header>
                <p className="lrn-text">{l.text}</p>
                <footer className="lrn-f">
                  <div className="lrn-tags">
                    {l.sources.map(s => <span key={s} className="lrn-tag">{s}</span>)}
                  </div>
                  <div className="lrn-meta">
                    <span>{l.source}</span>
                    <span><b>{l.confirms}</b> confirms</span>
                    <span><b>{l.contradictions}</b> contradictions</span>
                    <span className="muted">· {l.age}</span>
                  </div>
                  <div className="lrn-acts">
                    <button className="lrn-act" title="confirm"><Icons.check size={13}/></button>
                    <button className="lrn-act" title="reject"><Icons.x size={13}/></button>
                    <button className="lrn-act" title="edit"><Icons.edit size={13}/></button>
                    <button className="lrn-act" title="archive"><Icons.trash size={13}/></button>
                  </div>
                </footer>
              </article>
            ))}
            {filtered.length === 0 && <div className="task-empty">no learnings match those filters</div>}
          </div>
        </div>
      )}

      {tab === 'evolution' && (
        <div className="lrn-body">
          <div className="task-empty" style={{margin:'40px 32px'}}>
            evolution view — timeline of how learnings change as agents confirm or contradict them.
          </div>
        </div>
      )}
    </div>
  );
}

// ===== ANALYTICS — overview / workflows / agents / cost =====
function AnalyticsPage({ execs }) {
  const [tab, setTab] = nUseState('overview');
  const [range, setRange] = nUseState('24h');

  // synthesize KPIs (the live execs are sparse — use realistic totals)
  const totalExec = 714;
  const running = execs.filter(e => e.status === 'running').length;
  const completed = 316;
  const failed = 68;
  const totalCost = 1323.19;

  const avgByWorkflow = [
    { wf:'test-interior-designer', dur: 4188.9, runs: 1 },
    { wf:'chat:spawn_agent/vendor-rule-healer', dur: 4124.8, runs: 1 },
    { wf:'bug-investigate-and-fix', dur: 3341.7, runs: 1 },
    { wf:'chat:spawn_agent/vendor-rule-onboarder', dur: 1997.6, runs: 4 },
    { wf:'implement:spawn_agent/codebase-navigator', dur: 1711.0, runs: 2 },
    { wf:'feature-plan-and-implement', dur: 1442.3, runs: 9 },
  ];
  const costByWorkflow = [
    { wf:'chat:spawn_agent/classification-judge', cost: 584.62, runs: 151 },
    { wf:'chat:spawn_agent/vendor-rule-onboarder', cost: 141.24, runs: 6 },
    { wf:'chat:spawn_agent/scraped-data-validator', cost: 97.92, runs: 18 },
    { wf:'feature-plan-and-implement', cost: 84.10, runs: 9 },
    { wf:'resolve-pr-reviews', cost: 64.55, runs: 36 },
  ];
  const maxCost = costByWorkflow[0].cost;

  return (
    <div className="content scroll-hide" data-screen-label="analytics">
      <div className="page-head">
        <div className="ph-row">
          <div>
            <h1>analytics</h1>
            <p className="sub">cost, runtime, and run health across the org</p>
          </div>
          <div className="row" style={{gap:6}}>
            <select className="lrn-select" value={range} onChange={e=>setRange(e.target.value)} style={{minWidth:140}}>
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
            </select>
            <button className="btn"><Icons.refresh size={12}/></button>
          </div>
        </div>
        <nav className="topfilter-tabs" style={{marginTop:14}}>
          <button className={`tft ${tab==='overview'?'active':''}`} onClick={()=>setTab('overview')}>overview</button>
          <button className={`tft ${tab==='workflows'?'active':''}`} onClick={()=>setTab('workflows')}>workflows</button>
          <button className={`tft ${tab==='agents'?'active':''}`} onClick={()=>setTab('agents')}>agents</button>
          <button className={`tft ${tab==='cost'?'active':''}`} onClick={()=>setTab('cost')}>cost</button>
        </nav>
      </div>

      <div className="an-body">
        <div className="an-kpis">
          <KpiCard ic="exec"     lbl="total executions" v={totalExec.toLocaleString()} />
          <KpiCard ic="refresh"  lbl="running"          v={running} accent="info" />
          <KpiCard ic="check"    lbl="completed"        v={completed} accent="ok" />
          <KpiCard ic="x"        lbl="failed"           v={failed} accent="err" />
          <KpiCard ic="lightning" lbl="total cost (est.)" v={`$${totalCost.toFixed(2)}`} accent="warn" />
        </div>

        <div className="an-grid-2">
          <section className="an-section">
            <header className="an-h">
              <h3><Icons.refresh size={12}/> avg duration by workflow</h3>
            </header>
            <div className="an-rank">
              {avgByWorkflow.map(r => (
                <div key={r.wf} className="an-rank-row">
                  <span className="an-rank-n">{r.wf}</span>
                  <span className="mono">{r.dur.toFixed(1)}s</span>
                  <span className="muted mono">({r.runs} {r.runs===1?'run':'runs'})</span>
                </div>
              ))}
            </div>
          </section>
          <section className="an-section">
            <header className="an-h">
              <h3><Icons.lightning size={12}/> cost by workflow</h3>
            </header>
            <div className="an-rank">
              {costByWorkflow.map((r, i) => (
                <div key={r.wf} className="an-rank-row cost">
                  <span className="an-rank-i">{i+1}</span>
                  <span className="an-rank-n">
                    {r.wf}
                    <span className="an-rank-bar"><i style={{width: (r.cost/maxCost*100)+'%'}}/></span>
                  </span>
                  <span className="mono">${r.cost.toFixed(2)}</span>
                  <span className="muted mono">{r.runs} runs</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function KpiCard({ ic, lbl, v, accent }) {
  const I = Icons[ic] || Icons.exec;
  return (
    <div className={`an-kpi ${accent || ''}`}>
      <div className="an-kpi-ic"><I size={14}/></div>
      <div className="an-kpi-v">{v}</div>
      <div className="an-kpi-l">{lbl}</div>
    </div>
  );
}

window.MyWorkPage = MyWorkPage;
window.InboxPage = InboxPage;
window.ThreadsPage = ThreadsPage;
window.TaskPage = TaskPage;
window.SettingsPage = SettingsPage;
window.OrgSettingsPage = OrgSettingsPage;
window.LibraryPage = OrgSettingsPage;     // alias — same 2-pane shell, new label
window.TeamsAgentsPage = TeamsAgentsPage;
window.ActivityPage = ActivityPage;
window.AnalyticsPage = AnalyticsPage;
window.LearningsPage = LearningsPage;
window.StatusPill = StatusPill;
window.ProgBar = ProgBar;
