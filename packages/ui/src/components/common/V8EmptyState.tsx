import type { ReactNode } from 'react';

export type EmptyStateScene =
  | 'home'
  | 'sessions'
  | 'agents'
  | 'team'
  | 'workflows'
  | 'workflow'
  | 'workspaces'
  | 'repositories'
  | 'linear'
  | 'pull-request'
  | 'documents'
  | 'settings'
  | 'execution'
  | 'default';

const delays = ['0ms', '120ms', '240ms', '360ms', '480ms', '600ms'];
function delay(index: number) {
  return { animationDelay: delays[index] ?? `${index * 120}ms` };
}

function EmptyStateIllustration({ scene }: { scene: EmptyStateScene }) {
  if (scene === 'sessions') {
    return (
      <svg className="v8-empty-scene" viewBox="0 0 156 86" role="img" aria-label="Conversation rows">
        <circle className="scene-surface scene-pop" style={delay(0)} cx="34" cy="22" r="5" />
        <path className="scene-line scene-draw" style={delay(1)} pathLength="100" d="M48 22h56" />
        <circle className="scene-surface scene-pop" style={delay(2)} cx="34" cy="43" r="5" />
        <path className="scene-line scene-draw" style={delay(3)} pathLength="100" d="M48 43h68" />
        <circle className="scene-surface scene-accent scene-pop" style={delay(4)} cx="34" cy="64" r="5" />
        <circle className="scene-fill scene-pulse" cx="51" cy="64" r="2" />
        <circle className="scene-fill scene-pulse" style={delay(2)} cx="61" cy="64" r="2" />
        <circle className="scene-fill scene-pulse" style={delay(4)} cx="71" cy="64" r="2" />
      </svg>
    );
  }

  if (scene === 'agents' || scene === 'team') {
    return (
      <svg className="v8-empty-scene" viewBox="0 0 156 86" role="img" aria-label="Agent team">
        <path className="scene-line scene-faint scene-draw" style={delay(0)} pathLength="100" d="M30 68c8-17 21-25 39-25s31 8 39 25" />
        <circle className="scene-surface scene-pop" style={delay(1)} cx="69" cy="28" r="13" />
        <path className="scene-line scene-draw" style={delay(2)} pathLength="100" d="M47 69c3-17 11-25 22-25s19 8 22 25" />
        <circle className="scene-surface scene-accent scene-pop" style={delay(3)} cx="111" cy="36" r="9" />
        <path className="scene-line scene-accent scene-draw" style={delay(4)} pathLength="100" d="M96 68c2-12 7-19 15-19s13 7 15 19" />
        <path className="scene-dash" d="M20 72h116" />
      </svg>
    );
  }

  if (scene === 'workflows' || scene === 'workflow') {
    return (
      <svg className="v8-empty-scene" viewBox="0 0 156 86" role="img" aria-label="Workflow graph">
        <rect className="scene-surface scene-pop" style={delay(0)} x="18" y="28" width="28" height="18" rx="6" />
        <rect className="scene-surface scene-pop" style={delay(2)} x="64" y="14" width="30" height="18" rx="6" />
        <rect className="scene-surface scene-accent scene-pop" style={delay(4)} x="110" y="40" width="28" height="18" rx="6" />
        <path className="scene-line scene-draw" style={delay(1)} pathLength="100" d="M46 37h9c9 0 9-14 18-14" />
        <path className="scene-line scene-draw" style={delay(3)} pathLength="100" d="M94 23h8c10 0 8 26 17 26" />
        <path className="scene-dash" d="M24 70h108" />
      </svg>
    );
  }

  if (scene === 'workspaces') {
    return (
      <svg className="v8-empty-scene" viewBox="0 0 156 86" role="img" aria-label="Workspace branch">
        <path className="scene-line scene-draw" style={delay(0)} pathLength="100" d="M42 12v56" />
        <circle className="scene-surface scene-pop" style={delay(1)} cx="42" cy="20" r="5" />
        <path className="scene-line scene-accent scene-draw" style={delay(2)} pathLength="100" d="M42 39c26 0 31 5 31 24" />
        <circle className="scene-surface scene-accent scene-pop" style={delay(4)} cx="73" cy="66" r="6" />
        <rect className="scene-surface scene-pop" style={delay(3)} x="90" y="28" width="40" height="28" rx="8" />
        <path className="scene-line scene-faint" d="M99 39h22M99 47h14" />
      </svg>
    );
  }

  if (scene === 'repositories') {
    return (
      <svg className="v8-empty-scene" viewBox="0 0 156 86" role="img" aria-label="Repository folder">
        <path className="scene-surface scene-pop" style={delay(0)} d="M27 28h35l8 9h59a8 8 0 0 1 8 8v24H19V36a8 8 0 0 1 8-8Z" />
        <path className="scene-line scene-draw" style={delay(1)} pathLength="100" d="M19 43h118v23a7 7 0 0 1-7 7H26a7 7 0 0 1-7-7Z" />
        <circle className="scene-surface scene-accent scene-pop" style={delay(3)} cx="115" cy="58" r="12" />
        <path className="scene-check" d="m109 58 4 4 8-9" />
      </svg>
    );
  }

  if (scene === 'linear') {
    return (
      <svg className="v8-empty-scene" viewBox="0 0 156 86" role="img" aria-label="Ticket queue">
        <rect className="scene-surface scene-pop" style={delay(0)} x="30" y="16" width="70" height="16" rx="6" />
        <rect className="scene-surface scene-pop" style={delay(2)} x="50" y="38" width="76" height="16" rx="6" />
        <rect className="scene-surface scene-accent scene-pop" style={delay(4)} x="24" y="60" width="58" height="16" rx="6" />
        <path className="scene-line scene-draw" style={delay(1)} pathLength="100" d="M42 24h35M62 46h43M36 68h27" />
        <circle className="scene-fill scene-pulse" cx="112" cy="24" r="3" />
      </svg>
    );
  }

  if (scene === 'pull-request') {
    return (
      <svg className="v8-empty-scene" viewBox="0 0 156 86" role="img" aria-label="Pull request branches merging">
        <circle className="scene-surface scene-pop" style={delay(0)} cx="34" cy="20" r="5" />
        <circle className="scene-surface scene-pop" style={delay(1)} cx="34" cy="65" r="5" />
        <path className="scene-line scene-draw" style={delay(2)} pathLength="100" d="M39 20h21c18 0 18 22 36 22h12" />
        <path className="scene-line scene-draw" style={delay(3)} pathLength="100" d="M39 65h21c18 0 18-23 36-23" />
        <circle className="scene-surface scene-accent scene-pop" style={delay(4)} cx="120" cy="42" r="16" />
        <path className="scene-check" d="m112 42 6 6 11-13" />
        <path className="scene-dash" d="M20 76h116" />
      </svg>
    );
  }

  if (scene === 'documents') {
    return (
      <svg className="v8-empty-scene" viewBox="0 0 156 86" role="img" aria-label="Document stack">
        <path className="scene-surface scene-pop" style={delay(0)} d="M55 12h35l18 18v44H55Z" />
        <path className="scene-line scene-draw" style={delay(1)} pathLength="100" d="M90 12v18h18M66 42h30M66 52h25M66 62h18" />
        <path className="scene-line scene-faint scene-draw" style={delay(2)} pathLength="100" d="M42 24H30v50h50" />
        <circle className="scene-surface scene-accent scene-pop" style={delay(3)} cx="112" cy="62" r="10" />
      </svg>
    );
  }

  if (scene === 'settings') {
    return (
      <svg className="v8-empty-scene" viewBox="0 0 156 86" role="img" aria-label="Settings controls">
        <path className="scene-line scene-draw" style={delay(0)} pathLength="100" d="M30 26h96M30 44h96M30 62h96" />
        <circle className="scene-surface scene-pop" style={delay(1)} cx="62" cy="26" r="8" />
        <circle className="scene-surface scene-accent scene-pop" style={delay(3)} cx="96" cy="44" r="8" />
        <circle className="scene-surface scene-pop" style={delay(5)} cx="73" cy="62" r="8" />
      </svg>
    );
  }

  if (scene === 'execution') {
    return (
      <svg className="v8-empty-scene" viewBox="0 0 156 86" role="img" aria-label="Execution trace">
        <circle className="scene-surface scene-pop" style={delay(0)} cx="42" cy="22" r="7" />
        <circle className="scene-surface scene-pop" style={delay(2)} cx="78" cy="43" r="7" />
        <circle className="scene-surface scene-accent scene-pop" style={delay(4)} cx="114" cy="64" r="7" />
        <path className="scene-line scene-draw" style={delay(1)} pathLength="100" d="M49 26 71 39" />
        <path className="scene-line scene-draw" style={delay(3)} pathLength="100" d="M85 47 107 60" />
        <path className="scene-dash" d="M30 74h96" />
      </svg>
    );
  }

  return (
    <svg className="v8-empty-scene" viewBox="0 0 156 86" role="img" aria-label="Allen spark">
      <path className="scene-line scene-accent scene-pop" style={delay(0)} d="M78 12l5 25 25 5-25 5-5 25-5-25-25-5 25-5Z" />
      <path className="scene-line scene-pop" style={delay(2)} d="M118 18l2 8 8 2-8 2-2 8-2-8-8-2 8-2Z" />
      <path className="scene-line scene-pop" style={delay(4)} d="M38 52l2 7 7 2-7 2-2 7-2-7-7-2 7-2Z" />
      <circle className="scene-fill scene-pulse" cx="119" cy="62" r="2.5" />
    </svg>
  );
}

export default function V8EmptyState({
  action,
  description,
  scene = 'default',
  title,
}: {
  action?: ReactNode;
  description: ReactNode;
  scene?: EmptyStateScene;
  title: ReactNode;
}) {
  return (
    <div className="v8-empty v8-empty--illustrated">
      <EmptyStateIllustration scene={scene} />
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}
