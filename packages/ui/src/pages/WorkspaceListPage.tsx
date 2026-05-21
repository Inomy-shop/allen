import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ChevronDown, ChevronRight, ExternalLink, FileText, FolderGit2, GitBranch,
  GitPullRequest, Loader2, MessageSquare, Play, Plus, RefreshCw, RotateCw,
  Save, Settings, Square, Terminal, Trash2, X,
} from 'lucide-react';
import Editor, { DiffEditor } from '@monaco-editor/react';
import { workspaces } from '../services/workspaceService';
import { repos as repoApi } from '../services/api';
import StatusBadge from '../components/common/StatusBadge';
import { WorkspaceConfigEditor } from '../components/workspace/WorkspaceConfigEditor';
import { SetupProgressDialog } from '../components/workspace/SetupProgressDialog';
import { EmbeddedChat } from '../components/workspace/EmbeddedChat';
import { XTerminal } from '../components/workspace/XTerminal';
import { getMonacoTheme, setupMonaco } from '../lib/monaco-theme';

type Workspace = {
  _id: string;
  name: string;
  repoId?: string;
  repoName?: string;
  repoPath?: string;
  worktreePath?: string;
  branch?: string;
  baseBranch?: string;
  status?: string;
  source?: string;
  prNumber?: number;
  prUrl?: string;
  basePort?: number;
  changedFiles?: number;
  ahead?: number;
  behind?: number;
  setupProgress?: { log?: string[]; status?: string };
  services?: Array<{ name: string; status: string; port?: number }>;
  chatSessionId?: string;
  chatSessionIds?: string[];
  createdAt?: string;
  updatedAt?: string;
};

type DiffFile = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  diff?: string;
  originalContent?: string;
  modifiedContent?: string;
};

type FileEntry = {
  path: string;
  isDir?: boolean;
  status?: string;
};

type FileTreeNodeData = {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileTreeNodeData[];
  status?: string;
};

type ChatSessionSummary = {
  _id: string;
  title?: string;
  provider?: string;
  model?: string;
  messageCount?: number;
  lastMessageAt?: string;
};

type WorkspaceUiState = {
  activeTab?: string;
  openChatIds?: string[];
  activeFile?: string;
  diffMode?: 'unified' | 'split';
  explorerFile?: string;
  fileContent?: string;
  fileDirty?: boolean;
};

type SplitDiffRow = {
  key: number;
  type: string;
  header?: string;
  leftNo?: number;
  leftText?: string;
  rightNo?: number;
  rightText?: string;
};

const STATUS_LETTER: Record<string, string> = {
  added: 'A',
  new: 'A',
  modified: 'M',
  deleted: 'D',
};

function parseDiff(diff?: string, fallbackContent?: string) {
  if (diff?.trim()) {
    const rows: Array<{ key: number; type: string; marker: string; text: string; lineNo?: number | string }> = [];
    let oldLine = 0;
    let newLine = 0;
    for (const rawLine of diff.split('\n').slice(0, 260)) {
      if (
        rawLine.startsWith('diff --git ') ||
        rawLine.startsWith('index ') ||
        rawLine.startsWith('--- ') ||
        rawLine.startsWith('+++ ')
      ) {
        continue;
      }
      if (rawLine.startsWith('@@')) {
        const match = rawLine.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?/);
        if (match) {
          oldLine = Number(match[1]);
          newLine = Number(match[2]);
        }
        rows.push({ key: rows.length, type: 'h', marker: '', text: rawLine, lineNo: '' });
        continue;
      }
      if (rawLine.startsWith('-')) {
        rows.push({ key: rows.length, type: 'r', marker: '-', text: rawLine.slice(1), lineNo: oldLine || '' });
        if (oldLine) oldLine += 1;
        continue;
      }
      if (rawLine.startsWith('+')) {
        rows.push({ key: rows.length, type: 'a', marker: '+', text: rawLine.slice(1), lineNo: newLine || '' });
        if (newLine) newLine += 1;
        continue;
      }
      const text = rawLine.startsWith(' ') ? rawLine.slice(1) : rawLine;
      rows.push({ key: rows.length, type: 'c', marker: ' ', text, lineNo: newLine || oldLine || '' });
      if (oldLine) oldLine += 1;
      if (newLine) newLine += 1;
    }
    return rows;
  }
  const lines = (fallbackContent ?? '').split('\n').slice(0, 160);
  return lines.map((line, idx) => ({ key: idx, type: 'c', marker: ' ', text: line, lineNo: idx + 1 }));
}

