import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Folder,
  Github,
  Loader2,
  RefreshCw,
  Sparkle,
  X,
} from 'lucide-react';
import { repos, system } from '../services/api';
import { useOnboardingGate } from '../hooks/useOnboardingGate';
import { DEFAULT_ONBOARDING_REPO } from '../lib/onboarding-defaults';
import { OnboardingShell } from '../components/onboarding/OnboardingShell';
import { useAuthStore } from '../stores/authStore';

type Mode = 'demo' | 'local' | 'clone';
type CheckStatus = 'pass' | 'warn' | 'fail';

interface ValidationCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  version?: string;
}

interface ValidationResult {
  ok: boolean;
  source: Mode;
  requiresSsh?: boolean;
  checks: ValidationCheck[];
}

const DEMO_VALIDATION: ValidationResult = {
  ok: true,
  source: 'demo',
  checks: [
    {
      id: 'public',
      label: 'Public repository',
      version: 'no credentials needed',
      status: 'pass',
      detail: 'Cloned over HTTPS — your SSH keys are not used.',
    },
    {
      id: 'workflows',
      label: 'Starter workflows ready',
      version: 'bug-fix-by-severity · feature-plan-and-implement',
      status: 'pass',
      detail: 'Seeded and matched to this repo.',
    },
  ],
};

interface SshResult {
  ok: boolean;
  host: string;
  detail: string;
  fix?: { summary: string; commands?: string[]; docsPath?: string };
}

const MODE_COPY: Record<Mode, { title: string; copy: string }> = {
  demo: {
    title: 'Try the demo repo',
    copy: 'A small starter website. One click — nothing private touches this machine.',
  },
  local: {
    title: 'Local checkout',
    copy: 'Register a git repository that already lives on this machine.',
  },
  clone: {
    title: 'Clone from GitHub',
    copy: 'SSH or HTTPS. Access and branch are verified before cloning.',
  },
};

function ValidationChecks({ result }: { result: ValidationResult | null }) {
  if (!result) return null;
  return (
    <div className="ob-inline-checks" aria-live="polite">
      {result.checks.map(check => (
        <div key={check.id} className={`ob-inline-check is-${check.status}`}>
          <span className="ic">{check.status === 'fail' ? <X /> : <Check />}</span>
          <span>
            <span className="tt">
              {check.label}
              {check.version && <span className="v">{check.version}</span>}
            </span>
            <span className="dt">{check.detail}</span>
          </span>
          <span className="st">{check.status}</span>
        </div>
      ))}
    </div>
  );
}

