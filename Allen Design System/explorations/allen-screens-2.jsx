// Allen screens · part 2 — Tickets, PRs, Workspaces + their detail pages
(function () {
  const { AdIcon: Icon, AdStat: Stat, AdStatusBadge: StatusBadge, AdTab: Tab, AdBackLink: BackLink, AdSideField: SideField } = window;

  // ────────────────────────────────────────────────────────────
  // TICKETS
  // ────────────────────────────────────────────────────────────
  const TICKETS_BY_COL = {
    Backlog: [
    { id: "ENG-1405", proj: "Unified AI Shop…", title: "Fake Discount Detection and Removal", tags: [{ t: "ws:core-quality", k: "" }, { t: "area:pipeline", k: "area" }, { t: "roadmap:q2-2026", k: "roadmap" }], when: "7h ago" },
    { id: "ENG-1660", proj: "Pricing Health, …", title: "Brand Health: add canonical brand-list cleanup with auto/review consolidation flow", tags: [{ t: "type:improvement", k: "improvement" }, { t: "area:pipeline", k: "area" }, { t: "area:agent", k: "" }], when: "7h ago" },
    { id: "ENG-1714", proj: "Unified AI Shop…", title: "Email price alert", tags: [], when: "1d ago" },
    { id: "ENG-1701", proj: "Pricing Health…", title: "verify on sample products where errors were identified", tags: [{ t: "area:pipeline", k: "area" }], when: "4d ago" }],

    "In Progress": [
    { id: "ENG-1451", proj: "LLM Extraction", title: "Spec/field specific extraction capability.", tags: [{ t: "roadmap:q2-2026", k: "roadmap" }, { t: "daily", k: "daily" }, { t: "area:pipeline", k: "area" }], when: "5h ago", who: "M" },
    { id: "ENG-1615", proj: "Category Expans…", title: "pending testing post pr merge on top electronic categories.", tags: [{ t: "area:pipeline", k: "area" }, { t: "type:improvement", k: "improvement" }], when: "6h ago", who: "S" },
    { id: "ENG-1505", proj: "Series Extracti…", title: "GEPA Integration: Allen and ES Data Pipeline", tags: [{ t: "roadmap:q2-2026", k: "roadmap" }, { t: "type:feature", k: "feature" }, { t: "area:pipeline", k: "area" }], when: "7h ago", who: "A" }],

    "Dev Done": [
    { id: "ENG-1528", proj: "Unified AI Shop…", title: "UX-audit-new-ui", tags: [{ t: "website", k: "" }, { t: "ios app", k: "" }], when: "1d ago", who: "M" },
    { id: "ENG-1703", proj: "Allen", title: "Slack bot posts intermediate tool progress messages", tags: [{ t: "type:bug", k: "bug" }, { t: "area:agent", k: "" }], when: "2d ago", who: "A" },
    { id: "ENG-1278", proj: "Scraping Reliab…", title: "Pilot — Merging category structures for better search (example - cat_speakers)", tags: [{ t: "roadmap:q2-2026", k: "roadmap" }, { t: "daily", k: "daily" }, { t: "area:pipeline", k: "area" }], when: "4d ago", who: "M" }],

    Todo: [
    { id: "ENG-1204", proj: "Increase groupi…", title: "Variant IDs- Regenerate variant IDs", tags: [{ t: "roadmap:q2-2026", k: "roadmap" }, { t: "type:bug", k: "bug" }, { t: "area:pipeline", k: "area" }], when: "1d ago" },
    { id: "ENG-1700", proj: "Scraping Reliab…", title: "Post pilot- merge other target categories and complete.", tags: [{ t: "area:pipeline", k: "area" }], when: "4d ago" }],

    Done: [
    { id: "ENG-1402", proj: "Allen", title: "Wire `executions` failure banner to the inspector deep-link", tags: [{ t: "area:agent", k: "" }], when: "12d ago", who: "M" }]

  };
  const COL_COLORS = { Backlog: "oklch(0.78 0.005 250)", Todo: "oklch(0.78 0.005 250)", "In Progress": "var(--warning)", "Dev Done": "var(--danger)", Done: "var(--success)" };

  const TicketsScreen = ({ setRoute, setSelectedTicket }) => {
    const [view, setView] = React.useState("board");
    const [tab, setTab] = React.useState("All");
    return (
      <div className="ad-scope view-inner wide">
      <div className="page-header">
        <div className="left">
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <h1 className="page-h1" style={{ margin: 0 }}>Tickets</h1>
            <span className="badge ok" style={{ alignSelf: "center" }}>
              <span className="dot" style={{ background: "var(--success)" }} />Inomy
            </span>
            <span className="mono" style={{ fontSize: 13, color: "var(--text-3)", alignSelf: "center" }}>· 200 issues</span>
          </div>
          <div className="page-sub" style={{ marginTop: 6 }}>Linear synced. Click a card to dispatch an agent.</div>
        </div>
        <div className="right" style={{ alignSelf: "center" }}>
          <div className="run-tabs">
            <button className={`tt ${view === "list" ? "active" : ""}`} onClick={() => setView("list")}>
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: "-2px", marginRight: 6 }}>
                <line x1="8" y1="6"  x2="20" y2="6"  />
                <line x1="8" y1="12" x2="20" y2="12" />
                <line x1="8" y1="18" x2="20" y2="18" />
                <circle cx="4" cy="6"  r="1.2" fill="currentColor" stroke="none" />
                <circle cx="4" cy="12" r="1.2" fill="currentColor" stroke="none" />
                <circle cx="4" cy="18" r="1.2" fill="currentColor" stroke="none" />
              </svg>
              List
            </button>
            <button className={`tt ${view === "board" ? "active" : ""}`} onClick={() => setView("board")}>
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: "-2px", marginRight: 6 }}>
                <rect x="3"  y="3"  width="8" height="8" rx="1.5" />
                <rect x="13" y="3"  width="8" height="8" rx="1.5" />
                <rect x="3"  y="13" width="8" height="8" rx="1.5" />
                <rect x="13" y="13" width="8" height="8" rx="1.5" />
              </svg>
              Board
            </button>
          </div>
          <button className="btn"><Icon name="refresh" size={13} className="ico" />Refresh</button>
          <button className="btn primary"><Icon name="plus" size={13} className="ico" />New ticket</button>
        </div>
      </div>
      <div style={{ display: "flex", gap: 4, marginBottom: 18 }}>
        <Tab v="All" ct="200" active={tab === "All"} onClick={() => setTab("All")} />
        <Tab v="Active" ct="50" active={tab === "Active"} onClick={() => setTab("Active")} />
        <Tab v="Running" ct="2" active={tab === "Running"} onClick={() => setTab("Running")} />
        <Tab v="Done" active={tab === "Done"} onClick={() => setTab("Done")} />
      </div>
      <div style={{ display: "flex", gap: 12, marginBottom: 18 }}>
        <div className="search-input" style={{ flex: 1, maxWidth: 360 }}><Icon name="search" size={13} /><input placeholder="Search issues…" /></div>
        <window.ADDropdown options={["Project: All projects", "Allen", "Pricing Health"]} placeholder="Project: All projects" />
        <window.ADDropdown options={["Assignee: Any", "Me", "Unassigned"]} placeholder="Assignee: Any" />
        <window.ADDropdown options={["Label: Any"]} placeholder="Label: Any" />
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--text-3)" }}>200 of 200</span>
      </div>
      {view === "board" ?
        <div className="kanban">
          {Object.entries(TICKETS_BY_COL).map(([col, items]) =>
          <div key={col} className="kanban-col">
              <div className="kanban-col-head">
                <span className="colordot" style={{ background: COL_COLORS[col] }} />
                <span className="name">{col}</span>
                <span className="ct mono">{items.length}</span>
                <button className="btn ghost icon sm"><Icon name="plus" size={12} /></button>
              </div>
              <div className="kanban-col-body">
                {items.map((t) =>
              <div key={t.id} className="ticket" onClick={() => {setSelectedTicket && setSelectedTicket(t.id);setRoute("ticket-detail");}}>
                    <div className="ticket-head">
                      <span className="colordot" style={{ background: COL_COLORS[col], width: 8, height: 8, borderRadius: "50%", display: "inline-block" }} />
                      <span className="id">{t.id}</span>
                      <span className="proj">{t.proj}</span>
                    </div>
                    <div className="ticket-title">{t.title}</div>
                    {t.tags.length > 0 &&
                <div className="ticket-meta">
                        {t.tags.slice(0, 3).map((tg, i) => <span key={i} className={`tag ${tg.k}`}>{tg.t}</span>)}
                        {t.tags.length > 3 && <span className="tag">+{t.tags.length - 3}</span>}
                      </div>
                }
                    <div className="ticket-foot">
                      <button className="dispatch-btn" onClick={(e) => {e.stopPropagation();setSelectedTicket && setSelectedTicket(t.id);setRoute("ticket-detail");}}>
                        <Icon name="sparkles" size={10} className="ico" />Dispatch
                      </button>
                      <span style={{ marginLeft: "auto" }}>{t.when}</span>
                      {t.who && <div className="avatar" style={{ width: 18, height: 18, fontSize: 10 }}>{t.who}</div>}
                    </div>
                  </div>
              )}
              </div>
            </div>
          )}
        </div> :

        <div className="list">
          {Object.entries(TICKETS_BY_COL).flatMap(([col, items]) => items.map((t) =>
          <div key={t.id} className="row compact" onClick={() => {setSelectedTicket && setSelectedTicket(t.id);setRoute("ticket-detail");}}>
              <span className="colordot" style={{ background: COL_COLORS[col], width: 8, height: 8, borderRadius: "50%" }} />
              <span className="mono" style={{ fontSize: 12, color: "var(--text-2)", width: 86 }}>{t.id}</span>
              <div className="titleblock grow">
                <div className="title" style={{ fontSize: 13.5 }}>{t.title}</div>
                <div className="sub mono">{t.proj} · {col.toLowerCase()}</div>
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                {t.tags.slice(0, 2).map((tg, i) => <span key={i} className={`tag ${tg.k}`}>{tg.t}</span>)}
              </div>
              <button className="dispatch-btn"><Icon name="sparkles" size={10} className="ico" />Dispatch</button>
              <span className="mono" style={{ fontSize: 11.5, color: "var(--text-3)", width: 60, textAlign: "right" }}>{t.when}</span>
            </div>
          ))}
        </div>
        }
    </div>);

  };

  const TicketDetail = ({ setRoute, ticketId, setSelectedExec }) => {
    const t = {
      id: ticketId || "ENG-1505",
      title: "GEPA Integration: Allen and ES Data Pipeline",
      proj: "Series Extraction",
      description: [
      "Connect GEPA-style optimization loops to the schema-designer flow. We want each schema-designer run to be evaluated by the judge, then the eval is fed back into a meta-prompt that improves the next iteration's extraction rules.",
      "Out of scope: per-vendor specialization. That ships in ENG-1610.",
      "Acceptance: a 10-iteration run on the speakers category must improve mean-extraction-accuracy by ≥4pp without regressing any of the 12 protected fields."],

      tags: [{ t: "roadmap:q2-2026", k: "roadmap" }, { t: "type:feature", k: "feature" }, { t: "area:pipeline", k: "area" }],
      history: [
      { who: "Manish", w: "5/12/2026", what: "created the ticket" },
      { who: "Allen", w: "5/13/2026", what: "auto-linked to schema-designer workflow" },
      { who: "Ashish", w: "5/14/2026", what: "moved to In Progress" },
      { who: "Allen", w: "7h ago", what: "dispatched schema-designer · run 97fc5afd · completed" },
      { who: "Ashish", w: "6h ago", what: "approved evaluator update for protected fields" }],

      runs: [
      { id: "97fc5afd", node: "schema-designer-judge", status: "completed", dur: "1m 4s", when: "7h ago" },
      { id: "ce47ad23", node: "schema-designer-judge", status: "completed", dur: "7m 1s", when: "7h ago" },
      { id: "fef44b5a", node: "schema-evaluator", status: "completed", dur: "2m 53s", when: "7h ago" }]

    };
    return (
      <div className="ad-scope view-inner">
      <BackLink to="tickets" label="Tickets" setRoute={setRoute} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 28, alignItems: "start" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span className="mono" style={{ fontSize: 12, color: "var(--text-2)", padding: "2px 8px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--surface-2)" }}>{t.id}</span>
            <span className="mono" style={{ fontSize: 12, color: "var(--text-3)" }}>{t.proj}</span>
          </div>
          <h1 className="page-h1" style={{ fontSize: 24, marginBottom: 14 }}>{t.title}</h1>
          <div style={{ display: "flex", gap: 6, marginBottom: 24, flexWrap: "wrap" }}>
            {t.tags.map((tg, i) => <span key={i} className={`tag ${tg.k}`}>{tg.t}</span>)}
          </div>
          <div className="card card-pad" style={{ marginBottom: 16 }}>
            <div className="mono" style={{ fontSize: 10.5, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-3)", marginBottom: 10 }}>Description</div>
            {t.description.map((p, i) => <p key={i} style={{ margin: "0 0 10px", fontSize: 14, lineHeight: 1.65 }}>{p}</p>)}
          </div>
          <div className="section-h"><span className="t">Agent runs · {t.runs.length}</span></div>
          <div className="list">
            {t.runs.map((r) =>
              <div key={r.id} className="exec-row" style={{ gridTemplateColumns: "120px 1fr auto auto auto" }} onClick={() => {setSelectedExec && setSelectedExec(r.id);setRoute("execution-detail");}}>
                <span className="exec-id mono">{r.id}</span>
                <span className="exec-node mono">{r.node}</span>
                <span style={{ textAlign: "right" }}><StatusBadge s={r.status} /></span>
                <span className="exec-dur mono">{r.dur}</span>
                <span className="exec-time mono">{r.when}</span>
              </div>
              )}
          </div>
          <div className="section-h"><span className="t">Activity</span></div>
          <div>
            {t.history.map((h, i) =>
              <div key={i} style={{ display: "flex", gap: 12, padding: "10px 4px", borderBottom: i < t.history.length - 1 ? "1px solid var(--border-faint)" : "none" }}>
                <div className="avatar" style={{ width: 22, height: 22, fontSize: 10 }}>{h.who[0]}</div>
                <div style={{ flex: 1, fontSize: 13 }}>
                  <span style={{ fontWeight: 500 }}>{h.who}</span>{" "}
                  <span style={{ color: "var(--text-2)" }}>{h.what}</span>
                </div>
                <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>{h.w}</span>
              </div>
              )}
          </div>
          <div className="composer" style={{ marginTop: 24, marginLeft: 4, marginRight: 4, boxSizing: "border-box", width: "833px", minWidth: "833px", maxWidth: "833px" }}>
            <textarea placeholder="Comment, or @-mention an agent to dispatch…" style={{ minHeight: 48 }} />
            <div className="composer-foot">
              <button className="comp-chip"><Icon name="plus" size={13} className="ico" /></button>
              <button className="comp-chip"><span>@schema-designer</span></button>
              <button className="comp-chip"><Icon name="paperclip" size={13} className="ico" /></button>
              <button className="send-btn"><Icon name="arr-up" size={14} /></button>
            </div>
          </div>
        </div>
        <aside style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <button className="btn primary" style={{ height: 36, justifyContent: "center" }}>
            <Icon name="sparkles" size={13} className="ico" />Dispatch agent
          </button>
          <div className="card">
            <SideField label="Status" v={<span className="badge warning"><span className="dot" />In Progress</span>} />
            <SideField label="Assignee" v={<div style={{ display: "flex", alignItems: "center", gap: 6 }}><div className="avatar" style={{ width: 20, height: 20, fontSize: 9 }}>A</div>Ashish</div>} />
            <SideField label="Reporter" v="Manish" />
            <SideField label="Priority" v={<span className="badge danger"><span className="dot" />High</span>} />
            <SideField label="Created" v={<span className="mono" style={{ fontSize: 12 }}>5/12/2026</span>} />
            <SideField label="Updated" v={<span className="mono" style={{ fontSize: 12 }}>7h ago</span>} />
            <SideField label="Linear" v={<span className="mono" style={{ fontSize: 12, color: "var(--accent)" }}>↗ open in Linear</span>} />
          </div>
          <div className="card card-pad">
            <div className="mono" style={{ fontSize: 10.5, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-3)", marginBottom: 8 }}>Suggested agent</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div className="icon-box agent" style={{ width: 32, height: 32 }}><Icon name="users" size={15} /></div>
              <div>
                <div style={{ fontWeight: 500, fontSize: 13 }}>schema-designer</div>
                <div className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>22 runs · 89% ok</div>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>);

  };

  // ────────────────────────────────────────────────────────────
  // PULL REQUESTS
  // ────────────────────────────────────────────────────────────
  const PullRequestsScreen = ({ setRoute, setSelectedExec, setSelectedPR }) => {
    const prs = [
    { num: "633", title: "fix(inquiry_parser): handle image-sourced deal context generically", state: "open", repo: "inomy-ai-service", branch: "fix/inquiry-parser-image-price-context-tfclwj", target: "dev", by: "ajit-inomy", when: "1m ago", files: 5, add: 324, sub: 26 },
    { num: "629", title: "feat(internal-res): Phase 2 Response Experience Studio — Internal Endpoint Layer", state: "open", repo: "inomy-ai-service", branch: "allen/phase-2-response-experience-studio-inter-mpdmrmu5", target: "dev", by: "shreemantkumar65", when: "1h ago", files: 57, add: 9726, sub: 70 },
    { num: "87", title: "Context engine integration", state: "open", repo: "allen", branch: "context-engine-integration", target: "main", by: "ashish-inomy", when: "2h ago", files: 95, add: 22588, sub: 102 },
    { num: "897", title: "feat(response-experience): Phase 2 — lifecycle module, admin APIs, admin UI", state: "open", repo: "inomy-mono", branch: "allen/phase-2-response-experience-studio-mono--mpdqcnq9", target: "development", by: "shreemantkumar65", when: "3h ago", files: 70, add: 16093, sub: 1226 },
    { num: "900", title: "Testnet <> Dev sync May", state: "open", repo: "inomy-mono", branch: "development", target: "staging", by: "Saitejavarma30", when: "6h ago", files: 686, add: 73999, sub: 23507 },
    { num: "812", title: "fix(executions): inspector breadcrumb generates wrong route when no parent run", state: "open", repo: "allen", branch: "fix/inspector-breadcrumb-no-parent-mpa3a", target: "main", by: "manish-inomy", when: "1d ago", files: 3, add: 41, sub: 18 },
    { num: "808", title: "feat(workflows): retry-from-checkpoint preserves agent sessions", state: "open", repo: "allen", branch: "feat/checkpoint-resume-mt6qz", target: "main", by: "manish-inomy", when: "2d ago", files: 12, add: 218, sub: 64 }];

    const [tab, setTab] = React.useState("open");
    return (
      <div className="ad-scope view-inner">
      <div className="page-header">
        <div className="left">
          <h1 className="page-h1">Pull Requests</h1>
          <div className="page-sub">63 results · synced from GitHub · auto-refresh every 30s.</div>
        </div>
        <div className="right">
          <button className="btn"><Icon name="wrench" size={13} className="ico" />Resolve CodeRabbit</button>
          <button className="btn"><Icon name="refresh" size={13} className="ico" />Sync from GitHub</button>
        </div>
      </div>
      <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
        <Tab v="open" ct="63" active={tab === "open"} onClick={() => setTab("open")} />
        <Tab v="merged" ct="412" active={tab === "merged"} onClick={() => setTab("merged")} />
        <Tab v="closed" ct="48" active={tab === "closed"} onClick={() => setTab("closed")} />
        <Tab v="All" ct="523" active={tab === "All"} onClick={() => setTab("All")} />
      </div>
      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <div className="search-input" style={{ flex: 1, maxWidth: 360 }}><Icon name="search" size={13} /><input placeholder="Search PRs…" /></div>
        <window.ADDropdown options={["All repos", "allen", "inomy-mono", "inomy-ai-service"]} placeholder="All repos" />
        <window.ADDropdown options={["Any author"]} placeholder="Any author" />
        <window.ADDropdown options={["Any reviewer"]} placeholder="Any reviewer" />
      </div>
      <div className="list">
        {prs.map((p) =>
          <div key={p.num} className="pr" onClick={() => {setSelectedPR && setSelectedPR(p.num);setRoute("pr-detail");}}>
            <div style={{ width: 24, paddingTop: 2, color: "var(--success)" }}><Icon name="git-pr" size={16} /></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <span className="pr-num mono">#{p.num}</span>
                <span className="pr-title">{p.title}</span>
                <span className="badge success" style={{ marginLeft: 4 }}>{p.state}</span>
              </div>
              <div className="pr-branch">
                <span className="repo">{p.repo}</span><span style={{ color: "var(--text-4)" }}>·</span>
                <span className="branch">{p.branch}</span><span style={{ color: "var(--text-4)" }}>→</span>
                <span>{p.target}</span><span style={{ color: "var(--text-4)" }}>·</span>
                <span>by {p.by}</span>
              </div>
              <div className="pr-meta">
                <span><Icon name="clock" size={11} style={{ verticalAlign: "-2px" }} /> {p.when}</span>
                <span><Icon name="file" size={11} style={{ verticalAlign: "-2px" }} /> {p.files} files</span>
                <span className="add">+{p.add.toLocaleString()}</span>
                <span className="sub">−{p.sub.toLocaleString()}</span>
              </div>
            </div>
            <div className="pr-actions" onClick={(e) => e.stopPropagation()}>
              <button className="btn sm" onClick={() => setRoute("workspace-detail")}><Icon name="workspace" size={12} className="ico" />Open Workspace</button>
              <button className="btn sm" onClick={() => {setSelectedPR && setSelectedPR(p.num);setRoute("pr-detail");}}><Icon name="wrench" size={12} className="ico" />Resolve CodeRabbit</button>
              <button className="btn icon sm"><Icon name="external" size={12} /></button>
            </div>
          </div>
          )}
      </div>
    </div>);

  };

  const Comment = ({ who, when, body, badge }) =>
  <div className="card card-pad">
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
      <div className="avatar" style={{ width: 22, height: 22, fontSize: 10, background: who.includes("Allen") ? "linear-gradient(135deg, var(--agent), var(--accent))" : who.includes("CodeRabbit") ? "var(--warning)" : undefined }}>{who[0]}</div>
      <span style={{ fontWeight: 500, fontSize: 13 }}>{who}</span>
      {badge && <span className={`badge ${badge === "needs-action" ? "warning" : badge === "agent" ? "accent" : "success"}`}><span className="dot" />{badge}</span>}
      <span className="mono" style={{ fontSize: 11, color: "var(--text-3)", marginLeft: "auto" }}>{when}</span>
    </div>
    {body.map((p, i) => <p key={i} style={{ margin: "0 0 8px", fontSize: 13.5, lineHeight: 1.6 }}>{p}</p>)}
  </div>;


  const PRDetail = ({ setRoute, prNum, setSelectedExec }) => {
    const [tab, setTab] = React.useState("conversation");
    const pr = {
      num: prNum || "633",
      title: "fix(inquiry_parser): handle image-sourced deal context generically",
      repo: "inomy-ai-service",
      branch: "fix/inquiry-parser-image-price-context-tfclwj",
      target: "dev", author: "ajit-inomy", when: "1m ago",
      files: 5, add: 324, sub: 26
    };
    return (
      <div className="ad-scope view-inner">
      <BackLink to="prs" label="Pull Requests" setRoute={setRoute} />
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
        <span className="badge success"><span className="dot" />open</span>
        <span className="mono" style={{ color: "var(--accent)", fontSize: 14, fontWeight: 500 }}>#{pr.num}</span>
        <span className="mono" style={{ fontSize: 12, color: "var(--text-3)" }}>{pr.repo}</span>
      </div>
      <h1 className="page-h1" style={{ fontSize: 22, marginBottom: 10 }}>{pr.title}</h1>
      <div className="mono" style={{ fontSize: 12.5, color: "var(--text-3)", marginBottom: 18, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ color: "var(--accent)" }}>{pr.branch}</span>
        <span style={{ color: "var(--text-4)" }}>→</span>
        <span>{pr.target}</span>
        <span style={{ color: "var(--text-4)" }}>·</span>
        <span>by {pr.author}</span>
        <span style={{ color: "var(--text-4)" }}>·</span>
        <span>{pr.when}</span>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
        <button className="btn primary"><Icon name="wrench" size={13} className="ico" />Resolve CodeRabbit · <span className="mono">7 threads</span></button>
        <button className="btn" onClick={() => setRoute("workspace-detail")}><Icon name="workspace" size={13} className="ico" />Open Workspace</button>
        <button className="btn"><Icon name="external" size={13} className="ico" />Open on GitHub</button>
        <div style={{ marginLeft: "auto" }}>
          <button className="btn"><Icon name="check" size={13} className="ico" />Approve</button>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 28, alignItems: "start" }}>
        <div>
          <div className="tabs">
            <button className={`tab ${tab === "conversation" ? "active" : ""}`} onClick={() => setTab("conversation")}>Conversation <span className="ct mono">12</span></button>
            <button className={`tab ${tab === "files" ? "active" : ""}`} onClick={() => setTab("files")}>Files <span className="ct mono">{pr.files}</span></button>
            <button className={`tab ${tab === "checks" ? "active" : ""}`} onClick={() => setTab("checks")}>Checks <span className="ct mono">8/8</span></button>
            <button className={`tab ${tab === "runs" ? "active" : ""}`} onClick={() => setTab("runs")}>Agent runs <span className="ct mono">3</span></button>
          </div>
          {tab === "conversation" &&
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <Comment who="ajit-inomy" when="opened 5d ago" body={["Image-sourced deal context (Instagram/TikTok inquiries) was being dropped because the parser only walked text/plain parts. This widens the parser to also extract from attachment captions and OCR results."]} />
              <Comment who="CodeRabbit" when="reviewed 5d ago" badge="needs-action" body={["Potential regression in parseInquiry() when the same image is referenced more than once — current dedupe key uses URL hash, but Instagram CDN rewrites URLs. Suggest hashing image bytes instead."]} />
              <Comment who="Allen · schema-designer" when="dispatched 1h ago" badge="agent" body={["Investigated and fixed. Switched dedupe to perceptual hash of image bytes (8-byte dHash). Added a unit test pinning the dedupe to a fixture of the same image under two CDN URLs. All 7 CodeRabbit threads resolved."]} />
              <Comment who="manish-inomy" when="approved 4m ago" badge="approved" body={["LGTM. Let's get this in before the deal-boosting indexer ships."]} />
            </div>
            }
          {tab === "files" &&
            <div className="list">
              {[
              { p: "apps/api/src/products/inquiry_parser.ts", add: 184, sub: 12 },
              { p: "apps/api/src/products/__tests__/inquiry_parser.test.ts", add: 92, sub: 0 },
              { p: "apps/api/src/utils/perceptual_hash.ts", add: 38, sub: 0 },
              { p: "apps/api/package.json", add: 6, sub: 2 },
              { p: "apps/api/src/products/types.ts", add: 4, sub: 12 }].
              map((f) =>
              <div key={f.p} className="row compact">
                  <Icon name="file" size={14} style={{ color: "var(--text-3)" }} />
                  <span className="mono" style={{ flex: 1, fontSize: 12.5 }}>{f.p}</span>
                  <span className="mono" style={{ fontSize: 11, color: "var(--success)" }}>+{f.add}</span>
                  <span className="mono" style={{ fontSize: 11, color: "var(--danger)" }}>−{f.sub}</span>
                </div>
              )}
            </div>
            }
          {tab === "checks" &&
            <div className="list">
              {[
              "ci · lint", "ci · typecheck", "ci · unit", "ci · integration",
              "ci · e2e", "coderabbit · review", "allen · auto-resolve", "vercel · preview"].
              map((c) =>
              <div key={c} className="row compact">
                  <Icon name="check-circle" size={14} style={{ color: "var(--success)" }} />
                  <span className="mono" style={{ flex: 1, fontSize: 12.5 }}>{c}</span>
                  <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>1m 24s</span>
                  <button className="btn ghost sm">View</button>
                </div>
              )}
            </div>
            }
          {tab === "runs" &&
            <div className="list">
              {[
              { id: "ac99e012", node: "investigate", status: "completed", dur: "1m 14s", when: "5h ago" },
              { id: "ac99e145", node: "engineering-lead", status: "completed", dur: "3m 42s", when: "5h ago" },
              { id: "ac99e201", node: "open_pr", status: "completed", dur: "8s", when: "5h ago" }].
              map((r) =>
              <div key={r.id} className="exec-row" style={{ gridTemplateColumns: "120px 1fr auto auto auto" }} onClick={() => {setSelectedExec && setSelectedExec(r.id);setRoute("execution-detail");}}>
                  <span className="exec-id mono">{r.id}</span>
                  <span className="exec-node mono">{r.node}</span>
                  <span style={{ textAlign: "right" }}><StatusBadge s={r.status} /></span>
                  <span className="exec-dur mono">{r.dur}</span>
                  <span className="exec-time mono">{r.when}</span>
                </div>
              )}
            </div>
            }
        </div>
        <aside style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="card">
            <SideField label="Reviewers" v={<div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}><div className="avatar" style={{ width: 22, height: 22, fontSize: 10 }}>M</div><div className="avatar" style={{ width: 22, height: 22, fontSize: 10, background: "linear-gradient(135deg, var(--agent), var(--accent))" }}>CR</div></div>} />
            <SideField label="Labels" v={<span className="tag improvement">type:bug</span>} />
            <SideField label="Linked" v={<span className="mono" style={{ fontSize: 11, color: "var(--accent)" }}>ENG-1660</span>} />
            <SideField label="Workflow" v={<span className="mono" style={{ fontSize: 11 }}>bug-investigate-and-fix</span>} />
            <SideField label="Files" v={<span className="mono" style={{ fontSize: 11 }}>{pr.files}</span>} />
            <SideField label="Changes" v={<span className="mono" style={{ fontSize: 11 }}><span style={{ color: "var(--success)" }}>+{pr.add}</span> <span style={{ color: "var(--danger)" }}>−{pr.sub}</span></span>} />
          </div>
        </aside>
      </div>
    </div>);

  };

  // ────────────────────────────────────────────────────────────
  // WORKSPACES
  // ────────────────────────────────────────────────────────────
  const WorkspacesScreen = ({ setRoute }) => {
    const ws = [
    { name: "allen/some-random-shits-mpc92obu", branch: "allen/some-random-shits-mpc92obu", target: "main", port: 15710, when: "5/19/2026", status: "active" },
    { name: "allen/linear-ticket-eng-1703-slack-bot-posts-i-mpazup16", branch: "allen/linear-ticket-eng-1703-slack-bot-posts-i-mpazup16", target: "main", port: 15680, when: "5/18/2026", status: "active" },
    { name: "allen/linear-ticket-eng-1661-inject-absolute-p-mp6kls0f", branch: "allen/linear-ticket-eng-1661-inject-absolute-p-mp6kls0f", target: "main", port: 15610, when: "5/15/2026", status: "active" },
    { name: "allen/claude-chat-fails-with-spawn-claude-enoe-mp5kgh2p", branch: "allen/claude-chat-fails-with-spawn-claude-enoe-mp5kgh2p", target: "main", port: 15600, when: "5/14/2026", status: "active" },
    { name: "feature-daily-status-prep-automation-tew60q", branch: "feature/daily-status-prep-automation-tew60q", target: "main", port: 15510, when: "5/11/2026", status: "active" },
    { name: "fix-eng-1584-delete-mcp-removes-mcp-server-e-tepyxq", branch: "fix/eng-1584-delete-mcp-removes-mcp-server-e-tepyxq", target: "main", port: 15490, when: "5/8/2026", status: "active" },
    { name: "fix-chat-stream-network-error-reconnect-tepojr", branch: "fix/chat-stream-network-error-reconnect-tepojr", target: "main", port: 15450, when: "5/8/2026", status: "active", changed: 36 },
    { name: "fix-make-create-workspace-idempotent-for-exi-tepdrt", branch: "fix/make-create-workspace-idempotent-for-exi-tepdrt", target: "main", port: 15420, when: "5/8/2026", status: "active" },
    { name: "allen-context-engine-integration", branch: "context-engine-integration", target: "main", port: 15380, when: "5/7/2026", status: "idle" },
    { name: "fix-coderabbit-review-batch-ten0bx", branch: "fix/coderabbit-review-batch-ten0bx", target: "main", port: 15340, when: "5/5/2026", status: "idle" }];

    return (
      <div className="ad-scope view-inner">
      <div className="page-header">
        <div className="left">
          <h1 className="page-h1">Workspaces</h1>
          <div className="page-sub">Isolated agent code environments · {ws.length} active.</div>
        </div>
        <div className="right">
          <button className="btn"><Icon name="refresh" size={13} className="ico" /></button>
          <button className="btn primary"><Icon name="plus" size={13} className="ico" />New workspace</button>
        </div>
      </div>
      <div style={{ display: "flex", gap: 12, marginBottom: 18 }}>
        <div className="search-input" style={{ flex: 1, maxWidth: 360 }}><Icon name="search" size={13} /><input placeholder="Search workspaces or branches…" /></div>
        <window.ADDropdown options={["All repos", "allen", "inomy-mono"]} placeholder="All repos" />
        <window.ADDropdown options={["All status", "active", "idle"]} placeholder="All status" />
      </div>
      <div className="list">
        <div style={{ padding: "10px 18px", background: "var(--surface-2)", display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid var(--border-faint)" }}>
          <Icon name="folder" size={13} style={{ color: "var(--text-3)" }} />
          <span className="mono" style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-3)" }}>ALLEN</span>
          <span className="mono" style={{ fontSize: 11, color: "var(--text-3)", marginLeft: "auto" }}>{ws.length} workspaces</span>
        </div>
        {ws.map((w) =>
          <div key={w.name} className="ws" onClick={() => setRoute("workspace-detail")}>
            <Icon name="workspace" size={14} style={{ color: "var(--text-3)" }} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span className="ws-title mono">{w.name}</span>
                <span className={`badge ${w.status === "active" ? "success" : "warning"}`}><span className="dot" />{w.status}</span>
                {w.changed ? <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-3)" }}>{w.changed} changed</span> : null}
              </div>
              <div className="ws-meta mono">
                <span>{w.branch}</span><span className="arr">→</span>
                <span>{w.target}</span><span className="arr">·</span>
                <span className="port">port {w.port}</span><span className="arr">·</span>
                <span>{w.when}</span>
              </div>
            </div>
            <div style={{ display: "flex", gap: 6 }} onClick={(e) => e.stopPropagation()}>
              <button className="btn icon sm" title="Open in IDE" onClick={() => setRoute("workspace-detail")}><Icon name="external" size={12} /></button>
              <button className="btn icon sm" title="Delete"><Icon name="trash" size={12} /></button>
            </div>
          </div>
          )}
      </div>
    </div>);

  };

  const WorkspaceDetail = ({ setRoute }) => {
    const [activeFile, setActiveFile] = React.useState("inquiry_parser.ts");
    const files = [
    { p: "apps/api/", isDir: true },
    { p: "  src/", isDir: true, indent: 1 },
    { p: "    products/", isDir: true, indent: 2 },
    { p: "      inquiry_parser.ts", changed: "M", indent: 3 },
    { p: "      perceptual_hash.ts", changed: "A", indent: 3 },
    { p: "      types.ts", changed: "M", indent: 3 },
    { p: "      __tests__/inquiry_parser.test.ts", changed: "M", indent: 3 },
    { p: "  package.json", changed: "M", indent: 1 }];

    return (
      <div className="ad-scope" style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
        <button onClick={() => setRoute("workspaces")} className="btn ghost sm" style={{ height: 24, padding: "0 8px" }}>
          <Icon name="arr-l" size={12} className="ico" />Workspaces
        </button>
        <Icon name="workspace" size={14} style={{ color: "var(--text-3)" }} />
        <span className="mono" style={{ fontSize: 13, fontWeight: 500 }}>allen/some-random-shits-mpc92obu</span>
        <span className="badge success"><span className="dot" />active</span>
        <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>port 15710</span>
        <div style={{ flex: 1 }} />
        <button className="btn sm"><Icon name="branch" size={12} className="ico" />main</button>
        <button className="btn sm"><Icon name="terminal" size={12} className="ico" />Terminal</button>
        <button className="btn sm"><Icon name="external" size={12} className="ico" />Open in VSCode</button>
        <button className="btn primary sm"><Icon name="git-pr" size={12} className="ico" />Open PR</button>
      </div>
      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "240px 1fr 320px", overflow: "hidden" }}>
        <div style={{ borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
          <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border-faint)", display: "flex", alignItems: "center", gap: 8 }}>
            <span className="mono" style={{ fontSize: 10.5, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-3)" }}>Explorer</span>
            <span className="badge" style={{ marginLeft: "auto" }}><span className="mono">5 changed</span></span>
          </div>
          <div style={{ overflowY: "auto", padding: "6px 4px", flex: 1 }}>
            {files.map((f, i) => {
                const name = f.p.trim();
                return (
                  <div key={i} onClick={() => !f.isDir && setActiveFile(name)} style={{
                    padding: "4px 8px", paddingLeft: 8 + (f.indent || 0) * 12,
                    fontSize: 12.5, fontFamily: "var(--font-mono)",
                    display: "flex", alignItems: "center", gap: 6,
                    borderRadius: 4, cursor: f.isDir ? "default" : "pointer",
                    color: activeFile === name ? "var(--text)" : "var(--text-2)",
                    background: activeFile === name ? "var(--accent-tint)" : "transparent"
                  }}>
                  <Icon name={f.isDir ? "folder" : "file"} size={11} style={{ color: f.isDir ? "var(--warning)" : "var(--text-3)" }} />
                  <span style={{ flex: 1 }}>{name}</span>
                  {f.changed && <span style={{ fontSize: 10, color: f.changed === "A" ? "var(--success)" : "var(--warning)" }}>{f.changed}</span>}
                </div>);

              })}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ display: "flex", borderBottom: "1px solid var(--border)", background: "var(--surface)" }}>
            <div style={{ padding: "10px 14px", borderRight: "1px solid var(--border)", background: "var(--bg)", display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontFamily: "var(--font-mono)" }}>
              <Icon name="file" size={11} style={{ color: "var(--text-3)" }} />
              <span>{activeFile}</span>
              <span style={{ color: "var(--warning)", marginLeft: 6 }}>●</span>
            </div>
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: "16px", fontFamily: "var(--font-mono)", fontSize: 12.5, background: "var(--bg)" }}>
            <div>
              {[
                <><span className="com">// dedupe inquiry images by perceptual hash, not URL</span></>,
                <><span className="kw">import</span> {`{ dHash }`} <span className="kw">from</span> <span className="str">"../utils/perceptual_hash"</span>;</>,
                <></>,
                <><span className="kw">export function</span> dedupeKey(image: <span className="kw">Attachment</span>): <span className="kw">string</span> {`{`}</>,
                <>  <span className="kw">if</span> (!image.bytes) <span className="kw">return</span> hash(image.url);</>,
                <>  <span className="kw">return</span> dHash(image.bytes);</>,
                <>{`}`}</>].
                map((c, i) =>
                <div key={i} className="code-line" style={{ padding: "1px 0" }}>
                  <span className="ln" style={{ minWidth: 28 }}>{i + 1}</span>
                  <span className="c">{c}</span>
                </div>
                )}
            </div>
          </div>
        </div>
        <div style={{ borderLeft: "1px solid var(--border)", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)" }}>
          <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border-faint)", display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="sparkles" size={12} style={{ color: "var(--accent)" }} />
            <span className="mono" style={{ fontSize: 10.5, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-3)" }}>Agent · schema-designer</span>
            <span className="badge success" style={{ marginLeft: "auto" }}><span className="dot" />active</span>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ fontSize: 13, lineHeight: 1.6 }}>
              <div className="mono" style={{ fontSize: 10.5, color: "var(--accent)", letterSpacing: "0.06em", marginBottom: 4 }}>STEP 3 / 5 · investigate</div>
              Switched dedupe key from URL hash to perceptual byte hash. Reproduced the regression on a fixture with two CDN URLs for the same image — only 1 extraction now, was 2.
            </div>
            <div className="tool-call">
              <div className="h">
                <Icon name="terminal" size={11} className="ico" />
                <span className="label">bash</span>
                <span className="cmd mono">pnpm test inquiry_parser -t dedupe</span>
                <span className="badge success" style={{ height: 16, fontSize: 10 }}><span className="dot" />3 passed</span>
              </div>
            </div>
          </div>
          <div style={{ padding: 12, borderTop: "1px solid var(--border-faint)" }}>
            <div className="composer" style={{ padding: "10px 12px" }}>
              <textarea placeholder="Steer the agent…" style={{ minHeight: 36, fontSize: 13 }} />
              <div className="composer-foot">
                <button className="comp-chip"><span className="mono">opus</span><Icon name="chev-d" size={11} className="ico" /></button>
                <button className="send-btn" style={{ width: 26, height: 26 }}><Icon name="arr-up" size={12} /></button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>);

  };

  Object.assign(window, { TicketsScreen, TicketDetail, PullRequestsScreen, PRDetail, WorkspacesScreen, WorkspaceDetail });
})();