function parseSplitDiff(diff?: string, fallbackContent?: string): SplitDiffRow[] {
  if (!diff?.trim()) {
    return (fallbackContent ?? '').split('\n').slice(0, 160).map((line, idx) => ({
      key: idx,
      type: 'c',
      leftNo: idx + 1,
      leftText: line,
      rightNo: idx + 1,
      rightText: line,
    }));
  }

  type SideLine = { no: number; text: string };
  const rows: SplitDiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let pendingRemoved: SideLine[] = [];
  let pendingAdded: SideLine[] = [];

  const flushChanges = () => {
    const count = Math.max(pendingRemoved.length, pendingAdded.length);
    for (let i = 0; i < count; i++) {
      const left = pendingRemoved[i];
      const right = pendingAdded[i];
      rows.push({
        key: rows.length,
        type: left && right ? 'm' : left ? 'r' : 'a',
        leftNo: left?.no,
        leftText: left?.text,
        rightNo: right?.no,
        rightText: right?.text,
      });
    }
    pendingRemoved = [];
    pendingAdded = [];
  };

  for (const rawLine of diff.split('\n').slice(0, 260)) {
    if (
      rawLine.startsWith('diff --git ') ||
      rawLine.startsWith('index ') ||
      rawLine.startsWith('--- ') ||
      rawLine.startsWith('+++ ')
    ) {
      continue;
    }
    if (rawLine.startsWith('@@')) {
      flushChanges();
      const match = rawLine.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?/);
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
      }
      rows.push({ key: rows.length, type: 'h', header: rawLine });
      continue;
    }
    if (rawLine.startsWith('-')) {
      pendingRemoved.push({ no: oldLine++, text: rawLine.slice(1) });
      continue;
    }
    if (rawLine.startsWith('+')) {
      pendingAdded.push({ no: newLine++, text: rawLine.slice(1) });
      continue;
    }
    flushChanges();
    const text = rawLine.startsWith(' ') ? rawLine.slice(1) : rawLine;
    rows.push({
      key: rows.length,
      type: 'c',
      leftNo: oldLine || undefined,
      leftText: text,
      rightNo: newLine || undefined,
      rightText: text,
    });
    if (oldLine) oldLine += 1;
    if (newLine) newLine += 1;
  }
  flushChanges();
  return rows;
}

function chatLabel(session?: ChatSessionSummary) {
  if (!session) return 'new chat';
  const title = session.title?.trim();
  return title && title !== 'New Conversation' ? title : `chat ${session._id.slice(-4)}`;
}

function getLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    mjs: 'javascript', cjs: 'javascript', json: 'json', md: 'markdown', mdx: 'markdown',
    css: 'css', scss: 'scss', less: 'less', html: 'html', xml: 'xml',
    yml: 'yaml', yaml: 'yaml', toml: 'ini', py: 'python', rb: 'ruby',
    go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
    c: 'c', cpp: 'cpp', h: 'c', sh: 'shell', bash: 'shell', zsh: 'shell',
    sql: 'sql', graphql: 'graphql', tf: 'hcl', env: 'ini', txt: 'plaintext',
    log: 'plaintext', prisma: 'graphql', dockerfile: 'dockerfile',
  };
  return map[ext] ?? 'plaintext';
}

function buildFileTree(files: FileEntry[]): FileTreeNodeData[] {
  const root: Record<string, any> = {};
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const path = parts.slice(0, i + 1).join('/');
      if (i === parts.length - 1) {
        current[part] = { name: part, path: file.path, isDir: false, status: file.status };
      } else {
        if (!current[part]) current[part] = { name: part, path, isDir: true, _children: {} };
        current = current[part]._children;
      }
    }
  }
  function toArray(obj: Record<string, any>): FileTreeNodeData[] {
    return Object.values(obj)
      .map(item => item.isDir && item._children ? { ...item, children: toArray(item._children) } : item)
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  }
  return toArray(root);
}

function WorkspaceFileTreeNode({
  node,
  selectedFile,
  onSelect,
  level = 0,
}: {
  node: FileTreeNodeData;
  selectedFile?: string;
  onSelect: (path: string) => void;
  level?: number;
}) {
  const [expanded, setExpanded] = useState(level < 1);
  const selected = selectedFile === node.path;
  if (node.isDir) {
    return (
      <div>
        <button className="ws-tree-node dir" style={{ paddingLeft: `${level * 14 + 8}px` }} onClick={() => setExpanded(v => !v)} type="button">
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <FolderGit2 className="h-3.5 w-3.5" />
          <span>{node.name}</span>
        </button>
        {expanded && node.children?.map(child => (
          <WorkspaceFileTreeNode key={child.path} node={child} selectedFile={selectedFile} onSelect={onSelect} level={level + 1} />
        ))}
      </div>
    );
  }
  return (
    <button className={`ws-tree-node file ${selected ? 'active' : ''}`} style={{ paddingLeft: `${level * 14 + 22}px` }} onClick={() => onSelect(node.path)} type="button">
      <FileText className="h-3.5 w-3.5" />
      <span>{node.name}</span>
      {node.status && <em>{node.status === 'added' ? 'A' : node.status === 'deleted' ? 'D' : 'M'}</em>}
    </button>
  );
}

