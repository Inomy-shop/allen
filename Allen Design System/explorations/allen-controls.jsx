// Custom dropdown + ⌘K command palette + sidebar animation utilities.
// Loaded after react/babel and after allen-icons.jsx.

(function () {
  const { AdIcon } = window;

  // ── Dropdown ─────────────────────────────────────────────
  // Drop-in replacement for <select> with a consistent UI.
  // Props: value, onChange, options (string[] | {value,label}[]), placeholder, width
  function ADDropdown({ value, onChange, options, placeholder = "Select…", width, style }) {
    const [open, setOpen] = React.useState(false);
    const [hover, setHover] = React.useState(-1);
    // {top, left, width} — computed from trigger rect when opening
    const [pos, setPos] = React.useState(null);
    const wrap = React.useRef(null);
    const triggerRef = React.useRef(null);
    const opts = (options || []).map((o) => typeof o === "string" ? { value: o, label: o } : o);
    const current = opts.find((o) => o.value === value) || opts[0] || { label: placeholder };
    const [internal, setInternal] = React.useState(value ?? (opts[0] && opts[0].value));

    // Recompute position when the menu opens or the window resizes/scrolls.
    const updatePos = React.useCallback(() => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      setPos({ top: r.bottom + 8, left: r.left, width: r.width });
    }, []);

    React.useEffect(() => {
      if (!open) return;
      updatePos();
      const onDown = (e) => {
        // Dismiss if the click is outside both the trigger and the portal menu.
        const inTrigger = wrap.current?.contains(e.target);
        const inMenu = e.target.closest?.(".ad-dd-menu");
        if (!inTrigger && !inMenu) setOpen(false);
      };
      const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
      window.addEventListener("mousedown", onDown);
      window.addEventListener("keydown", onKey);
      window.addEventListener("resize", updatePos);
      window.addEventListener("scroll", updatePos, true);
      return () => {
        window.removeEventListener("mousedown", onDown);
        window.removeEventListener("keydown", onKey);
        window.removeEventListener("resize", updatePos);
        window.removeEventListener("scroll", updatePos, true);
      };
    }, [open, updatePos]);

    const pick = (v) => {
      setInternal(v);
      if (onChange) onChange(v);
      setOpen(false);
    };

    const shown = opts.find((o) => o.value === (value ?? internal)) || opts[0];

    return (
      <div ref={wrap} className="ad-dd" style={{ width, ...style }}>
      <button ref={triggerRef} type="button"
        className={`ad-dd-trigger ${open ? "is-open" : ""}`}
        onClick={() => setOpen((o) => !o)} style={{ padding: "0px 8px" }}>

        <span className="ad-dd-trigger-label">{shown?.label ?? placeholder}</span>
        <svg className="ad-dd-caret" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && pos && ReactDOM.createPortal(
        <div className="ad-dd-menu ad-dd-menu-portal"
             style={{ position: "fixed", top: pos.top, left: pos.left, minWidth: pos.width }}>
          {opts.map((o, i) => {
            const active = (value ?? internal) === o.value;
            return (
              <button key={o.value}
              type="button"
              className={`ad-dd-item ${active ? "is-active" : ""} ${hover === i ? "is-hover" : ""}`}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(-1)}
              onClick={() => pick(o.value)}>
                <span className="ad-dd-item-label">{o.label}</span>
              </button>);
          })}
        </div>,
        document.body
      )}
    </div>);

  }

  // ── Command palette overlay ──────────────────────────────
  function CmdKOverlay({ open, onClose, setRoute }) {
    const [q, setQ] = React.useState("");
    const [sel, setSel] = React.useState(0);
    const inputRef = React.useRef(null);

    React.useEffect(() => {
      if (!open) return;
      setQ("");
      setSel(0);
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }, [open]);

    const all = [
    { id: "home", label: "Go to new chat", path: "/", group: "Navigate", icon: "sparkles" },
    { id: "executions", label: "Open executions", path: "/executions", group: "Navigate", icon: "play" },
    { id: "chats", label: "Open chats", path: "/chats", group: "Navigate", icon: "message" },
    { id: "chat", label: "Open assistant chat", path: "/chat", group: "Action", icon: "message" },
    { id: "exec-log", label: "View execution log", path: "/executions", group: "Executions", icon: "play" },
    { id: "exec-run", label: "View running executions", path: "/executions?status=running", group: "Executions", icon: "play" },
    { id: "tickets", label: "Open Linear tickets", path: "/tickets", group: "Sources", icon: "ticket" },
    { id: "prs", label: "Open pull requests", path: "/prs", group: "Sources", icon: "git-pr" },
    { id: "workspaces", label: "Open workspaces", path: "/workspaces", group: "Code", icon: "workspace" },
    { id: "settings", label: "Open settings", path: "/settings", group: "Settings", icon: "settings" },
    { id: "schedules", label: "Open scheduled jobs", path: "/settings/schedules", group: "Settings", icon: "clock" },
    { id: "analytics", label: "Open analytics", path: "/settings/analytics", group: "Settings", icon: "chart" },
    { id: "learnings", label: "Open learnings", path: "/settings/learnings", group: "Settings", icon: "lib-skills" },
    { id: "workflows", label: "Open workflows", path: "/workflows", group: "Library", icon: "workflow" },
    { id: "agents", label: "Open agents and teams", path: "/library-teams", group: "Library", icon: "users" }];

    const ROUTE_MAP = {
      "home": "home", "executions": "executions", "chats": "chats", "chat": "chats",
      "exec-log": "executions", "exec-run": "executions", "tickets": "tickets",
      "prs": "prs", "workspaces": "workspaces", "settings": "settings",
      "schedules": "settings", "analytics": "settings", "learnings": "settings",
      "workflows": "workflows", "agents": "library/teams"
    };

    const filtered = React.useMemo(() => {
      const Q = q.trim().toLowerCase();
      if (!Q) return all;
      return all.filter((x) => x.label.toLowerCase().includes(Q) || x.group.toLowerCase().includes(Q) || x.path.toLowerCase().includes(Q));
    }, [q]);

    React.useEffect(() => {setSel(0);}, [q]);

    React.useEffect(() => {
      if (!open) return;
      function onKey(e) {
        if (e.key === "Escape") {e.preventDefault();onClose();} else
        if (e.key === "ArrowDown") {e.preventDefault();setSel((s) => Math.min(s + 1, filtered.length - 1));} else
        if (e.key === "ArrowUp") {e.preventDefault();setSel((s) => Math.max(s - 1, 0));} else
        if (e.key === "Enter") {
          e.preventDefault();
          const c = filtered[sel];
          if (c) {setRoute(ROUTE_MAP[c.id] || "home");onClose();}
        }
      }
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [open, filtered, sel, onClose, setRoute]);

    if (!open) return null;
    return (
      <div className="cmdk-scrim" onClick={onClose}>
      <div className="cmdk-panel" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-input-row">
          <svg className="cmdk-cmd-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z" />
          </svg>
          <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search navigation and actions..."
              className="cmdk-input" />
            
          <span className="cmdk-esc">esc</span>
        </div>
        <div className="cmdk-list">
          {filtered.length === 0 ?
            <div className="cmdk-empty">No commands match.</div> :
            filtered.map((c, i) =>
            <button key={c.id}
            type="button"
            className={`cmdk-item ${i === sel ? "is-active" : ""}`}
            onMouseEnter={() => setSel(i)}
            onClick={() => {setRoute(ROUTE_MAP[c.id] || "home");onClose();}}>
              <span className="cmdk-item-ico">{AdIcon ? <AdIcon name={c.icon} size={16} /> : null}</span>
              <span className="cmdk-item-body">
                <span className="cmdk-item-label">{c.label}</span>
                <span className="cmdk-item-path">{c.path}</span>
              </span>
              <span className="cmdk-item-group">{c.group}</span>
              <svg className="cmdk-item-arr" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
              </svg>
            </button>
            )}
        </div>
      </div>
    </div>);

  }

  Object.assign(window, { ADDropdown, CmdKOverlay });
})();