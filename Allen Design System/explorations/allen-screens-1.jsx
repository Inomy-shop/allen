// Allen screens · list + detail views for tabs other than "new chat".
// Wrapped in <div className="ad-scope"> so design tokens (var(--surface)…)
// are isolated from our existing shell.

const { AdIcon: Icon } = window;

// ── Shared atoms ─────────────────────────────────────────────
const Stat = ({ label, v, delta, deltaCls }) =>
<div className="stat">
    <div className="label mono">{label}</div>
    <div className="v">{v}</div>
    {delta ? <div className={`delta mono ${deltaCls || ""}`}>{delta}</div> : null}
  </div>;


const StatusBadge = ({ s }) => {
  const map = {
    failed: { cls: "danger", ico: "x-circle", t: "failed" },
    completed: { cls: "success", ico: "check-circle", t: "completed" },
    cancelled: { cls: "", ico: "x-circle", t: "cancelled" },
    running: { cls: "info", ico: "play-circle", t: "running" },
    queued: { cls: "warning", ico: "clock", t: "queued" },
    approved: { cls: "success", ico: "check-circle", t: "approved" },
    idle: { cls: "warning", ico: "clock", t: "idle" },
    active: { cls: "success", ico: "circle-d", t: "active" }
  };
  const m = map[s] || map.idle;
  return (
    <span className={`badge ${m.cls}`}>
      <Icon name={m.ico} size={11} />
      {m.t}
    </span>);

};

const Tab = ({ v, ct, active, onClick }) =>
<button className="btn ghost sm"
style={{ color: active ? "var(--accent)" : "var(--text-2)", background: active ? "var(--accent-tint)" : "transparent" }}
onClick={onClick}>
    {v} {ct ? <span className="mono" style={{ marginLeft: 6, color: active ? "var(--accent)" : "var(--text-3)" }}>{ct}</span> : null}
  </button>;


const BackLink = ({ to, label, setRoute }) =>
<button onClick={() => setRoute(to)} className="btn ghost sm" style={{ height: 24, padding: "0 8px", marginBottom: 14 }}>
    <Icon name="arr-l" size={12} className="ico" />{label}
  </button>;


