import type { ReactNode } from 'react';
import { Check, Clock3, Moon, Sun } from 'lucide-react';
import { BRAND_SLUG } from '../../lib/brand';
import { V8AllenMark } from '../common/V8SidebarIcons';
import { useSettingsStore } from '../../stores/settingsStore';

export type OnboardingStep = 'account' | 'health' | 'repository' | 'first_workflow' | 'complete';

interface OnboardingShellProps {
  step: OnboardingStep;
  eyebrow: string;
  title: string;
  description: string;
  runtimeLabel?: string;
  runtimeCopy?: string;
  stepCopy?: Partial<Record<Exclude<OnboardingStep, 'complete'>, string>>;
  children: ReactNode;
  side?: ReactNode;
}

const STEP_ORDER: Exclude<OnboardingStep, 'complete'>[] = ['account', 'health', 'repository', 'first_workflow'];
const STEP_LABELS: Record<Exclude<OnboardingStep, 'complete'>, { title: string; copy: string }> = {
  account: { title: 'Account', copy: 'Create the first admin' },
  health: { title: 'Environment', copy: 'Verify runtime & providers' },
  repository: { title: 'Repository', copy: 'Demo repo or your own' },
  first_workflow: { title: 'First run', copy: 'Watch agents ship a change' },
};

function stepState(
  step: OnboardingStep,
  candidate: Exclude<OnboardingStep, 'complete'>,
): 'done' | 'active' | 'next' {
  if (step === 'complete') return 'done';
  const activeIndex = STEP_ORDER.indexOf(step);
  const index = STEP_ORDER.indexOf(candidate);
  if (index < activeIndex) return 'done';
  if (index === activeIndex) return 'active';
  return 'next';
}

export function OnboardingShell({
  step,
  eyebrow,
  title,
  description,
  runtimeLabel = 'desktop runtime',
  runtimeCopy,
  stepCopy,
  children,
  side,
}: OnboardingShellProps) {
  const colorMode = useSettingsStore(state => state.colorMode);
  const setColorMode = useSettingsStore(state => state.setColorMode);
  const isDark = colorMode === 'dark'
    || (colorMode === 'system' && typeof document !== 'undefined' && document.documentElement.classList.contains('dark'));

  return (
    <main data-onboarding-step={step} className="ob-shell onboarding-shell bg-app text-theme-primary">
      <button
        type="button"
        className="ob-theme-toggle"
        aria-label={`Switch to ${isDark ? 'light' : 'dark'} theme`}
        onClick={() => setColorMode(isDark ? 'light' : 'dark')}
      >
        {isDark ? <Moon /> : <Sun />}
      </button>
      <aside className="ob-rail onboarding-left-pane">
        <a className="ob-brand" href="/onboarding/account" aria-label={`${BRAND_SLUG} onboarding`}>
          <span className="mark"><V8AllenMark /></span>
          <span className="nm">{BRAND_SLUG}</span>
          <span className="rt">{runtimeLabel}</span>
        </a>

        <div className="ob-eyebrow">{eyebrow}</div>
        <h1 className="ob-title">{title}</h1>
        <p className="ob-desc">{description}</p>
        {runtimeCopy && <span className="ob-time"><Clock3 />{runtimeCopy}</span>}

        <div className="ob-steps" aria-label="Bootstrap path">
          <div className="ob-steps__lbl">bootstrap path</div>
          {STEP_ORDER.map((candidate, index) => {
            const state = stepState(step, candidate);
            const meta = STEP_LABELS[candidate];
            return (
              <div className={`ob-step ${state === 'active' ? 'now' : ''} ${state === 'done' ? 'done' : ''}`} key={candidate}>
                <span className="rail">
                  <span className="dot">
                    {state === 'done' ? <Check /> : index + 1}
                  </span>
                  {index < STEP_ORDER.length - 1 && <span className="cord" />}
                </span>
                <span className="bd">
                  <span className="tt">{meta.title}</span>
                  <span className="sb">{stepCopy?.[candidate] ?? meta.copy}</span>
                </span>
              </div>
            );
          })}
        </div>
        {side && <div className="ob-side-extra">{side}</div>}
      </aside>

      <section className="ob-pane onboarding-main-pane">
        <div className="ob-pane__in">
          {children}
        </div>
      </section>
    </main>
  );
}
