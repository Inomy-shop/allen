/**
 * Design Studio — workspace detail.
 *
 * Repo mode: analyze → review/correct profile (R3/R4), with the mandatory
 * mimic-vs-normalize choice (R4.1) and theme pick (R4.2). Reuses the saved
 * profile (R22.1) and offers refresh-or-keep when the repo changed (R22.2).
 * Greenfield mode: discovery interview → confirmed brief (R6/R7/R22.3).
 * Lists/creates sessions for the workspace.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2, RefreshCw, Check, Plus, FileText, FolderGit2, MessageSquare, ExternalLink, Upload, Folder, Palette, Sparkles } from 'lucide-react';
import Select from '../components/common/Select';
import {
  designStudio,
  workspaceSitePath,
  resolvePreviewAbsoluteUrl,
  openInBrowser,
  type Workspace,
  type DesignProfile,
  type WorkspaceFile,
} from '../services/designStudioService';
import { groupWorkspaceFiles } from '../components/design-studio/WorkspaceFilesPanel';

interface DesignSummary { _id: string; title: string; lastMessageAt: string; messageCount: number }

export default function DesignStudioWorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [ws, setWs] = useState<Workspace | null>(null);
  const [sessions, setSessions] = useState<DesignSummary[]>([]);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [repoChanged, setRepoChanged] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    const w = await designStudio.getWorkspace(id);
    setWs(w);
    setSessions(await designStudio.listDesigns(id));
    setFiles(await designStudio.listFiles(id).catch(() => []));
    setLoading(false);
    if (w.kind === 'repo' && w.profileStatus === 'confirmed') {
      designStudio.repoChange(id).then((r) => setRepoChanged(r.changed)).catch(() => {});
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  if (loading || !ws) {
    return <div className="flex h-full items-center justify-center text-theme-muted"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-app px-6 py-5">
      <button className="mb-4 inline-flex w-fit items-center gap-1.5 rounded-md px-1 py-1 text-[12px] text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary" onClick={() => navigate('/studio')}>
        <ArrowLeft className="h-3.5 w-3.5" /> All workspaces
      </button>
      <header className="mb-5 rounded-md border border-app bg-app-card px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <WorkspaceKindBadge ws={ws} />
              <StatusBadge status={ws.profileStatus} />
            </div>
            <h1 className="truncate text-[22px] font-semibold text-theme-primary">{ws.name}</h1>
            <p className="mt-1 max-w-3xl truncate font-mono text-[11px] text-theme-muted">
              {ws.kind === 'repo' ? ws.sourceRepoPath || 'Repository workspace' : 'Greenfield design workspace'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button className="btn btn-secondary btn-sm gap-1.5 !rounded-md" onClick={() => openWorkspacePreview(ws._id)} disabled={files.length === 0}>
              <ExternalLink className="h-3.5 w-3.5" /> Preview
            </button>
            <ExportWorkspaceButton workspaceId={ws._id} disabled={files.length === 0} />
          </div>
        </div>
      </header>

      {ws.profileStatus !== 'confirmed' ? (
        ws.kind === 'repo'
          ? <RepoSetup ws={ws} onChange={load} />
          : <GreenfieldSetup ws={ws} onChange={load} />
      ) : (
        <ConfirmedWorkspace ws={ws} sessions={sessions} files={files} repoChanged={repoChanged} onChange={load} onOpenSession={(sid) => navigate(sid ? `/studio/sessions/${sid}?ws=${ws._id}` : `/studio/sessions?ws=${ws._id}`)} />
      )}
    </div>
  );
}

function WorkspaceKindBadge({ ws }: { ws: Workspace }) {
  return (
    <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-app bg-app px-2 text-[12px] font-medium text-theme-secondary">
      {ws.kind === 'repo' ? <FolderGit2 className="h-3.5 w-3.5 text-accent" /> : <Sparkles className="h-3.5 w-3.5 text-accent" />}
      {ws.kind === 'repo' ? 'Repository' : 'New idea'}
    </span>
  );
}

function StatusBadge({ status }: { status: Workspace['profileStatus'] }) {
  const map: Record<Workspace['profileStatus'], { label: string; cls: string }> = {
    pending: { label: 'Analysis pending', cls: 'border-accent-yellow/25 bg-accent-yellow/10 text-accent-yellow' },
    analyzing: { label: 'Analyzing', cls: 'border-accent-blue/25 bg-accent-blue/10 text-accent-blue' },
    needs_review: { label: 'Review required', cls: 'border-accent-yellow/25 bg-accent-yellow/10 text-accent-yellow' },
    needs_choice: { label: 'Choice required', cls: 'border-accent-orange/25 bg-accent-orange/10 text-accent-orange' },
    confirmed: { label: 'Ready', cls: 'border-accent-green/25 bg-accent-green/10 text-accent-green' },
  };
  const item = map[status];
  return <span className={`inline-flex h-7 items-center rounded-md border px-2 text-[12px] font-medium ${item.cls}`}>{item.label}</span>;
}

async function openWorkspacePreview(workspaceId: string, file = 'index.html') {
  openInBrowser(await resolvePreviewAbsoluteUrl(workspaceSitePath(workspaceId, file)));
}

function ExportWorkspaceButton({ workspaceId, disabled }: { workspaceId: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  async function exportWorkspace() {
    setBusy(true);
    try {
      const desktop = (window as any).allenDesktop;
      const res = await designStudio.exportSystem(workspaceId);
      if (desktop?.showItemInFolder) void desktop.showItemInFolder(res.dir);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button className="btn btn-primary btn-sm gap-1.5 !rounded-md" onClick={exportWorkspace} disabled={disabled || busy} title="Exports to Downloads/Allen Design Studio">
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Export
    </button>
  );
}

// ── Repo setup ────────────────────────────────────────────────────────────────

function RepoSetup({ ws, onChange }: { ws: Workspace; onChange: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<{ provider: string; model: string; label: string }[]>([]);
  // "" = use Allen's default agent model; otherwise "provider::model".
  const [selected, setSelected] = useState<string>(ws.analysisModel ? `${ws.analysisProvider ?? ''}::${ws.analysisModel}` : '');

  useEffect(() => { designStudio.listModels().then(setModels).catch(() => setModels([])); }, []);

  async function analyze() {
    setBusy(true); setError(null);
    try {
      const [provider, model] = selected ? selected.split('::') : [undefined, undefined];
      await designStudio.analyze(ws._id, provider && model ? { provider, model } : undefined);
      await onChange();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  if (ws.profileStatus === 'pending' || ws.profileStatus === 'analyzing') {
    return (
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="rounded-md border border-app bg-app-card p-5">
          <div className="mb-4 flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-app bg-app text-accent">
              <Palette className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-[15px] font-semibold text-theme-primary">Repository analysis</h2>
              <p className="mt-1 text-[13px] leading-relaxed text-theme-muted">
                Analyze the source repo to build the Design Studio kit: tokens, typography, components, icons, and layout patterns.
              </p>
            </div>
          </div>
          <label className="mb-4 block max-w-md">
            <span className="mb-1.5 block text-[12px] font-medium text-theme-secondary">Analysis model</span>
            <Select
              value={selected}
              onChange={setSelected}
              placeholder="Default Opus model"
              searchPlaceholder="Search models..."
              options={[
                { value: '', label: 'Default Opus model' },
                ...models.map((m) => ({ value: `${m.provider}::${m.model}`, label: m.label })),
              ]}
            />
          </label>
          {error && <p className="mb-3 whitespace-pre-wrap rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-[12px] text-accent-red">{error}</p>}
          <button className="btn btn-primary btn-sm inline-flex items-center gap-1.5" onClick={analyze} disabled={busy || ws.profileStatus === 'analyzing'}>
            {busy || ws.profileStatus === 'analyzing' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Analyze repository
          </button>
        </section>
        <aside className="rounded-md border border-app bg-app-card p-4">
          <h3 className="text-[13px] font-semibold text-theme-primary">What analysis creates</h3>
          <div className="mt-3 space-y-2 text-[12px] text-theme-muted">
            {['system/tokens.css', 'system/components.css', 'system/components.html', 'system/pro-max.md', 'system/source-repo.json'].map((item) => (
              <div key={item} className="flex items-center gap-2 rounded-md border border-app bg-app px-2 py-1.5 font-mono text-[11px]">
                <FileText className="h-3.5 w-3.5 text-accent" /> {item}
              </div>
            ))}
          </div>
        </aside>
      </div>
    );
  }

  // needs_review / needs_choice → show the profile editor with required choices.
  return <ProfileReview ws={ws} onChange={onChange} />;
}

function ProfileReview({ ws, onChange }: { ws: Workspace; onChange: () => Promise<void> }) {
  const profile = ws.profile!;
  const [strategy, setStrategy] = useState<'mimic' | 'normalize' | undefined>(profile.consistency.strategy);
  const [selectedTheme, setSelectedTheme] = useState<string | undefined>(profile.selectedTheme ?? profile.themes?.[0]?.name);
  const [summary, setSummary] = useState(profile.summaryMarkdown);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsStrategy = profile.consistency.consistent === false;
  const needsTheme = (profile.themes?.length ?? 0) >= 2;

  async function confirm() {
    setBusy(true); setError(null);
    try {
      const edited: Partial<DesignProfile> = { summaryMarkdown: summary };
      await designStudio.confirmProfile(ws._id, { profile: edited, strategy, selectedTheme });
      await onChange();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-app bg-app-card p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-accent" />
            <h3 className="text-[14px] font-semibold text-theme-primary">Review design profile</h3>
          </div>
          <StatusBadge status={ws.profileStatus} />
        </div>
        <p className="mb-3 text-[12px] text-theme-muted">This profile feeds the Design Studio kit and every design chat in this workspace.</p>
        <textarea className="input min-h-[170px] w-full rounded-md font-mono text-[12px]" value={summary} onChange={(e) => setSummary(e.target.value)} />
        {(profile.typography || profile.spacing || profile.iconography || profile.layoutPatterns) && (
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {profile.typography && <SignalCard title="Typography" value={profile.typography} />}
            {profile.spacing && <SignalCard title="Spacing" value={profile.spacing} />}
            {profile.iconography && <SignalCard title="Iconography" value={profile.iconography} />}
            {profile.layoutPatterns && <SignalCard title="Layout" value={profile.layoutPatterns} />}
          </div>
        )}
        {profile.colors.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {profile.colors.map((c) => (
              <span key={c.name} className="inline-flex items-center gap-1.5 rounded border border-app px-2 py-1 text-[11px]">
                <span className="h-3 w-3 rounded-sm border border-app" style={{ background: c.value }} /> {c.name}
              </span>
            ))}
          </div>
        )}
        {(profile.components?.length ?? 0) > 0 && (
          <p className="mt-3 text-[12px] text-theme-muted"><span className="font-medium text-theme-primary">Components:</span> {profile.components!.map((c) => c.name).join(', ')}</p>
        )}
      </div>

      {needsStrategy && (
        <div className="rounded-md border border-accent-orange/40 bg-accent-orange/5 p-4">
          <h3 className="mb-1 text-[13px] font-semibold text-orange-500">Inconsistent styling detected</h3>
          <ul className="mb-3 list-disc pl-5 text-[12px] text-theme-muted">
            {profile.consistency.issues.map((i, idx) => <li key={idx}>{i}</li>)}
          </ul>
          <div className="flex gap-2">
            <ChoiceButton active={strategy === 'mimic'} onClick={() => setStrategy('mimic')} title="Mimic dominant" desc="Match the most common existing style as-is" />
            <ChoiceButton active={strategy === 'normalize'} onClick={() => setStrategy('normalize')} title="Normalize" desc="Clean up into one consistent system" />
          </div>
        </div>
      )}

      {needsTheme && (
        <div className="rounded-md border border-accent-orange/40 bg-accent-orange/5 p-4">
          <h3 className="mb-2 text-[13px] font-semibold text-orange-500">Multiple themes detected — pick one</h3>
          <div className="space-y-2">
            {profile.themes!.map((t) => (
              <button
                key={t.name}
                type="button"
                role="radio"
                aria-checked={selectedTheme === t.name}
                className={`flex w-full items-start gap-2 rounded-md border p-2 text-left transition-colors ${selectedTheme === t.name ? 'border-accent bg-accent-soft' : 'border-app bg-app hover:border-app-strong'}`}
                onClick={() => setSelectedTheme(t.name)}
              >
                <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-md border ${selectedTheme === t.name ? 'border-accent bg-accent text-white' : 'border-app bg-app-card'}`}>
                  {selectedTheme === t.name && <Check className="h-3 w-3" />}
                </span>
                <span className="text-[12px]"><span className="font-medium text-theme-primary">{t.name}</span> — {t.description} <span className="text-theme-muted">({t.location})</span></span>
              </button>
            ))}
          </div>
        </div>
      )}

      {error && <p className="text-[12px] text-red-500">{error}</p>}
      <button
        className="btn btn-primary btn-sm inline-flex items-center gap-1.5"
        onClick={confirm}
        disabled={busy || (needsStrategy && !strategy) || (needsTheme && !selectedTheme)}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Confirm profile & start designing
      </button>
    </div>
  );
}

function SignalCard({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-md border border-app bg-app px-3 py-2 text-[12px]">
      <p className="mb-1 font-medium text-theme-primary">{title}</p>
      <p className="line-clamp-2 text-theme-muted">{value}</p>
    </div>
  );
}

function ChoiceButton({ active, onClick, title, desc }: { active: boolean; onClick: () => void; title: string; desc: string }) {
  return (
    <button className={`flex-1 rounded-md border p-3 text-left transition ${active ? 'border-accent bg-accent-soft' : 'border-app bg-app hover:border-app-strong'}`} onClick={onClick}>
      <span className="block text-[13px] font-medium text-theme-primary">{title}</span>
      <span className="block text-[11px] text-theme-muted">{desc}</span>
    </button>
  );
}

// ── Greenfield setup ──────────────────────────────────────────────────────────

const DISCOVERY_QUESTIONS: { key: string; label: string; placeholder: string }[] = [
  { key: 'product', label: 'What is the product?', placeholder: 'e.g. A habit-tracking app for students' },
  { key: 'audience', label: 'Who is the target audience?', placeholder: 'e.g. University students, 18–24' },
  { key: 'feel', label: 'Brand personality / desired feel?', placeholder: 'e.g. Friendly, energetic, modern' },
  { key: 'references', label: 'Reference products or styles you like/dislike?', placeholder: 'e.g. Like Notion; dislike cluttered dashboards' },
  { key: 'screens', label: 'Key screens or flows needed?', placeholder: 'e.g. Onboarding, dashboard, habit detail' },
];

function GreenfieldSetup({ ws, onChange }: { ws: Workspace; onChange: () => Promise<void> }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true); setError(null);
    try { await designStudio.greenfield(ws._id, { idea: ws.name, answers }); await onChange(); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  }

  return (
    <div className="max-w-2xl rounded-md border border-app bg-app-card p-5">
      <h3 className="mb-1 text-[15px] font-semibold text-theme-primary">Shape the design brief</h3>
      <p className="mb-4 text-[13px] text-theme-muted">Answer what matters. Blank fields are allowed; the brief will record any assumptions.</p>
      <div className="space-y-3">
        {DISCOVERY_QUESTIONS.map((q) => (
          <label key={q.key} className="block">
            <span className="mb-1 block text-[12px] font-medium text-theme-primary">{q.label}</span>
            <input className="input h-9 w-full rounded-md text-[13px]" placeholder={q.placeholder} value={answers[q.key] ?? ''} onChange={(e) => setAnswers({ ...answers, [q.key]: e.target.value })} />
          </label>
        ))}
      </div>
      {error && <p className="mt-3 text-[12px] text-red-500">{error}</p>}
      <button className="btn btn-primary btn-sm mt-4 inline-flex items-center gap-1.5" onClick={submit} disabled={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Save brief & start designing
      </button>
    </div>
  );
}

// ── Confirmed workspace (sessions) ────────────────────────────────────────────

function ConfirmedWorkspace({ ws, sessions, files, repoChanged, onChange, onOpenSession }: {
  ws: Workspace; sessions: DesignSummary[]; files: WorkspaceFile[]; repoChanged: boolean; onChange: () => Promise<void>; onOpenSession: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const grouped = useMemo(() => groupWorkspaceFiles(files), [files]);

  async function newSession() {
    setBusy(true);
    try { onOpenSession(''); }
    finally { setBusy(false); }
  }
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  async function refreshProfile() {
    setBusy(true);
    try { await designStudio.analyze(ws._id); await onChange(); }
    finally { setBusy(false); }
  }

  async function updateRepoContext() {
    setRefreshBusy(true);
    setRefreshError(null);
    try {
      await designStudio.refresh(ws._id);
      await onChange();
    } catch (e) {
      setRefreshError((e as Error).message);
    } finally {
      setRefreshBusy(false);
    }
  }

  return (
    <div className="grid min-h-0 gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
      <main className="space-y-5">
      {repoChanged && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-accent-yellow/40 bg-accent-yellow/10 px-4 py-3">
          <span className="text-[12px] text-amber-600">This repository changed since the profile was built. Refresh the profile or keep the current one.</span>
          <button className="btn btn-secondary btn-sm shrink-0" onClick={updateRepoContext} disabled={busy || refreshBusy}>Refresh profile</button>
        </div>
      )}

      <AnalysisSummary ws={ws} files={files} onRefresh={updateRepoContext} refreshBusy={refreshBusy} refreshError={refreshError} />

      <section className="rounded-md border border-app bg-app-card">
        <div className="flex items-center justify-between gap-3 border-b border-app px-4 py-3">
          <div>
            <h3 className="text-[14px] font-semibold text-theme-primary">Design chats</h3>
            <p className="mt-0.5 text-[12px] text-theme-muted">Plan, create, and iterate design groups for this workspace.</p>
          </div>
          <button className="btn btn-primary btn-sm inline-flex items-center gap-1.5 !rounded-md" onClick={newSession} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} New design chat
          </button>
        </div>
        {sessions.length === 0 ? (
          <div className="p-8 text-center text-[13px] text-theme-muted">
            No design chats yet. Start one to create the first design group.
          </div>
        ) : (
          <div className="divide-y divide-app">
            {sessions.map((s) => (
              <button key={s._id} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-app-muted" onClick={() => onOpenSession(s._id)}>
                <span className="flex min-w-0 items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-app bg-app text-theme-muted">
                    <MessageSquare className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium text-theme-primary">{s.title}</span>
                    <span className="block font-mono text-[10.5px] text-theme-muted">{s.messageCount} message{s.messageCount === 1 ? '' : 's'}</span>
                  </span>
                </span>
                <span className="shrink-0 text-[11px] text-theme-muted">{new Date(s.lastMessageAt).toLocaleString()}</span>
              </button>
            ))}
          </div>
        )}
      </section>
      </main>

      <aside className="space-y-5">
        <section className="rounded-md border border-app bg-app-card">
          <div className="border-b border-app px-4 py-3">
            <h3 className="text-[14px] font-semibold text-theme-primary">Design folders</h3>
            <p className="mt-0.5 text-[12px] text-theme-muted">Generated groups in this workspace.</p>
          </div>
          {grouped.designGroups.length === 0 ? (
            <div className="p-5 text-[13px] text-theme-muted">No design folders yet.</div>
          ) : (
            <div className="divide-y divide-app">
              {grouped.designGroups.map((group) => (
                <div key={group.slug} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <Folder className="h-4 w-4 shrink-0 text-accent" />
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-medium text-theme-primary">{group.slug.replace(/[-_]+/g, ' ')}</p>
                        <p className="font-mono text-[10.5px] text-theme-muted">{group.files.length} HTML file{group.files.length === 1 ? '' : 's'}</p>
                      </div>
                    </div>
                    <button className="rounded-md p-1.5 text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary" onClick={() => openWorkspacePreview(ws._id, `designs/${group.slug}/index.html`)} aria-label={`Open ${group.slug}`}>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </aside>
    </div>
  );
}

function AnalysisSummary({ ws, files, onRefresh, refreshBusy, refreshError }: {
  ws: Workspace;
  files: WorkspaceFile[];
  onRefresh?: () => Promise<void>;
  refreshBusy?: boolean;
  refreshError?: string | null;
}) {
  const profile = ws.profile;
  const systemCount = files.filter((file) => file.path.startsWith('system/')).length;
  const hasProMax = files.some((file) => file.path === 'system/pro-max.md' || file.path === 'system/pro-max.json');
  const hasRepoContext = files.some((file) => file.path === 'system/repo-context.md' || file.path === 'system/repo-context.json');
  return (
    <section className="rounded-md border border-app bg-app-card">
      <div className="flex items-center justify-between gap-3 border-b border-app px-4 py-3">
        <div>
          <h3 className="text-[14px] font-semibold text-theme-primary">Repository analysis complete</h3>
          <p className="mt-0.5 text-[12px] text-theme-muted">
            {ws.kind === 'repo' ? 'Design chats use this repository kit and read source pages on demand.' : 'Design chats use this confirmed brief.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex h-7 items-center rounded-md border border-app bg-app px-2 font-mono text-[10.5px] text-theme-muted">{systemCount} system files</span>
          {ws.kind === 'repo' && onRefresh && (
            <button
              className="btn btn-secondary btn-sm inline-flex items-center gap-1.5 !rounded-md"
              onClick={onRefresh}
              disabled={refreshBusy}
              title="Re-run analysis and refresh all repo context, design tokens, components, and Pro Max intelligence"
            >
              {refreshBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Update repo context &amp; design system
            </button>
          )}
        </div>
      </div>
      {refreshError && (
        <div className="border-b border-app px-4 py-2 text-[12px] text-accent-red">{refreshError}</div>
      )}
      {profile ? (
        <div className="grid gap-3 p-4 md:grid-cols-6">
          <MetricCard label="Colors" value={String(profile.colors.length)} />
          <MetricCard label="Components" value={String(profile.components?.length ?? 0)} />
          <MetricCard label="Typography" value={profile.typography ? 'Captured' : 'Default'} />
          <MetricCard label="Icons" value={profile.iconography ? 'Captured' : 'Default'} />
          <MetricCard label="Intelligence" value={hasProMax ? 'Pro Max' : 'Pending'} />
          <MetricCard label="Repo Context" value={hasRepoContext ? 'Captured' : 'Pending'} />
        </div>
      ) : (
        <div className="p-4 text-[13px] text-theme-muted">Brief confirmed.</div>
      )}
    </section>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-app bg-app px-3 py-2">
      <p className="font-mono text-[10.5px] uppercase text-theme-muted">{label}</p>
      <p className="mt-1 truncate text-[13px] font-medium text-theme-primary">{value}</p>
    </div>
  );
}
