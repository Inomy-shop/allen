// Composer dropdown specimens — four redesigned popovers.
// Each cell shows the chip in its "active" state with the dropdown
// opened beneath it, so the relationship is unambiguous.

// ── Extra icons used here ─────────────────────────────────────
const DD = {
  Layers: (p) => <I {...p}><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></I>,
  Cube: (p) => <I {...p}><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" /></I>,
  Beaker: (p) => <I {...p}><path d="M9 3h6v6l5 8a3 3 0 0 1-3 5H7a3 3 0 0 1-3-5l5-8z" /><line x1="6" y1="14" x2="18" y2="14" /></I>,
  CheckSq: (p) => <I {...p}><polyline points="9 11 12 14 22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></I>,
  Bot: (p) => <I {...p}><rect x="3" y="11" width="18" height="10" rx="2" /><circle cx="12" cy="5" r="2" /><path d="M12 7v4" /><line x1="8" y1="16" x2="8" y2="16" /><line x1="16" y1="16" x2="16" y2="16" /></I>,
  Compass: (p) => <I {...p}><circle cx="12" cy="12" r="10" /><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" /></I>,
  Code: (p) => <I {...p}><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></I>,
  Hash: (p) => <I {...p}><line x1="4" y1="9" x2="20" y2="9" /><line x1="4" y1="15" x2="20" y2="15" /><line x1="10" y1="3" x2="8" y2="21" /><line x1="16" y1="3" x2="14" y2="21" /></I>,
  GitMark: (p) => <I {...p}><circle cx="12" cy="12" r="4" /><line x1="1.05" y1="12" x2="7" y2="12" /><line x1="17" y1="12" x2="22.96" y2="12" /></I>,
  Zap: (p) => <I {...p}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></I>,
  Sparkles: (p) => <I {...p}><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z" /></I>,
  Off: (p) => <I {...p}><circle cx="12" cy="12" r="10" /><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" /></I>,
  Folder: (p) => <I {...p}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></I>
};

function I({ children, size = 14 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>);

}

// ── Chip (matches composer footer) ────────────────────────────
function Chip({ icon: IconCmp, accent, mono, children, active }) {
  const styleCls =
  accent ? 'nc-chip nc-chip-accent' :
  mono ? 'nc-chip nc-chip-mono' : 'nc-chip';
  return (
    <button className={`${styleCls} ${active ? 'is-active' : ''}`}>
      {IconCmp ? <IconCmp size={13} /> : null}
      {children}
      <span className="caret">▾</span>
    </button>);

}

// ── Foot hints ────────────────────────────────────────────────
function Foot({ link }) {
  return (
    <div className="dd-foot">
      <span className="kbd">↑</span><span className="kbd">↓</span>
      <span>navigate</span>
      <span className="sep">·</span>
      <span className="kbd">↵</span>
      <span>select</span>
      <span className="sep">·</span>
      <span className="kbd">esc</span>
      <span>close</span>
      {link ? <a className="link" href="#">{link} →</a> : null}
    </div>);

}

// ── Item ──────────────────────────────────────────────────────
function Item({ icon: IconCmp, name, meta, tag, selected, active, rowClass = '' }) {
  return (
    <div className={`dd-item ${rowClass} ${selected ? 'is-selected' : ''} ${active && !selected ? 'is-active' : ''}`} style={{ backgroundColor: "rgba(223, 226, 247, 0)" }}>
      {IconCmp ? <span className="ico"><IconCmp /></span> : null}
      <span className="dd-item-label">
        <span className="name">{name}</span>
        {meta ? <span className="meta">{meta}</span> : null}
      </span>
      <span className="dd-item-trail">
        {tag ? <span className={`dd-tag ${tag === 'DEFAULT' ? 'accent' : ''}`}>{tag}</span> : null}
        {selected ?
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg> :
        null}
      </span>
    </div>);

}