export default function OnboardingRepositoryPage() {
  const navigate = useNavigate();
  const email = useAuthStore(state => state.user?.email);
  const checkingOnboarding = useOnboardingGate('repository');
  const [mode, setMode] = useState<Mode>('demo');
  const [localPath, setLocalPath] = useState('');
  const [cloneUrl, setCloneUrl] = useState('git@github.com:Inomy-shop/storefront.git');
  const [branch, setBranch] = useState(DEFAULT_ONBOARDING_REPO.branch);
  const [name, setName] = useState('');
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [sshResult, setSshResult] = useState<SshResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sshLoading, setSshLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValidation(null);
    setError(null);
  }, [branch, cloneUrl, localPath, mode, name]);

  const canConnect = useMemo(() => {
    if (saving) return false;
    if (mode === 'demo') return true;
    if (!validation?.ok) return false;
    return mode !== 'clone' || validation.requiresSsh === false || Boolean(sshResult?.ok);
  }, [mode, saving, sshResult, validation]);

  async function validate() {
    if (mode === 'demo') return;
    setChecking(true);
    setError(null);
    try {
      const result = mode === 'local'
        ? await repos.validateLocal(localPath)
        : await repos.validateClone({
          url: cloneUrl.trim(),
          branch: branch.trim() || DEFAULT_ONBOARDING_REPO.branch,
          name: name.trim() || undefined,
        });
      setValidation(result as ValidationResult);
    } catch (err) {
      setValidation(null);
      setError((err as Error).message || 'Validation failed');
    } finally {
      setChecking(false);
    }
  }

  async function verifySsh() {
    setSshLoading(true);
    setError(null);
    try {
      setSshResult(await system.verifySsh('github.com'));
    } catch (err) {
      setSshResult({
        ok: false,
        host: 'github.com',
        detail: (err as Error).message || 'SSH verification failed',
      });
    } finally {
      setSshLoading(false);
    }
  }

  async function connectRepo() {
    if (!canConnect) return;
    setSaving(true);
    setError(null);
    try {
      if (mode === 'local') {
        await repos.create({ path: localPath.trim() });
      } else {
        const existing = mode === 'demo'
          ? (await repos.list()).find(repo => repo.name === DEFAULT_ONBOARDING_REPO.name)
          : null;
        if (!existing) {
          await repos.clone({
            url: mode === 'demo' ? DEFAULT_ONBOARDING_REPO.url : cloneUrl.trim(),
            branch: mode === 'demo' ? DEFAULT_ONBOARDING_REPO.branch : branch.trim() || DEFAULT_ONBOARDING_REPO.branch,
            name: mode === 'demo' ? DEFAULT_ONBOARDING_REPO.name : name.trim() || undefined,
          });
        }
      }
      await system.updateOnboardingProgress({ step: 'first_workflow' }).catch(() => {});
      navigate('/onboarding/first-workflow', { replace: true });
    } catch (err) {
      setError((err as Error).message || 'Could not connect repository');
    } finally {
      setSaving(false);
    }
  }

  async function skipOnboarding() {
    await system.updateOnboardingProgress({ action: 'skip' }).catch(() => {});
    navigate('/', { replace: true });
  }

  if (checkingOnboarding) {
    return (
      <div className="ob-loading">
        <Loader2 className="animate-spin" />
        Loading onboarding
      </div>
    );
  }

  const isDesktop = typeof window !== 'undefined' && Boolean(window.allenDesktop);
  const connectLabel = mode === 'demo'
    ? 'Use demo repo'
    : mode === 'clone'
      ? 'Clone & connect'
      : 'Connect repository';

  return (
    <OnboardingShell
      step="repository"
      eyebrow="repository"
      title="Give the agents something real to work on."
      description="Fastest path: the demo repo — one click, nothing private. Or connect a local checkout or a GitHub repository; Allen validates access before anything is registered."
      runtimeLabel={isDesktop ? 'desktop runtime' : 'web setup'}
      stepCopy={{
        account: email ?? 'elena@company.com',
        health: '6 checks passed',
      }}
    >
      <section className="ob-card">
        <div className="ob-card__head">
          <div>
            <h2>Connect your first repository</h2>
            <p className="sub">Pick a source. Validation runs inline — no surprises after you commit to a choice.</p>
          </div>
        </div>

        <div className="ob-opts" role="radiogroup" aria-label="Repository source">
          {(['demo', 'local', 'clone'] as Mode[]).map(candidate => {
            const Icon = candidate === 'demo' ? Sparkle : candidate === 'local' ? Folder : Github;
            return (
              <button
                key={candidate}
                type="button"
                role="radio"
                aria-checked={mode === candidate}
                className={`ob-opt ${mode === candidate ? 'on' : ''}`}
                onClick={() => setMode(candidate)}
              >
                <span className="gl"><Icon /></span>
                <span>
                  <span className="tt">
                    {MODE_COPY[candidate].title}
                    {candidate === 'demo' && <span className="rec">recommended</span>}
                  </span>
                  <span className="sb">{MODE_COPY[candidate].copy}</span>
                </span>
                <span className="pick" />
              </button>
            );
          })}
        </div>

        <div className={`ob-mode ${mode === 'demo' ? 'on' : ''}`}>
          <div className="ob-strip is-pass">
            <span className="dot" />
            <span>
              <span className="tt">test-website</span>
              <span className="sb"> · github.com/Inomy-shop/test-website · main · JavaScript, React</span>
            </span>
            <span className="sp" />
            <a className="ob-back" href={DEFAULT_ONBOARDING_REPO.url} target="_blank" rel="noreferrer">
              View repo
            </a>
          </div>
          <ValidationChecks result={DEMO_VALIDATION} />
        </div>

        <div className={`ob-mode ${mode === 'local' ? 'on' : ''}`}>
          <div className="ob-f">
            <label htmlFor="repo-local-path">repository path</label>
            <input
              id="repo-local-path"
              className="ob-in mono"
              value={localPath}
              onChange={event => setLocalPath(event.target.value)}
              placeholder="/Users/you/projects/app"
            />
            <p className="ob-hint">Must be a git repository. Allen detects language, framework, and default branch.</p>
          </div>
          {mode === 'local' && <ValidationChecks result={validation} />}
        </div>

        <div className={`ob-mode ${mode === 'clone' ? 'on' : ''}`}>
          <div className={`ob-strip ${sshResult?.ok ? 'is-pass' : sshResult ? 'is-fail' : 'is-pass'}`}>
            <span className="dot" />
            <span>
              <span className="tt">GitHub SSH</span>
              <span className="sb"> · {sshResult?.detail ?? 'key found · github.com ready to test'}</span>
            </span>
            <span className="sp" />
            <button type="button" className="ob-action-ghost" onClick={() => void verifySsh()} disabled={sshLoading}>
              {sshLoading && <Loader2 className="animate-spin" />}
              {sshResult ? 'Test again' : 'Test'}
            </button>
          </div>
          <div className="ob-f">
            <label htmlFor="repo-clone-url">github repository url</label>
            <input
              id="repo-clone-url"
              className="ob-in mono"
              value={cloneUrl}
              onChange={event => setCloneUrl(event.target.value)}
              placeholder="git@github.com:owner/repo.git"
            />
          </div>
          <div className="ob-2col">
            <div className="ob-f">
              <label htmlFor="repo-branch">branch</label>
              <input id="repo-branch" className="ob-in mono" value={branch} onChange={event => setBranch(event.target.value)} />
            </div>
            <div className="ob-f">
              <label htmlFor="repo-name">name <span className="ob-label-note">(optional)</span></label>
              <input id="repo-name" className="ob-in" value={name} onChange={event => setName(event.target.value)} placeholder="Auto-detected" />
            </div>
          </div>
          {mode === 'clone' && <ValidationChecks result={validation} />}
        </div>

        {error && <div className="ob-error">{error}</div>}

        <div className="ob-actions">
          <button type="button" className="ob-back" onClick={() => navigate('/onboarding/health')}>
            <ArrowLeft /> Back
          </button>
          <span className="sp" />
          {mode !== 'demo' && (
            <button type="button" className="ob-action-ghost" onClick={() => void validate()} disabled={checking}>
              {checking ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Validate
            </button>
          )}
          <button type="button" className="ob-action-primary" onClick={() => void connectRepo()} disabled={!canConnect}>
            {saving && <Loader2 className="animate-spin" />}
            {saving ? 'Connecting…' : connectLabel}
            {!saving && <ArrowRight />}
          </button>
        </div>
      </section>
      <button type="button" onClick={skipOnboarding} className="ob-skip">
        Skip for now — connect a repository later from Repos
      </button>
    </OnboardingShell>
  );
}
