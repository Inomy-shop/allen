import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

const baseProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export function V8AllenMark(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" fill="currentColor" />
    </svg>
  );
}

export function V8HomeIcon(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <path fill="currentColor" stroke="none" opacity=".12" d="M4.5 10 12 4l7.5 6v9.2a1.3 1.3 0 0 1-1.3 1.3H5.8a1.3 1.3 0 0 1-1.3-1.3Z" />
      <path d="M4.5 10 12 4l7.5 6v9.2a1.3 1.3 0 0 1-1.3 1.3H5.8a1.3 1.3 0 0 1-1.3-1.3Z" />
      <path d="M9.6 20.5v-5.6a1 1 0 0 1 1-1h2.8a1 1 0 0 1 1 1v5.6" />
    </svg>
  );
}

export function V8SessionsIcon(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <path fill="currentColor" stroke="none" opacity=".12" d="M21 11.5c0 4.1-3.8 7.5-8.5 7.5-1 0-2-.1-2.9-.4L4 20l1.5-3.4A7.2 7.2 0 0 1 4 11.5C4 7.4 7.8 4 12.5 4S21 7.4 21 11.5Z" />
      <path d="M21 11.5c0 4.1-3.8 7.5-8.5 7.5-1 0-2-.1-2.9-.4L4 20l1.5-3.4A7.2 7.2 0 0 1 4 11.5C4 7.4 7.8 4 12.5 4S21 7.4 21 11.5Z" />
      <path strokeWidth="2.2" d="M9 11.5h.01M12.5 11.5h.01M16 11.5h.01" />
    </svg>
  );
}

export function V8ExecutionsIcon(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <path fill="currentColor" stroke="none" opacity=".12" d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 9h8M8 12h8M8 15h5" />
    </svg>
  );
}

export function V8WorkspacesIcon(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <path fill="currentColor" stroke="none" opacity=".12" d="M3.5 5.5A2 2 0 0 1 5.5 3.5h13a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
      <path d="M9.8 3.5v17M3.5 9.5h6.3" />
    </svg>
  );
}

export function V8ReposIcon(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <path fill="currentColor" stroke="none" opacity=".12" d="M5 4.5A2.5 2.5 0 0 1 7.5 2H19v20H7.5A2.5 2.5 0 0 1 5 19.5Z" />
      <path d="M19 22H7.5A2.5 2.5 0 0 1 5 19.5v-15A2.5 2.5 0 0 1 7.5 2H19Z" />
      <path d="M5 19.5A2.5 2.5 0 0 1 7.5 17H19M10 7h6" />
    </svg>
  );
}

export function V8LinearIcon(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <path fill="currentColor" stroke="none" opacity=".12" d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5Z" />
      <rect x="4" y="4" width="16" height="16" rx="2.5" />
      <path d="M8.5 12h7M8.5 8.75h7M8.5 15.25h4" />
    </svg>
  );
}

export function V8PullRequestsIcon(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <circle cx="6" cy="6" r="2.6" />
      <circle cx="6" cy="18" r="2.6" />
      <circle fill="currentColor" stroke="none" opacity=".12" cx="18" cy="18" r="2.6" />
      <circle cx="18" cy="18" r="2.6" />
      <path d="M6 8.6v6.8M12.7 6H16a2 2 0 0 1 2 2v7.4" />
    </svg>
  );
}

export function V8DocumentsIcon(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <path fill="currentColor" stroke="none" opacity=".12" d="M6.5 2.5h7.5L18.5 7v13a1.5 1.5 0 0 1-1.5 1.5H6.5A1.5 1.5 0 0 1 5 20V4a1.5 1.5 0 0 1 1.5-1.5Z" />
      <path d="M6.5 2.5h7.5L18.5 7v13a1.5 1.5 0 0 1-1.5 1.5H6.5A1.5 1.5 0 0 1 5 20V4a1.5 1.5 0 0 1 1.5-1.5Z" />
      <path d="M14 2.5V7h4.5M8.5 12.5h7M8.5 16h4.5" />
    </svg>
  );
}

export function V8AgentsIcon(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <path fill="currentColor" stroke="none" opacity=".14" d="M10.5 3.5 12.6 8.9l5.4 2.1-5.4 2.1-2.1 5.4-2.1-5.4L3 11l5.4-2.1Z" />
      <path d="M10.5 3.5 12.6 8.9l5.4 2.1-5.4 2.1-2.1 5.4-2.1-5.4L3 11l5.4-2.1Z" />
      <path d="m18.5 15.5.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9Z" />
    </svg>
  );
}

export function V8WorkflowsIcon(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
      <rect fill="currentColor" stroke="none" opacity=".14" x="13.5" y="13.5" width="7" height="7" rx="2" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
      <path d="M7 10.5v3.7a2.3 2.3 0 0 0 2.3 2.3h4.2" />
    </svg>
  );
}

