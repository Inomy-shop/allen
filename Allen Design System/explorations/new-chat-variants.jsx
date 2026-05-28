// Three UI variations of the New Chat dashboard.
// Same UX, same content, same sections — different visual treatment.

const { APPROVALS, RECENT } = window.NewChatData;

// ────────────────────────────────────────────────────────────
// SHARED FRAGMENTS
// ────────────────────────────────────────────────────────────

function GreetingBlock({ size = 'lg', inline = false }) {
  if (inline) {
    return (
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
        <h1 style={{
          margin: 0,
          fontSize: 28, fontWeight: 600, letterSpacing: '-0.015em',
          color: 'rgb(var(--color-text-primary))',
          whiteSpace: 'nowrap',
        }}>Good afternoon, Vallabh</h1>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'rgb(var(--color-text-muted))', whiteSpace: 'nowrap' }}>
          <span style={{ whiteSpace: 'nowrap' }}><span style={{ color: 'rgb(var(--color-accent-yellow))', fontWeight: 600 }}>4</span>&nbsp;approvals</span>
          <span style={{ color: 'rgb(var(--color-text-subtle))' }}>·</span>
          <span style={{ whiteSpace: 'nowrap' }}><span style={{ color: 'rgb(var(--color-text-primary))', fontWeight: 600 }}>0</span>&nbsp;running</span>
          <span style={{ color: 'rgb(var(--color-text-subtle))' }}>·</span>
          <span style={{ whiteSpace: 'nowrap' }}><span style={{ color: 'rgb(var(--color-text-primary))', fontWeight: 600 }}>2</span>&nbsp;recent</span>
        </div>
      </div>
    );
  }
  const fs = size === 'xl' ? 40 : size === 'lg' ? 32 : 24;
  return (
    <div>
      <div className="nc-overline-row" style={{ marginBottom: 14, whiteSpace: 'nowrap' }}>
        <span className="nc-overline-dot" />
        <span className="nc-overline">New Chat</span>
      </div>
      <h1 style={{
        margin: 0,
        fontSize: fs, fontWeight: 600, letterSpacing: '-0.018em',
        color: 'rgb(var(--color-text-primary))',
        lineHeight: 1.1,
        whiteSpace: 'nowrap',
      }}>Good afternoon, Vallabh</h1>
      <div style={{
        marginTop: 10,
        display: 'flex', alignItems: 'center', gap: 10,
        fontFamily: 'var(--font-mono)', fontSize: 12.5,
        color: 'rgb(var(--color-text-muted))',
        whiteSpace: 'nowrap',
      }}>
        <span style={{ whiteSpace: 'nowrap' }}><span style={{ color: 'rgb(var(--color-accent-yellow))', fontWeight: 600 }}>4</span>&nbsp;approvals</span>
        <span style={{ color: 'rgb(var(--color-text-subtle))' }}>·</span>
        <span style={{ whiteSpace: 'nowrap' }}><span style={{ color: 'rgb(var(--color-text-primary))', fontWeight: 600 }}>0</span>&nbsp;running</span>
        <span style={{ color: 'rgb(var(--color-text-subtle))' }}>·</span>
        <span style={{ whiteSpace: 'nowrap' }}><span style={{ color: 'rgb(var(--color-text-primary))', fontWeight: 600 }}>2</span>&nbsp;recent</span>
      </div>
    </div>
  );
}

function ApprovalRow({ a }) {
  return (
    <div className="nc-row">
      <span className={`nc-row-tag ${a.type === 'approval' ? 'approval' : 'question'}`}>
        {a.type === 'approval' ? 'Approval' : 'Question'}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="nc-row-title">{a.title}</div>
        <div className="nc-row-sub">{a.sub}</div>
      </div>
      <span className="nc-row-meta">{a.age}</span>
      <window.Icon.ChevRight size={14} />
    </div>
  );
}

function FlatApprovalRow({ a }) {
  return (
    <div className="nc-flat-row">
      <span className={`nc-row-tag ${a.type === 'approval' ? 'approval' : 'question'}`}>
        {a.type === 'approval' ? 'Approval' : 'Question'}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="nc-row-title">{a.title}</div>
        <div className="nc-row-sub">{a.sub}</div>
      </div>
      <span className="nc-row-meta">{a.age}</span>
      <window.Icon.ChevRight size={14} />
    </div>
  );
}