export default function WorkspaceListPage() {
  const { id: routeWorkspaceId } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const [repos, setRepos] = useState<any[]>([]);
  const [workspaceList, setWorkspaceList] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState('');
  const [diffFiles, setDiffFiles] = useState<DiffFile[]>([]);
  const [allFiles, setAllFiles] = useState<FileEntry[]>([]);
  const [activeFile, setActiveFile] = useState('');
  const [explorerFile, setExplorerFile] = useState('');
  const [fileContent, setFileContent] = useState('');
  const [fileDirty, setFileDirty] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [workspaceChats, setWorkspaceChats] = useState<ChatSessionSummary[]>([]);
  const [openChatIds, setOpenChatIds] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState('diff');
  const [diffMode, setDiffMode] = useState<'unified' | 'split'>('unified');
  const [workspaceUi, setWorkspaceUi] = useState<Record<string, WorkspaceUiState>>({});
  const workspaceUiRef = useRef<Record<string, WorkspaceUiState>>({});
  const [mountedTerminalIds, setMountedTerminalIds] = useState<string[]>([]);
  const [serviceAction, setServiceAction] = useState<string | null>(null);
  const [gitBusy, setGitBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ repoId: '', repoPath: '', repoName: '', branch: '', baseBranch: 'main', name: '' });
  const [pendingWsId, setPendingWsId] = useState<string | null>(null);
  const [configRepoId, setConfigRepoId] = useState<string | null>(null);

  const active = useMemo(
    () => workspaceList.find(ws => ws._id === activeId) ?? null,
    [workspaceList, activeId],
  );
  const activeDiff = diffFiles.find(file => file.path === activeFile) ?? diffFiles[0] ?? null;
  const fileTree = useMemo(() => buildFileTree(allFiles), [allFiles]);
  const repoById = useMemo(() => new Map(repos.map(repo => [repo._id, repo])), [repos]);
  const workspaceGroups = useMemo(() => {
    const groups = new Map<string, { key: string; label: string; items: Workspace[] }>();
    for (const ws of workspaceList) {
      const repo = ws.repoId ? repoById.get(ws.repoId) : null;
      const label = repo?.name ?? ws.repoName ?? ws.repoPath?.split('/').pop() ?? 'repo unknown';
      const key = `repo:${label.trim().toLowerCase()}`;
      const existing = groups.get(key);
      if (existing) existing.items.push(ws);
      else groups.set(key, { key, label, items: [ws] });
    }
    return Array.from(groups.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [repoById, workspaceList]);

  useEffect(() => {
    workspaceUiRef.current = workspaceUi;
  }, [workspaceUi]);

  const patchWorkspaceUi = useCallback((workspaceId: string, patch: WorkspaceUiState) => {
    workspaceUiRef.current = {
      ...workspaceUiRef.current,
      [workspaceId]: {
        ...workspaceUiRef.current[workspaceId],
        ...patch,
      },
    };
    setWorkspaceUi(workspaceUiRef.current);
  }, []);

  function showWorkspaceTab(tab: string) {
    setActiveTab(tab);
    if (!activeId) return;
    patchWorkspaceUi(activeId, { activeTab: tab });
    if (tab === 'terminal') {
      setMountedTerminalIds(prev => prev.includes(activeId) ? prev : [...prev, activeId]);
    }
  }

  function selectWorkspace(workspaceId: string) {
    if (activeId) {
      patchWorkspaceUi(activeId, {
        activeTab,
        openChatIds,
        activeFile,
        diffMode,
        explorerFile,
        fileContent,
        fileDirty,
      });
    }
    setActiveId(workspaceId);
  }

  function switchWorkspace(workspaceId: string) {
    selectWorkspace(workspaceId);
    setActiveTab('diff');
    patchWorkspaceUi(workspaceId, { activeTab: 'diff' });
    navigate(`/workspaces/${workspaceId}`);
  }

  function openWorkspace(workspaceId: string) {
    switchWorkspace(workspaceId);
  }

  function startCreateWorkspace() {
    setCreating(true);
    setActiveTab('diff');
    navigate('/workspaces');
  }

  function changeDiffMode(mode: 'unified' | 'split') {
    setDiffMode(mode);
    if (activeId) patchWorkspaceUi(activeId, { diffMode: mode });
  }

  const loadWorkspaces = useCallback(async () => {
    setLoading(true);
    try {
      const [repoList, wsList] = await Promise.all([
        repoApi.list().catch(() => []),
        workspaces.list().catch(() => []),
      ]);
      setRepos(repoList);
      setWorkspaceList(wsList);
      setActiveId(prev => {
        if (routeWorkspaceId && wsList.some((ws: Workspace) => ws._id === routeWorkspaceId)) return routeWorkspaceId;
        if (!routeWorkspaceId) return '';
        if (prev && wsList.some((ws: Workspace) => ws._id === prev)) return prev;
        return '';
      });
    } finally {
      setLoading(false);
    }
  }, [routeWorkspaceId]);

  useEffect(() => { loadWorkspaces(); }, [loadWorkspaces]);

  useEffect(() => {
    if (!activeId) {
      setDiffFiles([]);
      setAllFiles([]);
      setActiveFile('');
      setDiffMode('unified');
      setExplorerFile('');
      setFileContent('');
      setFileDirty(false);
      setWorkspaceChats([]);
      setOpenChatIds([]);
      setActiveTab('chat:new');
      return;
    }
    let cancelled = false;
    Promise.all([
      workspaces.getDiff(activeId, { mode: 'workspace' }).catch(() => ({ files: [] })),
      workspaces.listChats(activeId).catch(() => []),
      workspaces.getAllFiles(activeId).catch(() => []),
    ]).then(([diffResult, chats, filesResult]) => {
      if (cancelled) return;
      const files = (diffResult.files ?? []) as DiffFile[];
      const chatsList = chats as ChatSessionSummary[];
      const cached = workspaceUiRef.current[activeId];
      const defaultChatId = chatsList[0]?._id ?? `new-${activeId}`;
      const restoredOpenChatIds = cached?.openChatIds?.length ? cached.openChatIds : [defaultChatId];
      const restoredTab = cached?.activeTab === 'files' || cached?.activeTab === 'services' ? cached.activeTab : 'diff';
      const restoredTabIsValid =
        ['diff', 'files', 'services', 'terminal'].includes(restoredTab) ||
        restoredOpenChatIds.some(sessionId => restoredTab === `chat:${sessionId}`);
      const nextTab = restoredTabIsValid ? restoredTab : 'diff';
      setDiffFiles(files);
      setAllFiles(filesResult as FileEntry[]);
      setActiveFile(cached?.activeFile && files.some(file => file.path === cached.activeFile) ? cached.activeFile : (files[0]?.path ?? ''));
      setDiffMode(cached?.diffMode ?? 'unified');
      setExplorerFile(cached?.explorerFile ?? '');
      setFileContent(cached?.fileContent ?? '');
      setFileDirty(!!cached?.fileDirty);
      setWorkspaceChats(chatsList);
      setOpenChatIds(restoredOpenChatIds);
      setActiveTab(nextTab);
    });
    return () => { cancelled = true; };
  }, [activeId]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!form.repoId || !form.branch || !form.name) return;
    try {
      const ws = await workspaces.create(form);
      setCreating(false);
      setPendingWsId(ws._id);
      await loadWorkspaces();
    } catch (err: any) {
      alert(err.message);
    }
  }

  function selectRepo(repoId: string) {
    const repo = repos.find(r => r._id === repoId);
    setForm(f => ({ ...f, repoId, repoPath: repo?.path ?? '', repoName: repo?.name ?? '' }));
  }

  function openChat(sessionId: string) {
    const nextOpenChatIds = openChatIds.includes(sessionId) ? openChatIds : [...openChatIds, sessionId];
    setOpenChatIds(nextOpenChatIds);
    setActiveTab(`chat:${sessionId}`);
    if (activeId) patchWorkspaceUi(activeId, { openChatIds: nextOpenChatIds, activeTab: `chat:${sessionId}` });
  }

  function openNewChat() {
    const tempId = `new-${Date.now()}`;
    const nextOpenChatIds = [...openChatIds, tempId];
    setOpenChatIds(nextOpenChatIds);
    setActiveTab(`chat:${tempId}`);
    if (activeId) patchWorkspaceUi(activeId, { openChatIds: nextOpenChatIds, activeTab: `chat:${tempId}` });
  }

  function openWorkspaceChat() {
    if (openChatIds.length > 0) {
      openChat(openChatIds[0]);
      return;
    }
    if (workspaceChats[0]?._id) {
      openChat(workspaceChats[0]._id);
      return;
    }
    openNewChat();
  }

  function focusTerminal() {
    if (!activeId) return;
    setMountedTerminalIds(prev => prev.includes(activeId) ? prev : [...prev, activeId]);
    document.querySelector('.ws-terminal-body')?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }

  function closeChat(sessionId: string) {
    const nextOpenChatIds = openChatIds.filter(id => id !== sessionId);
    const nextTab = activeTab === `chat:${sessionId}` ? 'diff' : activeTab;
    setOpenChatIds(nextOpenChatIds);
    setActiveTab(nextTab);
    if (activeId) patchWorkspaceUi(activeId, { openChatIds: nextOpenChatIds, activeTab: nextTab });
  }

  async function refreshWorkspaceChats() {
    if (!activeId) return;
    const chats = await workspaces.listChats(activeId).catch(() => []);
    setWorkspaceChats(chats as ChatSessionSummary[]);
  }

  async function openExplorerFile(path: string) {
    if (!activeId) return;
    if (fileDirty && !window.confirm('Discard unsaved changes?')) return;
    setExplorerFile(path);
    setFileLoading(true);
    setFileDirty(false);
    try {
      const file = await workspaces.getFile(activeId, path);
      const nextContent = file.isImage ? '[binary image preview is available in the dedicated editor]' : file.content ?? '';
      setFileContent(nextContent);
      patchWorkspaceUi(activeId, { explorerFile: path, fileContent: nextContent, fileDirty: false });
    } catch (err: any) {
      alert(err.message);
    } finally {
      setFileLoading(false);
    }
  }

  async function saveExplorerFile() {
    if (!activeId || !explorerFile || fileLoading) return;
    setFileLoading(true);
    try {
      await workspaces.saveFile(activeId, explorerFile, fileContent);
      setFileDirty(false);
      patchWorkspaceUi(activeId, { explorerFile, fileContent, fileDirty: false });
      const [diffResult, filesResult] = await Promise.all([
        workspaces.getDiff(activeId, { mode: 'workspace' }).catch(() => ({ files: [] })),
        workspaces.getAllFiles(activeId).catch(() => []),
      ]);
      setDiffFiles((diffResult.files ?? []) as DiffFile[]);
      setAllFiles(filesResult as FileEntry[]);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setFileLoading(false);
    }
  }

  async function runServiceAction(name: string, action: 'start' | 'stop' | 'restart') {
    if (!activeId) return;
    setServiceAction(`${name}:${action}`);
    try {
      if (action === 'start') await workspaces.startService(activeId, name);
      else if (action === 'stop') await workspaces.stopService(activeId, name);
      else await workspaces.restartService(activeId, name);
      await loadWorkspaces();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setServiceAction(null);
    }
  }

  async function runGitAction(action: 'pull' | 'push' | 'commit' | 'pr') {
    if (!activeId) return;
    setGitBusy(action);
    try {
      if (action === 'pull') await workspaces.pull(activeId);
      if (action === 'push') await workspaces.push(activeId);
      if (action === 'commit') {
        const message = window.prompt('Commit message');
        if (!message) return;
        await workspaces.commit(activeId, message);
      }
      if (action === 'pr') {
        const title = window.prompt('PR title', active?.name ?? 'Workspace changes');
        if (!title) return;
        const pr = await workspaces.createPR(activeId, title, '');
        if (pr?.url) window.open(pr.url, '_blank');
      }
      await loadWorkspaces();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setGitBusy(null);
    }
  }

  async function deleteWorkspace(workspaceId: string, workspaceName?: string) {
    const label = workspaceName || 'this workspace';
    if (!window.confirm(`Delete ${label}? This removes the worktree and archives the workspace.`)) return;
    setGitBusy(`delete:${workspaceId}`);
    try {
      await workspaces.archive(workspaceId);
      setWorkspaceList(prev => prev.filter(ws => ws._id !== workspaceId));
      if (activeId === workspaceId || routeWorkspaceId === workspaceId) {
        setActiveId('');
        navigate('/workspaces');
      }
    } catch (err: any) {
      alert(err.message);
    } finally {
      setGitBusy(null);
    }
  }

  function handleLinkedChat(tempId: string, realId: string) {
    const nextOpenChatIds = openChatIds.map(id => id === tempId ? realId : id);
    setOpenChatIds(nextOpenChatIds);
    setActiveTab(`chat:${realId}`);
    if (activeId) patchWorkspaceUi(activeId, { openChatIds: nextOpenChatIds, activeTab: `chat:${realId}` });
    refreshWorkspaceChats();
    loadWorkspaces();
  }

  const activeChatId = activeTab.startsWith('chat:') ? activeTab.slice(5) : null;
  const availablePreviousChats = workspaceChats.filter(chat => !openChatIds.includes(chat._id));
  const showWorkspaceDetail = Boolean(routeWorkspaceId) || creating;

  const listContent = (
    <div className="ws-list-content scroll-hide">
      <div className="ws-list-head">
        <div>
          <h1>Workspaces</h1>
          <div className="sub">Isolated agent code environments</div>
        </div>
        <div className="ws-list-actions">
          <button className="btn btn-secondary btn-sm" onClick={loadWorkspaces} type="button" title="Refresh workspaces">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button className="btn btn-primary btn-sm" onClick={startCreateWorkspace} type="button">
            <Plus className="h-3.5 w-3.5" /> New workspace
          </button>
        </div>
      </div>

      {loading && workspaceList.length === 0 ? (
        <div className="ws-list-empty">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> loading workspaces...
        </div>
      ) : workspaceList.length === 0 ? (
        <div className="ws-list-empty">no workspaces yet.</div>
      ) : workspaceGroups.map(group => (
        <section key={group.key} className="ws-list-card">
          <div className="ws-list-card-head">
            <FolderGit2 className="h-3.5 w-3.5 text-theme-muted" />
            <h2>{group.label}</h2>
          </div>
          <div className="ws-list-rows">
            {group.items.map((ws, index) => {
              const status = (ws.status ?? 'active').toLowerCase();
              const changed = ws.changedFiles ?? 0;
              return (
                <div key={ws._id} className="ws-list-row" data-first={index === 0 ? 'true' : undefined}>
                  <div className="ws-list-row-main">
                    <div className="ws-list-row-title">
                      <FolderGit2 className="h-3 w-3 text-accent" />
                      <span>{ws.name}</span>
                      <span className={`ws-workspace-state ${status}`}>{ws.status ?? 'active'}</span>
                      {changed > 0 ? <span className="ws-list-change">{changed} changed</span> : null}
                      {ws.prNumber ? <span className="ws-list-change">PR #{ws.prNumber}</span> : null}
                    </div>
                    <div className="ws-list-row-meta">
                      <span>{ws.branch ?? 'branch unknown'}</span>
                      <span>→</span>
                      <span>{ws.baseBranch ?? 'base unknown'}</span>
                      {ws.basePort ? <><span>·</span><span>port {ws.basePort}</span></> : null}
                      {ws.updatedAt ? <><span>·</span><span>{new Date(ws.updatedAt).toLocaleDateString()}</span></> : null}
                    </div>
                  </div>
                  <div className="ws-list-row-actions">
                    {ws.prUrl ? (
                      <a className="btn btn-ghost btn-sm" href={ws.prUrl} target="_blank" rel="noreferrer" title="Open pull request">
                        <GitPullRequest className="h-3.5 w-3.5" />
                      </a>
                    ) : null}
                    <button className="btn btn-ghost btn-sm" type="button" onClick={() => openWorkspace(ws._id)} title="Open workspace">
                      <ExternalLink className="h-3.5 w-3.5" /> Open
                    </button>
                    <button
                      className="btn btn-ghost btn-sm ws-danger-action"
                      type="button"
                      onClick={() => deleteWorkspace(ws._id, ws.name)}
                      title="Delete workspace"
                      disabled={gitBusy === `delete:${ws._id}`}
                    >
                      {gitBusy === `delete:${ws._id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );

  if (!showWorkspaceDetail) {
    return (
      <div className="ws-shell ws-list-shell" data-screen-label="workspaces">
        {listContent}
        {configRepoId && <WorkspaceConfigEditor repoId={configRepoId} onClose={() => setConfigRepoId(null)} />}
        {pendingWsId && (
          <SetupProgressDialog
            workspaceId={pendingWsId}
            onComplete={(ws) => { setPendingWsId(null); setActiveId(ws._id); loadWorkspaces(); navigate(`/workspaces/${ws._id}`); }}
            onFailed={() => { setPendingWsId(null); loadWorkspaces(); }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="ws-shell ws-detail-shell" data-screen-label="workspaces">
      <div className="ws-detail-layout">
        <div className="ws-stage">
          <header className="ws-ide-topbar">
            <button className="ws-ide-back" type="button" onClick={() => navigate('/workspaces')} title="Back to workspaces">
              <FolderGit2 className="h-3.5 w-3.5 text-theme-muted" />
              <span>all workspaces</span>
            </button>
            <div className="ws-ide-meta">
              <strong>{creating ? 'new workspace' : active?.name ?? 'workspace not found'}</strong>
              <GitBranch className="h-3 w-3" />
              <span>{active?.branch ?? 'branch unknown'}</span>
              <span>→</span>
              <span>{active?.baseBranch ?? 'development'}</span>
              <span>·</span>
              <span>{active?.repoName ?? 'repo unknown'}</span>
              {active?.basePort ? <><span>·</span><span>port {active.basePort}</span></> : null}
            </div>
            <div className="ws-ide-actions">
              {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-theme-muted" />}
              <button onClick={loadWorkspaces} className="btn btn-ghost btn-sm" title="Refresh workspace" type="button">
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              </button>
              {active?.prUrl ? (
                <a href={active.prUrl} target="_blank" rel="noreferrer" className="btn btn-primary btn-sm">
                  <GitPullRequest className="h-3.5 w-3.5" /> open PR
                </a>
              ) : active ? (
                <button onClick={() => runGitAction('pr')} disabled={!active || gitBusy === 'pr'} className="btn btn-primary btn-sm" type="button">
                  {gitBusy === 'pr' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitPullRequest className="h-3.5 w-3.5" />} open PR
                </button>
              ) : null}
              {active ? (
                <button
                  onClick={() => deleteWorkspace(active._id, active.name)}
                  className="btn btn-ghost btn-sm ws-danger-action"
                  title="Delete workspace"
                  type="button"
                  disabled={gitBusy === `delete:${active._id}`}
                >
                  {gitBusy === `delete:${active._id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                </button>
              ) : null}
            </div>
          </header>

          <div className="ws-ide-filebar">
            <div className="ws-ide-filetitle">
              <FileText className="h-3.5 w-3.5" />
              <span>{activeTab === 'diff' ? 'base branch to current workspace diff' : activeDiff?.path ?? 'workspace preview'}</span>
            </div>
            <div className="ws-ide-fileactions">
              <button className={`btn btn-ghost btn-sm ${activeTab === 'diff' ? 'active' : ''}`} onClick={() => showWorkspaceTab('diff')} type="button">diff</button>
              <button className={`btn btn-ghost btn-sm ${activeTab === 'files' ? 'active' : ''}`} onClick={() => showWorkspaceTab('files')} type="button">files</button>
              {(active?.services ?? []).length > 0 ? (
                <button className={`btn btn-ghost btn-sm ${activeTab === 'services' ? 'active' : ''}`} onClick={() => showWorkspaceTab('services')} type="button">services</button>
              ) : null}
              <button className={`btn btn-ghost btn-sm ${activeTab.startsWith('chat:') ? 'active' : ''}`} onClick={openWorkspaceChat} type="button">
                <MessageSquare className="h-3.5 w-3.5" /> chat
              </button>
              <button className="btn btn-ghost btn-sm" onClick={openNewChat} type="button">
                <Plus className="h-3.5 w-3.5" /> new chat
              </button>
              <select
                className="ws-prev-chat"
                value=""
                onChange={(event) => { if (event.target.value) openChat(event.target.value); }}
                disabled={!active || availablePreviousChats.length === 0}
                title="Open previous workspace conversation"
              >
                <option value="">previous chats</option>
                {availablePreviousChats.map(chat => <option key={chat._id} value={chat._id}>{chatLabel(chat)}</option>)}
              </select>
              <button className={`btn btn-ghost btn-sm ${activeTab === 'terminal' ? 'active' : ''}`} onClick={focusTerminal} type="button">
                <Terminal className="h-3.5 w-3.5" /> terminal
              </button>
            </div>
          </div>

          <div className="ws-main ws-panel" hidden={activeTab !== 'diff'}>
              <aside className="ws-tree scroll-hide">
                <div className="ws-tree-h">
                  <span>files changed</span>
                  <span className="mono ws-tree-ct">{diffFiles.length}</span>
                </div>
                <div className="ws-tree-list">
                  {diffFiles.length === 0 ? (
                    <div className="ws-tree-empty">
                      {active ? 'no changes against the base branch yet.' : 'create or select a workspace.'}
                    </div>
                  ) : diffFiles.map(file => (
                    <button key={file.path} className={`ws-file ${activeFile === file.path ? 'active' : ''}`} onClick={() => { setActiveFile(file.path); if (activeId) patchWorkspaceUi(activeId, { activeFile: file.path }); }} type="button">
                      <span className={`ws-file-tag ${file.status}`}>{STATUS_LETTER[file.status] ?? 'M'}</span>
                      <span className="ws-file-p">{file.path}</span>
                      <span className="ws-file-d mono">
                        {file.additions ? <span className="pos">+{file.additions}</span> : null}
                        {file.deletions ? <span className="neg">-{file.deletions}</span> : null}
                      </span>
                    </button>
                  ))}
                </div>
              </aside>

              <section className="ws-diff scroll-hide">
                <div className="ws-diff-h">
                  <FileText className="h-3.5 w-3.5 text-theme-muted" />
                  <span className="mono truncate">{activeDiff?.path ?? 'workspace preview'}</span>
                  <div className="ws-diff-h-r">
                    <div className="ws-diff-mode" role="group" aria-label="Diff view mode">
                      <button className={diffMode === 'unified' ? 'active' : ''} onClick={() => changeDiffMode('unified')} type="button">
                        unified
                      </button>
                      <button className={diffMode === 'split' ? 'active' : ''} onClick={() => changeDiffMode('split')} type="button">
                        split
                      </button>
                    </div>
                  </div>
                </div>
                <div className="ws-diff-body">
                  {creating ? (
                    <form onSubmit={handleCreate} className="ws-create">
                      <div>
                        <h2>new workspace</h2>
                        <p>create an isolated worktree before assigning implementation work.</p>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <label>
                          <span>repository</span>
                          <select value={form.repoId} onChange={e => selectRepo(e.target.value)} className="input w-full text-[12px]">
                            <option value="">select repo...</option>
                            {repos.map(r => <option key={r._id} value={r._id}>{r.name}</option>)}
                          </select>
                        </label>
                        <label>
                          <span>workspace name</span>
                          <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="feature/light-theme" className="input w-full text-[12px]" />
                        </label>
                        <label>
                          <span>branch</span>
                          <input value={form.branch} onChange={e => setForm(f => ({ ...f, branch: e.target.value }))} placeholder="feature/my-feature" className="input w-full text-[12px]" />
                        </label>
                        <label>
                          <span>base branch</span>
                          <input value={form.baseBranch} onChange={e => setForm(f => ({ ...f, baseBranch: e.target.value }))} placeholder="main" className="input w-full text-[12px]" />
                        </label>
                      </div>
                      <div className="flex justify-end gap-2">
                        {form.repoId && (
                          <button type="button" onClick={() => setConfigRepoId(form.repoId)} className="btn btn-secondary btn-sm">
                            <Settings className="w-3 h-3" /> configure
                          </button>
                        )}
                        <button type="button" onClick={() => setCreating(false)} className="btn btn-secondary btn-sm">cancel</button>
                        <button type="submit" className="btn btn-primary btn-sm">create workspace</button>
                      </div>
                    </form>
                  ) : activeDiff ? (
                    <div className="ws-monaco-diff">
                      <DiffEditor
                        height="100%"
                        language={getLanguage(activeDiff.path)}
                        original={activeDiff.originalContent ?? ''}
                        modified={activeDiff.modifiedContent ?? ''}
                        theme={getMonacoTheme()}
                        beforeMount={setupMonaco}
                        options={{
                          readOnly: true,
                          originalEditable: false,
                          renderSideBySide: diffMode === 'split',
                          automaticLayout: true,
                          scrollBeyondLastLine: false,
                          minimap: { enabled: false },
                          fontSize: 12,
                          fontFamily: "'JetBrains Mono', monospace",
                          wordWrap: 'on',
                          diffWordWrap: 'on',
                          wrappingStrategy: 'advanced',
                          renderOverviewRuler: false,
                          hideUnchangedRegions: {
                            enabled: true,
                            contextLineCount: 3,
                            minimumLineCount: 8,
                            revealLineCount: 12,
                          },
                        }}
                      />
                    </div>
                  ) : (
                    <div className="ws-diff-empty">
                      <FolderGit2 className="mx-auto mb-3 h-8 w-8 text-theme-subtle" />
                      <div>{active ? 'no base-branch diff for this workspace yet.' : 'no workspace selected.'}</div>
                      <button onClick={() => setCreating(true)} className="btn btn-primary btn-sm mt-4" type="button">
                        <Plus className="h-3.5 w-3.5" /> new workspace
                      </button>
                    </div>
                  )}
                </div>
              </section>
          </div>

          <div className="ws-files-body ws-panel" hidden={activeTab !== 'files'}>
              <aside className="ws-files-list scroll-hide">
                <div className="ws-tree-h">
                  <span>file explorer</span>
                  <span className="mono ws-tree-ct">{allFiles.length}</span>
                </div>
                <div className="ws-tree-list">
                  {allFiles.length === 0 ? (
                    <div className="ws-tree-empty">no files found.</div>
                  ) : fileTree.map(node => (
                    <WorkspaceFileTreeNode key={node.path} node={node} selectedFile={explorerFile} onSelect={openExplorerFile} />
                  ))}
                </div>
              </aside>
              <section className="ws-file-editor">
                <div className="ws-diff-h">
                  <FileText className="h-3.5 w-3.5 text-theme-muted" />
                  <span className="mono truncate">{explorerFile || 'select a file'}</span>
                  <div className="ws-diff-h-r">
                    <button onClick={saveExplorerFile} className="btn btn-secondary btn-sm" type="button" disabled={!explorerFile || !fileDirty || fileLoading}>
                      {fileLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} save
                    </button>
                  </div>
                </div>
                {explorerFile ? (
                  <div className="ws-monaco-wrap">
                    <Editor
                      path={explorerFile}
                      value={fileContent}
                      language={getLanguage(explorerFile)}
                      theme={getMonacoTheme()}
                      beforeMount={setupMonaco}
                      onChange={(value) => {
                        const nextContent = value ?? '';
                        setFileContent(nextContent);
                        setFileDirty(true);
                        if (activeId) patchWorkspaceUi(activeId, { explorerFile, fileContent: nextContent, fileDirty: true });
                      }}
                      options={{
                        minimap: { enabled: true },
                        fontSize: 12,
                        fontFamily: "'JetBrains Mono', 'Geist Mono', ui-monospace, monospace",
                        lineNumbers: 'on',
                        wordWrap: 'on',
                        scrollBeyondLastLine: false,
                        automaticLayout: true,
                        tabSize: 2,
                        insertSpaces: true,
                      }}
                    />
                  </div>
                ) : (
                  <div className="ws-diff-empty">select a file to inspect or edit.</div>
                )}
              </section>
          </div>

          <div className="ws-services-body ws-panel" hidden={activeTab !== 'services'}>
              {(active?.services ?? []).length === 0 ? (
                <div className="ws-diff-empty">no services configured for this workspace.</div>
              ) : (active?.services ?? []).map(service => {
                const running = service.status === 'ready' || service.status === 'starting';
                return (
                  <div key={service.name} className="ws-service-row">
                    <span className={`ws-service-dot ${service.status}`} />
                    <span className="ws-service-main">
                      <strong>{service.name}</strong>
                      <em>:{service.port ?? '-'}</em>
                    </span>
                    <StatusBadge status={service.status} />
                    {!running ? (
                      <button onClick={() => runServiceAction(service.name, 'start')} className="btn btn-secondary btn-sm" disabled={!!serviceAction} type="button">
                        {serviceAction === `${service.name}:start` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} start
                      </button>
                    ) : (
                      <>
                        <button onClick={() => runServiceAction(service.name, 'restart')} className="btn btn-secondary btn-sm" disabled={!!serviceAction} type="button">
                          {serviceAction === `${service.name}:restart` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCw className="h-3.5 w-3.5" />} restart
                        </button>
                        <button onClick={() => runServiceAction(service.name, 'stop')} className="btn btn-secondary btn-sm" disabled={!!serviceAction} type="button">
                          {serviceAction === `${service.name}:stop` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />} stop
                        </button>
                      </>
                    )}
                    {service.status === 'ready' && active && (
                      <button onClick={() => window.open(`${window.location.protocol}//${service.name}-${active._id}.${window.location.hostname}`, '_blank')} className="btn btn-secondary btn-sm" type="button">
                        <ExternalLink className="h-3.5 w-3.5" /> preview
                      </button>
                    )}
                  </div>
                );
              })}
          </div>

          {mountedTerminalIds.map(workspaceId => (
            <div key={workspaceId} className="ws-terminal-body ws-panel" hidden={activeTab !== 'terminal' || activeId !== workspaceId}>
              <XTerminal workspaceId={workspaceId} terminalId="default" className="h-full" />
            </div>
          ))}

          {active && openChatIds.map(sessionId => (
            <div key={sessionId} className="ws-chat-body ws-panel" hidden={activeTab !== `chat:${sessionId}`}>
              <EmbeddedChat
                workspaceId={active._id}
                workspaceName={active.name}
                worktreePath={active.worktreePath ?? active.repoPath ?? ''}
                linkedSessionId={sessionId.startsWith('new-') ? null : sessionId}
                onClose={() => closeChat(sessionId)}
                onLinkedSession={(realId) => handleLinkedChat(sessionId, realId)}
              />
            </div>
          ))}

          {(!active || (activeTab.startsWith('chat:') && activeChatId && !openChatIds.includes(activeChatId))) && (
            <div className="ws-chat-empty ws-panel">
              <MessageSquare className="h-8 w-8 text-theme-subtle" />
              <p>open a previous chat or start a new workspace chat.</p>
            </div>
          )}

        </div>
      </div>

      {configRepoId && <WorkspaceConfigEditor repoId={configRepoId} onClose={() => setConfigRepoId(null)} />}
      {pendingWsId && (
        <SetupProgressDialog
          workspaceId={pendingWsId}
          onComplete={(ws) => { setPendingWsId(null); setActiveId(ws._id); loadWorkspaces(); navigate(`/workspaces/${ws._id}`); }}
          onFailed={() => { setPendingWsId(null); loadWorkspaces(); }}
        />
      )}
    </div>
  );
}
