import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { McpPresetConnectModal } from '../components/settings/McpServerManager';
import { pullRequests } from '../services/workspaceService';
import {
  AlertCircle, ArrowRight, Bot, Clock, ExternalLink, FileDiff, FolderGit2,
  GitPullRequest, KeyRound, ListChecks, Minus, Plus, RefreshCw,
} from 'lucide-react';
import { SetupProgressDialog } from '../components/workspace/SetupProgressDialog';
import { executions as executionsApi, system as systemApi, workflows as workflowsApi } from '../services/api';
import IconTooltipButton from '../components/common/IconTooltipButton';

const STATUS_FILTERS = [
  { id: 'open', label: 'Open' },
  { id: 'merged', label: 'Merged' },
  { id: 'closed', label: 'Closed' },
  { id: '', label: 'All' },
];

function statusBadge(status: string) {
  const cls = status === 'merged'
    ? 'border-accent-purple/30 bg-accent-purple/10 text-accent-purple'
    : status === 'closed'
      ? 'border-accent-red/30 bg-accent-red/10 text-accent-red'
      : 'border-accent-green/30 bg-accent-green/10 text-accent-green';
  return <span className={`rounded-md border px-2 py-0.5 font-mono text-[10.5px] ${cls}`}>{status}</span>;
}

