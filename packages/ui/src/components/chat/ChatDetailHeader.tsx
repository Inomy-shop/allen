import { useMemo } from 'react';
import { Code2, Files, FileText, MessageSquare, Server, Terminal, Upload, X } from 'lucide-react';
import { resourceScopeKey, useDocumentTabStore } from '../../stores/documentTabStore';
import ChatTabCreateMenu from './ChatTabCreateMenu';
import CopyChatIdButton from './CopyChatIdButton';
import TeamClassificationSelect from '../common/TeamClassificationSelect';
import type { TeamClassification } from '../../types/teamClassification';

type Props = {
  title?: string;
  onExport?: () => void;
  chatTabs?: Array<{ id: string; title: string; isTemp?: boolean }>;
  activeChatId?: string | null;
  onChatSelect?: (id: string) => void;
  onChatClose?: (id: string) => void;
  terminalTabs?: Array<{ id: string; title: string; sourceLabel: string }>;
  activeTerminalId?: string | null;
  onTerminalSelect?: (id: string) => void;
  onTerminalClose?: (id: string) => void;
  utilityTabs?: Array<{ id: string; title: string; kind: 'code-diff' | 'file-explorer' | 'servers' }>;
  tabOrder?: string[];
  activeUtilityId?: string | null;
  onUtilitySelect?: (id: string) => void;
  onUtilityClose?: (id: string) => void;
  onBaseChatSelect?: () => void;
  onNewChat?: () => void;
  onNewTerminal?: () => void;
  onOpenCodeDiff?: () => void;
  onOpenFileExplorer?: () => void;
  resourceTabs?: Array<{ key: string; kind: 'document' | 'file'; title: string; tooltip: string }>;
  activeResourceKey?: string | null;
  onResourceSelect?: (key: string) => void;
  onResourceClose?: (key: string) => void;
  teamClassification?: TeamClassification | null;
  onTeamClassificationChange?: (value: TeamClassification | null) => void;
  classificationDisabled?: boolean;
};