function CompactApprovalRow({ a }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 12px',
      borderRadius: 8,
      cursor: 'pointer',
    }} className="nc-compact-hover">
      <span style={{
        width: 6, height: 6, borderRadius: 999,
        background: a.type === 'approval' ? 'rgb(var(--color-accent-purple))' : 'rgb(var(--color-accent-yellow))',
        flexShrink: 0,
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'rgb(var(--color-text-primary))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.title}</div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgb(var(--color-text-muted))', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.sub}</div>
      </div>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgb(var(--color-text-subtle))', whiteSpace: 'nowrap' }}>{a.age}</span>
    </div>
  );
}

function RecentRow({ r }) {
  const sCls = r.status === 'failed' ? 'err' : r.status === 'running' ? 'run' : 'ok';
  return (
    <div className="nc-recent-row">
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="nc-recent-title">{r.title}</div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgb(var(--color-text-muted))', marginTop: 2 }}>{r.wf}</div>
      </div>
      <span className={`nc-recent-status ${sCls}`}>
        <span style={{
          width: 5, height: 5, borderRadius: 999,
          background: sCls === 'err' ? 'rgb(var(--color-accent-red))' : sCls === 'run' ? 'rgb(var(--color-accent-cyan))' : 'rgb(var(--color-accent-green))',
        }} />
        {r.status}
      </span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgb(var(--color-text-subtle))', minWidth: 24, textAlign: 'right' }}>{r.age}</span>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// VARIANT A — "Quiet focus" · centered single column · refined chrome
// ────────────────────────────────────────────────────────────
function VariantA() {
  const [collapsed, setCollapsed] = React.useState(false);
  return (
    <div className={`dash-artboard ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <window.DashSidebar collapsed={collapsed} />
      <button className="sidebar-handle" title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-label="Toggle sidebar" onClick={() => setCollapsed(v => !v)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <div className="main-col">
        <window.DashTopbar />
        <div className="main-body" style={{ overflowY: 'auto' }}>
          <div style={{ maxWidth: 1040, margin: '0 auto', padding: '56px 32px 64px' }}>
            {/* Hero */}
            <GreetingBlock size="lg" />

            {/* Composer */}
            <div className="nc-composer-A" style={{ marginTop: 28 }}>
              <div className="nc-caret-wrap">
                <textarea className="nc-composer-textarea" placeholder="Describe a task, paste a Linear ticket, or @mention an agent. Allen routes the work and runs it in an isolated workspace." />
                <span className="nc-caret" aria-hidden="true"></span>
              </div>
              <div className="nc-composer-A-foot">
                <window.ComposerChips />
                <span style={{ flex: 1 }} />
                <button className="nc-attach" title="Attach"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66L9.41 17.41a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></button>
                <button className="nc-send" title="Send"><window.Icon.ArrowRight size={15} /></button>
              </div>
            </div>

            {/* Approvals (left) + In Flight & Recent (right rail), side-by-side */}
            <div style={{
              marginTop: 48, display: 'grid',
              gridTemplateColumns: '1.5fr 1fr', gap: 28,
              alignItems: 'flex-start',
            }}>
              {/* Left: Human Approval */}
              <div>
                <div className="nc-section-head">
                  <span className="nc-section-title">Human Approval</span>
                  <span className="nc-section-meta">4 executions waiting</span>
                  <a className="nc-section-link" href="#">View all <window.Icon.ArrowRight size={11} /></a>
                </div>
                <div className="nc-flat-list">
                  {APPROVALS.map((a, i) => <FlatApprovalRow key={i} a={a} />)}
                </div>
              </div>

              {/* Right: In Flight + Recent stacked */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
                <div>
                  <div className="nc-section-head">
                    <span className="nc-section-title">In Flight</span>
                    <span className="nc-section-meta">0 active</span>
                  </div>
                  <div className="nc-empty">
                    <span style={{ width: 6, height: 6, borderRadius: 999, background: 'rgb(var(--color-text-subtle))' }} />
                    No tasks running
                  </div>
                </div>
                <div>
                  <div className="nc-section-head">
                    <span className="nc-section-title">Recent</span>
                    <span className="nc-section-meta">latest outcomes</span>
                    <a className="nc-section-link" href="#">All <window.Icon.ArrowRight size={11} /></a>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {RECENT.map((r, i) => <RecentRow key={i} r={r} />)}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// VARIANT B — "Productivity dashboard" · greeting + stat tiles · 2-col below
// ────────────────────────────────────────────────────────────
function VariantB() {
  const [collapsed, setCollapsed] = React.useState(false);
  return (
    <div className={`dash-artboard ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <window.DashSidebar collapsed={collapsed} />
      <button className="sidebar-handle" title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-label="Toggle sidebar" onClick={() => setCollapsed(v => !v)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <div className="main-col">
        <window.DashTopbar />
        <div className="main-body" style={{ overflowY: 'auto' }}>
          <div style={{ maxWidth: 1080, margin: '0 auto', padding: '40px 36px 56px' }}>
            {/* Hero row: greeting left, stat tiles right */}
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 480px',
              gap: 32, alignItems: 'center', marginBottom: 28,
            }}>
              <div>
                <div className="nc-overline-row" style={{ marginBottom: 10 }}>
                  <span className="nc-overline-dot" />
                  <span className="nc-overline">New Chat · Tuesday</span>
                </div>
                <h1 style={{
                  margin: 0,
                  fontSize: 30, fontWeight: 600, letterSpacing: '-0.018em',
                  color: 'rgb(var(--color-text-primary))', lineHeight: 1.15,
                }}>Good afternoon, Vallabh</h1>
                <p style={{
                  margin: '8px 0 0',
                  color: 'rgb(var(--color-text-muted))',
                  fontSize: 13.5, lineHeight: 1.5, maxWidth: 480,
                }}>Describe a task, paste a Linear ticket, or @mention an agent. Allen routes the work and runs it in an isolated workspace.</p>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                <div className="nc-stat">
                  <span className="nc-stat-label">Approvals</span>
                  <span className="nc-stat-value nc-stat-value-accent">4</span>
                  <span className="nc-stat-foot">waiting on you</span>
                </div>
                <div className="nc-stat">
                  <span className="nc-stat-label">Running</span>
                  <span className="nc-stat-value">0</span>
                  <span className="nc-stat-foot">no live tasks</span>
                </div>
                <div className="nc-stat">
                  <span className="nc-stat-label">Recent</span>
                  <span className="nc-stat-value">2</span>
                  <span className="nc-stat-foot">last 24 hours</span>
                </div>
              </div>
            </div>

            {/* Composer */}
            <div className="nc-composer-B">
              <div className="nc-caret-wrap">
                <textarea className="nc-composer-textarea" placeholder="Message Allen..." />
                <span className="nc-caret" aria-hidden="true"></span>
              </div>
              <div className="nc-composer-B-foot">
                <window.ComposerChips />
                <span style={{ flex: 1 }} />
                <button className="nc-attach" title="Attach"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66L9.41 17.41a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></button>
                <button className="nc-send" title="Send"><window.Icon.ArrowRight size={15} /></button>
              </div>
            </div>

            {/* Two-col grid: approvals (8) · right rail (4) */}
            <div style={{
              marginTop: 32,
              display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 18,
            }}>
              {/* Approvals card */}
              <div className="nc-section-card">
                <div className="nc-section-card-head">
                  <span className="nc-section-title">Human Approval</span>
                  <span className="nc-section-meta">4 executions waiting</span>
                  <a className="nc-section-link" href="#">View all <window.Icon.ArrowRight size={11} /></a>
                </div>
                <div className="nc-section-card-body">
                  {APPROVALS.map((a, i) => <ApprovalRow key={i} a={a} />)}
                </div>
              </div>

              {/* Right rail */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                <div className="nc-section-card">
                  <div className="nc-section-card-head">
                    <span className="nc-section-title">In Flight</span>
                    <span className="nc-section-meta">0 active</span>
                  </div>
                  <div className="nc-empty">
                    <span style={{ width: 6, height: 6, borderRadius: 999, background: 'rgb(var(--color-text-subtle))' }} />
                    No tasks running
                  </div>
                </div>
                <div className="nc-section-card">
                  <div className="nc-section-card-head">
                    <span className="nc-section-title">Recent</span>
                    <span className="nc-section-meta">latest outcomes</span>
                    <a className="nc-section-link" href="#">All <window.Icon.ArrowRight size={11} /></a>
                  </div>
                  <div className="nc-section-card-body">
                    {RECENT.map((r, i) => <RecentRow key={i} r={r} />)}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// VARIANT C — "Linear-style dense" · compact greeting · 3-column grid below
// ────────────────────────────────────────────────────────────
function VariantC() {
  const [collapsed, setCollapsed] = React.useState(false);
  return (
    <div className={`dash-artboard ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <window.DashSidebar collapsed={collapsed} />
      <button className="sidebar-handle" title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-label="Toggle sidebar" onClick={() => setCollapsed(v => !v)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <div className="main-col">
        <window.DashTopbar />
        <div className="main-body" style={{ overflowY: 'auto' }}>
          <div style={{ maxWidth: 1240, margin: '0 auto', padding: '28px 28px 48px' }}>
            {/* Inline hero */}
            <div style={{ paddingBottom: 16, borderBottom: '1px solid rgb(var(--color-border))', marginBottom: 20 }}>
              <GreetingBlock inline={true} />
            </div>

            {/* Composer */}
            <div className="nc-composer-C">
              <div className="nc-caret-wrap">
                <textarea className="nc-composer-textarea" placeholder="Message Allen..." />
                <span className="nc-caret" aria-hidden="true"></span>
              </div>
              <div className="nc-composer-C-foot">
                <window.ComposerChips />
                <span style={{ flex: 1 }} />
                <button className="nc-attach" title="Attach"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66L9.41 17.41a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></button>
                <button className="nc-send" title="Send" style={{ width: 28, height: 28, borderRadius: 6 }}><window.Icon.ArrowRight size={14} /></button>
              </div>
            </div>

            {/* 3-column grid */}
            <div style={{
              marginTop: 28,
              display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr', gap: 16,
            }}>
              {/* Approvals column */}
              <div>
                <div className="nc-section-head" style={{ paddingBottom: 10 }}>
                  <span className="nc-section-title">Human Approval</span>
                  <span style={{
                    fontFamily: 'var(--font-mono)', fontSize: 11,
                    color: 'rgb(var(--color-accent-yellow))',
                    background: 'rgb(var(--color-accent-yellow) / 0.1)',
                    border: '1px solid rgb(var(--color-accent-yellow) / 0.25)',
                    padding: '1px 7px', borderRadius: 999,
                    whiteSpace: 'nowrap',
                  }}>4 waiting</span>
                  <a className="nc-section-link" href="#">View all <window.Icon.ArrowRight size={11} /></a>
                </div>
                <div style={{
                  border: '1px solid rgb(var(--color-border))',
                  borderRadius: 12,
                  background: 'rgb(var(--color-surface-100))',
                  padding: 6,
                  display: 'flex', flexDirection: 'column', gap: 2,
                }}>
                  {APPROVALS.map((a, i) => <CompactApprovalRow key={i} a={a} />)}
                </div>
              </div>

              {/* In Flight column */}
              <div>
                <div className="nc-section-head" style={{ paddingBottom: 10 }}>
                  <span className="nc-section-title">In Flight</span>
                  <span style={{
                    fontFamily: 'var(--font-mono)', fontSize: 11,
                    color: 'rgb(var(--color-text-subtle))',
                    background: 'rgb(var(--color-surface-200))',
                    border: '1px solid rgb(var(--color-border))',
                    padding: '1px 7px', borderRadius: 999,
                    whiteSpace: 'nowrap',
                  }}>0 active</span>
                </div>
                <div style={{
                  border: '1px dashed rgb(var(--color-border-strong))',
                  borderRadius: 12,
                  padding: '32px 16px',
                  textAlign: 'center',
                  color: 'rgb(var(--color-text-muted))',
                  fontSize: 13,
                  background: 'transparent',
                }}>
                  <div style={{
                    width: 32, height: 32, borderRadius: 999,
                    border: '1px solid rgb(var(--color-border))',
                    background: 'rgb(var(--color-surface-100))',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    marginBottom: 10,
                    color: 'rgb(var(--color-text-subtle))',
                  }}>
                    <window.Icon.Play size={14} />
                  </div>
                  <div>No tasks running</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgb(var(--color-text-subtle))', marginTop: 4 }}>start one from the composer above</div>
                </div>
              </div>

              {/* Recent column */}
              <div>
                <div className="nc-section-head" style={{ paddingBottom: 10 }}>
                  <span className="nc-section-title">Recent</span>
                  <span style={{
                    fontFamily: 'var(--font-mono)', fontSize: 11,
                    color: 'rgb(var(--color-text-subtle))',
                    background: 'rgb(var(--color-surface-200))',
                    border: '1px solid rgb(var(--color-border))',
                    padding: '1px 7px', borderRadius: 999,
                    whiteSpace: 'nowrap',
                  }}>last 24h</span>
                  <a className="nc-section-link" href="#">All <window.Icon.ArrowRight size={11} /></a>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {RECENT.map((r, i) => <RecentRow key={i} r={r} />)}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// CANVAS
// ────────────────────────────────────────────────────────────
function NewChatExplorations() {
  return (
    <DesignCanvas defaultZoom={0.55}>
      <DCSection id="variations" title="New Chat — three directions">
        <DCArtboard id="A" label="A · Quiet focus" width={1280} height={1080}>
          <VariantA />
        </DCArtboard>
        <DCArtboard id="B" label="B · Productivity dashboard" width={1280} height={1080}>
          <VariantB />
        </DCArtboard>
        <DCArtboard id="C" label="C · Linear-style dense" width={1280} height={1000}>
          <VariantC />
        </DCArtboard>
      </DCSection>
    </DesignCanvas>
  );
}

window.NewChatExplorations = NewChatExplorations;