function timeAgo(date: string) {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function integrationErrorMessage(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : String(err ?? '');
  if (!message || message === 'fetch failed' || message.includes('Failed to fetch')) return fallback;
  return message;
}

export default function PullRequestListPage() {
  const navigate = useNavigate();
  const [showGithubModal, setShowGithubModal] = useState(false);
  const [prs, setPrs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [githubConfigured, setGithubConfigured] = useState<boolean | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('open');
  const [pendingWsId, setPendingWsId] = useState<string | null>(null);
  const [resolveBusy, setResolveBusy] = useState(false);

  const loadGitHubStatus = useCallback(async () => {
    try {
      const runtime = await systemApi.desktopRuntime();
      const githubSecret = runtime.secrets.find(secret => secret.key === 'ALLEN_GITHUB_PERSONAL_ACCESS_TOKEN');
      setGithubConfigured(Boolean(githubSecret?.configured));
    } catch {
      setGithubConfigured(null);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPrs(await pullRequests.list({ status: statusFilter || undefined }));
      setConnectionError(null);
    } catch (err) {
      setConnectionError(integrationErrorMessage(err, 'Allen could not load pull requests.'));
      setPrs([]);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { void loadGitHubStatus(); }, [loadGitHubStatus]);
  useEffect(() => { void load(); }, [load]);

  async function handleSync() {
    setSyncing(true);
    try {
      if (githubConfigured === false) {
        setConnectionError('GitHub is not connected. Connect GitHub in Settings, then sync pull requests.');
        return;
      }
      const result = await pullRequests.syncAll();
      await load();
      setConnectionError(
        result.errorCount > 0
          ? (result.summary || 'GitHub sync finished with errors. Check the GitHub connection and retry.')
          : null,
      );
      await loadGitHubStatus();
    } catch (err) {
      setConnectionError(integrationErrorMessage(err, 'GitHub could not be reached. Check your network connection or GitHub status, then retry.'));
    } finally {
      setSyncing(false);
    }
  }

  async function handleCreateWorkspace(prId: string) {
    try {
      const ws = await pullRequests.createWorkspace(prId);
      setPendingWsId(ws._id);
    } catch (err: any) {
      alert(err.message);
    }
  }

  async function handleTriggerResolve(prUrl: string, navigateAfter = true) {
    setResolveBusy(true);
    try {
      const list = await workflowsApi.list();
      const workflow = list.find((w: any) => w.name === 'resolve-pr-reviews');
      if (!workflow) throw new Error('resolve-pr-reviews workflow not found on the server');
      const exec = await executionsApi.start(workflow._id, {
        pr_url: prUrl.trim(),
        review_bot_logins: 'coderabbitai,coderabbitai[bot]',
        already_processed_comment_ids: '[]',
      });
      if (navigateAfter) navigate(`/executions/${exec.id}`);
    } catch (err: any) {
      alert(err?.message ?? 'Failed to trigger resolution');
    } finally {
      setResolveBusy(false);
    }
  }

  const emptyState = statusFilter === 'closed'
    ? {
      title: 'No closed pull requests found',
      description: 'Closed only includes pull requests closed without merge. Merged pull requests are listed under Merged.',
    }
    : statusFilter === 'merged'
      ? {
        title: 'No merged pull requests found',
        description: 'Sync from GitHub to import merged pull requests.',
      }
      : statusFilter === 'open'
        ? {
          title: 'No open pull requests found',
          description: 'Sync from GitHub to import open pull requests for review.',
        }
        : {
          title: 'No pull requests found',
          description: 'Sync from GitHub to import pull requests for review.',
        };

  if (githubConfigured === false) {
    return (
      <div className="content scroll-hide !p-0 h-full bg-app" data-screen-label="pull-requests">
        <div className="flex min-h-full w-full items-center justify-center px-8 py-8">
          <div className="w-full max-w-[480px] rounded-md border border-app bg-app-card px-6 py-8 text-center">
            <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-md border border-app bg-app text-accent">
              <AlertCircle className="h-5 w-5" />
            </span>
            <h2 className="mt-5 text-[17px] font-semibold text-theme-primary">GitHub is not connected</h2>
            <p className="mt-2 text-[13px] text-theme-muted">
              Add the GitHub credential before pull requests can be synced from repositories.
            </p>
            <div className="mt-5 inline-flex items-center gap-2 rounded-md border border-app bg-app px-3 py-2 font-mono text-[11px] text-accent">
              <KeyRound className="h-3.5 w-3.5" /> ALLEN_GITHUB_PERSONAL_ACCESS_TOKEN
            </div>
            <div className="mt-6 flex items-center justify-center gap-2">
              <button
                onClick={() => setShowGithubModal(true)}
                className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover"
                type="button"
              >
                Connect GitHub
              </button>
              <button
                onClick={loadGitHubStatus}
                className="inline-flex h-9 items-center gap-2 rounded-md border border-app bg-app px-3 text-[13px] font-medium text-theme-secondary transition-colors hover:border-app-strong hover:text-theme-primary"
                type="button"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Recheck
              </button>
            </div>
          </div>
          {showGithubModal && (
            <McpPresetConnectModal
              presetName="github"
              onClose={() => setShowGithubModal(false)}
              onConnected={() => {
                setShowGithubModal(false);
                void loadGitHubStatus();
                void load();
              }}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="content scroll-hide bg-app" data-screen-label="pull-requests">
      <div className="w-full px-8 py-8">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-md border border-app bg-app-card text-theme-muted">
              <GitPullRequest className="h-[18px] w-[18px]" />
            </span>
            <div>
              <h1 className="text-[24px] font-semibold leading-tight text-theme-primary">Pull requests</h1>
              <p className="mt-1 text-[13px] text-theme-muted">Review GitHub pull requests, open workspaces, and resolve review feedback.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleSync}
              disabled={syncing}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              type="button"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Syncing' : 'Sync'}
            </button>
          </div>
        </div>

        {connectionError && (
          <div className="mb-4 rounded-md border border-accent-red/30 bg-accent-red/5 px-5 py-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-accent-red" />
                <div>
                  <div className="text-[14px] font-semibold text-theme-primary">Could not reach GitHub</div>
                  <p className="mt-1 text-[13px] text-theme-muted">{connectionError}</p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  onClick={handleSync}
                  disabled={syncing}
                  className="inline-flex h-8 items-center gap-2 rounded-md border border-app bg-app px-3 text-[12px] font-medium text-theme-secondary transition-colors hover:border-app-strong hover:text-theme-primary disabled:cursor-not-allowed disabled:opacity-50"
                  type="button"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} /> Retry
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-app bg-app-card px-3 py-2">
          <div className="flex items-center gap-1">
            {STATUS_FILTERS.map(filter => (
              <button
                key={filter.id}
                onClick={() => setStatusFilter(filter.id)}
                className={`h-8 rounded-md px-3 text-[12px] font-medium transition-colors ${
                  statusFilter === filter.id
                    ? 'bg-app-muted text-theme-primary shadow-sm'
                    : 'text-theme-muted hover:text-theme-primary'
                }`}
                type="button"
              >
                {filter.label}
              </button>
            ))}
          </div>
          <span className="font-mono text-[11px] text-theme-muted">{prs.length} result{prs.length === 1 ? '' : 's'}</span>
        </div>

        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="rounded-md border border-app bg-app-card px-5 py-4">
                <div className="h-4 w-64 animate-pulse rounded-md bg-app-muted" />
                <div className="mt-3 h-3 w-96 animate-pulse rounded-md bg-app-muted" />
              </div>
            ))}
          </div>
        ) : prs.length === 0 ? (
          <div className="rounded-md border border-dashed border-app bg-app-card px-5 py-12 text-center">
            <GitPullRequest className="mx-auto h-8 w-8 text-theme-subtle" />
            <div className="mt-4 text-[15px] font-semibold text-theme-primary">{emptyState.title}</div>
            <p className="mt-1 text-[13px] text-theme-muted">{emptyState.description}</p>
            <button
              onClick={handleSync}
              className="mt-5 inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover"
              type="button"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Sync pull requests
            </button>
          </div>
        ) : (
          <div className="space-y-2.5">
            {prs.map(pr => (
              <div
                key={pr._id}
                className="cursor-pointer rounded-md border border-app bg-app-card px-4 py-3 transition-colors hover:border-app-strong hover:bg-app-muted/20"
                onClick={() => navigate(`/pull-requests/${pr._id}`)}
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="shrink-0 font-mono text-[12px] text-theme-muted">#{pr.number}</span>
                      <span className="min-w-0 truncate text-[14px] font-semibold leading-5 text-theme-primary">{pr.title}</span>
                      {statusBadge(pr.status)}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[11px] leading-4 text-theme-muted">
                      <span>{pr.repoName}</span>
                      <span className="text-theme-subtle">·</span>
                      <span className="inline-flex items-center gap-1">
                        {pr.branch}
                        <ArrowRight className="h-3 w-3" />
                        {pr.baseBranch}
                      </span>
                      <span className="text-theme-subtle">·</span>
                      <span>by {pr.author}</span>
                      {pr.createdByAgent && (
                        <>
                        <span className="text-theme-subtle">·</span>
                        <span className="inline-flex items-center gap-1 text-theme-secondary">
                          <Bot className="h-3 w-3" /> {pr.createdByAgent}
                        </span>
                        </>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] leading-4 text-theme-muted">
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3 w-3" /> updated {timeAgo(pr.updatedAt)}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <FileDiff className="h-3 w-3" /> {pr.changedFiles} files
                      </span>
                      <span className="inline-flex items-center gap-0.5 text-accent-green">
                        <Plus className="h-3 w-3" />{pr.additions}
                      </span>
                      <span className="inline-flex items-center gap-0.5 text-accent-red">
                        <Minus className="h-3 w-3" />{pr.deletions}
                      </span>
                    </div>
                  </div>
                  <div className="ml-auto flex shrink-0 items-center gap-2" onClick={event => event.stopPropagation()}>
                    {pr.status === 'open' && (
                      <button
                        onClick={() => handleCreateWorkspace(pr._id)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-app bg-app px-2.5 text-[12px] font-medium text-theme-secondary transition-colors hover:border-app-strong hover:text-theme-primary"
                        type="button"
                      >
                        <FolderGit2 className="h-3.5 w-3.5" /> Workspace
                      </button>
                    )}
                    {pr.status === 'open' && pr.url && (
                      <button
                        onClick={() => handleTriggerResolve(pr.url, true)}
                        disabled={resolveBusy}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-app bg-app px-2.5 text-[12px] font-medium text-theme-secondary transition-colors hover:border-app-strong hover:text-theme-primary disabled:cursor-not-allowed disabled:opacity-50"
                        type="button"
                      >
                        <ListChecks className="h-3.5 w-3.5" /> Resolve
                      </button>
                    )}
                    {pr.url && (
                      <IconTooltipButton
                        label="Open on GitHub"
                        onClick={() => window.open(pr.url, '_blank', 'noopener,noreferrer')}
                        className="h-8 w-8 border border-app bg-app hover:border-app-strong"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </IconTooltipButton>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {pendingWsId && (
          <SetupProgressDialog
            workspaceId={pendingWsId}
            onComplete={(ws) => { setPendingWsId(null); navigate(`/workspaces/${ws._id}`); }}
            onFailed={() => setPendingWsId(null)}
          />
        )}
      </div>
    </div>
  );
}
