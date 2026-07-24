import type { ReactNode } from 'react';

type EmptyStateScene = 'pull-request' | 'team';

function EmptyStateIllustration({ scene }: { scene: EmptyStateScene }) {
  if (scene === 'team') {
    return (
      <svg className="v8-empty-scene" viewBox="0 0 156 86" role="img" aria-label="Team members">
        <path className="scene-line scene-faint" d="M30 68c8-17 21-25 39-25s31 8 39 25" />
        <circle className="scene-surface" cx="69" cy="28" r="13" />
        <path className="scene-line" d="M47 69c3-17 11-25 22-25s19 8 22 25" />
        <circle className="scene-surface scene-accent" cx="111" cy="36" r="9" />
        <path className="scene-line scene-accent" d="M96 68c2-12 7-19 15-19s13 7 15 19" />
        <path className="scene-dash" d="M20 69h116" />
      </svg>
    );
  }

  return (
    <svg className="v8-empty-scene" viewBox="0 0 156 86" role="img" aria-label="Pull request branches merging">
      <circle className="scene-surface" cx="34" cy="20" r="5" />
      <circle className="scene-surface" cx="34" cy="65" r="5" />
      <path className="scene-line" d="M39 20h21c18 0 18 22 36 22h12" />
      <path className="scene-line" d="M39 65h21c18 0 18-23 36-23" />
      <circle className="scene-surface scene-accent" cx="120" cy="42" r="16" />
      <path className="scene-check" d="m112 42 6 6 11-13" />
      <path className="scene-dash" d="M20 76h116" />
    </svg>
  );
}

export default function V8EmptyState({
  action,
  description,
  scene,
  title,
}: {
  action?: ReactNode;
  description: string;
  scene: EmptyStateScene;
  title: string;
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
