import type { ReactNode } from 'react';
import { BRAND_SLUG } from '../../lib/brand';

type OnboardingStep = 'account' | 'health' | 'model_defaults' | 'repository' | 'first_workflow';

interface OnboardingShellProps {
  step: OnboardingStep;
  eyebrow: string;
  title: string;
  description: string;
  runtimeLabel?: string;
  runtimeCopy?: string;
  children: ReactNode;
  side?: ReactNode;
}

export function OnboardingShell({
  step,
  eyebrow,
  title,
  description,
  runtimeLabel = 'desktop runtime',
  runtimeCopy = 'Local server, managed data, and agent workspaces start with this app.',
  children,
  side,
}: OnboardingShellProps) {
  return (
    <main data-onboarding-step={step} className="onboarding-shell min-h-screen bg-app text-theme-primary lg:h-screen lg:overflow-hidden">
      <div className="mx-auto flex min-h-screen w-full max-w-[1180px] flex-col px-5 py-4 sm:px-7 lg:h-screen lg:min-h-0 lg:px-8">
        <header className="onboarding-header flex h-9 shrink-0 items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="inline-flex items-center justify-center rounded-md border border-accent/25 bg-accent-soft px-1.5 py-0.5 font-mono text-[13px] font-semibold text-accent">
              [a]
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-[14px] font-semibold lowercase text-theme-primary">{BRAND_SLUG}</span>
              <span className="font-mono text-[10px] text-theme-subtle">{runtimeLabel}</span>
            </div>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 items-center gap-6 py-5 lg:grid-cols-[minmax(0,1fr)_430px] lg:gap-10 lg:py-4">
          <section className="onboarding-left-pane hidden min-w-0 lg:block lg:max-h-full lg:overflow-hidden">
            <div className="max-w-[620px]">
              <span className="font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-theme-subtle">
                {eyebrow}
              </span>
              <h1 className="mt-2 max-w-[580px] text-[32px] font-semibold leading-[1.08] text-theme-primary">
                {title}
              </h1>
              <p className="mt-3 max-w-[560px] text-[13px] leading-5 text-theme-muted">
                {description}
              </p>

              {side}
            </div>
          </section>

          <section className="onboarding-main-pane mx-auto min-h-0 w-full max-w-[430px] lg:max-h-full lg:overflow-y-auto lg:pr-1">
            {children}
          </section>
        </div>
      </div>
    </main>
  );
}