const SideField = ({ label, v }) =>
<div style={{ display: "flex", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid var(--border-faint)", fontSize: 13 }}>
    <span style={{ color: "var(--text-3)", fontFamily: "var(--font-mono)", fontSize: 11, width: 80 }}>{label}</span>
    <span style={{ flex: 1, textAlign: "right" }}>{v}</span>
  </div>;


// ────────────────────────────────────────────────────────────
// CHATS
// ────────────────────────────────────────────────────────────
const ChatsScreen = ({ setRoute, setSelectedChat }) => {
  const chats = [
  { id: "ch-001", title: "Improve deal boosting with price history metrics", msgs: 8, w: "22h ago", who: "manish@inomy.shop" },
  { id: "ch-002", title: "Design response strategy agent templates", msgs: 120, w: "1d ago", who: "manish@inomy.shop" },
  { id: "ch-003", title: "Debug missing iPad Pro in Allen chat", msgs: 22, w: "3d ago", who: "manish@inomy.shop" },
  { id: "ch-004", title: "Debug dev.inomy.shop dashboard chat error", msgs: 6, w: "4d ago", who: "manish@inomy.shop" },
  { id: "ch-005", title: "Find new product condition filtering in Allen search", msgs: 8, w: "5d ago", who: "manish@inomy.shop" },
  { id: "ch-006", title: "Plan a Q3 migration for the inomy-mono workspace bootstrap", msgs: 4, w: "5d ago", who: "manish@inomy.shop" },
  { id: "ch-007", title: "Audit which spawn_agent calls fail with ENOENT on staging", msgs: 14, w: "1w ago", who: "manish@inomy.shop" },
  { id: "ch-008", title: "Rewrite the executions inspector breadcrumb logic", msgs: 31, w: "1w ago", who: "manish@inomy.shop" },
  { id: "ch-009", title: "Brainstorm naming for the response experience studio", msgs: 9, w: "2w ago", who: "manish@inomy.shop" }];

  return (
    <div className="ad-scope view-inner">
      <div className="page-header">
        <div className="left">
          <h1 className="page-h1">Chats</h1>
          <div className="page-sub">Pick up where conversations left off.</div>
        </div>
        <div className="right">
          <button className="btn"><Icon name="refresh" size={13} className="ico" /></button>
          <button className="btn primary" onClick={() => setRoute("home")}>
            <Icon name="plus" size={13} className="ico" />New chat
          </button>
        </div>
      </div>
      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <div className="search-input" style={{ flex: 1 }}>
          <Icon name="search" size={13} />
          <input placeholder="Search conversations…" />
        </div>
        <window.ADDropdown options={["Manish (me)", "All members"]} placeholder="Manish (me)" />
        <window.ADDropdown options={["All providers", "Codex (CLI)", "Claude (CLI)"]} placeholder="All providers" />
      </div>
      <div className="list">
        {chats.map((c) =>
        <div key={c.id} className="row" onClick={() => {setSelectedChat && setSelectedChat(c.id);setRoute("chat-detail");}}>
            <div className="icon-box"><Icon name="message" size={14} /></div>
            <div className="titleblock grow">
              <div className="title">{c.title}</div>
              <div className="sub mono">{c.who}</div>
            </div>
            <span className="badge"><span className="mono">{c.msgs} messages</span></span>
            <span className="mono" style={{ fontSize: 11.5, color: "var(--text-3)", width: 72, textAlign: "right" }}>{c.w}</span>
          </div>
        )}
      </div>
    </div>);

};

const CHAT_SIDE_TABS = [
{ id: "tasks", label: "Tasks", count: 1, ico: "tasks" },
{ id: "execs", label: "Executions", count: 1, ico: "execs" },
{ id: "artifacts", label: "Artifacts", count: null, ico: "artifacts" },
{ id: "files", label: "Files", count: 1, ico: "code" }];


const ChatSideTabIcon = ({ id }) => {
  const sp = { width: 13, height: 13, fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round" };
  switch (id) {
    case "tasks":
      return <svg viewBox="0 0 24 24" {...sp}><line x1="9" y1="6" x2="20" y2="6" /><line x1="9" y1="12" x2="20" y2="12" /><line x1="9" y1="18" x2="20" y2="18" /><polyline points="3 6 4.5 7.5 6 5" /><polyline points="3 12 4.5 13.5 6 11" /><polyline points="3 18 4.5 19.5 6 17" /></svg>;
    case "execs":
      return <svg viewBox="0 0 24 24" {...sp}><circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="12" r="2" /><path d="M8 6h2a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H8" /><path d="M13 12h3" /></svg>;
    case "artifacts":
      return <svg viewBox="0 0 24 24" {...sp}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="9" y1="13" x2="15" y2="13" /><line x1="9" y1="17" x2="13" y2="17" /></svg>;
    case "code":
      return <svg viewBox="0 0 24 24" {...sp}><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>;
    default:return null;
  }
};

// Sidepanel tab contents — sample data; visual fidelity to the references.
const ChatSideContent = ({ tab, setRoute }) => {
  if (tab === "tasks") {
    const PRS = [
    { num: "627", state: "Open", age: "recently" },
    { num: "897", state: "Merged", age: "5h ago" }];

    const EXECS = [
    { n: 1, title: "multi-repo-change-orchestration", kind: "Workflow", status: "failed", progress: 0.40, summary: "Failed · $0.00",
      steps: [
      { name: "Understand Request", who: "requirements-analyst", dur: "1m 30s", cost: "$0.12", model: "sonnet-4-6", status: "failed" },
      { name: "Clarify Request", who: "Human", status: "cancelled" },
      { name: "Plan Repo Changes", who: "engineering-lead", dur: "7m 23s", cost: "$0.51", model: "sonnet-4-6", status: "failed" },
      { name: "Review Repo Plan", who: "Human", status: "cancelled" },
      { name: "Execute Repo Plan", who: "engineering-lead", status: "cancelled" },
      { name: "Final Summary", who: "documentation-writer", status: "cancelled" }]

    },
    { n: 2, title: "feature-plan-and-implement", kind: "Workflow", status: "failed", progress: 0.45, summary: "Failed at Implementation Self Check · $…" },
    { n: 3, title: "chat:spawn_agent/backend-developer", kind: "Agent", status: "completed", progress: 1, summary: "Completed · $2.49" }];

    const renderStepDot = (s) => {
      if (s === "completed" || s === "failed") {
        return (
          <div className="cs-step-dot cs-step-dot-done" data-status={s}>
            <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>);

      }
      return <div className="cs-step-dot cs-step-dot-empty" />;
    };
    return (
      <div className="cs-tab-pane">
        <div className="cs-overline">
          <span className="cs-bad">Cancelled</span>
          <span className="cs-sep">·</span><span>0%</span>
          <span className="cs-sep">·</span><span>$79.68</span>
          <span className="cs-sep">·</span><span>0 / 1</span>
        </div>

        <div className="cs-overline cs-overline-strong" style={{ marginTop: 22 }}>
          <span>PULL REQUESTS</span><span className="mono">{PRS.length}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
          {PRS.map((p) =>
          <div key={p.num} className="cs-pr-card">
              <span className="cs-pr-tag">PULL REQUEST</span>
              <span className="cs-pr-num">PR #{p.num} <span className={`cs-pr-state ${p.state.toLowerCase()}`}>{p.state}</span></span>
              <span style={{ flex: 1 }} />
              <span className="cs-pr-age mono">{p.age}</span>
              <button className="cs-icon-btn" title="Open PR"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg></button>
              <button className="cs-icon-btn" title="View branch"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M13 6h3a2 2 0 0 1 2 2v7" /><line x1="6" y1="9" x2="6" y2="21" /></svg></button>
            </div>
          )}
        </div>

        <div className="cs-overline cs-overline-strong" style={{ marginTop: 24 }}>
          <span>EXECUTIONS</span><span className="mono">40</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 10 }}>
          {EXECS.map((e) =>
          <div key={e.n} className="cs-ex-block">
              <div className="cs-ex-row">
                <div className={`cs-ex-status cs-ex-status-${e.status}`}>
                  {e.status === "completed" ?
                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg> :

                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                }
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="cs-ex-title">Execution {e.n}: {e.title}</div>
                  <div className="cs-ex-meta mono"><span>{e.kind}</span><span className="cs-sep">·</span><span>{e.summary}</span></div>
                </div>
                <div className="cs-ex-bar">
                  <div className={`cs-ex-bar-fill cs-ex-bar-${e.status}`} style={{ width: `${e.progress * 100}%` }} />
                </div>
                {e.steps ?
              <button className="cs-icon-btn" title="Collapse"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg></button> :

              <button className="cs-icon-btn" title="Expand"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 6 15 12 9 18" /></svg></button>
              }
                <button className="cs-icon-btn" title="Open"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg></button>
              </div>
              {e.steps ?
            <div className="cs-ex-steps">
                  {e.steps.map((s, i) =>
              <div key={i} className="cs-ex-step">
                      <div className="cs-ex-step-rail">
                        {renderStepDot(s.status)}
                        {i < e.steps.length - 1 ? <div className="cs-ex-step-line" /> : null}
                      </div>
                      <div className="cs-ex-step-body">
                        <div className="cs-ex-step-name">{s.name}</div>
                        <div className="cs-ex-step-meta mono">
                          <span>{s.who}</span>
                          {s.dur ? <><span className="cs-sep">·</span><span>{s.dur}</span></> : null}
                          {s.cost ? <><span className="cs-sep">·</span><span>{s.cost}</span></> : null}
                          {!s.dur && s.status === "cancelled" ? <><span className="cs-sep">·</span><span>cancelled</span></> : null}
                        </div>
                      </div>
                      {s.model ? <span className="cs-ex-step-model mono">{s.model}</span> : null}
                      <button className="cs-icon-btn"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 6 15 12 9 18" /></svg></button>
                    </div>
              )}
                </div> :
            null}
            </div>
          )}
        </div>
      </div>);

  }

  if (tab === "execs") {
    return (
      <div className="cs-tab-pane">
        <div className="cs-exec-card">
          <button className="cs-exec-chev">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 6 15 12 9 18" />
            </svg>
          </button>
          <div className="cs-exec-icon">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="6" y="3" width="12" height="8" rx="2" />
              <path d="M4 7h2M18 7h2" />
              <path d="M9 11v3M15 11v3" />
              <rect x="5" y="14" width="14" height="7" rx="2" />
              <circle cx="9.5" cy="17.5" r="0.6" fill="currentColor" />
              <circle cx="14.5" cy="17.5" r="0.6" fill="currentColor" />
            </svg>
          </div>
          <div className="cs-exec-body">
            <div className="cs-exec-title-row">
              <div className="cs-exec-title">Execution 1: chat:spawn_agent/codebase-navigator</div>
              <span className="badge danger"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>FAILED</span>
            </div>
            <div className="cs-exec-meta mono">Agent · chat:spawn_agent/codebase-navigator · Failed · $0.00</div>
            <div className="cs-exec-meta mono cs-exec-id"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: "-2px", marginRight: 4 }}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>fb854169…a26c</div>
            <div className="cs-exec-meta mono" style={{ color: "var(--text-3)" }}>Read-only investigation: determine the primary button colo…</div>
          </div>
          <button className="cs-exec-detail" onClick={() => setRoute("execution-detail")}>
            See detailed execution
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
          </button>
        </div>
      </div>);

  }

  if (tab === "artifacts") {
    const FILES = [
    { name: "phase-2-mono-validation-remediation-plan.md", desc: "Phase 2 inomy-mono QA/acceptance status and remediation plan", kind: "Markdown", size: "4.4 KB", age: "2d ago", active: true },
    { name: "response-experience-phase-2-implementation-plan.md", kind: "Markdown", age: "2d ago" },
    { name: "phase2-repo-impact-plan.md", kind: "Markdown", age: "2d ago" },
    { name: "normalized-intake-brief.md", kind: "Markdown", age: "2d ago" },
    { name: "tdd-audit-r2.md", kind: "Markdown", age: "2d ago" },
    { name: "tdd-audit.md", kind: "Markdown", age: "2d ago" },
    { name: "technical-design.md", kind: "Markdown", age: "2d ago" },
    { name: "hla-audit-r2.md", kind: "Markdown", age: "2d ago" },
    { name: "hla-audit.md", kind: "Markdown", age: "2d ago" },
    { name: "architecture.md", kind: "Markdown", age: "2d ago" }];

    const active = FILES.find((f) => f.active) || FILES[0];
    return (
      <div className="cs-tab-pane">
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
          <button className="cs-pill">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
            </svg>
            Hide list
          </button>
        </div>
        <div className="cs-artifacts">
          <div className="cs-art-list">
            {FILES.map((f) =>
            <div key={f.name} className={"cs-art-row" + (f.active ? " is-active" : "")}>
                <span className="cs-art-icon">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
                  </svg>
                </span>
                <div className="cs-art-body">
                  <div className="cs-art-name">{f.name}</div>
                  <div className="cs-art-meta mono">{f.kind} · {f.age}</div>
                </div>
                <svg className="cs-art-chev" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 6 15 12 9 18" /></svg>
              </div>
            )}
          </div>
          <div className="cs-art-preview">
            <div className="cs-art-pv-head">
              <span className="cs-art-icon">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
                </svg>
              </span>
              <span style={{ flex: 1, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{active.name}</span>
              <button className="cs-icon-btn" title="Copy"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg></button>
              <button className="cs-icon-btn" title="Open"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg></button>
              <button className="cs-icon-btn" title="Download"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg></button>
              <button className="cs-icon-btn" title="Close"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg></button>
            </div>
            <div className="cs-art-pv-meta mono">MARKDOWN · 4.4 KB</div>
            <div className="cs-art-pv-desc">Phase 2 inomy-mono QA/acceptance status and remediation plan</div>
            <div className="cs-art-pv-fail mono">Failed to load: HTTP 500</div>
          </div>
        </div>
      </div>);

  }

  if (tab === "files") {
    return <ChatFilesPane />;
  }

  return null;
};

// Files sub-pane — own state for changed / browse / terminal
function ChatFilesPane() {
  const [view, setView] = React.useState("browse");
  const ENTRIES = [
  { kind: "folder", name: ".claude" }, { kind: "folder", name: ".codex" }, { kind: "folder", name: ".husky" }, { kind: "folder", name: ".vscode" },
  { kind: "folder", name: "apps" }, { kind: "folder", name: "docs" }, { kind: "folder", name: "infra" }, { kind: "folder", name: "packages" },
  { kind: "folder", name: "reports" }, { kind: "folder", name: "skills" },
  { kind: "file", name: ".dockerignore" }, { kind: "file", name: ".env.example" }, { kind: "file", name: ".mcp.json" }, { kind: "file", name: ".npmrc" },
  { kind: "file", name: "AGENTS.md" }, { kind: "file", name: "buildspec.yml" }, { kind: "file", name: "cdk.context.json" }, { kind: "file", name: "cdk.json" },
  { kind: "file", name: "CHAT_V2_IMPLEMENTATI…" }, { kind: "file", name: "CLAUDE.md" }, { kind: "file", name: "CODE_REVIEW_REPORT.md" },
  { kind: "file", name: "CODEBASE_CONTEXT.md" }, { kind: "file", name: "Dockerfile" }, { kind: "file", name: "GUEST_USER_IMPLEMENT…" }];

  return (
    <div className="cs-tab-pane">
      <div className="cs-pill-row">
        <button className={"cs-pill" + (view === "changed" ? " is-active" : "")} onClick={() => setView("changed")}>
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
          0 changed
        </button>
        <button className={"cs-pill" + (view === "browse" ? " is-active" : "")} onClick={() => setView("browse")}>
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
          Browse
        </button>
        <button className={"cs-pill" + (view === "term" ? " is-active" : "")} onClick={() => setView("term")}>
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></svg>
          Terminal
        </button>
      </div>

      {view === "changed" &&
      <div className="cs-files-grid">
          <div className="cs-files-list">
            <div className="cs-files-head mono"><span>FILES CHANGED</span><span style={{ marginLeft: "auto" }}>0</span></div>
            <div className="cs-files-empty">No changed files were found in the linked workspaces.</div>
          </div>
          <div className="cs-files-preview">
            <div className="cs-files-pv-head cs-files-pv-head-stack">
              <div className="cs-files-pv-title">
                <span className="cs-art-icon">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
                </span>
                <span className="mono" style={{ flex: 1, fontWeight: 500 }}>workspace preview</span>
              </div>
              <div className="cs-seg" role="tablist" style={{ width: "160px" }}>
                <button className="cs-seg-btn is-active" title="Unified diff view">
                  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="3" y1="6" x2="21" y2="6" />
                    <line x1="3" y1="12" x2="21" y2="12" />
                    <line x1="3" y1="18" x2="21" y2="18" />
                  </svg>
                  <span>unified</span>
                </button>
                <button className="cs-seg-btn" title="Side-by-side split">
                  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="4" width="8" height="16" rx="1.5" />
                    <rect x="13" y="4" width="8" height="16" rx="1.5" />
                  </svg>
                  <span>split</span>
                </button>
              </div>
            </div>
            <div className="cs-files-pv-empty mono">No changed file selected.</div>
          </div>
        </div>
      }

      {view === "browse" &&
      <div className="cs-files-grid">
          <div className="cs-files-list">
            <div className="cs-files-head mono"><span>FILE EXPLORER</span><span style={{ marginLeft: "auto" }}>2232</span></div>
            <div className="cs-fexp">
              {ENTRIES.map((e) =>
            <div key={e.name} className={"cs-fexp-row " + (e.kind === "folder" ? "is-folder" : "is-file")}>
                  {e.kind === "folder" &&
              <svg className="cs-fexp-chev" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 6 15 12 9 18" /></svg>
              }
                  <svg className="cs-fexp-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    {e.kind === "folder" ?
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /> :
                <React.Fragment><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></React.Fragment>}
                  </svg>
                  <span className="mono">{e.name}</span>
                </div>
            )}
            </div>
          </div>
          <div className="cs-files-preview">
            <div className="cs-files-pv-head">
              <span className="cs-art-icon">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
              </span>
              <span style={{ fontWeight: 600 }}>inomy-mono</span>
            </div>
            <div className="cs-files-pv-empty">Select a file to preview it here.</div>
          </div>
        </div>
      }

      {view === "term" &&
      <div className="cs-term">
          <div className="cs-term-head">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></svg>
            <span className="mono">allen/phase-2-response-experience-studio-mono--mpdqcnq9</span>
            <span style={{ flex: 1 }} />
            <button className="cs-pill">
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
              workspace
            </button>
          </div>
          <div className="cs-term-body mono">
            <span style={{ color: "var(--success)" }}>ubuntu@ip-192-168-3-140</span>
            <span style={{ color: "var(--text-3)" }}>:</span>
            <span style={{ color: "var(--accent)" }}>~/.allen/workspaces/6a0d60315fc24e2b7f13bc76</span>
            <span style={{ color: "var(--text-3)" }}>$</span>
            <span className="cs-term-cursor" />
          </div>
        </div>
      }
    </div>);

}