// ════════════════════════════════════════════════════════════
// 1 · AGENT PICKER
// ════════════════════════════════════════════════════════════
function AgentDropdown() {
  return (
    <div className="dd dd-w-360">
      <span className="dd-tether" />
      <div className="dd-search">
        <span className="ico"><DD.Hash size={13} /></span>
        <input placeholder="Search agents..." />
        <span className="kbd">esc</span>
      </div>
      <div className="dd-body">
        <Item icon={DD.Bot} name="Assistant" meta="general purpose · routes everywhere" selected />

        <div className="dd-section"><span className="dot" /><span>Product</span><span className="count">5 agents</span></div>
        <Item icon={DD.CheckSq} name="Acceptance Tester" meta="quality team · l3" />
        <Item icon={DD.Compass} name="Brainstormer" meta="product team · l2" active />
        <Item icon={DD.Layers} name="Design Doc Auditor" meta="quality team · l3" />
        <Item icon={DD.Cube} name="Product Manager" meta="product team · lead" />
        <Item icon={DD.Beaker} name="Requirements Analyst" meta="product team · l2" />

        <div className="dd-section"><span className="dot" /><span>Engineering</span><span className="count">7 agents</span></div>
        <Item icon={DD.Code} name="Bug Fix L2" meta="engineering · specialist" />
        <Item icon={DD.Code} name="Implementation L2" meta="engineering · specialist" />
        <Item icon={DD.Code} name="PR Resolver" meta="engineering · review" />

        <div className="dd-section"><span className="dot" /><span>Meta</span><span className="count">3 agents</span></div>
        <Item icon={DD.Sparkles} name="Self-Healer" meta="meta team · monitor" />
      </div>
    </div>);

}

// ════════════════════════════════════════════════════════════
// 2 · MODEL PICKER
// ════════════════════════════════════════════════════════════
function ModelDropdown() {
  return (
    <div className="dd dd-w-360">
      <span className="dd-tether" />
      <div className="dd-search">
        <span className="ico"><DD.Hash size={13} /></span>
        <input placeholder="Search models..." />
        <span className="kbd">esc</span>
      </div>
      <div className="dd-body">
        <div className="dd-section codex"><span className="dot" /><span>Codex (CLI)</span><span className="count">5</span></div>
        <Item icon={DD.Zap} name="gpt-5.5" meta="200k context · default" tag="LATEST" selected />
        <Item icon={DD.Zap} name="gpt-5.4" meta="128k context" />
        <Item icon={DD.Zap} name="o3" meta="reasoning · 128k context" />
        <Item icon={DD.Zap} name="o4-mini" meta="fast · 32k context" />
        <Item icon={DD.Zap} name="codex-mini" meta="cheapest · 16k context" />

        <div className="dd-section claude"><span className="dot" /><span>Claude (CLI)</span><span className="count">3</span></div>
        <Item icon={DD.Sparkles} name="sonnet" meta="balanced · 200k context" />
        <Item icon={DD.Sparkles} name="opus" meta="best quality · 200k context" />
        <Item icon={DD.Sparkles} name="haiku" meta="fastest · 200k context" />
      </div>
    </div>);

}

// ════════════════════════════════════════════════════════════
// 3 · REASONING EFFORT
// ════════════════════════════════════════════════════════════
function ReasoningDropdown() {
  return (
    <div className="dd dd-w-360">
      <span className="dd-tether" />
      <div className="dd-section" style={{ paddingTop: 14 }}>
        <span className="dot" /><span>Reasoning effort</span>
        <span className="count">5 levels</span>
      </div>
      <div className="dd-body" style={{ paddingBottom: 4 }}>
        <Item rowClass="r-row" icon={DD.Off} name="Off" meta="No extended thinking" />
        <Item rowClass="r-row" icon={DD.Zap} name="Low" meta="Quick · ~1s overhead" />
        <Item rowClass="r-row" icon={DD.Sparkles} name="Medium" meta="Standard · balanced" />
        <Item rowClass="r-row" icon={DD.Sparkles} name="High" meta="Deliberate" tag="DEFAULT" selected />
        <Item rowClass="r-row" icon={DD.Sparkles} name="Max" meta="Opus only · slow" />
      </div>
    </div>);

}

// ════════════════════════════════════════════════════════════
// 4 · REPOSITORY PICKER
// ════════════════════════════════════════════════════════════
function RepoDropdown() {
  return (
    <div className="dd dd-w-440">
      <span className="dd-tether" />
      <div className="dd-current">
        <span className="label">Current</span>
        <span className="badge"><DD.Sparkles size={11} /> Auto</span>
        <span className="hint" style={{ width: "300px" }}>Allen will pick the right repo for the task</span>
      </div>
      <div className="dd-search">
        <span className="ico"><DD.Hash size={13} /></span>
        <input placeholder="Search 12 repositories..." />
        <span className="kbd">esc</span>
      </div>
      <div className="dd-body">
        <div className="dd-section"><span className="dot" /><span>Recent</span><span className="count">~/allen/repositories</span></div>
        <Item icon={DD.Folder} name="inomy-mono" meta="~/.allen/repositories/inomy-mono" tag="ts" />
        <Item icon={DD.Folder} name="inomy-ai-service" meta="~/.allen/repositories/inomy-ai-service" tag="py" />
        <Item icon={DD.Folder} name="allen" meta="~/.allen/repositories/allen" tag="ts" />
        <Item icon={DD.Folder} name="es-data-pipeline" meta="~/.allen/repositories/es-data-pipeline" tag="py" />
        <Item icon={DD.Folder} name="allen-website" meta="~/.allen/repositories/allen-website" tag="ts" />
      </div>
    </div>);

}

