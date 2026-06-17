/**
 * Design Studio — workspace design-system panel.
 *
 * Groups generated design folders, system kit files, and other workspace files.
 * HTML files can be previewed in browser; every file can be opened in a
 * read-only source drawer.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ChevronRight,
  Code2,
  ExternalLink,
  Eye,
  FileCode,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Layers,
  ListTree,
  Loader2,
  RefreshCw,
  Rows3,
  Upload,
  X,
} from 'lucide-react';
import DirectMonacoEditor from '../common/DirectMonacoEditor';
import {
  designStudio, workspaceSitePath, resolvePreviewAbsoluteUrl, openInBrowser,
  type WorkspaceFile, type WorkspaceFileContent,
} from '../../services/designStudioService';

interface DesignGroup {
  slug: string;
  files: WorkspaceFile[];
}

type PanelMode = 'explorer' | 'grouped';

interface FileTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: FileTreeNode[];
  file?: WorkspaceFile;
}

const PANEL_MODE_STORAGE_KEY = 'allen.designStudio.filesPanelMode';

function designLabel(slug: string): string {
  return slug.split('-').filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ') || slug;
}

function fileName(path: string): string {
  return path.split('/').pop() || path;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function iconForFile(file: WorkspaceFile) {
  if (file.isHtml) return <FileText className="h-3.5 w-3.5 text-accent" />;
  if (/\.json$/i.test(file.path)) return <FileJson className="h-3.5 w-3.5 text-accent-yellow" />;
  if (/\.css$/i.test(file.path)) return <Code2 className="h-3.5 w-3.5 text-accent-blue" />;
  return <FileCode className="h-3.5 w-3.5 text-theme-muted" />;
}

function languageForFile(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    css: 'css',
    html: 'html',
    js: 'javascript',
    json: 'json',
    jsx: 'javascript',
    md: 'markdown',
    mjs: 'javascript',
    scss: 'scss',
    ts: 'typescript',
    tsx: 'typescript',
    txt: 'plaintext',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
  };
  return map[ext] ?? 'plaintext';
}

function buildFileTree(files: WorkspaceFile[]): FileTreeNode[] {
  const root: FileTreeNode = { name: '', path: '', isDir: true, children: [] };
  const byPath = new Map<string, FileTreeNode>([['', root]]);
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    let parent = root;
    let currentPath = '';
    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isLeaf = index === parts.length - 1;
      let node = byPath.get(currentPath);
      if (!node) {
        node = { name: part, path: currentPath, isDir: !isLeaf, children: [] };
        byPath.set(currentPath, node);
        parent.children.push(node);
      }
      if (isLeaf) {
        node.isDir = false;
        node.file = file;
      }
      parent = node;
    });
  }
  const sort = (nodes: FileTreeNode[]) => {
    nodes.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    nodes.forEach((node) => sort(node.children));
  };
  sort(root.children);
  return root.children;
}

export function groupWorkspaceFiles(files: WorkspaceFile[]) {
  const pages = files.filter((f) => f.isHtml);
  const dashboard = pages.find((f) => f.path === 'index.html') ?? null;
  const designGroups = Array.from(pages.reduce((groups, file) => {
    const match = file.path.match(/^designs\/([^/]+)\/(.+\.html?)$/i);
    if (!match) return groups;
    const slug = match[1];
    const existing = groups.get(slug) ?? { slug, files: [] as WorkspaceFile[] };
    existing.files.push(file);
    groups.set(slug, existing);
    return groups;
  }, new Map<string, DesignGroup>()).values())
    .map((group) => ({
      ...group,
      files: group.files.sort((a, b) => (a.path.endsWith('/index.html') ? -1 : b.path.endsWith('/index.html') ? 1 : a.path.localeCompare(b.path))),
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  const systemFiles = files.filter((f) => f.path.startsWith('system/')).sort((a, b) => a.path.localeCompare(b.path));
  const loosePages = pages.filter((f) => f.path !== 'index.html' && !f.path.startsWith('designs/'));
  const otherFiles = files.filter((f) => !f.isHtml && !f.path.startsWith('system/')).sort((a, b) => a.path.localeCompare(b.path));
  return { dashboard, designGroups, systemFiles, loosePages, otherFiles };
}

export default function WorkspaceFilesPanel({ workspaceId }: { workspaceId: string | null }) {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [viewer, setViewer] = useState<WorkspaceFileContent | null>(null);
  const [viewerLoading, setViewerLoading] = useState<string | null>(null);
  const [mode, setMode] = useState<PanelMode>(() => {
    if (typeof window === 'undefined') return 'explorer';
    return window.localStorage.getItem(PANEL_MODE_STORAGE_KEY) === 'grouped' ? 'grouped' : 'explorer';
  });
  const groups = useMemo(() => groupWorkspaceFiles(files), [files]);
  const tree = useMemo(() => buildFileTree(files), [files]);

  useEffect(() => {
    window.localStorage.setItem(PANEL_MODE_STORAGE_KEY, mode);
  }, [mode]);

  const refresh = useCallback(async () => {
    if (!workspaceId) { setFiles([]); return; }
    setLoading(true);
    try { setFiles(await designStudio.listFiles(workspaceId)); }
    catch { /* keep last */ }
    finally { setLoading(false); }
  }, [workspaceId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!workspaceId) return;
    const t = setInterval(() => { void refresh(); }, 5000);
    return () => clearInterval(t);
  }, [workspaceId, refresh]);

  async function open(file = 'index.html') {
    if (!workspaceId) return;
    openInBrowser(await resolvePreviewAbsoluteUrl(workspaceSitePath(workspaceId, file)));
  }

  async function view(file: WorkspaceFile) {
    if (!workspaceId) return;
    setViewerLoading(file.path);
    setNote(null);
    try {
      setViewer(await designStudio.readFile(workspaceId, file.path));
    } catch (e) {
      setNote(`Could not open ${file.path}: ${(e as Error).message}`);
    } finally {
      setViewerLoading(null);
    }
  }

  async function exportSystem() {
    if (!workspaceId) return;
    setExporting(true);
    setNote(null);
    try {
      const desktop = (window as any).allenDesktop;
      const res = await designStudio.exportSystem(workspaceId);
      setNote(`Exported to: ${res.dir}`);
      if (desktop?.showItemInFolder) void desktop.showItemInFolder(res.dir);
    } catch (e) {
      setNote(`Export failed: ${(e as Error).message}`);
    } finally {
      setExporting(false);
    }
  }

  const hasFiles = files.length > 0;

  return (
    <aside className="flex w-[380px] min-w-[320px] flex-col border-l border-app bg-app-card">
      <div className="border-b border-app px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-theme-primary">
              <Layers className="h-4 w-4 text-accent" />
              Design system
            </div>
            <p className="mt-0.5 text-[11px] text-theme-muted">Workspace files and export controls</p>
          </div>
          <button className="rounded-md p-1.5 text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary" onClick={() => void refresh()} aria-label="Refresh files">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </button>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button className="btn btn-secondary btn-sm justify-center gap-1.5 !rounded-md" onClick={() => open('index.html')} disabled={!hasFiles}>
            <ExternalLink className="h-3.5 w-3.5" /> Preview
          </button>
          <button className="btn btn-primary btn-sm justify-center gap-1.5 !rounded-md" onClick={exportSystem} disabled={!hasFiles || exporting} title="Exports to Downloads/Allen Design Studio">
            {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Export
          </button>
        </div>
        <p className="mt-2 truncate font-mono text-[10.5px] text-theme-muted" title="~/Downloads/Allen Design Studio">
          Export path: ~/Downloads/Allen Design Studio
        </p>
        <div className="mt-3 flex rounded-md border border-app bg-app p-0.5">
          <ModeButton active={mode === 'explorer'} icon={<ListTree className="h-3.5 w-3.5" />} label="Explorer" onClick={() => setMode('explorer')} />
          <ModeButton active={mode === 'grouped'} icon={<Rows3 className="h-3.5 w-3.5" />} label="Grouped" onClick={() => setMode('grouped')} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!hasFiles ? (
          <div className="rounded-md border border-dashed border-app bg-app px-4 py-8 text-center text-[13px] text-theme-muted">
            Files will appear after the first design is created.
          </div>
        ) : mode === 'explorer' ? (
          <div className="space-y-0.5">
            {tree.map((node) => (
              <FileTreeNodeView key={node.path} node={node} activePath={viewer?.path ?? ''} loadingPath={viewerLoading} onPreview={open} onView={view} />
            ))}
          </div>
        ) : (
          <GroupedFiles groups={groups} viewerPath={viewer?.path ?? ''} loadingPath={viewerLoading} onPreview={open} onView={view} />
        )}
        {note && <p className="mt-3 rounded-md border border-app bg-app px-3 py-2 text-[11px] text-theme-muted">{note}</p>}
      </div>

      {viewer && <FileViewer file={viewer} onClose={() => setViewer(null)} />}
    </aside>
  );
}

