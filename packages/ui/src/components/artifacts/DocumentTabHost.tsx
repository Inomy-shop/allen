import { useEffect, useMemo } from 'react';
import { Code2, FileText, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import ArtifactViewer from './ArtifactViewer';
import { useDocumentTabStore } from '../../stores/documentTabStore';
import ChatTabCreateMenu from '../chat/ChatTabCreateMenu';
import DirectMonacoEditor from '../common/DirectMonacoEditor';

type DocumentTabHostProps = {
  workspaceId?: string | null;
  onAllResourcesClosed?: () => void;
  onCreateTab?: (kind: 'chat' | 'terminal' | 'code-diff' | 'file-explorer') => void;
  showTabStrip?: boolean;
  visible?: boolean;
};

function editorLanguage(path: string): string {
  const filename = path.toLowerCase();
  if (filename.endsWith('dockerfile')) return 'dockerfile';
  const ext = filename.split('.').pop() ?? '';
  return ({
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json', md: 'markdown', mdx: 'markdown', css: 'css', scss: 'scss', html: 'html', xml: 'xml',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', swift: 'swift', sh: 'shell', bash: 'shell',
    zsh: 'shell', sql: 'sql', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', graphql: 'graphql',
  } as Record<string, string>)[ext] ?? 'plaintext';
}

export default function DocumentTabHost({
  workspaceId = null,
  onAllResourcesClosed,
  onCreateTab,
  showTabStrip = true,
  visible = true,
}: DocumentTabHostProps) {
  const navigate = useNavigate();
  const activeScopeKey = useDocumentTabStore(state => state.activeScopeKey);
  const allTabs = useDocumentTabStore(state => state.tabs);
  const activeArtifactId = useDocumentTabStore(state => state.activeArtifactId);
  const allFileTabs = useDocumentTabStore(state => state.fileTabs);
  const activeFileKey = useDocumentTabStore(state => state.activeFileKey);
  const selectDocument = useDocumentTabStore(state => state.selectDocument);
  const selectFile = useDocumentTabStore(state => state.selectFile);
  const closeDocument = useDocumentTabStore(state => state.closeDocument);
  const closeFile = useDocumentTabStore(state => state.closeFile);
  const selectBaseTab = useDocumentTabStore(state => state.selectBaseTab);
  const tabs = useMemo(() => allTabs.filter(tab => tab.scopeKey === activeScopeKey), [activeScopeKey, allTabs]);
  const fileTabs = useMemo(() => allFileTabs.filter(tab => tab.scopeKey === activeScopeKey), [activeScopeKey, allFileTabs]);
  const activeDocument = tabs.find(tab => tab.artifact.artifactId === activeArtifactId) ?? null;
  const activeFile = fileTabs.find(tab => tab.key === activeFileKey) ?? null;
  const activeResourceLabel = activeDocument?.artifact.filename ?? activeFile?.path ?? null;
  const baseTabLabel = activeDocument?.sourceLabel ?? 'Chat';

  function closeDocumentTab(artifactId: string) {
    const closesActiveResource = artifactId === activeArtifactId;
    const hasFallbackResource = tabs.some(tab => tab.artifact.artifactId !== artifactId) || fileTabs.length > 0;
    closeDocument(artifactId, activeScopeKey);
    if (closesActiveResource && !hasFallbackResource) onAllResourcesClosed?.();
  }

  function closeFileTab(key: string) {
    const closesActiveResource = key === activeFileKey;
    const hasFallbackResource = fileTabs.some(tab => tab.key !== key) || tabs.length > 0;
    closeFile(key, activeScopeKey);
    if (closesActiveResource && !hasFallbackResource) onAllResourcesClosed?.();
  }

  useEffect(() => {
    if (!visible || !activeResourceLabel) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (activeDocument) closeDocumentTab(activeDocument.artifact.artifactId);
      else if (activeFile) closeFileTab(activeFile.key);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeDocument, activeFile, activeResourceLabel, activeScopeKey, activeArtifactId, activeFileKey, tabs, fileTabs, closeDocument, closeFile, onAllResourcesClosed, visible]);

  if (!visible || (!activeDocument && !activeFile)) return null;

  function createTab(kind: 'chat' | 'terminal' | 'code-diff' | 'file-explorer') {
    selectBaseTab(activeScopeKey);
    if (onCreateTab) {
      onCreateTab(kind);
      return;
    }
    if (!workspaceId) {
      if (kind === 'chat') navigate('/chat');
      return;
    }
    window.dispatchEvent(new CustomEvent('allen:workspace-tab-create', {
      detail: { kind, workspaceId },
    }));
  }

  return (
    <div className={`document-tab-host ${showTabStrip ? '' : 'document-tab-host--integrated'}`} role="region" aria-label={`Open resource: ${activeResourceLabel}`}>
      {showTabStrip && <nav className="document-tab-strip resource-tab-strip" aria-label="Chat and open resources">
        <button type="button" className="document-tab-strip__base" onClick={() => selectBaseTab(activeScopeKey)}>{baseTabLabel}</button>
        {tabs.map(tab => {
          const title = tab.artifact.filename.replace(/\.(md|markdown|json|csv|txt|text)$/i, '').replace(/[-_]+/g, ' ');
          return (
            <button
              type="button"
              key={tab.artifact.artifactId}
              className={`document-tab-strip__tab ${tab.artifact.artifactId === activeArtifactId ? 'on' : ''}`}
              onClick={() => selectDocument(tab.artifact.artifactId, activeScopeKey)}
              title={tab.artifact.filename}
            >
              <FileText aria-hidden="true" />
              <span>{title}</span>
              <i role="button" tabIndex={0} aria-label={`Close ${title}`} onClick={event => { event.stopPropagation(); closeDocumentTab(tab.artifact.artifactId); }} onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); closeDocumentTab(tab.artifact.artifactId); }
              }}>×</i>
            </button>
          );
        })}
        {fileTabs.map(tab => (
          <button
            type="button"
            key={tab.key}
            className={`document-tab-strip__tab ${tab.key === activeFileKey ? 'on' : ''}`}
            onClick={() => selectFile(tab.key, activeScopeKey)}
            title={`${tab.path} · ${tab.sourceLabel}`}
          >
            <Code2 aria-hidden="true" />
            <span>{tab.path.split('/').pop()}</span>
            <i role="button" tabIndex={0} aria-label={`Close ${tab.path}`} onClick={event => { event.stopPropagation(); closeFileTab(tab.key); }} onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); closeFileTab(tab.key); }
            }}>×</i>
          </button>
        ))}
        <ChatTabCreateMenu
          onNewChat={() => createTab('chat')}
          onNewTerminal={workspaceId || onCreateTab ? () => createTab('terminal') : undefined}
          onOpenCodeDiff={workspaceId || onCreateTab ? () => createTab('code-diff') : undefined}
          onOpenFileExplorer={workspaceId || onCreateTab ? () => createTab('file-explorer') : undefined}
        />
        <span />
      </nav>}

      <div className="resource-tab-content">
        {activeDocument && (
          <ArtifactViewer
            key={activeDocument.artifact.artifactId}
            artifact={activeDocument.artifact}
            presentation="tab"
            hideTabStrip
            onClose={() => closeDocumentTab(activeDocument.artifact.artifactId)}
          />
        )}
        {activeFile && (
          <section className="file-tab-viewer" aria-label={`File viewer: ${activeFile.path}`}>
            <header>
              <div>
                <Code2 aria-hidden="true" />
                <span>
                  <strong>{activeFile.path}</strong>
                  <small>{activeFile.sourceLabel}</small>
                </span>
              </div>
              <button type="button" onClick={() => closeFileTab(activeFile.key)} aria-label={`Close ${activeFile.path}`} title="Close file (Esc)"><X aria-hidden="true" /></button>
            </header>
            <div className="file-tab-viewer__editor">
              <DirectMonacoEditor
                className="h-full w-full"
                language={activeFile.language ?? editorLanguage(activeFile.path)}
                value={activeFile.content}
                readOnly
                options={{
                  automaticLayout: true,
                  fontSize: 12,
                  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  minimap: { enabled: true, scale: 1 },
                  lineNumbers: 'on',
                  scrollBeyondLastLine: false,
                  wordWrap: 'off',
                  padding: { top: 12, bottom: 20 },
                }}
              />
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
