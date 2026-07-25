import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, Check, Loader2 } from 'lucide-react';
import { OnboardingShell } from '../components/onboarding/OnboardingShell';
import { useAuthStore } from '../stores/authStore';

const NODES = [
  { name: 'Create workspace', agent: 'worktree', status: 'completed', tone: 'pass' },
  { name: 'Classify bug severity', agent: 'triage-analyst', status: 'running', tone: 'run' },
  { name: 'Root cause & fix scope', agent: 'bug-investigator', status: 'queued', tone: 'queue' },
  { name: 'Your approval — fix plan checkpoint', agent: 'you', status: 'waiting soon', tone: 'human' },
  { name: 'Implement, test & open PR', agent: 'fix-implementer', status: 'queued', tone: 'queue' },
] as const;

export default function OnboardingLaunchPage() {
  const [params] = useSearchParams();
  const executionId = params.get('execution');
  const workflowName = params.get('workflow') ?? 'bug-fix-by-severity';
  const repoName = params.get('repo') ?? 'test-website';
  const repoSource = params.get('source') ?? 'demo';
  const email = useAuthStore(state => state.user?.email);
  const [tokens, setTokens] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTokens(current => current + 180 + Math.floor(Math.random() * 420));
    }, 700);
    return () => window.clearInterval(timer);
  }, []);

  const tokenCopy = tokens > 1000 ? `${(tokens / 1000).toFixed(1)}k tokens` : `${tokens} tokens`;

  return (
    <OnboardingShell
      step="complete"
      eyebrow="setup complete"
      title="Agents are on it."
      description="Everything from here is visible: every agent step, every diff, every test run streams into the execution trace. A human checkpoint holds the fix before anything merges."
      stepCopy={{
        account: email ?? 'elena@company.com',
        health: '6 checks passed',
        repository: `${repoName} · ${repoSource}`,
        first_workflow: workflowName,
      }}
    >
      <section className="ob-card">
        <div className="ob-hero">
          <span className="halo"><Check /></span>
          <h2>You're set up. Your first workflow is running.</h2>
          <p>
            <b>{workflowName}</b> started against <b>{repoName}</b> in an isolated workspace.
            Nothing merges without your approval.
          </p>
        </div>

        <div className="ob-live">
          <div className="ob-live__hd">
            <span className="ob-status-dot is-run" />
            <span className="tt">Execution</span>
            <span className="id">
              {executionId
                ? `${executionId.slice(0, 12)} · workspace ws-${repoName}-01`
                : `workspace ws-${repoName}-01 starting`}
            </span>
            <span className="sp" />
            <span className="id">{tokenCopy}</span>
          </div>
          {NODES.map((node, index) => (
            <div
              key={node.name}
              className={`ob-node in is-${node.tone}`}
              style={{ animationDelay: `${420 + index * 180}ms` }}
            >
              <span className={`ob-status-dot is-${node.tone}`} />
              <span className="nm">{node.name}</span>
              <span className="ag">{node.agent}</span>
              <span className="stx">{node.status}</span>
            </div>
          ))}
        </div>

        <div className="ob-done">
          <div className="it"><Check />Admin account created <span className="m">{email ?? 'elena@company.com'}</span></div>
          <div className="it"><Check />Machine verified <span className="m">6 checks · Claude + Codex ready</span></div>
          <div className="it"><Check />Repository connected <span className="m">{repoName} · main</span></div>
        </div>

        <div className="ob-actions">
          <span className="sp" />
          <Link to="/" className="ob-action-ghost">Go to home</Link>
          <Link to={executionId ? `/executions/${executionId}` : '/executions'} className="ob-action-primary">
            Watch live execution
            {executionId ? <ArrowRight /> : <Loader2 className="animate-spin" />}
          </Link>
        </div>
      </section>
    </OnboardingShell>
  );
}