function ModeButton({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-[11px] font-medium transition-colors ${active ? 'bg-app-card text-theme-primary shadow-sm' : 'text-theme-muted hover:text-theme-primary'}`}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

function GroupedFiles({ groups, viewerPath, loadingPath, onPreview, onView }: {
  groups: ReturnType<typeof groupWorkspaceFiles>;
  viewerPath: string;
  loadingPath: string | null;
  onPreview: (path: string) => void;
  onView: (file: WorkspaceFile) => void;
}) {
  return (
    <div className="space-y-4">
      {groups.dashboard && (
        <FileSection title="Dashboard">
          <FileRow file={groups.dashboard} active={viewerPath === groups.dashboard.path} onPreview={() => onPreview(groups.dashboard!.path)} onView={() => onView(groups.dashboard!)} loading={loadingPath === groups.dashboard.path} />
        </FileSection>
      )}

      <FileSection title="Design folders" count={groups.designGroups.length}>
        {groups.designGroups.length === 0 ? (
          <p className="rounded-md border border-dashed border-app bg-app px-3 py-4 text-[12px] text-theme-muted">No design folders yet.</p>
        ) : groups.designGroups.map((group) => (
          <div key={group.slug} className="rounded-md border border-app bg-app">
            <div className="flex w-full items-center justify-between gap-2 border-b border-app px-3 py-2 text-left">
              <span className="flex min-w-0 items-center gap-2">
                <Folder className="h-3.5 w-3.5 shrink-0 text-accent" />
                <span className="truncate text-[12.5px] font-medium text-theme-primary">{designLabel(group.slug)}</span>
              </span>
              <span className="shrink-0 font-mono text-[10.5px] text-theme-muted">{group.files.length} file{group.files.length === 1 ? '' : 's'}</span>
            </div>
            <div className="p-1">
              {group.files.map((file) => (
                <FileRow key={file.path} file={file} active={viewerPath === file.path} compact label={file.path.replace(`designs/${group.slug}/`, '')} onPreview={() => onPreview(file.path)} onView={() => onView(file)} loading={loadingPath === file.path} />
              ))}
            </div>
          </div>
        ))}
      </FileSection>

      {groups.systemFiles.length > 0 && (
        <FileSection title="System kit" count={groups.systemFiles.length}>
          {groups.systemFiles.map((file) => (
            <FileRow key={file.path} file={file} active={viewerPath === file.path} label={file.path.replace('system/', '')} onPreview={file.isHtml ? () => onPreview(file.path) : undefined} onView={() => onView(file)} loading={loadingPath === file.path} />
          ))}
        </FileSection>
      )}

      {(groups.loosePages.length > 0 || groups.otherFiles.length > 0) && (
        <FileSection title="Other files" count={groups.loosePages.length + groups.otherFiles.length}>
          {[...groups.loosePages, ...groups.otherFiles].map((file) => (
            <FileRow key={file.path} file={file} active={viewerPath === file.path} onPreview={file.isHtml ? () => onPreview(file.path) : undefined} onView={() => onView(file)} loading={loadingPath === file.path} />
          ))}
        </FileSection>
      )}
    </div>
  );
}

function FileTreeNodeView({ node, activePath, loadingPath, onPreview, onView, depth = 0 }: {
  node: FileTreeNode;
  activePath: string;
  loadingPath: string | null;
  onPreview: (path: string) => void;
  onView: (file: WorkspaceFile) => void;
  depth?: number;
}) {
  if (node.isDir) {
    return (
      <details className="group/tree" open={depth < 1}>
        <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11.5px] text-theme-secondary transition-colors hover:bg-app-muted hover:text-theme-primary" style={{ paddingLeft: 8 + depth * 12 }}>
          <ChevronRight className="h-3 w-3 shrink-0 text-theme-muted transition-transform group-open/tree:rotate-90" />
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-theme-muted" />
          <span className="truncate font-mono">{node.name}</span>
        </summary>
        <div>
          {node.children.map((child) => (
            <FileTreeNodeView key={child.path} node={child} activePath={activePath} loadingPath={loadingPath} onPreview={onPreview} onView={onView} depth={depth + 1} />
          ))}
        </div>
      </details>
    );
  }
  if (!node.file) return null;
  return (
    <div className={`group flex w-full min-w-0 items-center rounded-md text-[11.5px] transition-colors hover:bg-app-muted hover:text-theme-primary ${activePath === node.path ? 'bg-accent-soft text-accent' : 'text-theme-secondary'}`}>
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-left"
        style={{ paddingLeft: 20 + depth * 12 }}
        onClick={() => onView(node.file!)}
      >
        <span className="shrink-0">{loadingPath === node.path ? <Loader2 className="h-3.5 w-3.5 animate-spin text-theme-muted" /> : iconForFile(node.file)}</span>
        <span className="min-w-0 flex-1 truncate font-mono">{node.name}</span>
      </button>
      {node.file.isHtml && (
        <button
          type="button"
          className="mr-1 rounded-md p-1 text-theme-muted opacity-100 transition-colors hover:bg-app-card hover:text-theme-primary sm:opacity-0 sm:group-hover:opacity-100"
          onClick={() => onPreview(node.path)}
          aria-label={`Preview ${node.path}`}
          title="Preview"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function FileSection({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between px-1">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-theme-muted">{title}</p>
        {typeof count === 'number' && <span className="font-mono text-[10.5px] text-theme-subtle">{count}</span>}
      </div>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function FileRow({ file, label, compact, active, loading, onPreview, onView }: {
  file: WorkspaceFile;
  label?: string;
  compact?: boolean;
  active?: boolean;
  loading?: boolean;
  onPreview?: () => void;
  onView: () => void;
}) {
  return (
    <div className={`group flex w-full items-center rounded-md text-[12px] transition-colors hover:bg-app-muted ${active ? 'bg-accent-soft' : ''}`}>
      <button type="button" className={`flex min-w-0 flex-1 items-center gap-2 px-2 text-left ${compact ? 'py-1' : 'py-1.5'}`} onClick={onView}>
        <span className="shrink-0">{iconForFile(file)}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-theme-primary">{label ?? fileName(file.path)}</span>
          {!compact && <span className="block truncate font-mono text-[10.5px] text-theme-muted">{file.path} · {formatBytes(file.size)}</span>}
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-1 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100">
        {onPreview && (
          <button type="button" className="rounded-md p-1 text-theme-muted transition-colors hover:bg-app-card hover:text-theme-primary" onClick={onPreview} aria-label={`Preview ${file.path}`} title="Preview">
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        )}
        <span className="mr-1 rounded-md p-1 text-theme-muted transition-colors hover:bg-app-card hover:text-theme-primary" aria-label={`View ${file.path}`} title="View file">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
        </span>
      </div>
    </div>
  );
}

function FileViewer({ file, onClose }: { file: WorkspaceFileContent; onClose: () => void }) {
  return (
    <div className="fixed bottom-0 right-0 top-0 z-[70] flex w-[560px] max-w-[calc(100vw-24px)] flex-col border-l border-app bg-app-card shadow-[-24px_0_60px_rgba(0,0,0,0.24)]">
      <div className="flex items-start justify-between gap-3 border-b border-app px-4 py-3">
        <div className="min-w-0">
          <h3 className="truncate text-[13px] font-semibold text-theme-primary">{file.path}</h3>
          <p className="mt-0.5 font-mono text-[10.5px] text-theme-muted">
            {formatBytes(file.size)}{file.truncated ? ' · truncated preview' : ''}
          </p>
        </div>
        <button className="rounded-md p-1.5 text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary" onClick={onClose} aria-label="Close file viewer">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <DirectMonacoEditor
          value={file.content}
          language={languageForFile(file.path)}
          readOnly
          height="100%"
          options={{
            minimap: { enabled: true, scale: 1 },
            padding: { top: 12, bottom: 24 },
            wordWrap: 'off',
          }}
        />
      </div>
    </div>
  );
}