// Bottom composer — smaller than the new-chat composer; uses real dropdowns.
function ChatComposerCompact() {
  return (
    <div className="cs-composer">
      <textarea placeholder="Message Allen…" rows={2} />
      <div className="cs-composer-foot">
        <button className="cs-composer-add" title="Attach a resource">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
        </button>
        {window.AgentDropdown ?
        <ChatChipDD icon={<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>} dropdownKey="AgentDropdown">Assistant</ChatChipDD> :
        null}
        {window.ModelDropdown ?
        <ChatChipDD dropdownKey="ModelDropdown" mono><span><span style={{ color: "var(--accent-green)" }}>Codex (CLI)</span> / gpt-5.5</span></ChatChipDD> :
        null}
        {window.ReasoningDropdown ?
        <ChatChipDD icon={<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z" /></svg>} dropdownKey="ReasoningDropdown">High (default)</ChatChipDD> :
        null}
        {window.RepoDropdown ?
        <ChatChipDD icon={<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>} dropdownKey="RepoDropdown" mono>inomy-mono</ChatChipDD> :
        null}
        <span style={{ flex: 1 }} />
        <button className="cs-composer-attach" title="Attach file">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66L9.41 17.41a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
        </button>
        <button className="cs-composer-send" title="Send">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: "rgb(255, 255, 255)" }}><line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" /></svg>
        </button>
      </div>
    </div>);

}

