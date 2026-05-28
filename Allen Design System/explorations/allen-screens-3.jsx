// Allen screens · part 3 — Library (Teams, Skills, Repos, Integrations), Workflows, Settings + detail pages
(function () {
  const { AdIcon: Icon, AdStat: Stat, AdStatusBadge: StatusBadge, AdBackLink: BackLink, AdSideField: SideField } = window;

  // ────────────────────────────────────────────────────────────
  // LIBRARY · Teams & Agents
  // ────────────────────────────────────────────────────────────

  // Small shared modal shell — closes on backdrop click or ESC.
  function LbModal({ open, onClose, title, children, footer, width = 720 }) {
    React.useEffect(() => {
      if (!open) return;
      const onKey = (e) => { if (e.key === "Escape") onClose(); };
      window.addEventListener("keydown", onKey);
      document.body.style.overflow = "hidden";
      return () => {
        window.removeEventListener("keydown", onKey);
        document.body.style.overflow = "";
      };
    }, [open, onClose]);
    if (!open) return null;
    return (
      <div className="lb-modal-scrim" onClick={onClose}>
        <div className="lb-modal" style={{ width }} onClick={(e) => e.stopPropagation()}>
          <div className="lb-modal-head">
            <h2 className="lb-modal-title">{title}</h2>
            <button className="lb-modal-x" onClick={onClose} aria-label="Close">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          <div className="lb-modal-body">{children}</div>
          {footer ? <div className="lb-modal-foot">{footer}</div> : null}
        </div>
      </div>
    );
  }

  function LbFieldLabel({ children }) {
    return <div className="lb-field-label">{children}</div>;
  }

  // Import Claude agents from repo
  function ImportAgentsModal({ open, onClose }) {
    const repos = ["allen", "inomy-mono", "inomy-ai-service", "es-data-pipeline", "scraping-fleet"];
    return (
      <LbModal open={open} onClose={onClose} title="Import Claude agents from repo" width={760}
        footer={
          <React.Fragment>
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary"><Icon name="import" size={13} className="ico"/>Import</button>
          </React.Fragment>
        }>
        <LbFieldLabel>Source repo</LbFieldLabel>
        <window.ADDropdown
          options={["— pick a registered repo —", ...repos]}
          placeholder="— pick a registered repo —"
          width="100%"
        />
        <div className="lb-modal-hint">
          Allen will scan <code className="mono">agents/</code> in the repo's default branch
          and register each <code className="mono">*.md</code> as an agent. Existing agents
          with the same slug are updated.
        </div>
      </LbModal>
    );
  }

  // Create team
  function CreateTeamModal({ open, onClose }) {
    const [name, setName] = React.useState("");
    const [slug, setSlug] = React.useState("");
    const slugify = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const onNameChange = (e) => {
      setName(e.target.value);
      setSlug(slugify(e.target.value));
    };
    const valid = name.trim().length > 0;
    return (
      <LbModal open={open} onClose={onClose} title="Create team" width={780}
        footer={
          <React.Fragment>
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={!valid}>
              <Icon name="check-circle" size={13} className="ico"/>Create team
            </button>
          </React.Fragment>
        }>
        <div className="lb-callout">
          A lead agent will be created as <code className="mono">{(slug || "<team>") + "-lead"}</code>.
          You can move agents into this team later.
        </div>

        <div className="lb-form-row">
          <div className="lb-form-col">
            <LbFieldLabel>Display name</LbFieldLabel>
            <input className="input" value={name} onChange={onNameChange} placeholder="Billing Team" />
          </div>
          <div className="lb-form-col" style={{ maxWidth: 260 }}>
            <LbFieldLabel>Slug</LbFieldLabel>
            <input className="input mono" value={slug} onChange={(e) => setSlug(slugify(e.target.value))} placeholder="billing" />
          </div>
        </div>

        <LbFieldLabel>Description</LbFieldLabel>
        <input className="input" placeholder="One sentence describing the team" />

        <LbFieldLabel>Mission</LbFieldLabel>
        <textarea className="input lb-textarea" rows={4}
          placeholder="2–3 sentences. Interpolated into the auto-generated lead's system prompt." />

        <LbFieldLabel>Parent team</LbFieldLabel>
        <window.ADDropdown
          options={TEAMS.filter(t => t.id !== "all").map(t => t.name)}
          placeholder="Executive"
          width="100%"
        />

        <details className="lb-advanced">
          <summary>Advanced — lead agent settings</summary>
          <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <LbFieldLabel>Lead model</LbFieldLabel>
              <window.ADDropdown options={["opus","sonnet","gpt-5.5"]} placeholder="opus" width="100%" />
            </div>
            <div>
              <LbFieldLabel>Lead role</LbFieldLabel>
              <window.ADDropdown options={["lead","coordinator"]} placeholder="lead" width="100%" />
            </div>
          </div>
        </details>
      </LbModal>
    );
  }

  const TEAMS = [
  { id: "all", name: "All agents", slug: "grouped by team", lead: null, desc: "Browse every agent, grouped by team. Search across names, teams, and capabilities." },
  { id: "data-acq", name: "Data Acquisition", slug: "data-acquisition", lead: "Data Acquisition", desc: "Vendor onboarding, scraping rules, search optimization, and data collection from external sources." },
  { id: "data-pipe", name: "Data Pipeline", slug: "data-pipeline", lead: "Pipeline Lead", desc: "ETL, indexing, backfills, and OpenSearch transforms across all repos." },
  { id: "data-qual", name: "Data Quality", slug: "data-quality", lead: "Data Quality Lead", desc: "Audits scraped output, freshness, and dedupe; flags drift and quality regressions." },
  { id: "eng", name: "Engineering", slug: "engineering", lead: "Engineering Lead", desc: "Design implementation plans and turn them into working code. Coordinate specialists for backend, frontend, devops, code review, security, and docs." },
  { id: "exec", name: "Executive", slug: "ceo", lead: "Allen CEO", desc: "Strategy, prioritization, and final approval on multi-team initiatives." },
  { id: "meta", name: "Meta — Builders", slug: "team-builder-agent", lead: "Team Builder", desc: "Agents that build, configure, and maintain other agents and teams." },
  { id: "ops", name: "Operations", slug: "operations", lead: "Operations Lead", desc: "Infra, deploys, runbooks, monitoring, and incident response." },
  { id: "prod", name: "Product", slug: "product-manager", lead: "Product Manager", desc: "Specs, PRDs, TDDs, and stakeholder coordination." },
  { id: "research", name: "Research", slug: "research-lead", lead: "Research Lead", desc: "Spike investigations, literature review, and prototype evaluation." },
  { id: "support", name: "Support", slug: "support-lead", lead: "Support Lead", desc: "Customer escalations, bug intake, and reproducible issue triage." }];


  // Used by the new filtered view. Counts are looked up from AGENTS_BY_TEAM
  // when present, otherwise fall back to these placeholders.
  const TEAM_COUNTS = { "data-acq": 11, "data-pipe": 7, "data-qual": 22, "eng": 40, "exec": 1, "meta": 6, "ops": 26, "prod": 5, "research": 9, "support": 8 };

  const AGENTS_BY_TEAM = {
    "Data Acquisition": [
    { name: "Data Acquisition", model: "sonnet", runs: 0, role: "lead", status: "idle" },
    { name: "New Product Discover", model: "opus", runs: 0, role: "member", status: "idle" },
    { name: "Pagination Specialist", model: "sonnet", runs: 0, role: "member", status: "idle" },
    { name: "Scraped Data Validator", model: "opus", runs: 11, role: "member", status: "active" },
    { name: "Search Query Optimizer", model: "sonnet", runs: 0, role: "member", status: "idle" },
    { name: "Search Query Optimizer Judge", model: "sonnet", runs: 0, role: "member", status: "idle" },
    { name: "Vendor Category Mapper", model: "opus", runs: 4, role: "member", status: "active" }],

    "Data Pipeline": [
    { name: "Pipeline Lead", model: "opus", runs: 12, role: "lead", status: "active" },
    { name: "ES Indexer", model: "sonnet", runs: 84, role: "member", status: "active" },
    { name: "Backfill Coordinator", model: "sonnet", runs: 3, role: "member", status: "idle" }]

  };

  // Helper: total agent count across all known teams.
  const ALL_AGENTS_TOTAL = Object.values(TEAM_COUNTS).reduce((a, b) => a + b, 0);

  // Pull a team's display name → AGENTS_BY_TEAM key (handles the
  // "Meta — Builders" → "Meta" style mismatches if any are added later).
  const teamAgentsKey = (team) => team.name;

  const LibraryTeams = ({ setRoute }) => {
    const [activeTeamId, setActiveTeamId] = React.useState("all");
    const [search, setSearch] = React.useState("");
    const [importOpen, setImportOpen] = React.useState(false);
    const [createOpen, setCreateOpen] = React.useState(false);
    const [selectedIds, setSelectedIds] = React.useState(() => new Set());

    const toggleSelect = (id) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
    };
    const clearSelection = () => setSelectedIds(new Set());

    const activeTeam = TEAMS.find((t) => t.id === activeTeamId) || TEAMS[0];
    const isAll = activeTeam.id === "all";

    // Agents to render. On "All" we show every team's roster grouped;
    // otherwise we flatten the active team's roster.
    const teamsForBody = isAll ?
    TEAMS.filter((t) => t.id !== "all" && AGENTS_BY_TEAM[teamAgentsKey(t)]) :
    [activeTeam];

    // Search filter — by agent name only, kept simple.
    const q = search.trim().toLowerCase();
    const filterAgents = (agents) => q ? agents.filter((a) => a.name.toLowerCase().includes(q)) : agents;

    // Counts shown next to "agents" label.
    const totalShown = isAll ?
    ALL_AGENTS_TOTAL :
    AGENTS_BY_TEAM[teamAgentsKey(activeTeam)]?.length ?? TEAM_COUNTS[activeTeam.id] ?? 0;

    // Stat tiles change with selection — All shows org rollup, team shows team details.
    const statTiles = isAll ?
    [
    { label: "Teams", v: TEAMS.length - 1 },
    { label: "Agents", v: ALL_AGENTS_TOTAL },
    { label: "Leads", v: TEAMS.length - 1 }] :

    [
    { label: "Lead", v: activeTeam.lead, mono: false },
    { label: "Agents", v: AGENTS_BY_TEAM[teamAgentsKey(activeTeam)]?.length ?? TEAM_COUNTS[activeTeam.id] ?? 0 },
    { label: "ID", v: activeTeam.slug, mono: true }];


    return (
      <React.Fragment>
      {selectedIds.size > 0 && (
        <div className="lb-bulk-bar">
          <div className="lb-bulk-count">
            <span className="lb-bulk-num">{selectedIds.size}</span>
            <span> selected</span>
          </div>
          <span style={{ flex: 1 }} />
          <button className="lb-bulk-btn">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
            </svg>
            assign to team
          </button>
          <button className="lb-bulk-btn">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12h14"/>
            </svg>
            create team
          </button>
          <button className="lb-bulk-btn lb-bulk-btn-ghost" onClick={clearSelection}>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
            clear
          </button>
        </div>
      )}
      <div className="ad-scope view-inner">
      {/* Universal page header — title NEVER changes with selection */}
      <div className="page-header">
        <div className="left">
          <h1 className="page-h1">Teams & agents</h1>
          <div className="page-sub">Browse every agent, grouped by team. Search across names, teams, and capabilities.</div>
        </div>
        <div className="right">
          <button className="btn icon" title="Refresh"><Icon name="refresh" size={13} /></button>
        </div>
      </div>

      {/* Two-column body: team rail (left) + selected-team panel (right) */}
      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 24, alignItems: "start" }}>

        {/* Team rail — sits right below subtext, persistent navigation */}
        <div style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-lg)",
            padding: "12px 10px",
            position: "sticky", top: 12
          }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "2px 6px 8px" }}>
            <span className="mono" style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-3)" }}>teams</span>
            <span className="mono" style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-3)" }}>{TEAMS.length - 1} · {ALL_AGENTS_TOTAL}</span>
          </div>
          <div className="search-input" style={{ margin: "0 2px 6px" }}>
            <Icon name="search" size={13} />
            <input placeholder="search teams or leads…" />
          </div>
          <div className="lb-rail-actions">
            <button className="lb-rail-btn" onClick={() => setImportOpen(true)}>
              <Icon name="import" size={12} className="ico" />
              <span>import</span>
            </button>
            <button className="lb-rail-btn is-primary" onClick={() => setCreateOpen(true)}>
              <Icon name="plus" size={12} className="ico" />
              <span>new team</span>
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {TEAMS.map((t) => {
                const a = activeTeamId === t.id;
                const c = t.id === "all" ? ALL_AGENTS_TOTAL : AGENTS_BY_TEAM[teamAgentsKey(t)]?.length ?? TEAM_COUNTS[t.id] ?? 0;
                return (
                  <button key={t.id} onClick={() => setActiveTeamId(t.id)} className={a ? "lb-team is-active" : "lb-team"}>
                  <span className="lb-team-name">{t.name}</span>
                  <span className="lb-team-count mono">{c}</span>
                </button>);
              })}
          </div>
        </div>

        {/* Selected team panel — header + stats + agents */}
        <div style={{ minWidth: 0 }}>

          {/* Team header: name + desc + per-team actions */}
          <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 18 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: "-0.022em", color: "var(--text)", lineHeight: 1.2 }}>
                {activeTeam.name}
              </h2>
              <div style={{ marginTop: 4, color: "var(--text-3)", fontSize: 13, lineHeight: 1.5 }}>
                {activeTeam.desc}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <button className="btn"><Icon name="import" size={13} className="ico" />import from repo</button>
              {!isAll && <button className="btn"><Icon name="edit" size={13} className="ico" />edit</button>}
              <button className="btn primary"><Icon name="plus" size={13} className="ico" />add agent</button>
            </div>
          </div>

          {/* Stats — sit ABOVE the agents list, inside the right column */}
          <div className="stat-row" style={{ gridTemplateColumns: "repeat(3, 1fr)", marginBottom: 20 }}>
            {statTiles.map((t) =>
              <div key={t.label} className="stat" style={{ height: "90px" }}>
                <div className="label">{t.label}</div>
                <div className="v" style={t.mono ? { fontFamily: "var(--font-mono)", fontSize: 18, fontWeight: 500 } :
                typeof t.v === "string" ? { fontSize: 20 } : null}>
                  {t.v}
                </div>
                {t.delta ? <div className={`delta ${t.deltaCls || ""}`}>{t.delta}</div> : null}
              </div>
              )}
          </div>

          {/* Agents list */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <span style={{ fontWeight: 500 }}>agents <span className="mono" style={{ fontSize: 11.5, color: "var(--text-3)" }}>{totalShown}</span></span>
            <div style={{ flex: 1 }} />
            <div className="search-input" style={{ width: 260 }}>
              <Icon name="search" size={13} />
              <input placeholder="search agents…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <window.ADDropdown options={["All roles", "lead", "member"]} placeholder="All roles" />
            <button className="btn icon" title="Refresh"><Icon name="refresh" size={13} /></button>
          </div>

          {teamsForBody.map((t) => {
              const agents = filterAgents(AGENTS_BY_TEAM[teamAgentsKey(t)] || []);
              if (isAll && !agents.length) return null;
              return (
                <div key={t.id} style={{ marginBottom: 24 }}>
                {isAll ?
                  <div style={{ display: "flex", alignItems: "baseline", marginBottom: 8 }}>
                    <h3 style={{ margin: 0, fontWeight: 600, fontSize: 14, letterSpacing: "-0.01em" }}>{t.name}</h3>
                    <span className="mono" style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-3)" }}>{agents.length}</span>
                  </div> :
                  null}
                {agents.length ?
                  <div className="list">
                    {agents.map((a) => {
                    const aid = t.id + ":" + a.name;
                    const checked = selectedIds.has(aid);
                    return (
                    <div key={aid} className={"row compact" + (checked ? " is-selected" : "")} onClick={() => setRoute("agent-detail")}>
                        <button
                          className={"lb-cb" + (checked ? " is-checked" : "")}
                          aria-label={checked ? "Deselect agent" : "Select agent"}
                          onClick={(e) => { e.stopPropagation(); toggleSelect(aid); }}>
                          {checked ? (
                            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12"/>
                            </svg>
                          ) : null}
                        </button>
                        <div className="icon-box agent"><Icon name="users" size={14} /></div>
                        <div className="titleblock grow">
                          <div className="title">{a.name}</div>
                          <div className="sub mono"><span>{a.model}</span><span className="dotsep" /><span>{a.runs} runs</span><span className="dotsep" /><span>{a.role}</span></div>
                        </div>
                        <StatusBadge s={a.status} />
                        <button className="btn icon sm" title="Run" onClick={(e) => e.stopPropagation()}><Icon name="play" size={12} /></button>
                        <button className="btn icon sm" title="Edit" onClick={(e) => e.stopPropagation()}><Icon name="edit" size={12} /></button>
                        <button className="btn icon sm" title="Delete" onClick={(e) => e.stopPropagation()}><Icon name="trash" size={12} /></button>
                      </div>);
                    })}
                  </div> :

                  <div className="lb-empty">
                    <div className="lb-empty-title">No agents in this team yet</div>
                    <div className="lb-empty-sub">Add agents directly, or import them from a repository's <code className="mono">agents/</code> folder.</div>
                    <div className="lb-empty-actions">
                      <button className="btn primary sm"><Icon name="plus" size={12} className="ico" />Add agent</button>
                      <button className="btn sm"><Icon name="import" size={12} className="ico" />Import from repo</button>
                    </div>
                  </div>
                  }
              </div>);

            })}
        </div>
      </div>
    </div>
    <ImportAgentsModal open={importOpen} onClose={() => setImportOpen(false)} />
    <CreateTeamModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </React.Fragment>);
  };

  const LibrarySkills = ({ setRoute }) => {
    const skills = [
    { name: "search_repo", lang: "TypeScript", desc: "Grep + AST-aware repo search; respects .gitignore.", uses: 1248, owner: "platform" },
    { name: "run_pytest", lang: "Python", desc: "Run pytest with auto-discovery and JUnit XML output.", uses: 832, owner: "qa" },
    { name: "open_pr", lang: "TypeScript", desc: "Open a GitHub PR with template-aware body and required reviewers.", uses: 612, owner: "platform" },
    { name: "linear_dispatch", lang: "TypeScript", desc: "Resolve a Linear ticket to a fully populated agent task.", uses: 411, owner: "integrations" },
    { name: "es_index_sample", lang: "Python", desc: "Probe a small sample from any OpenSearch index for shape inspection.", uses: 389, owner: "pipeline" },
    { name: "claude_compose", lang: "TypeScript", desc: "Run a composed Claude session with persistent context.", uses: 1542, owner: "runtime" },
    { name: "bash_safe", lang: "Shell", desc: "Sandboxed bash with allow-list for read-only investigation.", uses: 2204, owner: "runtime" },
    { name: "git_branch_create", lang: "Shell", desc: "Create + push a feature branch following the repo convention.", uses: 522, owner: "platform" },
    { name: "schema_diff", lang: "TypeScript", desc: "Compare two OpenSearch index mappings, emit semver-style report.", uses: 178, owner: "pipeline" }];

    return (
      <div className="ad-scope view-inner">
      <div className="page-header">
        <div className="left">
          <h1 className="page-h1">Skills</h1>
          <div className="page-sub">Capabilities agents can compose. Skills are versioned and audited.</div>
        </div>
        <div className="right">
          <button className="btn"><Icon name="import" size={13} className="ico" />Import skill</button>
          <button className="btn primary"><Icon name="plus" size={13} className="ico" />Author skill</button>
        </div>
      </div>
      <div style={{ display: "flex", gap: 12, marginBottom: 18 }}>
        <div className="search-input" style={{ flex: 1, maxWidth: 360 }}><Icon name="search" size={13} /><input placeholder="Search skills…" /></div>
        <window.ADDropdown options={["All languages"]} placeholder="All languages" />
        <window.ADDropdown options={["All owners"]} placeholder="All owners" />
      </div>
      <div className="grid-cards">
        {skills.map((s) =>
          <div key={s.name} className="repo-card" style={{ cursor: "pointer" }} onClick={() => setRoute("skill-detail")}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Icon name="lib-skills" size={14} style={{ color: "var(--accent)" }} />
              <span className="nm mono">{s.name}</span>
              <span className="badge" style={{ marginLeft: "auto" }}><span className="mono">{s.lang}</span></span>
            </div>
            <div className="desc">{s.desc}</div>
            <div className="stats">
              <span><Icon name="play" size={10} style={{ verticalAlign: "-1px" }} /> {s.uses.toLocaleString()} uses</span>
              <span>· owner: {s.owner}</span>
            </div>
          </div>
          )}
      </div>
    </div>);

  };

  const LibraryRepos = ({ setRoute }) => {
    const repos = [
    { name: "allen", desc: "Agent orchestration platform, web app, and runtimes.", lang: "TypeScript", agents: 24, last: "2m ago" },
    { name: "inomy-mono", desc: "Inomy monorepo: apps/api, apps/web, packages/*", lang: "TypeScript", agents: 41, last: "12m ago" },
    { name: "inomy-ai-service", desc: "Pricing & deal-detection inference service.", lang: "Python", agents: 18, last: "1h ago" },
    { name: "es-data-pipeline", desc: "OpenSearch indexer + transforms.", lang: "Python", agents: 11, last: "6h ago" },
    { name: "scraping-fleet", desc: "Distributed scrapers and proxies.", lang: "Go", agents: 7, last: "1d ago" },
    { name: "allen-docs", desc: "Internal docs and design system.", lang: "MDX", agents: 3, last: "3d ago" }];

    return (
      <div className="ad-scope view-inner">
      <div className="page-header">
        <div className="left">
          <h1 className="page-h1">Repos</h1>
          <div className="page-sub">Codebases Allen can read, write, and dispatch agents against.</div>
        </div>
        <div className="right">
          <button className="btn"><Icon name="github" size={13} className="ico" />Connect GitHub</button>
          <button className="btn primary"><Icon name="plus" size={13} className="ico" />Add repo</button>
        </div>
      </div>
      <div className="grid-cards">
        {repos.map((r) =>
          <div key={r.name} className="repo-card" style={{ cursor: "pointer" }} onClick={() => setRoute("repo-detail")}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Icon name="lib-repos" size={14} style={{ color: "var(--text-2)" }} />
              <span className="nm mono">{r.name}</span>
              <span className="badge" style={{ marginLeft: "auto" }}><span className="mono">{r.lang}</span></span>
            </div>
            <div className="desc">{r.desc}</div>
            <div className="stats">
              <span><Icon name="users" size={10} style={{ verticalAlign: "-1px" }} /> {r.agents} agents</span>
              <span><Icon name="clock" size={10} style={{ verticalAlign: "-1px" }} /> {r.last}</span>
            </div>
          </div>
          )}
      </div>
    </div>);

  };

  const LibraryIntegrations = ({ setRoute, setSelectedIntegration }) => {
    const ints = [
    { ico: "github", name: "GitHub", desc: "PRs, issues, workflows, branch protection.", status: "connected", scope: "5 repos" },
    { ico: "linear", name: "Linear", desc: "Two-way ticket sync; agents read assignment.", status: "connected", scope: "Inomy workspace" },
    { ico: "slack", name: "Slack", desc: "Notifications, slash commands, approvals.", status: "connected", scope: "#allen-ci, #pricing" },
    { ico: "openai", name: "OpenAI", desc: "GPT-5.5 / Codex CLI default.", status: "connected", scope: "Org key · $200/mo cap" },
    { ico: "anthropic", name: "Anthropic", desc: "Claude (opus, sonnet) via claude-cli.", status: "connected", scope: "Org key · $400/mo cap" },
    { ico: "external", name: "Notion", desc: "Read-only doc context for agents.", status: "available" },
    { ico: "external", name: "Sentry", desc: "Pull failing traces into investigate nodes.", status: "available" },
    { ico: "external", name: "Datadog", desc: "Pull metrics & logs into investigate nodes.", status: "available" }];

    return (
      <div className="ad-scope view-inner">
      <div className="page-header">
        <div className="left">
          <h1 className="page-h1">Integrations</h1>
          <div className="page-sub">Plug Allen into the systems your team already uses.</div>
        </div>
      </div>
      <div className="section-h"><span className="t">Connected · {ints.filter((i) => i.status === "connected").length}</span></div>
      <div className="grid-cards">
        {ints.filter((i) => i.status === "connected").map((i) =>
          <div key={i.name} className="repo-card" style={{ cursor: "pointer" }} onClick={() => {setSelectedIntegration && setSelectedIntegration(i.name.toLowerCase());setRoute("integration-config");}}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div className="icon-box" style={{ width: 32, height: 32 }}><Icon name={i.ico} size={16} /></div>
              <div>
                <div className="nm" style={{ fontFamily: "var(--font-sans)", fontSize: 14, fontWeight: 600 }}>{i.name}</div>
                <div className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>{i.scope}</div>
              </div>
              <span className="badge success" style={{ marginLeft: "auto" }}><span className="dot" />connected</span>
            </div>
            <div className="desc" style={{ marginTop: 4 }}>{i.desc}</div>
            <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
              <button className="btn sm" onClick={(e) => {e.stopPropagation();setSelectedIntegration && setSelectedIntegration(i.name.toLowerCase());setRoute("integration-config");}}>Configure</button>
              <button className="btn ghost sm" onClick={(e) => e.stopPropagation()}>Disconnect</button>
            </div>
          </div>
          )}
      </div>
      <div className="section-h"><span className="t">Available</span></div>
      <div className="grid-cards">
        {ints.filter((i) => i.status === "available").map((i) =>
          <div key={i.name} className="repo-card">
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div className="icon-box" style={{ width: 32, height: 32 }}><Icon name={i.ico} size={16} /></div>
              <div><div className="nm" style={{ fontFamily: "var(--font-sans)", fontSize: 14, fontWeight: 600 }}>{i.name}</div></div>
              <button className="btn sm" style={{ marginLeft: "auto" }}>Connect</button>
            </div>
            <div className="desc" style={{ marginTop: 4 }}>{i.desc}</div>
          </div>
          )}
      </div>
    </div>);

  };

  // ── Detail pages ────────────────────────────────────────────
  const AgentDetail = ({ setRoute, setSelectedExec }) => {
    const [tab, setTab] = React.useState("overview");
    return (
      <div className="ad-scope view-inner">
      <BackLink to="library-teams" label="Library / Teams & Agents" setRoute={setRoute} />
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18 }}>
        <div className="icon-box agent" style={{ width: 48, height: 48, borderRadius: 10 }}><Icon name="users" size={22} /></div>
        <div>
          <h1 className="page-h1" style={{ fontSize: 22, marginBottom: 4 }}>schema-designer</h1>
          <div className="mono" style={{ fontSize: 12, color: "var(--text-3)" }}>Data Pipeline · sonnet · claude-cli</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className="btn"><Icon name="edit" size={13} className="ico" />Edit prompt</button>
          <button className="btn primary"><Icon name="play" size={13} className="ico" />Run</button>
        </div>
      </div>
      <div className="stat-row">
        <Stat label="Runs · 30d" v="22" delta="+4 vs last 30d" deltaCls="up" />
        <Stat label="Success rate" v="89%" delta="+2pp" deltaCls="up" />
        <Stat label="Avg duration" v="3.2s" />
        <Stat label="Spend · 30d" v="$31.20" />
      </div>
      <div className="tabs">
        {[["overview", "Overview"], ["prompt", "Prompt"], ["skills", "Skills"], ["runs", "Runs"], ["evals", "Evals"], ["settings", "Settings"]].map(([id, lbl]) =>
          <button key={id} className={`tab ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>{lbl}</button>
          )}
      </div>
      {tab === "overview" &&
        <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 24 }}>
          <div>
            <div className="card card-pad" style={{ marginBottom: 16 }}>
              <div className="mono" style={{ fontSize: 10.5, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-3)", marginBottom: 10 }}>About</div>
              <p style={{ margin: 0, fontSize: 14, lineHeight: 1.65 }}>Proposes additions and refinements to OpenSearch index mappings. Reviewed by schema-designer-judge before each commit. Never alters protected fields.</p>
            </div>
            <div className="section-h"><span className="t">Recent runs</span></div>
            <div className="list">
              {[
              { id: "97fc5afd", node: "judge", status: "completed", dur: "1m 4s", when: "7h ago" },
              { id: "ce47ad23", node: "judge", status: "completed", dur: "7m 1s", when: "7h ago" },
              { id: "0cffb966", node: "designer", status: "failed", dur: "8m 23s", when: "7h ago" }].
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
          </div>
          <aside style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="card">
              <SideField label="Role" v={<span className="badge">lead</span>} />
              <SideField label="Model" v={<span className="mono" style={{ fontSize: 11 }}>sonnet</span>} />
              <SideField label="Provider" v="Anthropic" />
              <SideField label="Sandbox" v={<span className="mono" style={{ fontSize: 11 }}>workspace</span>} />
              <SideField label="Source" v={<span className="mono" style={{ fontSize: 11, color: "var(--accent)" }}>allen/agents/schema-designer.yaml</span>} />
            </div>
          </aside>
        </div>
        }
      {tab === "prompt" &&
        <div className="card">
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-faint)", display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--font-mono)", fontSize: 12 }}>
            <Icon name="file" size={12} style={{ color: "var(--text-3)" }} />
            <span>system_prompt.md</span>
          </div>
          <div style={{ padding: 18, fontFamily: "var(--font-mono)", fontSize: 13, lineHeight: 1.7, color: "var(--text-2)", whiteSpace: "pre-wrap" }}>
{`You are schema-designer.

Goal: propose minimal, backwards-compatible additions to OpenSearch
mappings under apps/es-data-pipeline/mappings/*.json.

Rules:
  1. Never alter or remove a protected field. The list is in
     protected_fields.yaml at the repo root.
  2. Every new field must have a deterministic extraction rule.
  3. Enums must be exhaustive AND have a tombstone for renames.

Composition: at the end of every iteration, call
  spawn_agent("schema-designer-judge")
with your diff. If the judge rejects, revise and call again.`}
          </div>
        </div>
        }
      {tab === "skills" &&
        <div className="grid-cards">
          {["es_index_sample", "schema_diff", "bash_safe", "git_branch_create", "claude_compose", "open_pr"].map((s) =>
          <div key={s} className="repo-card" style={{ cursor: "pointer" }} onClick={() => setRoute("skill-detail")}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Icon name="lib-skills" size={14} style={{ color: "var(--accent)" }} />
                <span className="nm mono">{s}</span>
              </div>
              <div className="desc">Allowed for this agent · used in 18 of last 22 runs.</div>
            </div>
          )}
        </div>
        }
      {tab === "runs" &&
        <div className="list">
          {[
          { id: "97fc5afd", node: "judge", status: "completed", dur: "1m 4s", when: "7h ago" },
          { id: "ce47ad23", node: "judge", status: "completed", dur: "7m 1s", when: "7h ago" },
          { id: "0cffb966", node: "designer", status: "failed", dur: "8m 23s", when: "7h ago" },
          { id: "9df8d8d4", node: "designer", status: "failed", dur: "8m 40s", when: "7h ago" },
          { id: "e2302770", node: "designer", status: "failed", dur: "10m 4s", when: "7h ago" }].
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
      {tab === "evals" &&
        <div className="card card-pad">
          <div className="mono" style={{ fontSize: 10.5, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-3)", marginBottom: 12 }}>Eval — speakers fixture</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
            <Stat label="Mean accuracy" v="0.872" delta="+4.1pp" deltaCls="up" />
            <Stat label="Protected drift" v="0.000" delta="ok" deltaCls="up" />
            <Stat label="Judge approval" v="92%" delta="+3pp" deltaCls="up" />
            <Stat label="Avg cost" v="$0.42" />
          </div>
        </div>
        }
      {tab === "settings" &&
        <div className="card card-pad-lg">
          <FieldRow label="Allowed models">
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{["sonnet", "opus", "gpt-5.5"].map((m) => <span key={m} className="badge"><span className="mono">{m}</span></span>)}</div>
          </FieldRow>
          <FieldRow label="Max iterations"><input className="input mono" defaultValue="10" style={{ width: 80 }} /></FieldRow>
          <FieldRow label="Require judge approval"><div className="toggle on" /></FieldRow>
        </div>
        }
    </div>);

  };

  const FieldRow = ({ label, desc, children }) =>
  <div className="field">
    <div className="label-block">
      <div className="label">{label}</div>
      {desc && <div className="desc">{desc}</div>}
    </div>
    <div>{children}</div>
  </div>;


  const SkillDetail = ({ setRoute }) =>
  <div className="ad-scope view-inner">
    <BackLink to="library-skills" label="Library / Skills" setRoute={setRoute} />
    <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18 }}>
      <div className="icon-box accent" style={{ width: 44, height: 44, borderRadius: 10 }}><Icon name="lib-skills" size={20} /></div>
      <div>
        <h1 className="page-h1" style={{ fontSize: 22, marginBottom: 4, fontFamily: "var(--font-mono)" }}>schema_diff</h1>
        <div className="mono" style={{ fontSize: 12, color: "var(--text-3)" }}>TypeScript · owner: pipeline · v2.1.4</div>
      </div>
      <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
        <button className="btn"><Icon name="edit" size={13} className="ico" />Edit</button>
        <button className="btn primary"><Icon name="play" size={13} className="ico" />Try</button>
      </div>
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 24 }}>
      <div>
        <div className="card card-pad" style={{ marginBottom: 16 }}>
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.65 }}>Compare two OpenSearch index mappings and emit a semver-style report. Detects breaking field type changes, enum tombstones, and missing extraction rules.</p>
        </div>
        <div className="section-h"><span className="t">Signature</span></div>
        <div className="code-block">
          <div className="code-line"><span className="ln">1</span><span className="c"><span className="kw">function</span> schema_diff(args: {`{`}</span></div>
          <div className="code-line"><span className="ln">2</span><span className="c">  before: <span className="kw">Mapping</span>;</span></div>
          <div className="code-line"><span className="ln">3</span><span className="c">  after: <span className="kw">Mapping</span>;</span></div>
          <div className="code-line"><span className="ln">4</span><span className="c">  protected_fields?: <span className="kw">string</span>[];</span></div>
          <div className="code-line"><span className="ln">5</span><span className="c">{`}`}): <span className="kw">DiffReport</span></span></div>
        </div>
        <div className="section-h"><span className="t">Used by</span></div>
        <div className="list">
          {["schema-designer", "schema-designer-judge", "indexer-coordinator"].map((a) =>
          <div key={a} className="row compact" onClick={() => setRoute("agent-detail")}>
              <div className="icon-box agent"><Icon name="users" size={13} /></div>
              <span className="mono" style={{ flex: 1, fontSize: 12.5 }}>{a}</span>
              <Icon name="arr-r" size={12} style={{ color: "var(--text-3)" }} />
            </div>
          )}
        </div>
      </div>
      <aside>
        <div className="card">
          <SideField label="Language" v={<span className="badge"><span className="mono">TypeScript</span></span>} />
          <SideField label="Owner" v="pipeline team" />
          <SideField label="Uses · 30d" v={<span className="mono" style={{ fontSize: 11 }}>178</span>} />
          <SideField label="Source" v={<span className="mono" style={{ fontSize: 11, color: "var(--accent)" }}>allen/skills/schema_diff.ts</span>} />
        </div>
      </aside>
    </div>
  </div>;


  const RepoDetail = ({ setRoute }) =>
  <div className="ad-scope view-inner">
    <BackLink to="library-repos" label="Library / Repos" setRoute={setRoute} />
    <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18 }}>
      <div className="icon-box" style={{ width: 44, height: 44, borderRadius: 10 }}><Icon name="lib-repos" size={20} /></div>
      <div>
        <h1 className="page-h1" style={{ fontSize: 22, marginBottom: 4, fontFamily: "var(--font-mono)" }}>inomy-mono</h1>
        <div className="mono" style={{ fontSize: 12, color: "var(--text-3)" }}>github.com/inomy/inomy-mono · TypeScript</div>
      </div>
      <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
        <button className="btn"><Icon name="github" size={13} className="ico" />Open on GitHub</button>
        <button className="btn primary" onClick={() => setRoute("workspace-detail")}><Icon name="workspace" size={13} className="ico" />New workspace</button>
      </div>
    </div>
    <div className="stat-row">
      <Stat label="Agents" v="41" delta="+3 this week" deltaCls="up" />
      <Stat label="Open PRs" v="12" />
      <Stat label="Workspaces" v="22" />
      <Stat label="Last activity" v="12m" delta="ago" />
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      <div>
        <div className="section-h"><span className="t">Agents with access</span></div>
        <div className="list">
          {[
          { n: "schema-designer", role: "Pipeline", runs: 22 },
          { n: "engineering-lead", role: "Engineering", runs: 142 },
          { n: "backend-developer", role: "Engineering", runs: 64 },
          { n: "codebase-navigator", role: "Platform", runs: 318 }].
          map((x) =>
          <div key={x.n} className="row compact" onClick={() => setRoute("agent-detail")}>
              <div className="icon-box agent"><Icon name="users" size={13} /></div>
              <div className="titleblock grow">
                <div className="title mono" style={{ fontSize: 12.5 }}>{x.n}</div>
                <div className="sub mono">{x.role} · {x.runs} runs</div>
              </div>
              <Icon name="arr-r" size={12} style={{ color: "var(--text-3)" }} />
            </div>
          )}
        </div>
      </div>
      <div>
        <div className="section-h"><span className="t">Recent activity</span></div>
        <div className="list">
          {[
          { t: "PR #897 opened by shreemantkumar65", w: "3h ago", ico: "git-pr" },
          { t: "PR #629 merged", w: "5h ago", ico: "check-circle" },
          { t: "New workspace allen/some-random-shits-mpc92obu", w: "1d ago", ico: "workspace" },
          { t: "schema-designer ran 4 times", w: "1d ago", ico: "users" }].
          map((a, i) =>
          <div key={i} className="row compact">
              <Icon name={a.ico} size={13} style={{ color: "var(--text-3)" }} />
              <span style={{ flex: 1, fontSize: 13 }}>{a.t}</span>
              <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>{a.w}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  </div>;


  const IntegrationConfig = ({ setRoute, integrationId }) => {
    const i = { github: { name: "GitHub", ico: "github", scope: "5 repos" }, linear: { name: "Linear", ico: "linear", scope: "Inomy workspace" }, slack: { name: "Slack", ico: "slack", scope: "#allen-ci, #pricing" } }[integrationId || "github"] || { name: "GitHub", ico: "github", scope: "5 repos" };
    return (
      <div className="ad-scope view-inner">
      <BackLink to="library-integrations" label="Library / Integrations" setRoute={setRoute} />
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18 }}>
        <div className="icon-box" style={{ width: 44, height: 44, borderRadius: 10 }}><Icon name={i.ico} size={20} /></div>
        <div>
          <h1 className="page-h1" style={{ fontSize: 22, marginBottom: 4 }}>{i.name}</h1>
          <div className="mono" style={{ fontSize: 12, color: "var(--text-3)" }}>
            <span className="badge success" style={{ marginRight: 8 }}><span className="dot" />connected</span>
            {i.scope}
          </div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className="btn"><Icon name="refresh" size={13} className="ico" />Test connection</button>
          <button className="btn danger">Disconnect</button>
        </div>
      </div>
      <div className="card card-pad-lg">
        <FieldRow label="Installation" desc="Allen accesses GitHub via a fine-grained installation token.">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="check-circle" size={14} style={{ color: "var(--success)" }} />
            <span className="mono" style={{ fontSize: 12 }}>installed on inomy organization</span>
          </div>
        </FieldRow>
        <FieldRow label="Repositories" desc="Repos Allen agents can read and open PRs against.">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {["allen", "inomy-mono", "inomy-ai-service", "es-data-pipeline", "scraping-fleet"].map((r) =>
              <div key={r} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontFamily: "var(--font-mono)" }}>
                <Icon name="lib-repos" size={11} style={{ color: "var(--text-3)" }} />{r}
                <div className="toggle on" style={{ marginLeft: "auto" }} />
              </div>
              )}
          </div>
        </FieldRow>
        <FieldRow label="Default reviewers" desc="Allen will request these reviewers on agent-opened PRs.">
          <div style={{ display: "flex", gap: 6 }}>
            {["@manish-inomy", "@ajit-inomy"].map((r) => <span key={r} className="badge"><span className="mono">{r}</span></span>)}
            <button className="btn ghost sm"><Icon name="plus" size={11} className="ico" />Add</button>
          </div>
        </FieldRow>
        <FieldRow label="Branch naming" desc="Pattern for agent-created branches.">
          <input className="input mono" defaultValue="allen/{ticket_id}-{slug}-{hash}" />
        </FieldRow>
        <FieldRow label="CodeRabbit auto-resolve" desc="Let agents respond to CodeRabbit suggestions.">
          <div className="toggle on" />
        </FieldRow>
      </div>
    </div>);

  };

  // ────────────────────────────────────────────────────────────
  // WORKFLOWS
  // ────────────────────────────────────────────────────────────
  const WorkflowGraph = ({ editor, onSelect, selected }) => {
    const nodes = [
    { x: 60, y: 90, w: 180, label: "create_workspace", state: "ok", sub: "2.0s" },
    { x: 290, y: 90, w: 180, label: "investigate", state: "ok", sub: "1m 30s" },
    { x: 290, y: 230, w: 180, label: "engineering-lead", state: "current", sub: "running" },
    { x: 580, y: 230, w: 180, label: "human-approval", state: "pending", sub: "manual" },
    { x: 810, y: 230, w: 180, label: "open_pr", state: "idle", sub: "queued" },
    { x: 810, y: 90, w: 180, label: "post_slack", state: "idle", sub: "queued" }];

    const edges = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]];
    const stateColor = { ok: "var(--success)", current: "var(--accent)", pending: "var(--warning)", idle: "var(--text-3)" };
    const stateBg = { ok: "var(--success-tint)", current: "var(--accent-tint)", pending: "var(--warning-tint)", idle: "var(--surface-2)" };
    return (
      <div style={{ position: "relative", height: 380, width: "100%" }}>
      <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
        {edges.map(([a, b], i) => {
            const A = nodes[a],B = nodes[b];
            const ax = A.x + A.w,ay = A.y + 28;
            const bx = B.x,by = B.y + 28;
            return (
              <g key={i}>
              <path d={`M ${ax} ${ay} C ${ax + 40} ${ay}, ${bx - 40} ${by}, ${bx} ${by}`} fill="none" stroke="var(--border-strong)" strokeWidth="1.5" strokeDasharray={B.state === "idle" ? "4 4" : "0"} />
              <circle cx={bx} cy={by} r="3" fill="var(--border-strong)" />
            </g>);

          })}
      </svg>
      {nodes.map((n, i) => {
          const isSel = editor && selected === i;
          return (
            <div key={i} onClick={() => editor && onSelect && onSelect(i)} style={{
              position: "absolute", left: n.x, top: n.y, width: n.w,
              background: stateBg[n.state],
              border: `1px solid ${isSel ? "var(--accent)" : n.state === "current" ? "var(--accent)" : "var(--border)"}`,
              borderRadius: 8, padding: "10px 12px",
              fontFamily: "var(--font-mono)", cursor: editor ? "pointer" : "default"
            }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: stateColor[n.state] }} />
              <span style={{ fontSize: 12.5, fontWeight: 500 }}>{n.label}</span>
            </div>
            <div style={{ fontSize: 10.5, color: "var(--text-3)", marginTop: 4 }}>{n.sub}</div>
          </div>);

        })}
    </div>);

  };

  const WorkflowsScreen = ({ setRoute }) => {
    const workflows = [
    { name: "bug-investigate-and-fix", desc: "investigate → engineering-lead → open_pr", runs: 142, last: "6h ago", success: 87 },
    { name: "schema-designer", desc: "schema-designer → judge → evaluator → indexer-update", runs: 64, last: "7h ago", success: 92 },
    { name: "feature-plan-and-implement", desc: "clarify → plan → scaffold → implement → review → open_pr", runs: 23, last: "1d ago", success: 78 },
    { name: "ticket-dispatch", desc: "linear_pull → triage → spawn_agent → status_back", runs: 318, last: "12m ago", success: 95 },
    { name: "daily-status-prep", desc: "scrape → digest → post_slack", runs: 12, last: "1d ago", success: 100 },
    { name: "multi-repo-change-orchestration", desc: "plan → branch_per_repo → apply → cross-pr-link", runs: 9, last: "2d ago", success: 66 }];

    return (
      <div className="ad-scope view-inner">
      <div className="page-header">
        <div className="left">
          <h1 className="page-h1">Workflows</h1>
          <div className="page-sub">Declarative agent graphs with checkpointing, retries, and human approval gates.</div>
        </div>
        <div className="right">
          <button className="btn"><Icon name="import" size={13} className="ico" />Import YAML</button>
          <button className="btn primary"><Icon name="plus" size={13} className="ico" />New workflow</button>
        </div>
      </div>
      <div className="stat-row">
        <Stat label="Workflows" v="14" />
        <Stat label="Runs · 24h" v="568" delta="+11%" deltaCls="up" />
        <Stat label="Success rate" v="89%" delta="+3pp" deltaCls="up" />
        <Stat label="Median cost / run" v="$0.42" />
      </div>
      <div className="section-h">
        <span className="t">bug-investigate-and-fix · preview</span>
        <button className="link" onClick={() => setRoute("workflow-editor")}>Open in editor →</button>
      </div>
      <div className="wf-canvas"><WorkflowGraph /></div>
      <div className="section-h"><span className="t">All workflows</span></div>
      <div className="list">
        {workflows.map((w) =>
          <div key={w.name} className="row" onClick={() => setRoute("workflow-editor")}>
            <div className="icon-box accent"><Icon name="workflow" size={14} /></div>
            <div className="titleblock grow">
              <div className="title mono" style={{ fontFamily: "var(--font-mono)" }}>{w.name}</div>
              <div className="sub mono">{w.desc}</div>
            </div>
            <div style={{ display: "flex", gap: 14, fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--text-3)" }}>
              <span><span style={{ color: "var(--text)" }}>{w.runs}</span> runs</span>
              <span style={{ color: w.success >= 90 ? "var(--success)" : w.success >= 75 ? "var(--warning)" : "var(--danger)" }}>{w.success}% ok</span>
              <span>{w.last}</span>
            </div>
            <button className="btn sm" onClick={(e) => e.stopPropagation()}><Icon name="play" size={12} className="ico" />Run</button>
            <button className="btn icon sm" onClick={(e) => e.stopPropagation()}><Icon name="edit" size={12} /></button>
          </div>
          )}
      </div>
    </div>);

  };

  const WorkflowEditor = ({ setRoute }) => {
    const [selected, setSelected] = React.useState(2);
    return (
      <div className="ad-scope" style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "12px 24px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={() => setRoute("workflows")} className="btn ghost sm" style={{ height: 24, padding: "0 8px" }}>
          <Icon name="arr-l" size={12} className="ico" />Workflows
        </button>
        <Icon name="workflow" size={14} style={{ color: "var(--accent)" }} />
        <span className="mono" style={{ fontSize: 13.5, fontWeight: 500 }}>bug-investigate-and-fix</span>
        <span className="badge"><span className="mono">v4</span></span>
        <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>edited 2h ago by Manish</span>
        <div style={{ flex: 1 }} />
        <div className="run-tabs">
          <button className="tt active">Graph</button>
          <button className="tt">YAML</button>
          <button className="tt">Runs</button>
        </div>
        <button className="btn"><Icon name="save" size={13} className="ico" />Save draft</button>
        <button className="btn primary"><Icon name="play" size={13} className="ico" />Test run</button>
      </div>
      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 360px", overflow: "hidden" }}>
        <div className="wf-canvas" style={{ borderRadius: 0, border: "none", borderRight: "1px solid var(--border)" }}>
          <WorkflowGraph editor onSelect={(i) => setSelected(i)} selected={selected} />
          <div style={{ position: "absolute", top: 16, left: 16, display: "flex", gap: 6, background: "var(--surface)", padding: 4, borderRadius: 8, border: "1px solid var(--border)" }}>
            <button className="btn ghost sm"><Icon name="plus" size={12} className="ico" />Add node</button>
            <button className="btn ghost sm"><Icon name="git" size={12} className="ico" />Add edge</button>
          </div>
          <div style={{ position: "absolute", bottom: 16, left: 16, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-3)", background: "var(--surface)", padding: "4px 8px", borderRadius: 6, border: "1px solid var(--border)" }}>
            6 nodes · 5 edges · 1 human-approval
          </div>
        </div>
        <aside style={{ background: "var(--bg)", overflowY: "auto", padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="mono" style={{ fontSize: 10.5, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-3)" }}>Node · engineering-lead</div>
          <div className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div><div className="mono" style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 4 }}>label</div><input className="input" defaultValue="engineering-lead" /></div>
            <div><div className="mono" style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 4 }}>agent</div><window.ADDropdown options={["engineering-lead", "backend-developer"]} placeholder="engineering-lead" width="100%" /></div>
            <div><div className="mono" style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 4 }}>model</div><window.ADDropdown options={["opus", "sonnet", "gpt-5.5"]} placeholder="opus" width="100%" /></div>
            <div><div className="mono" style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 4 }}>retries</div><input className="input mono" defaultValue="2" /></div>
          </div>
          <div className="card card-pad">
            <div className="mono" style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 6 }}>guards</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}><div className="toggle on" /> Require human approval before next node</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}><div className="toggle" /> Abort on budget exceed</div>
            </div>
          </div>
        </aside>
      </div>
    </div>);

  };

  // ────────────────────────────────────────────────────────────
  // SETTINGS
  // ────────────────────────────────────────────────────────────
  const SettingsScreen = () => {
    const [section, setSection] = React.useState("profile");
    return (
      <div className="ad-scope view-inner">
      <div className="page-header">
        <div className="left">
          <h1 className="page-h1">Settings</h1>
          <div className="page-sub">Personal, organization, and runtime preferences.</div>
        </div>
      </div>
      <div className="settings-grid">
        <div className="set-nav">
          <div className="group">PERSONAL</div>
          {[["profile", "Profile"], ["appearance", "Appearance"], ["keybinds", "Keybinds"]].map(([id, lbl]) =>
            <div key={id} className={`it ${section === id ? "active" : ""}`} onClick={() => setSection(id)}>{lbl}</div>
            )}
          <div className="group">ORG</div>
          {[["members", "Members"], ["models", "Models & providers"], ["budgets", "Budgets"], ["secrets", "Secrets"], ["audit", "Audit log"], ["billing", "Billing"]].map(([id, lbl]) =>
            <div key={id} className={`it ${section === id ? "active" : ""}`} onClick={() => setSection(id)}>{lbl}</div>
            )}
        </div>
        <div>
          {section === "profile" &&
            <div className="card card-pad-lg">
              <FieldRow label="Display name" desc="Used in chat headers and human approval cards."><input className="input" defaultValue="Manish" /></FieldRow>
              <FieldRow label="Email" desc="Sign-in identity."><input className="input mono" defaultValue="manish@inomy.shop" readOnly /></FieldRow>
              <FieldRow label="Time zone"><window.ADDropdown options={["Asia/Kolkata (UTC+05:30)", "America/Los_Angeles", "UTC"]} placeholder="Asia/Kolkata (UTC+05:30)" width="100%" /></FieldRow>
              <FieldRow label="Default workspace"><window.ADDropdown options={["inomy-mono", "allen", "Auto"]} placeholder="inomy-mono" width="100%" /></FieldRow>
            </div>
            }
          {section === "appearance" &&
            <div className="card card-pad-lg">
              <FieldRow label="Theme"><div style={{ display: "flex", gap: 8 }}>{["light", "dark", "system"].map((o) => <button key={o} className="btn sm">{o}</button>)}</div></FieldRow>
              <FieldRow label="Density"><div style={{ display: "flex", gap: 8 }}>{["compact", "comfortable"].map((o) => <button key={o} className="btn sm">{o}</button>)}</div></FieldRow>
              <FieldRow label="Reduce motion"><div className="toggle" /></FieldRow>
            </div>
            }
          {section === "keybinds" &&
            <div className="card">
              {[["Open command palette", "⌘K"], ["New chat", "⌘N"], ["Toggle sidebar", "⌘\\"], ["Focus search", "/"], ["Cycle theme", "⌥⇧T"], ["Open last execution", "G then E"], ["Open tickets", "G then T"], ["Open pull requests", "G then P"]].map(([k, v]) =>
              <div key={k} className="row compact">
                  <span style={{ flex: 1 }}>{k}</span>
                  <kbd className="mono" style={{ padding: "2px 8px", border: "1px solid var(--border)", borderRadius: 5, fontSize: 11, background: "var(--surface-2)" }}>{v}</kbd>
                </div>
              )}
            </div>
            }
          {section === "members" &&
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>5 members</span>
                <button className="btn primary sm"><Icon name="plus" size={12} className="ico" />Invite</button>
              </div>
              <div className="list">
                {[
                { name: "Manish", email: "manish@inomy.shop", role: "Owner", last: "now" },
                { name: "Ajit", email: "ajit@inomy.shop", role: "Admin", last: "12m ago" },
                { name: "Shreemant Kumar", email: "shreemantkumar65@inomy.shop", role: "Member", last: "1h ago" },
                { name: "Ashish", email: "ashish@inomy.shop", role: "Member", last: "3h ago" },
                { name: "Saiteja Varma", email: "saitejavarma30@inomy.shop", role: "Member", last: "1d ago" }].
                map((m) =>
                <div key={m.email} className="row compact">
                    <div className="avatar" style={{ width: 28, height: 28 }}>{m.name[0]}</div>
                    <div className="titleblock grow"><div className="title">{m.name}</div><div className="sub mono">{m.email}</div></div>
                    <span className="badge">{m.role}</span>
                    <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>{m.last}</span>
                  </div>
                )}
              </div>
            </>
            }
          {section === "models" &&
            <div className="card card-pad-lg">
              <FieldRow label="Default provider"><window.ADDropdown options={["OpenAI · gpt-5.5", "Anthropic · claude-opus-4"]} placeholder="OpenAI · gpt-5.5" width="100%" /></FieldRow>
              <FieldRow label="Allow override per-agent"><div className="toggle on" /></FieldRow>
              <FieldRow label="Reasoning effort"><div style={{ display: "flex", gap: 8 }}>{["Low", "Medium", "High (default)", "Max"].map((o) => <button key={o} className="btn sm">{o}</button>)}</div></FieldRow>
            </div>
            }
          {section === "budgets" &&
            <div className="card card-pad-lg">
              <FieldRow label="Daily org cap" desc="Hard ceiling."><div style={{ display: "flex", alignItems: "center", gap: 8 }}><input className="input mono" defaultValue="200" style={{ width: 120 }} /><span className="mono text-3">USD</span></div></FieldRow>
              <FieldRow label="Per-run cap"><div style={{ display: "flex", alignItems: "center", gap: 8 }}><input className="input mono" defaultValue="5" style={{ width: 120 }} /><span className="mono text-3">USD</span></div></FieldRow>
              <FieldRow label="Alert thresholds"><div style={{ display: "flex", gap: 8 }}>{[50, 75, 90].map((p) => <span key={p} className="badge"><span className="mono">{p}%</span></span>)}</div></FieldRow>
            </div>
            }
          {section === "secrets" &&
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>5 keys · scoped to inomy</span>
                <button className="btn primary sm"><Icon name="plus" size={12} className="ico" />Add secret</button>
              </div>
              <div className="list">
                {[
                ["OPENAI_API_KEY", "sk-…AbCd", "all agents", "now"],
                ["ANTHROPIC_API_KEY", "sk-ant-…3FzQ", "all agents", "now"],
                ["GITHUB_PAT", "ghp_…7yQz", "platform team", "3d ago"],
                ["LINEAR_TOKEN", "lin_api_…r8x", "integrations", "1w ago"],
                ["SENTRY_DSN", "https://….ingest", "investigate-only", "2w ago"]].
                map(([k, v, scope, rotated]) =>
                <div key={k} className="row compact">
                    <Icon name="key" size={14} style={{ color: "var(--text-3)" }} />
                    <div className="titleblock grow"><div className="title mono" style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}>{k}</div><div className="sub mono">{v} · {scope}</div></div>
                    <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>rotated {rotated}</span>
                    <button className="btn icon sm"><Icon name="edit" size={12} /></button>
                    <button className="btn icon sm"><Icon name="trash" size={12} /></button>
                  </div>
                )}
              </div>
            </>
            }
          {section === "audit" &&
            <div className="list">
              {[
              ["manish@inomy.shop", "approved continue from investigate on b5e4c7d5", "12m ago"],
              ["ajit@inomy.shop", "dispatched ENG-1505 to schema-designer", "1h ago"],
              ["system", "auto-paused: daily cap reached", "6h ago"],
              ["shreemantkumar65", "opened PR #629", "1h ago"],
              ["manish@inomy.shop", "rotated GITHUB_PAT", "3d ago"]].
              map((r, i) =>
              <div key={i} className="row compact">
                  <span className="mono" style={{ fontSize: 12, color: "var(--text-2)", minWidth: 200 }}>{r[0]}</span>
                  <span style={{ flex: 1 }}>{r[1]}</span>
                  <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>{r[2]}</span>
                </div>
              )}
            </div>
            }
          {section === "billing" &&
            <div className="card card-pad-lg">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 24 }}>
                <Stat label="Plan" v="Team" />
                <Stat label="Seats" v="9 / 25" />
                <Stat label="This cycle" v="$1,284" delta="of $4,000 cap" />
              </div>
              <FieldRow label="Payment method"><div style={{ display: "flex", alignItems: "center", gap: 8 }}><Icon name="credit-card" size={16} /><span className="mono">Visa · •••• 4242 · exp 09/27</span></div></FieldRow>
            </div>
            }
        </div>
      </div>
    </div>);

  };

  Object.assign(window, { LibraryTeams, LibrarySkills, LibraryRepos, LibraryIntegrations, AgentDetail, SkillDetail, RepoDetail, IntegrationConfig, WorkflowsScreen, WorkflowEditor, SettingsScreen });
})();