export default function ChatDetailHeader({
  title,
  onExport,
  chatTabs = [],
  activeChatId,
  onChatSelect,
  onChatClose,
  terminalTabs = [],
  activeTerminalId,
  onTerminalSelect,
  onTerminalClose,
  utilityTabs = [],
  tabOrder = [],
  activeUtilityId,
  onUtilitySelect,
  onUtilityClose,
  onBaseChatSelect,
  onNewChat,
  onNewTerminal,
  onOpenCodeDiff,
  onOpenFileExplorer,
  resourceTabs,
  activeResourceKey = null,
  onResourceSelect,
  onResourceClose,
  teamClassification,
  onTeamClassificationChange,
  classificationDisabled = false,
}: Props) {
  const scopeKey = activeChatId ? resourceScopeKey('chat', activeChatId) : null;
  const allTabs = useDocumentTabStore(state => state.tabs);
  const allFileTabs = useDocumentTabStore(state => state.fileTabs);
  const selections = useDocumentTabStore(state => state.selections);
  const tabs = useMemo(() => scopeKey ? allTabs.filter(tab => tab.scopeKey === scopeKey) : [], [allTabs, scopeKey]);
  const fileTabs = useMemo(() => scopeKey ? allFileTabs.filter(tab => tab.scopeKey === scopeKey) : [], [allFileTabs, scopeKey]);
  const selectDocument = useDocumentTabStore(state => state.selectDocument);
  const closeDocument = useDocumentTabStore(state => state.closeDocument);
  const selectFile = useDocumentTabStore(state => state.selectFile);
  const closeFile = useDocumentTabStore(state => state.closeFile);
  const selectBaseTab = useDocumentTabStore(state => state.selectBaseTab);
  const scopeSelection = scopeKey ? selections[scopeKey] : null;
  const activeArtifactId = scopeSelection?.activeArtifactId ?? null;
  const activeFileKey = scopeSelection?.activeFileKey ?? null;
  const usesExternalResourceTabs = resourceTabs !== undefined;
  const resourceActive = usesExternalResourceTabs
    ? Boolean(activeResourceKey)
    : Boolean(activeArtifactId || activeFileKey);
  const orderedViewTabs = useMemo(() => {
    const viewTabs = [
      ...chatTabs.map(tab => ({ type: 'chat' as const, key: `chat:${tab.id}`, tab })),
      ...terminalTabs.map(tab => ({ type: 'terminal' as const, key: `terminal:${tab.id}`, tab })),
      ...utilityTabs.map(tab => ({ type: 'utility' as const, key: `utility:${tab.id}`, tab })),
    ];
    if (tabOrder.length === 0) return viewTabs;
    const positions = new Map(tabOrder.map((key, index) => [key, index]));
    return [...viewTabs].sort((left, right) => {
      const leftIndex = positions.get(left.key) ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = positions.get(right.key) ?? Number.MAX_SAFE_INTEGER;
      return leftIndex - rightIndex;
    });
  }, [chatTabs, terminalTabs, utilityTabs, tabOrder]);

  return (
    <header className="v8-chat-detail-header">
      <div className="v8-chat-detail-tabs" role="tablist" aria-label="Conversation views">
        {orderedViewTabs.length === 0 ? (
          <button type="button" role="tab" aria-selected={!activeTerminalId && !activeUtilityId && !resourceActive} title={title} onClick={() => {
            if (scopeKey) selectBaseTab(scopeKey);
            onBaseChatSelect?.();
          }}>Chat</button>
        ) : orderedViewTabs.map(item => {
          if (item.type === 'chat') {
            const tab = item.tab;
            const canCopyChatId = !tab.isTemp;
            const canCloseChat = chatTabs.length > 1;
            return (
              <div
                className={`v8-chat-document-tab v8-chat-session-tab ${canCopyChatId && canCloseChat ? 'v8-chat-session-tab--two-actions' : ''} ${!canCopyChatId && !canCloseChat ? 'v8-chat-session-tab--no-actions' : ''}`}
                key={item.key}
              >
                <button type="button" role="tab" aria-selected={!activeTerminalId && !activeUtilityId && !resourceActive && tab.id === activeChatId} onClick={() => {
                  selectBaseTab(resourceScopeKey('chat', tab.id));
                  onChatSelect?.(tab.id);
                }} title={tab.title}>
                  <MessageSquare aria-hidden="true" />
                  <span>{tab.title || 'Chat'}</span>
                </button>
                {canCopyChatId && (
                  <CopyChatIdButton
                    chatId={tab.id}
                    chatTitle={tab.title || 'Chat'}
                    className="v8-chat-document-tab__action v8-chat-document-tab__copy"
                  />
                )}
                {canCloseChat && (
                  <button type="button" className="v8-chat-document-tab__close" onClick={() => onChatClose?.(tab.id)} aria-label={`Close ${tab.title || 'chat'}`}>
                    <X aria-hidden="true" />
                  </button>
                )}
              </div>
            );
          }
          if (item.type === 'terminal') {
            const tab = item.tab;
            return (
              <div className="v8-chat-document-tab v8-chat-session-tab" key={item.key}>
                <button type="button" role="tab" aria-selected={!activeUtilityId && tab.id === activeTerminalId} onClick={() => onTerminalSelect?.(tab.id)} title={`${tab.title} · ${tab.sourceLabel}`}>
                  <Terminal aria-hidden="true" />
                  <span>{tab.title}</span>
                </button>
                <button type="button" className="v8-chat-document-tab__close" onClick={() => onTerminalClose?.(tab.id)} aria-label={`Close ${tab.title}`}>
                  <X aria-hidden="true" />
                </button>
              </div>
            );
          }
          const tab = item.tab;
          const Icon = tab.kind === 'code-diff' ? Code2 : tab.kind === 'servers' ? Server : Files;
          return (
            <div className="v8-chat-document-tab v8-chat-session-tab" key={item.key}>
              <button type="button" role="tab" aria-selected={tab.id === activeUtilityId} onClick={() => onUtilitySelect?.(tab.id)} title={tab.title}>
                <Icon aria-hidden="true" />
                <span>{tab.title}</span>
              </button>
              <button type="button" className="v8-chat-document-tab__close" onClick={() => onUtilityClose?.(tab.id)} aria-label={`Close ${tab.title}`}>
                <X aria-hidden="true" />
              </button>
            </div>
          );
        })}
        {!usesExternalResourceTabs && tabs.map(tab => (
          <div className="v8-chat-document-tab" key={tab.artifact.artifactId}>
            <button type="button" role="tab" aria-selected={tab.artifact.artifactId === activeArtifactId} onClick={() => selectDocument(tab.artifact.artifactId, scopeKey ?? undefined)}>
              <FileText aria-hidden="true" />
              <span>{tab.artifact.filename}</span>
            </button>
            <button type="button" className="v8-chat-document-tab__close" onClick={() => closeDocument(tab.artifact.artifactId, scopeKey ?? undefined)} aria-label={`Close ${tab.artifact.filename}`}>
              <X aria-hidden="true" />
            </button>
          </div>
        ))}
        {!usesExternalResourceTabs && fileTabs.map(tab => (
          <div className="v8-chat-document-tab" key={tab.key}>
            <button type="button" role="tab" aria-selected={tab.key === activeFileKey} onClick={() => selectFile(tab.key, scopeKey ?? undefined)} title={`${tab.path} · ${tab.sourceLabel}`}>
              <Code2 aria-hidden="true" />
              <span>{tab.path.split('/').pop()}</span>
            </button>
            <button type="button" className="v8-chat-document-tab__close" onClick={() => closeFile(tab.key, scopeKey ?? undefined)} aria-label={`Close ${tab.path}`}>
              <X aria-hidden="true" />
            </button>
          </div>
        ))}
        {resourceTabs?.map(tab => {
          const Icon = tab.kind === 'document' ? FileText : Code2;
          return (
            <div className="v8-chat-document-tab" key={tab.key}>
              <button
                type="button"
                role="tab"
                aria-selected={tab.key === activeResourceKey}
                onClick={() => onResourceSelect?.(tab.key)}
                title={tab.tooltip}
              >
                <Icon aria-hidden="true" />
                <span>{tab.title}</span>
              </button>
              <button
                type="button"
                className="v8-chat-document-tab__close"
                onClick={() => onResourceClose?.(tab.key)}
                aria-label={`Close ${tab.title}`}
              >
                <X aria-hidden="true" />
              </button>
            </div>
          );
        })}
        {onNewChat && (
          <ChatTabCreateMenu
            onNewChat={onNewChat}
            onNewTerminal={onNewTerminal}
            onOpenCodeDiff={onOpenCodeDiff}
            onOpenFileExplorer={onOpenFileExplorer}
          />
        )}
      </div>
      <div className="v8-chat-detail-actions">
        {onTeamClassificationChange && (
          <TeamClassificationSelect
            compact
            value={teamClassification}
            onChange={onTeamClassificationChange}
            disabled={classificationDisabled}
            ariaLabel="Conversation team"
          />
        )}
        {onExport && (
          <button type="button" className="v8-chat-detail-export" onClick={onExport} aria-label="Export chat">
            <Upload aria-hidden="true" />
            <span>Export</span>
          </button>
        )}
      </div>
    </header>
  );
}