// Reusable chip dropdown (used by the chat composer).
function ChatChipDD({ children, icon, mono, dropdownKey }) {
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef(null);
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e) => {if (!wrapRef.current?.contains(e.target)) setOpen(false);};
    const onKey = (e) => {if (e.key === "Escape") setOpen(false);};
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {window.removeEventListener("mousedown", onDown);window.removeEventListener("keydown", onKey);};
  }, [open]);
  const Dropdown = window[dropdownKey];
  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button type="button" className={"cs-chip" + (mono ? " is-mono" : "") + (open ? " is-open" : "")} onClick={() => setOpen((o) => !o)}>
        {icon}
        <span>{children}</span>
        <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="cs-chip-caret"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {open && Dropdown ?
      <div style={{ position: "absolute", bottom: "calc(100% + 8px)", left: 0, zIndex: 60 }}>
          <Dropdown />
        </div> :
      null}
    </div>);

}

// Edge handle for the chat side panel — same pattern as the main sidebar.
// Arrow points toward the side that will be visible after the click.
function SideHandle({ open, onClick }) {
  return (
    <button
      className="cs-side-handle"
      title={open ? "Collapse side panel" : "Expand side panel"}
      onClick={onClick}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
      strokeLinecap="round" strokeLinejoin="round">
        {/* When open: chevron points → (collapse).  When closed: chevron points ← (expand). */}
        <polyline points={open ? "9 6 15 12 9 18" : "15 6 9 12 15 18"} />
      </svg>
    </button>);

}

