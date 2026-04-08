/**
 * EmbeddedChat — Full-featured chat panel for embedding inside workspaces.
 * Uses the same useChat hook, ChatMessageList, ChatInput, and agent selector
 * as the main ChatPage, but auto-creates and links a session to the workspace.
 */

import { useEffect, useState, useRef, useCallback } from 'react';
import { useChat } from '../../hooks/useChat';
import ChatInput from '../chat/ChatInput';
import ChatMessageList from '../chat/ChatMessageList';
import { workspaces as wsApi } from '../../services/workspaceService';
import { chat as chatApi, agents as agentsApi } from '../../services/api';
import { MessageSquare, Users, X, ExternalLink, Plus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface EmbeddedChatProps {
  workspaceId: string;
  workspaceName: string;
  worktreePath: string;
  linkedSessionId?: string | null;
  onClose: () => void;
}

export function EmbeddedChat({ workspaceId, workspaceName, worktreePath, linkedSessionId, onClose }: EmbeddedChatProps) {
  const navigate = useNavigate();
  const {
    sessions, activeSessionId, messages, streaming, streamText,
    thinkingText, activeToolCalls, agentThreads, agentReports, threadsByMessage,
    pendingUserQuestion, answerUserQuestion,
    spawnedAgents, loadingMessages,
    sendMessage, createSession, switchSession, cancelStream,
  } = useChat();

  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [teamAgents, setTeamAgents] = useState<any[]>([]);
  const [providers, setProviders] = useState<any[]>([]);
  const [selectedProvider, setSelectedProvider] = useState('codex');
  const [selectedModel, setSelectedModel] = useState('');
  const [initialized, setInitialized] = useState(false);
  const [forcedNew, setForcedNew] = useState(false);
  const chatInputRef = useRef<{ setValue: (v: string) => void; focus: () => void } | null>(null);

  // Load agents and providers
  useEffect(() => {
    agentsApi.list().then(all => setTeamAgents(all.filter((a: any) => a.type === 'team'))).catch(() => {});
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
    setInitialized(true);
    setForcedNew(false);
    return session._id;
  }, [selectedProvider, selectedModel, workspaceId]);

  const handleSend = useCallback(async (content: string) => {
    if (!activeSessionId) {
      const sid = await createAndLink();
      sendMessage(content, sid, selectedAgent ?? undefined);
      return;
    }
    sendMessage(content, undefined, selectedAgent ?? undefined);
  }, [activeSessionId, selectedAgent, createAndLink]);

  function handleNewChat() {
    switchSession('');
    setSelectedAgent(null);
    setInitialized(false);
    setForcedNew(true);
  }

  const agentLocked = !!activeSession?.activeAgent && (activeSession?.messageCount ?? 0) > 0;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/20 shrink-0">
        <MessageSquare className="w-3 h-3 text-blue-400" />
        <span className="text-[10px] font-label uppercase tracking-wider text-gray-500">Chat</span>
        {activeSessionId && <span className="text-[9px] font-mono text-emerald-500">linked</span>}
        <span className="flex-1" />
        <button onClick={handleNewChat} className="text-gray-600 hover:text-gray-300 p-0.5" title="New Chat">
          <Plus className="w-3 h-3" />
        </button>
        {activeSessionId && (
          <button onClick={() => navigate(`/chat/${activeSessionId}`)} className="text-gray-600 hover:text-gray-300 p-0.5" title="Open in full page">
            <ExternalLink className="w-3 h-3" />
          </button>
        )}
        <button onClick={onClose} className="text-gray-600 hover:text-gray-300 p-0.5"><X className="w-3 h-3" /></button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {!activeSessionId && !streaming ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <MessageSquare className="w-6 h-6 text-blue-400/20 mb-2" />
            <p className="text-[11px] text-gray-500">Chat with AI about this workspace</p>
            <p className="text-[9px] text-gray-700 mt-1 font-mono break-all">{worktreePath}</p>
          </div>
        ) : (
          <ChatMessageList
            messages={messages}
            streamText={streamText}
            thinkingText={thinkingText}
            streaming={streaming}
            activeToolCalls={activeToolCalls}
            agentThreads={agentThreads}
            agentReports={agentReports}
            threadsByMessage={threadsByMessage}
            spawnedAgents={spawnedAgents}
            pendingUserQuestion={pendingUserQuestion}
            onAnswerUserQuestion={answerUserQuestion}
            activeAgent={activeSession?.activeAgent}
            onSuggestionClick={handleSend}
            onSaveToLearnings={() => {}}
          />
        )}
      </div>

      {/* Agent selector + Input */}
      <div className="shrink-0">
        {teamAgents.length > 0 && (
          <div className="px-2 pt-1.5 flex items-center gap-1 flex-wrap border-t border-border/30">
            <Users className="w-3 h-3 text-gray-600 shrink-0" />
            <button onClick={() => !agentLocked && setSelectedAgent(null)} disabled={agentLocked}
              className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${!selectedAgent ? 'bg-blue-500/10 text-blue-400' : agentLocked ? 'text-gray-700' : 'text-gray-600 hover:text-gray-400'}`}>
              Assistant
            </button>
            {teamAgents.map((a: any) => (
              <button key={a.name} onClick={() => !agentLocked && setSelectedAgent(selectedAgent === a.name ? null : a.name)} disabled={agentLocked}
                className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${selectedAgent === a.name ? 'bg-cyan-500/10 text-cyan-400' : agentLocked ? 'text-gray-700' : 'text-gray-600 hover:text-gray-400'}`}>
                {a.displayName ?? a.name}
              </button>
            ))}
          </div>
        )}
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
        />
      </div>
    </div>
  );
}
