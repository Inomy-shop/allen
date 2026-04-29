// Inline SVG icon set — minimal stroke style.
const Ico = ({ d, fill, size = 16, sw = 1.6, children, vb = 24, ...p }) => (
  <svg width={size} height={size} viewBox={`0 0 ${vb} ${vb}`} fill="none"
       stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" {...p}>
    {d ? <path d={d} fill={fill || 'none'} /> : children}
  </svg>
);

const Icons = {
  inbox: (p) => <Ico {...p} d="M3 13l3-7h12l3 7M3 13v6a1 1 0 001 1h16a1 1 0 001-1v-6M3 13h5l1 2h6l1-2h5" />,
  chat: (p) => <Ico {...p} d="M21 12c0 4.4-4 8-9 8a9.7 9.7 0 01-4-.8L3 20l.9-4A8 8 0 013 12c0-4.4 4-8 9-8s9 3.6 9 8z" />,
  flow: (p) => <Ico {...p}><circle cx="6" cy="6" r="2.2" /><circle cx="18" cy="6" r="2.2" /><circle cx="12" cy="18" r="2.2" /><path d="M7.5 7.5l3.5 9M16.5 7.5L13 16.5" /></Ico>,
  agents: (p) => <Ico {...p}><circle cx="9" cy="9" r="3" /><circle cx="17" cy="11" r="2.4" /><path d="M3 19c.6-2.8 3-5 6-5s5.4 2.2 6 5M14 19.4c.5-1.7 2-3 3.5-3 1.4 0 2.7 1 3.5 2.6"/></Ico>,
  repo: (p) => <Ico {...p} d="M5 4h11l3 3v13H5zM5 14h13M9 4v8M9 18v2" />,
  linear: (p) => <Ico {...p}><rect x="3" y="3" width="18" height="18" rx="2.5" /><path d="M3 9h18M9 3v18"/></Ico>,
  workspace: (p) => <Ico {...p}><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 20h8M12 17v3"/></Ico>,
  pr: (p) => <Ico {...p}><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><path d="M6 8v8M6 6h6a4 4 0 014 4v8M14 8l4-2-4-2"/></Ico>,
  exec: (p) => <Ico {...p} d="M5 4l14 8-14 8z" />,
  intervene: (p) => <Ico {...p}><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></Ico>,
  analytics: (p) => <Ico {...p} d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>,
  settings: (p) => <Ico {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 14.6a8 8 0 000-5.2l1.7-1.3-2-3.4-2 .7a8 8 0 00-4.5-2.6L12 1l-2.5 0-.6 1.8a8 8 0 00-4.5 2.6l-2-.7-2 3.4 1.7 1.3a8 8 0 000 5.2L.4 16l2 3.4 2-.7a8 8 0 004.5 2.6L9.5 23h2.5l.6-1.7a8 8 0 004.5-2.6l2 .7 2-3.4z" /></Ico>,
  search: (p) => <Ico {...p}><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></Ico>,
  bell: (p) => <Ico {...p} d="M6 8a6 6 0 0112 0v5l1.5 3h-15L6 13zM10 19a2 2 0 004 0" />,
  plus: (p) => <Ico {...p} d="M12 5v14M5 12h14"/>,
  refresh: (p) => <Ico {...p} d="M3 12a9 9 0 0115-6.7L21 8M21 4v4h-4M21 12a9 9 0 01-15 6.7L3 16M3 20v-4h4"/>,
  play: (p) => <Ico {...p} d="M6 4l14 8-14 8z" fill="currentColor"/>,
  edit: (p) => <Ico {...p} d="M4 20h4l11-11-4-4L4 16zM14 6l4 4"/>,
  trash: (p) => <Ico {...p} d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>,
  ext: (p) => <Ico {...p} d="M14 4h6v6M20 4l-9 9M9 5H5a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2v-4"/>,
  chevR: (p) => <Ico {...p} d="M9 6l6 6-6 6"/>,
  chevD: (p) => <Ico {...p} d="M6 9l6 6 6-6"/>,
  chevL: (p) => <Ico {...p} d="M15 6l-6 6 6 6"/>,
  check: (p) => <Ico {...p} d="M5 13l4 4L19 7"/>,
  x: (p) => <Ico {...p} d="M6 6l12 12M18 6L6 18"/>,
  send: (p) => <Ico {...p} d="M22 2L2 9l8 3 3 8z M22 2l-12 10"/>,
  attach: (p) => <Ico {...p} d="M21 11l-9 9a5 5 0 01-7-7l9-9a3.5 3.5 0 015 5l-9 9a2 2 0 01-3-3l8-8"/>,
  sun: (p) => <Ico {...p}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5L4 4M20 20l-1-1M19 5l1-1M5 19l-1 1"/></Ico>,
  moon: (p) => <Ico {...p} d="M21 12.8A9 9 0 1111.2 3 7 7 0 0021 12.8z"/>,
  panel: (p) => <Ico {...p}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></Ico>,
  user: (p) => <Ico {...p}><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/></Ico>,
  download: (p) => <Ico {...p} d="M12 4v12M6 12l6 6 6-6M4 20h16"/>,
  branch: (p) => <Ico {...p}><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 7v10M6 12c4 0 6-2 6-5h4"/></Ico>,
  bug: (p) => <Ico {...p}><rect x="8" y="6" width="8" height="14" rx="4"/><path d="M9 9c0-2.2 1.3-4 3-4s3 1.8 3 4M3 12h5M16 12h5M3 18l3-2M21 18l-3-2M3 7l3 2M21 7l-3 2M12 10v9"/></Ico>,
  file: (p) => <Ico {...p} d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5"/>,
  more: (p) => <Ico {...p}><circle cx="12" cy="6" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="18" r="1"/></Ico>,
  cmd: (p) => <Ico {...p} d="M9 9V6a3 3 0 10-3 3h12a3 3 0 100-6v3M9 15v3a3 3 0 11-3-3h12a3 3 0 113 3v-3"/>,
  lightning: (p) => <Ico {...p} d="M13 2L4 14h7l-1 8 9-12h-7z" fill="currentColor" stroke="none"/>,
  sparkle: (p) => <Ico {...p} d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 3l.8 2.2L22 6l-2.2.8L19 9l-.8-2.2L16 6l2.2-.8zM5 17l.6 1.6L7 19l-1.4.4L5 21l-.6-1.6L3 19l1.4-.4z" fill="currentColor" stroke="none"/>,
  spinner: (p) => (
    <svg width={p.size||14} height={p.size||14} viewBox="0 0 24 24" {...p}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2.4" fill="none"/>
      <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" fill="none">
        <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite"/>
      </path>
    </svg>
  ),
};

window.Icons = Icons;