export function V8AllenDesignIcon(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M12 3a9 9 0 0 0-5.1 16.4c1.3.9 3-.1 2.7-1.6-.3-1.4.8-2.8 2.3-2.8h1.4a7.2 7.2 0 0 0 0-14Z" />
      <circle cx="7.5" cy="10" r="1" fill="currentColor" stroke="none" />
      <circle cx="10" cy="6.8" r="1" fill="currentColor" stroke="none" />
      <circle cx="14" cy="6.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="17" cy="9.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function V8SidebarCollapseIcon(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
      <path d="M9.5 4v16M15 9l-3 3 3 3" />
    </svg>
  );
}

export function V8SidebarExpandIcon(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
      <path d="M9.5 4v16M13 9l3 3-3 3" />
    </svg>
  );
}

// Home composer icons are kept here with the shell icons because V8 treats the
// SVG path data as part of the visual contract. Lucide's nearest equivalents
// have different geometry, which is noticeable at the prototype's 14px size.
export function V8ComposerUserIcon(props: IconProps) {
  return (
    <svg {...baseProps} strokeWidth="1.8" data-v8-icon="composer-user" {...props}>
      <circle cx="12" cy="8" r="3.4" />
      <path d="M5.5 19.4c.9-3 3.4-4.9 6.5-4.9s5.6 1.9 6.5 4.9" />
    </svg>
  );
}

export function V8ClaudeMarkIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="#D97757"
      strokeWidth="1.9"
      strokeLinecap="round"
      aria-hidden="true"
      data-v8-icon="claude-mark"
      {...props}
    >
      <path d="M8 1.6v2.7M8 11.7v2.7M1.6 8h2.7M11.7 8h2.7M3.5 3.5l1.9 1.9M10.6 10.6l1.9 1.9M12.5 3.5l-1.9 1.9M5.4 10.6l-1.9 1.9" />
    </svg>
  );
}

export function V8ChevronDownIcon(props: IconProps) {
  return (
    <svg {...baseProps} strokeWidth="2" data-v8-icon="chevron-down" {...props}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function V8PlanShieldIcon(props: IconProps) {
  return (
    <svg {...baseProps} strokeWidth="1.8" data-v8-icon="plan-shield" {...props}>
      <path d="M12 3l7 3v5c0 4.4-3 8.1-7 9-4-.9-7-4.6-7-9V6z" />
    </svg>
  );
}

export function V8PaperclipIcon(props: IconProps) {
  return (
    <svg {...baseProps} strokeWidth="1.8" data-v8-icon="paperclip" {...props}>
      <path d="M21 12.5 12.7 20.8a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l8-8" />
    </svg>
  );
}

export function V8ArrowUpIcon(props: IconProps) {
  return (
    <svg {...baseProps} strokeWidth="2" data-v8-icon="arrow-up" {...props}>
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  );
}

export function V8SetupGithubIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" data-v8-icon="setup-github" {...props}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function V8SetupLinearIcon(props: IconProps) {
  return (
    <svg {...baseProps} strokeWidth="1.8" data-v8-icon="setup-linear" {...props}>
      <rect x="4" y="4" width="16" height="16" rx="2.5" />
      <path d="M8.5 12h7M8.5 8.75h7M8.5 15.25h4" />
    </svg>
  );
}

export function V8SetupModelsIcon(props: IconProps) {
  return (
    <svg {...baseProps} strokeWidth="1.8" data-v8-icon="setup-models" {...props}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5 5l2.1 2.1M16.9 16.9 19 19M19 5l-2.1 2.1M7.1 16.9 5 19" />
    </svg>
  );
}

export function V8SetupMcpIcon(props: IconProps) {
  return (
    <svg {...baseProps} strokeWidth="1.8" data-v8-icon="setup-mcp" {...props}>
      <path d="M9 8V5.5a3 3 0 0 1 6 0V8" />
      <rect x="5" y="8" width="14" height="8" rx="2.5" />
      <path d="M9 16v2.5M15 16v2.5M9 12h.01M12 12h.01M15 12h.01" />
    </svg>
  );
}

export function V8SetupAgentsIcon(props: IconProps) {
  return (
    <svg {...baseProps} strokeWidth="1.8" data-v8-icon="setup-agents" {...props}>
      <path d="M10.5 3.5 12.6 8.9l5.4 2.1-5.4 2.1-2.1 5.4-2.1-5.4L3 11l5.4-2.1Z" />
      <path d="m18.5 15.5.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9Z" />
    </svg>
  );
}

export function V8SetupWorkflowIcon(props: IconProps) {
  return (
    <svg {...baseProps} strokeWidth="1.8" data-v8-icon="setup-workflow" {...props}>
      <rect x="3" y="3" width="7" height="7" rx="1.8" />
      <rect x="14" y="14" width="7" height="7" rx="1.8" />
      <path d="M6.5 10v4.2a2 2 0 0 0 2 2H14" />
    </svg>
  );
}

export function V8SetupTickIcon(props: IconProps) {
  return (
    <svg {...baseProps} strokeWidth="3" data-v8-icon="setup-tick" {...props}>
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}

export function V8ThemeSunIcon(props: IconProps) {
  return (
    <svg {...baseProps} data-v8-icon="theme-sun" {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4" />
    </svg>
  );
}

export function V8ThemeMoonIcon(props: IconProps) {
  return (
    <svg {...baseProps} data-v8-icon="theme-moon" {...props}>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z" />
    </svg>
  );
}