const ChatDetail = ({ setRoute }) => {
  const [sideOpen, setSideOpen] = React.useState(true);
  const [sideTab, setSideTab] = React.useState("execs");
  const [sideFull, setSideFull] = React.useState(false);
  // Width comes from state so the boundary handle, fullscreen toggle, and
  // collapsed rail all keep the chat column at the right size.
  // Open = fixed 460; collapsed = 44 rail; full = 50% of the chat-detail grid
  // (handled by a CSS class, not a fixed px, so it always matches the chat column).
  const sideWidth = !sideOpen ? 44 : sideFull ? undefined : 460;
  return (
    <div className={"ad-scope chat-detail-grid" + (sideFull && sideOpen ? " is-side-full" : "")}>
    <div className="chat-canvas" style={{ height: "100%" }}>
    <div style={{ padding: "12px 24px 0", display: "flex", alignItems: "center", gap: 10 }}>
      <button onClick={() => setRoute("chats")} className="btn ghost sm" style={{ height: 24, padding: "0 8px" }}>
        <Icon name="arr-l" size={12} className="ico" />Chats
      </button>
      <span style={{ flex: 1, fontSize: 13.5, fontWeight: 500, letterSpacing: "-0.01em" }}>Improve deal boosting with price history metrics</span>
      {sideOpen ? null : null}
      <button className="btn ghost sm"><Icon name="users" size={12} className="ico" />Resources</button>
      <button className="btn ghost sm"><Icon name="external" size={12} className="ico" />Share</button>
    </div>
    <div className="chat-scroll">
      <div className="chat-msg">
        <div className="role"><span className="badge"><span className="dot" style={{ background: "var(--text-3)" }} />You</span> manish@inomy.shop · 22h ago</div>
        <div className="body">
          <p>I want to improve the deal boosting signal in our product search. We already compute <code>percent_from_median</code> on the frontend; can we mirror that on the backend so OpenSearch can rank?</p>
        </div>
      </div>
      <div className="chat-msg">
        <div className="role"><span className="badge accent"><span className="dot" /> codex</span><span className="mono">gpt-5.5 · 3.4s · $0.012</span></div>
        <div className="body">
          <h3>Mapping to our proposed OpenSearch fields</h3>
          <p>I traced this through <code>apps/api/src/products/graph_resolvers.ts</code> and <code>indexer/transforms.py</code>. Here's what's already in the index versus what we'd need to add.</p>
          <table>
            <thead><tr><th>Proposed field</th><th>Already available from frontend stats?</th></tr></thead>
            <tbody>
              <tr><td><code>raw_discount_pct</code></td><td>No</td></tr>
              <tr><td><code>price_history_count</code></td><td>Yes, roughly <code>price_change_count</code></td></tr>
              <tr><td><code>price_vs_median_pct</code></td><td>Yes, but frontend has opposite sign as <code>percent_from_median</code></td></tr>
              <tr><td><code>price_vs_lowest_pct</code></td><td>Can be derived from <code>current_price</code> + <code>lowest_price</code></td></tr>
              <tr><td><code>always_on_sale_ratio</code></td><td>No</td></tr>
              <tr><td><code>deal_confidence</code></td><td>No</td></tr>
              <tr><td><code>deal_score</code></td><td>No</td></tr>
            </tbody>
          </table>
          <p style={{ marginTop: 14 }}><strong>Important:</strong> frontend does <strong>not</strong> get <code>deal_score</code>, <code>deal_confidence</code>, or <code>always_on_sale_ratio</code> today.</p>
          <div className="tool-call">
            <div className="h">
              <Icon name="wrench" size={12} className="ico" />
              <span className="label">4 tool calls · Bash</span>
              <span className="cmd mono">command: /bin/bash -lc "sed -n '75,118p' apps/api/src/products/graph…"</span>
              <Icon name="chev-d" size={12} className="ico" />
            </div>
          </div>
        </div>
      </div>
      <div className="chat-msg">
        <div className="role"><span className="badge"><span className="dot" style={{ background: "var(--text-3)" }} />You</span> manish@inomy.shop · 21h ago</div>
        <div className="body">
          <p>Good — go add the three missing ones to the indexer transform. Keep the signs consistent, and add a regression test that pins <code>price_vs_median_pct</code> to <code>−percent_from_median</code> on a known fixture.</p>
        </div>
      </div>
      <div className="chat-msg">
        <div className="role"><span className="badge accent"><span className="dot" /> codex</span><span className="mono">writing patch…</span></div>
        <div className="body">
          <div className="code-block">
            <div className="code-line"><span className="ln">1</span><span className="c"><span className="com"># indexer/transforms.py</span></span></div>
            <div className="code-line"><span className="ln">2</span><span className="c"><span className="kw">def</span> compute_deal_signals(doc):</span></div>
            <div className="code-line"><span className="ln">3</span><span className="c">    median = doc.get(<span className="str">"median_price"</span>)</span></div>
            <div className="code-line"><span className="ln">4</span><span className="c">    cur = doc[<span className="str">"current_price"</span>]</span></div>
            <div className="code-line"><span className="ln">5</span><span className="c">    <span className="kw">if</span> median <span className="kw">and</span> median &gt; 0:</span></div>
            <div className="code-line"><span className="ln">6</span><span className="c">        doc[<span className="str">"price_vs_median_pct"</span>] = (cur - median) / median</span></div>
            <div className="code-line"><span className="ln">7</span><span className="c">    doc[<span className="str">"always_on_sale_ratio"</span>] = compute_aos_ratio(doc[<span className="str">"price_history"</span>])</span></div>
            <div className="code-line"><span className="ln">8</span><span className="c">    doc[<span className="str">"deal_score"</span>] = score(doc)</span></div>
          </div>
          <div className="tool-call" style={{ marginTop: 10 }}>
            <div className="h">
              <Icon name="file" size={12} className="ico" />
              <span className="label">edit</span>
              <span className="cmd mono">indexer/transforms.py · +18 −2</span>
              <span className="badge success" style={{ height: 16, fontSize: 10 }}><span className="dot" />applied</span>
            </div>
          </div>
          <div className="tool-call">
            <div className="h">
              <Icon name="terminal" size={12} className="ico" />
              <span className="label">bash</span>
              <span className="cmd mono">pytest indexer/tests/test_deal_signals.py -k median -q</span>
              <span className="badge success" style={{ height: 16, fontSize: 10 }}><span className="dot" />3 passed</span>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div className="chat-foot">
      <ChatComposerCompact />
    </div>
    </div>

    {sideOpen ?
      <aside className="cs-aside" style={{ width: sideWidth }}>
        <SideHandle open={sideOpen} onClick={() => setSideOpen((o) => !o)} />
        <div className="cs-aside-tabs">
          {CHAT_SIDE_TABS.map((t) =>
          <button key={t.id}
          className={"cs-aside-tab" + (sideTab === t.id ? " is-active" : "")}
          onClick={() => setSideTab(t.id)}>
              <ChatSideTabIcon id={t.ico} />
              <span>{t.label}</span>
              {t.count != null ? <span className="cs-aside-count mono">{t.count}</span> : null}
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button className="cs-aside-iconbtn" title={sideFull ? "Exit full width" : "Open in full"} onClick={() => setSideFull((v) => !v)}>
            {sideFull ?
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" /></svg> :

            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
            }
          </button>
        </div>
        <div className="cs-aside-body">
          <ChatSideContent tab={sideTab} setRoute={setRoute} />
        </div>
      </aside> :

      <aside className="cs-rail" style={{ width: sideWidth }}>
        <SideHandle open={sideOpen} onClick={() => setSideOpen((o) => !o)} />
        {CHAT_SIDE_TABS.map((t) =>
        <button key={t.id}
        className="cs-rail-btn"
        title={t.label}
        onClick={() => {setSideTab(t.id);setSideOpen(true);}}>
            <ChatSideTabIcon id={t.ico} />
          </button>
        )}
        <button className="cs-rail-btn" title="Terminal"
        onClick={() => {setSideTab("files");setSideOpen(true);}}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
          </svg>
        </button>
      </aside>
      }
  </div>);
};

// ────────────────────────────────────────────────────────────
// EXECUTIONS
// ────────────────────────────────────────────────────────────
const EXECUTIONS = [
{ id: "fb854169", node: "chat:spawn_agent/codebase-navigator", type: "chat", status: "failed", dur: "4.9s", when: "4h ago" },
{ id: "fc07ac88", node: "chat:spawn_agent/backend-developer", type: "chat", status: "failed", dur: "4.4s", when: "5h ago" },
{ id: "b9953afa", node: "chat:spawn_agent/daily-status-prep", type: "chat", status: "failed", dur: "4.1s", when: "6h ago" },
{ id: "b526af98", node: "chat:spawn_agent/schema-designer", type: "chat", status: "failed", dur: "37.1s", when: "6h ago" },
{ id: "d4d1081c", node: "chat:spawn_agent/schema-designer", type: "chat", status: "failed", dur: "38.0s", when: "6h ago" },
{ id: "97fc5afd", node: "schema-designer:spawn_agent/schema-designer-judge", type: "agent", status: "completed", dur: "1m 4s", when: "7h ago" },
{ id: "0cffb966", node: "chat:spawn_agent/schema-designer", type: "chat", status: "failed", dur: "8m 23s", when: "7h ago" },
{ id: "9df8d8d4", node: "chat:spawn_agent/schema-designer", type: "chat", status: "failed", dur: "8m 40s", when: "7h ago" },
{ id: "e2302770", node: "chat:spawn_agent/schema-designer", type: "chat", status: "failed", dur: "10m 4s", when: "7h ago" },
{ id: "ce47ad23", node: "schema-designer:spawn_agent/schema-designer-judge", type: "agent", status: "completed", dur: "7m 1s", when: "7h ago" },
{ id: "fef44b5a", node: "schema-designer:spawn_agent/schema-evaluator", type: "agent", status: "completed", dur: "2m 53s", when: "7h ago" },
{ id: "b5e4c7d5", node: "workflow:bug-investigate-and-fix/investigate", type: "workflow", status: "cancelled", dur: "1m 30s", when: "6d ago" },
{ id: "ac99e012", node: "workflow:feature-plan-and-implement/scaffold", type: "workflow", status: "running", dur: "running", when: "now" },
{ id: "d11ec3f4", node: "ticket:dispatch/ENG-1505", type: "agent", status: "queued", dur: "—", when: "now" }];


const ExecutionsScreen = ({ setRoute, setSelectedExec }) => {
  const [tab, setTab] = React.useState("recent");
  const runningCount = EXECUTIONS.filter((e) => e.status === "running" || e.status === "queued").length;
  const shown = tab === "running" ? EXECUTIONS.filter((e) => e.status === "running" || e.status === "queued") : EXECUTIONS;
  return (
    <div className="ad-scope view-inner">
      <div className="page-header">
        <div className="left">
          <h1 className="page-h1">Executions</h1>
          <div className="page-sub">What's running, queued, and just finished across the org.</div>
        </div>
        <div className="right">
          <button className="btn"><Icon name="download" size={13} className="ico" />Export</button>
          <button className="btn"><Icon name="refresh" size={13} className="ico" /></button>
        </div>
      </div>
      <div className="stat-row" style={{ gridTemplateColumns: "repeat(5, 1fr)" }}>
        <Stat label="Running" v="1" delta="2 queued" />
        <Stat label="Completed · 24h" v="892" delta="+12%" deltaCls="up" />
        <Stat label="Failed · 24h" v="148" delta="14% rate" deltaCls="down" />
        <Stat label="P50 duration" v="3.2s" />
        <Stat label="Spend · 24h" v="$84.20" delta="of $200" />
      </div>
      <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center" }}>
        <div className="search-input" style={{ flex: 1, maxWidth: 360 }}>
          <Icon name="search" size={13} />
          <input placeholder="Search id, workflow, node…" />
        </div>
        <window.ADDropdown options={["All types", "workflow", "chat", "agent"]} placeholder="All types" />
        <window.ADDropdown options={["All statuses", "running", "failed", "completed"]} placeholder="All statuses" />
        <window.ADDropdown options={["Last 24h", "Last 7d", "Last 30d"]} placeholder="Last 24h" />
      </div>
      <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
        <Tab v="running now" ct={runningCount} active={tab === "running"} onClick={() => setTab("running")} />
        <Tab v="recent executions" ct="50" active={tab === "recent"} onClick={() => setTab("recent")} />
      </div>
      <div className="list">
        <div className="exec-row" style={{ background: "var(--surface-2)", fontFamily: "var(--font-mono)", fontSize: 10.5, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-3)", cursor: "default" }}>
          <span>ID</span><span>Node</span>
          <span style={{ textAlign: "right" }}>Type</span>
          <span style={{ textAlign: "right" }}>Status</span>
          <span style={{ textAlign: "right" }}>Duration</span>
          <span style={{ textAlign: "right" }}>When</span>
        </div>
        {shown.map((e) => {
          const [agent, sub] = e.node.split(":");
          return (
            <div key={e.id} className="exec-row" onClick={() => {setSelectedExec && setSelectedExec(e.id);setRoute("execution-detail");}}>
              <span className="exec-id mono">{e.id}</span>
              <span className="exec-node mono">
                <span style={{ color: "var(--text-3)" }}>{agent}</span>
                <span className="sep">:</span>
                <span className="agent">{sub}</span>
              </span>
              <span style={{ textAlign: "right" }}><span className="badge"><span className="mono">{e.type}</span></span></span>
              <span style={{ textAlign: "right" }}><StatusBadge s={e.status} /></span>
              <span className="exec-dur mono">{e.dur}</span>
              <span className="exec-time mono" style={{ textAlign: "right" }}>{e.when}</span>
            </div>);

        })}
      </div>
    </div>);

};

const Collapsible = ({ title, icon, meta, defaultOpen, children, ok }) => {
  const [open, setOpen] = React.useState(!!defaultOpen);
  return (
    <div style={{ borderBottom: "1px solid var(--border-faint)" }}>
      <button onClick={() => setOpen((o) => !o)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", textAlign: "left" }}>
        <Icon name={open ? "chev-d" : "chev-r"} size={12} />
        <Icon name={ok ? "check-circle" : icon} size={13} style={{ color: ok ? "var(--success)" : "var(--text-3)" }} />
        <span className="mono" style={{ fontSize: 10.5, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-3)" }}>{title}</span>
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>{meta}</span>
      </button>
      {open && children}
    </div>);

};

const ExecutionDetail = ({ execId, setRoute }) => {
  const [tab, setTab] = React.useState("trace");
  const [nodeTab, setNodeTab] = React.useState("prompt");
  const isFailed = execId === "b5e4c7d5";
  const isJudge = execId === "97fc5afd";
  const isCompleted = isJudge || !isFailed && execId !== "ac99e012";
  const meta = isJudge ?
  { name: "schema-designer-judge", agent: "schema-designer", status: "completed", dur: "1m 4s", cost: "$0.57", model: "sonnet · claude-cli" } :
  isFailed ?
  { name: "bug-investigate-and-fix", agent: "Manish", status: "failed", dur: "1m 30s", cost: "$0.00 EST", model: "opus · claude-cli" } :
  { name: "schema-designer", agent: "Codex", status: "running", dur: "running", cost: "$0.12", model: "gpt-5.5 · codex-cli" };

  return (
    <div className="ad-scope view-inner">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text-3)" }}>
        <button onClick={() => setRoute("executions")} className="btn ghost sm" style={{ height: 22, padding: "0 6px" }}>
          <Icon name="arr-l" size={12} className="ico" />Activity
        </button>
        <span style={{ color: "var(--text-4)" }}>/</span>
        <span>{execId}</span>
      </div>
      <div className="run-head">
        <div className="icon-box agent" style={{ width: 36, height: 36 }}>
          <Icon name={isJudge ? "users" : "workflow"} size={16} />
        </div>
        <div>
          <div className="name">{meta.name}</div>
          <div className="meta mono">
            <StatusBadge s={meta.status} />
            <span>by {meta.agent}</span><span>·</span>
            <Icon name="clock" size={11} /><span>{meta.dur}</span>
            <span style={{ color: "var(--success)" }}>{meta.cost}</span><span>·</span><span>{meta.model}</span>
          </div>
        </div>
        <div className="actions">
          <button className="btn sm"><Icon name="logs" size={12} className="ico" />Logs <span className="mono" style={{ color: "var(--text-3)" }}>50</span></button>
          {!isJudge && <button className="btn sm"><Icon name="chart" size={12} className="ico" />State</button>}
          <button className="btn sm"><Icon name="wrench" size={12} className="ico" />Artifacts {isFailed && <span className="mono" style={{ color: "var(--text-3)" }}>1</span>}</button>
          {isCompleted && !isJudge && <button className="btn primary sm"><Icon name="play" size={12} className="ico" />Resume</button>}
          {isJudge && <button className="btn primary sm"><Icon name="play" size={12} className="ico" />Resume</button>}
          {isFailed && <button className="btn primary sm" style={{ background: "var(--danger)", borderColor: "var(--danger)" }}><Icon name="refresh" size={12} className="ico" />Retry</button>}
        </div>
      </div>
      {isFailed &&
      <div className="banner">
          <Icon name="alert" size={16} className="ico" />
          <div style={{ flex: 1 }}>
            <div className="t mono">FAILED AT <span className="at">investigate</span> &nbsp; <a style={{ color: "var(--accent)" }}>Inspect →</a></div>
            <div className="desc">Resume rewinds state to the checkpoint taken before the selected node and re-enters the graph from there. Upstream outputs and agent sessions are preserved.</div>
          </div>
          <div className="actions">
            <button className="btn primary sm" style={{ background: "var(--danger)", borderColor: "var(--danger)" }}>
              <Icon name="refresh" size={12} className="ico" />Continue from <span className="mono">investigate</span>
            </button>
          </div>
        </div>
      }
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
        <div className="run-tabs">
          <button className={`tt ${tab === "graph" ? "active" : ""}`} onClick={() => setTab("graph")}>Graph</button>
          <button className={`tt ${tab === "trace" ? "active" : ""}`} onClick={() => setTab("trace")}>Trace</button>
          <button className={`tt ${tab === "io" ? "active" : ""}`} onClick={() => setTab("io")}>I/O</button>
        </div>
        <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--text-3)" }}>1/2 nodes</span>
      </div>
      {isJudge ?
      <div className="card">
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-faint)", display: "flex", alignItems: "center", gap: 12, fontFamily: "var(--font-mono)", fontSize: 12 }}>
            <span style={{ color: "var(--text-3)" }}>PHASE</span>
            <span className="badge success"><span className="dot" />completed</span>
            <span style={{ color: "var(--text-4)", margin: "0 8px" }}>·</span>
            <Icon name="terminal" size={12} />
            <span style={{ color: "var(--text-3)" }}>CWD</span>
            <span>/home/ubuntu/.allen/repositories/es-data-pipeline</span>
          </div>
          <Collapsible title="PROMPT" icon="terminal" meta="2966 chars" defaultOpen={false}>
            <div className="code-block">You are the <code>schema-designer-judge</code>. Given the proposed schema diff at HEAD against <code>main</code>, decide if the change preserves index integrity, enum stability, and downstream contracts.</div>
          </Collapsible>
          <Collapsible title="RESPONSE" icon="check-circle" meta="1115 chars" defaultOpen={true} ok>
            <div style={{ padding: 18 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 12px" }}>Judge Verdict: <span style={{ color: "var(--success)" }}>APPROVED</span></h3>
              <p style={{ margin: "0 0 12px", lineHeight: 1.65, fontSize: 13.5 }}>
                <strong>Fix 1 — <code>design_and_type.mount_type</code>:</strong> Verified. <code>'Floor-Standing'</code> is absent from the 4-value enum. Extraction rules now explicitly list <code>'Floor-Standing'</code> / <code>'Floor Standing'</code> / <code>'Standing'</code> as synonyms routing to <code>'Freestanding'</code>.
              </p>
              <p style={{ margin: "0 0 12px", lineHeight: 1.65, fontSize: 13.5 }}>
                <strong>Fix 2 — <code>material_and_construction.base_material</code>:</strong> Verified. <code>'Steel'</code> and <code>'Iron'</code> are absent from the 12-value enum.
              </p>
              <p style={{ margin: 0, fontSize: 13.5 }}>
                <strong>Structural integrity:</strong> 23 fields unchanged, zero <code>keyword[]</code> violations.
              </p>
            </div>
          </Collapsible>
          <Collapsible title="TOOL CALLS" icon="wrench" meta="6" defaultOpen={false} />
        </div> :

      <div className="run-grid">
          <div className="trace-table">
            <div className="trace-row head">
              <span>NODE</span>
              <span style={{ textAlign: "right" }}>STATUS</span>
              <span style={{ textAlign: "right" }}>DURATION</span>
              <span style={{ textAlign: "right" }}>COST</span>
            </div>
            <div className="trace-row">
              <span>create_workspace</span>
              <span style={{ textAlign: "right" }}><StatusBadge s="completed" /></span>
              <span className="dur" style={{ textAlign: "right" }}>2.0s</span>
              <span className="cost" style={{ textAlign: "right" }}>$0.00 EST</span>
            </div>
            <div className="trace-row active">
              <span>investigate</span>
              <span style={{ textAlign: "right" }}><StatusBadge s={isFailed ? "cancelled" : "running"} /></span>
              <span className="dur" style={{ textAlign: "right" }}>1m 30s</span>
              <span className="cost" style={{ textAlign: "right" }}>$0.00 EST</span>
            </div>
            <div className="trace-row" style={{ opacity: 0.5 }}>
              <span style={{ color: "var(--text-3)" }}>engineering_lead</span>
              <span style={{ textAlign: "right" }}><StatusBadge s="queued" /></span>
              <span style={{ textAlign: "right" }}>—</span>
              <span style={{ textAlign: "right" }}>—</span>
            </div>
          </div>
          <div className="card">
            <div style={{ padding: 14 }}>
              <div style={{ marginBottom: 10, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>investigate</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                <StatusBadge s={isFailed ? "cancelled" : "running"} />
                <span className="badge"><span className="mono">1m 30s</span></span>
                <span className="badge"><span className="mono">$0.00 EST</span></span>
              </div>
              <div className="node-tabs">
                {["input state", "prompt", "response", "outputs", "inspector"].map((t) =>
              <button key={t} className={`ttt ${nodeTab === t.split(" ")[0] ? "active" : ""}`} onClick={() => setNodeTab(t.split(" ")[0])}>{t}</button>
              )}
              </div>
              <div className="code-block">
                <div className="code-line"><span className="ln">1</span><span className="c">Investigate this bug and find the root cause. This is a READ-ONLY</span></div>
                <div className="code-line"><span className="ln">2</span><span className="c">investigation step: do not edit files. Implementation happens in</span></div>
                <div className="code-line"><span className="ln">3</span><span className="c">the downstream <span className="kw">engineering-lead</span> node.</span></div>
                <div className="code-line"><span className="ln">4</span><span className="c"></span></div>
                <div className="code-line"><span className="ln">5</span><span className="c"><span className="com">BUG REPORT:</span> Claude chat fails with <span className="str">`spawn claude ENOENT`</span> even</span></div>
                <div className="code-line"><span className="ln">6</span><span className="c">though the Allen server env has <span className="str">`CLAUDE_BIN=/home/ubuntu/.local/bin/claude`</span>.</span></div>
              </div>
            </div>
          </div>
        </div>
      }
    </div>);

};

Object.assign(window, { AdStat: Stat, AdStatusBadge: StatusBadge, AdTab: Tab, AdBackLink: BackLink, AdSideField: SideField, ChatsScreen, ChatDetail, ExecutionsScreen, ExecutionDetail });