// ════════════════════════════════════════════════════════════
// PAGE
// ════════════════════════════════════════════════════════════
function ComposerDropdowns() {
  return (
    <div className="dd-page">
      <div className="dd-page-head">
        <div className="nc-overline-row" style={{ marginBottom: 12 }}>
          <span className="nc-overline-dot" />
          <span className="nc-overline">Composer · Chip menus</span>
        </div>
        <h1 className="dd-page-title">Four redesigned dropdowns</h1>
        <p className="dd-page-sub">
          Unified popover anatomy: search row · grouped sections with role-color dots · proper selected state (accent rail + soft fill + check) · trailing tags · keyboard hint footer. No more underlined headers, no more "current value pinned in blue" header pattern — moved to a clearly-labelled <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'rgb(var(--color-accent))', background: 'rgb(var(--color-accent-soft))', padding: '0 6px', borderRadius: 4 }}>Current</code> tile where it adds context.
        </p>
      </div>

      <div className="dd-grid">

        <div className="dd-cell">
          <div className="dd-cell-head">
            <span className="dd-cell-label">01</span>
            <span className="dd-cell-name">Agent picker</span>
            <span className="dd-cell-tag">search · grouped · 20+ agents</span>
          </div>
          <div className="dd-trigger-row">
            <Chip icon={DD.Bot} active>Assistant</Chip>
            <Chip mono>Codex (CLI) / gpt-5.5</Chip>
            <Chip icon={window.Icon.Sparkles}>High (default)</Chip>
            <Chip icon={window.Icon.Folder}>Auto</Chip>
            <span style={{ flex: 1 }} />
          </div>
          <AgentDropdown />
        </div>

        <div className="dd-cell">
          <div className="dd-cell-head">
            <span className="dd-cell-label">02</span>
            <span className="dd-cell-name">Model picker</span>
            <span className="dd-cell-tag">grouped by provider · color-coded</span>
          </div>
          <div className="dd-trigger-row">
            <Chip icon={DD.Bot}>Assistant</Chip>
            <Chip mono active>Codex (CLI) / gpt-5.5</Chip>
            <Chip icon={window.Icon.Sparkles}>High (default)</Chip>
            <Chip icon={window.Icon.Folder}>Auto</Chip>
            <span style={{ flex: 1 }} />
          </div>
          <ModelDropdown />
        </div>

        <div className="dd-cell">
          <div className="dd-cell-head">
            <span className="dd-cell-label">03</span>
            <span className="dd-cell-name">Reasoning effort</span>
            <span className="dd-cell-tag">5 levels · descriptive rows</span>
          </div>
          <div className="dd-trigger-row">
            <Chip icon={DD.Bot}>Assistant</Chip>
            <Chip mono>Codex (CLI) / gpt-5.5</Chip>
            <Chip icon={window.Icon.Sparkles} active>High (default)</Chip>
            <Chip icon={window.Icon.Folder}>Auto</Chip>
            <span style={{ flex: 1 }} />
          </div>
          <ReasoningDropdown />
        </div>

        <div className="dd-cell">
          <div className="dd-cell-head">
            <span className="dd-cell-label">04</span>
            <span className="dd-cell-name">Repository picker</span>
            <span className="dd-cell-tag">current pinned · paths · lang tag</span>
          </div>
          <div className="dd-trigger-row">
            <Chip icon={DD.Bot}>Assistant</Chip>
            <Chip mono>Codex (CLI) / gpt-5.5</Chip>
            <Chip icon={window.Icon.Sparkles}>High (default)</Chip>
            <Chip icon={window.Icon.Folder} active>Auto</Chip>
            <span style={{ flex: 1 }} />
          </div>
          <RepoDropdown />
        </div>

      </div>
    </div>);

}

window.ComposerDropdowns = ComposerDropdowns;
Object.assign(window, { AgentDropdown, ModelDropdown, ReasoningDropdown, RepoDropdown });