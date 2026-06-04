/**
 * EmbeddedChat — Full-featured chat panel for embedding inside workspaces.
 * Uses the same useChat hook, ChatMessageList, ChatInput, and agent selector
 * as the main ChatPage, but auto-creates and links a session to the workspace.
 */

import { useEffect, useState, useRef, useCallback } from 'react';
import { useChat } from '../../hooks/useChat';
import ChatInput from '../chat/ChatInput';
import ChatMessageList from '../chat/ChatMessageList';
import AgentChatDropdown from '../chat/AgentChatDropdown';
import { workspaces as wsApi } from '../../services/workspaceService';
import { chat as chatApi, agents as agentsApi } from '../../services/api';
import { MessageSquare, X, ExternalLink, Plus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface EmbeddedChatProps {
  workspaceId: string;
  workspaceName: string;
  worktreePath: string;
  linkedSessionId?: string | null;
  onClose: () => void;
  onLinkedSession?: (sessionId: string) => void;
}

export function EmbeddedChat({
  workspaceId,
  workspaceName,
  worktreePath,
  linkedSessionId,
  onClose,
  onLinkedSession,
}: EmbeddedChatProps) {
  const navigate = useNavigate();
  const {
    sessions, activeSessionId, messages, streaming, streamText,
    thinkingText, activeToolCalls, agentReports,
    pendingUserQuestion, answerUserQuestion,
    spawnedAgents, loadingMessages,
    sendMessage, createSession, switchSession, cancelStream,
  } = useChat();

  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedAgentCwd, setSelectedAgentCwd] = useState<string | null>(null);
  const [allAgents, setAllAgents] = useState<any[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [providers, setProviders] = useState<any[]>([]);
  const [selectedProvider, setSelectedProvider] = useState('codex');
  const [selectedModel, setSelectedModel] = useState('');
  const [initialized, setInitialized] = useState(false);
  const [forcedNew, setForcedNew] = useState(false);
  const chatInputRef = useRef<{ setValue: (v: string) => void; focus: () => void } | null>(null);

  // Load agents and providers
  useEffect(() => {
    agentsApi.list().then(all => { setAllAgents(all); setAgentsLoading(false); }).catch(() => { setAgentsLoading(false); });
    chatApi.providers().then(p => {
      setProviders(p);
      if (p.length > 0) { setSelectedProvider(p[0].provider); setSelectedModel(p[0].defaultModel); }
    }).catch(() => {});
  }, []);

  // Initialize: switch to linked session or wait for first message
  useEffect(() => {
    if (initialized || forcedNew) return;
    if (linkedSessionId) {
      switchSession(linkedSessionId);
      setInitialized(true);
    }
  }, [linkedSessionId, initialized, forcedNew]);

  const activeSession = sessions.find(s => s._id === activeSessionId);

  // Lock agent after first message
  useEffect(() => {
    if (activeSession?.activeAgent) setSelectedAgent(activeSession.activeAgent);
  }, [activeSession?.activeAgent]);

  const createAndLink = useCallback(async () => {
    const session = await createSession(selectedProvider, selectedModel || undefined);
    await wsApi.linkChat(workspaceId, session._id);
    onLinkedSession?.(session._id);
    setInitialized(true);
    setForcedNew(false);
    return session._id;
  }, [selectedProvider, selectedModel, workspaceId, onLinkedSession]);

  const handleSend = useCallback(async (content: string) => {
    if (!activeSessionId) {
      const sid = await createAndLink();
      sendMessage(content, sid, selectedAgent ?? undefined, selectedAgentCwd ?? undefined);
      return;
    }
    sendMessage(content, undefined, selectedAgent ?? undefined, selectedAgentCwd ?? undefined);
  }, [activeSessionId, selectedAgent, selectedAgentCwd, createAndLink]);

  function handleNewChat() {
    switchSession('');
    setSelectedAgent(null);
    setSelectedAgentCwd(null);
    setInitialized(false);
    setForcedNew(true);
  }

  const agentLocked = !!activeSession?.activeAgent && (activeSession?.messageCount ?? 0) > 0;

  return (
    <div className="workspace-embedded-chat">
      {/* Header */}
      <div className="workspace-embedded-chat-head">
        <MessageSquare className="w-3 h-3 text-accent" />
        <span className="overline">Chat</span>
        {activeSessionId && <span className="text-[9px] font-mono text-accent-green">linked</span>}
        <span className="flex-1" />
        <button onClick={handleNewChat} className="text-theme-subtle hover:text-theme-secondary p-0.5" title="New Chat">
          <Plus className="w-3 h-3" />
        </button>
        {activeSessionId && (
          <button onClick={() => navigate(`/chat/${activeSessionId}`)} className="text-theme-subtle hover:text-theme-secondary p-0.5" title="Open in full page">
            <ExternalLink className="w-3 h-3" />
          </button>
        )}
        <button onClick={onClose} className="text-theme-subtle hover:text-theme-secondary p-0.5"><X className="w-3 h-3" /></button>
      </div>

      {/* Messages */}
      <div className="workspace-embedded-chat-messages">
        {!activeSessionId && !streaming ? (
          <div className="workspace-embedded-chat-empty">
            <MessageSquare className="w-6 h-6 text-accent/20 mb-2" />
            <p className="text-[11px] text-theme-muted">Chat with AI about this workspace</p>
            <p className="text-[9px] text-theme-subtle mt-1 font-mono break-all">{worktreePath}</p>
          </div>
        ) : (
          <ChatMessageList
            messages={messages}
            streamText={streamText}
            thinkingText={thinkingText}
            streaming={streaming}
            activeToolCalls={activeToolCalls}
            agentReports={agentReports}
            spawnedAgents={spawnedAgents}
            pendingUserQuestion={pendingUserQuestion}
            onAnswerUserQuestion={answerUserQuestion}
            activeAgent={activeSession?.activeAgent}
            onSuggestionClick={handleSend}
            onSaveToLearnings={() => {}}
          />
        )}
      </div>

      {/* Input */}
      <div className="workspace-embedded-chat-input">
        <ChatInput
          ref={chatInputRef}
          onSend={handleSend}
          onCancel={cancelStream}
          streaming={streaming}
          disabled={false}
          providers={providers}
          selectedProvider={activeSession?.provider ?? selectedProvider}
          selectedModel={activeSession?.model ?? selectedModel}
          modelLocked={!!activeSessionId}
          onProviderChange={(p, m) => { setSelectedProvider(p); setSelectedModel(m); }}
          extraControls={(
            <AgentChatDropdown
              value={selectedAgent}
              onChange={(name, cwd) => {
                setSelectedAgent(name);
                setSelectedAgentCwd(cwd);
              }}
              agents={allAgents}
              disabled={agentLocked}
              loading={agentsLoading}
              variant="composer"
            />
          )}
        />
      </div>
    </div>
  );
}
