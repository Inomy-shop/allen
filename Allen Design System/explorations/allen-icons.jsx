// Allen full-state screens.
// All FILLED-state screens for tabs other than "new chat". Each screen
// renders a root `.ad-scope` wrapper that holds the design tokens
// (var(--surface) etc.) — these don't collide with our existing
// .es-* shell classes or the new-chat composer dropdowns.
//
// Every interactive control routes via setRoute() so navigation is
// fully clickable (lists → detail pages → back).

// ────────────────────────────────────────────────────────────
// Icon set — covers every name referenced by the screen JSX below.
// ────────────────────────────────────────────────────────────
const AdIcon = ({ name, size = 16, className = "" }) => {
  const stroke = "currentColor";
  const w = size;
  const common = { width: w, height: w, viewBox: "0 0 24 24", fill: "none", stroke, strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", className };
  switch (name) {
    case "sparkles": return <svg {...common}><path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z"/><path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z"/></svg>;
    case "play": return <svg {...common}><polygon points="6 4 20 12 6 20 6 4"/></svg>;
    case "message": return <svg {...common}><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>;
    case "ticket": return <svg {...common}><path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4V8z"/><path d="M13 6v2M13 10v2M13 14v2M13 18v2"/></svg>;
    case "git-pr": return <svg {...common}><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><path d="M6 8v8"/><path d="M11 4h4a3 3 0 0 1 3 3v9"/><path d="M14 7l-3-3 3-3"/></svg>;
    case "workspace": return <svg {...common}><rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="11" height="6" rx="1.5"/><circle cx="18" cy="17" r="1"/><circle cx="6" cy="7" r="0.6" fill="currentColor"/></svg>;
    case "users": return <svg {...common}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>;
    case "workflow": return <svg {...common}><rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><path d="M9 6h6"/><path d="M18 9v6"/><path d="M6 9v3a3 3 0 0 0 3 3h3"/></svg>;
    case "settings": return <svg {...common}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>;
    case "search": return <svg {...common}><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>;
    case "chev-l": return <svg {...common}><polyline points="15 18 9 12 15 6"/></svg>;
    case "chev-r": return <svg {...common}><polyline points="9 18 15 12 9 6"/></svg>;
    case "chev-d": return <svg {...common}><polyline points="6 9 12 15 18 9"/></svg>;
    case "arr-up": return <svg {...common}><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>;
    case "arr-r": return <svg {...common}><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>;
    case "arr-l": return <svg {...common}><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>;
    case "plus": return <svg {...common}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>;
    case "refresh": return <svg {...common}><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>;
    case "filter": return <svg {...common}><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>;
    case "edit": return <svg {...common}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>;
    case "trash": return <svg {...common}><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>;
    case "import": return <svg {...common}><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/><polyline points="12 11 12 17"/><polyline points="9 14 12 17 15 14"/></svg>;
    case "external": return <svg {...common}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>;
    case "check": return <svg {...common}><polyline points="20 6 9 17 4 12"/></svg>;
    case "x": return <svg {...common}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>;
    case "x-circle": return <svg {...common}><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>;
    case "check-circle": return <svg {...common}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>;
    case "alert": return <svg {...common}><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>;
    case "clock": return <svg {...common}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
    case "play-circle": return <svg {...common}><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>;
    case "logs": return <svg {...common}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>;
    case "node": return <svg {...common}><rect x="3" y="9" width="6" height="6" rx="1"/><rect x="15" y="9" width="6" height="6" rx="1"/><path d="M9 12h6"/></svg>;
    case "lib-skills": return <svg {...common}><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>;
    case "lib-repos": return <svg {...common}><path d="M3 5a2 2 0 0 1 2-2h14v18H5a2 2 0 0 1-2-2V5z"/><path d="M3 16a2 2 0 0 1 2-2h14"/></svg>;
    case "lib-int": return <svg {...common}><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="18" r="3"/><line x1="9" y1="6" x2="15" y2="6"/><line x1="9" y1="18" x2="15" y2="18"/><line x1="6" y1="9" x2="6" y2="15"/><line x1="18" y1="9" x2="18" y2="15"/></svg>;
    case "wrench": return <svg {...common}><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4l-6 6a2 2 0 0 0 2.8 2.8l6-6a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.3-2.3 2.5-2.5z"/></svg>;
    case "chart": return <svg {...common}><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>;
    case "terminal": return <svg {...common}><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>;
    case "branch": return <svg {...common}><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>;
    case "key": return <svg {...common}><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>;
    case "credit-card": return <svg {...common}><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>;
    case "github": return <svg {...common}><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg>;
    case "linear": return <svg {...common}><path d="M3 14l7 7M3 9l12 12M3 4l17 17M9 3l12 12M15 3l6 6"/></svg>;
    case "slack": return <svg {...common}><rect x="13" y="2" width="3" height="8" rx="1.5"/><rect x="13" y="14" width="3" height="8" rx="1.5"/><rect x="8" y="13" width="8" height="3" rx="1.5"/><rect x="8" y="8" width="8" height="3" rx="1.5"/><rect x="2" y="8" width="3" height="8" rx="1.5"/><rect x="19" y="8" width="3" height="8" rx="1.5"/></svg>;
    case "openai": return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d="M22.28 9.83a5.94 5.94 0 0 0-.51-4.88 6 6 0 0 0-6.46-2.88A6 6 0 0 0 4.18 4.13a5.94 5.94 0 0 0-4 2.9 6 6 0 0 0 .74 7.05A5.96 5.96 0 0 0 1.43 19a6 6 0 0 0 6.46 2.88A5.96 5.96 0 0 0 12.4 24a6 6 0 0 0 5.72-4.13 5.94 5.94 0 0 0 4-2.9 6 6 0 0 0-.74-7.04z"/></svg>;
    case "anthropic": return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d="M14.6 4h-3l5.4 16h3.5L14.6 4zm-8.7 0L0 20h3.6l1.18-3.4h5.8L11.76 20h3.6L9.45 4H5.9zm.06 9.4l1.9-5.45 1.9 5.45h-3.8z"/></svg>;
    case "git": return <svg {...common}><circle cx="12" cy="12" r="3"/><circle cx="20" cy="12" r="2"/><circle cx="4" cy="12" r="2"/><path d="M6 12h3M15 12h3"/></svg>;
    case "save": return <svg {...common}><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>;
    case "download": return <svg {...common}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>;
    case "paperclip": return <svg {...common}><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>;
    case "folder": return <svg {...common}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>;
    case "file": return <svg {...common}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>;
    case "code": return <svg {...common}><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>;
    case "circle-d": return <svg {...common}><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>;
    default: return <svg {...common}/>;
  }
};

window.AdIcon = AdIcon;
