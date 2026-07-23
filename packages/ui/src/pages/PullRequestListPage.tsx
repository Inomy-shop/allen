import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { McpPresetConnectModal } from '../components/settings/McpServerManager';
import { pullRequests } from '../services/workspaceService';
import {
  AlertCircle, GitPullRequest, KeyRound, RefreshCw,
} from 'lucide-react';
import { SetupProgressDialog } from '../components/workspace/SetupProgressDialog';
import { system as systemApi } from '../services/api';
import { workspaceChatPath } from '../lib/workspace-routes';

const STATUS_FILTERS = [
  { id: 'open', label: 'Open' },
  { id: 'merged', label: 'Merged' },
  { id: 'closed', label: 'Closed' },
  { id: '', label: 'All' },
];

function timeAgo(date: string) {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
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
    <section className="v8-page v8-prs" data-screen-label="pull-requests" aria-labelledby="pull-requests-title">
      <div className="v8-page__wrap">
        <header className="v8-pagehead">
          <div>
            <h1 id="pull-requests-title">Pull requests</h1>
            <p>Review GitHub pull requests, open workspaces, and resolve review feedback.</p>
          </div>
        </header>

        {connectionError && (
          <div className="v8-prs-error">
            <div>
              <div>
                <AlertCircle />
                <div>
                  <b>Could not reach GitHub</b>
                  <p>{connectionError}</p>
                </div>
              </div>
              <button onClick={handleSync} disabled={syncing} className="btn btn-secondary btn-sm" type="button"><RefreshCw className={syncing ? 'animate-spin' : ''} /> Retry</button>
            </div>
          </div>
        )}

        <div className="v8-chips v8-prs-filters">
          {STATUS_FILTERS.map(filter => (
            <button key={filter.id || 'all'} onClick={() => setStatusFilter(filter.id)} className={statusFilter === filter.id ? 'on' : ''} type="button">
              {filter.label}{filter.id === 'open' && <span>{prs.length}</span>}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="v8-prs-loading">Loading pull requests…</div>
        ) : prs.length === 0 ? (
          <div className="v8-empty">
            <span className="glyph"><GitPullRequest /></span>
            <h2>{statusFilter ? emptyState.title : 'No pull requests'}</h2>
            <p>{statusFilter ? emptyState.description : 'PRs opened by Allen sessions appear here after each sync (every 30 minutes).'}</p>
            <button onClick={handleSync} className="v8-btn v8-btn--ink" type="button">Sync now</button>
          </div>
        ) : (
          <div className="v8-prs-panel">
            {prs.map(pr => (
              <div
                key={pr._id}
                className="v8-prs-row"
                onClick={() => navigate(`/pull-requests/${pr._id}`)}
                onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') navigate(`/pull-requests/${pr._id}`); }}
                role="link"
                tabIndex={0}
              >
                <span className={`v8-status-dot ${pr.status === 'merged' ? 'ok' : pr.status === 'closed' ? 'error' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'human' : 'ok'}`} />
                <div className="v8-prs-copy">
                  <b>#{pr.number} · {pr.title}</b>
                  <small>{pr.repoName} <i>·</i> <code>{pr.branch} → {pr.baseBranch}</code> <i>·</i> by {pr.author}</small>
                </div>
                <time dateTime={pr.updatedAt}>{timeAgo(pr.updatedAt)}</time>
                {pr.status === 'open' && <button onClick={event => { event.stopPropagation(); void handleCreateWorkspace(pr._id); }} className="btn btn-secondary" type="button">Workspace</button>}
              </div>
            ))}
          </div>
        )}

        <p className="v8-prs-foot">PRs sync every 30 minutes · merged PRs free their workspace</p>

        {pendingWsId && (
          <SetupProgressDialog
            workspaceId={pendingWsId}
            onComplete={(ws) => { setPendingWsId(null); navigate(workspaceChatPath(ws._id)); }}
            onFailed={() => setPendingWsId(null)}
            onCancel={() => setPendingWsId(null)}
          />
        )}
      </div>
    </section>
  );
}
