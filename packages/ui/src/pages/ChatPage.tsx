import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useChat } from '../hooks/useChat';
import ChatInput from '../components/chat/ChatInput';
import ChatMessageList from '../components/chat/ChatMessageList';
import CommandPalette from '../components/chat/CommandPalette';
import ConversationLogs from '../components/chat/ConversationLogs';
import {
  MessageSquare, Command, Server, ScrollText, Users,
} from 'lucide-react';
import { chat as chatApi, mcp as mcpApi, learnings as learningsApi, agents as agentsApi } from '../services/api';

const PROVIDER_DISPLAY: Record<string, { label: string; color: string }> = {
  codex: { label: 'Codex', color: 'text-accent-green' },
  'claude-cli': { label: 'Claude CLI', color: 'text-accent-blue' },
};

export default function ChatPage() {
  const { sessionId: urlSessionId } = useParams<{ sessionId?: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [mcpCount, setMcpCount] = useState<{ enabled: number; connected: number }>({ enabled: 0, connected: 0 });
  const [providers, setProviders] = useState<any[]>([]);
  const [selectedProvider, setSelectedProvider] = useState('codex');
  const [selectedModel, setSelectedModel] = useState('');
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [teamAgents, setTeamAgents] = useState<any[]>([]);
  const chatInputRef = useRef<{ setValue: (v: string) => void; focus: () => void } | null>(null);

  const {
    sessions, activeSessionId, messages, streaming, streamText,
    thinkingText, activeToolCalls, agentThreads, agentReports, threadsByMessage,
    spawnedAgents, pendingUserQuestion, answerUserQuestion,
    loadingSessions, loadingMessages,
    sendMessage, createSession, switchSession, cancelStream,
  } = useChat();

  useEffect(() => {
    chatApi.providers().then(p => {
      setProviders(p);
      if (p.length > 0) { setSelectedProvider(p[0].provider); setSelectedModel(p[0].defaultModel); }
    }).catch(() => {});
    mcpApi.list().then(servers => {
      setMcpCount({ enabled: servers.filter((s: any) => s.enabled).length, connected: servers.filter((s: any) => s.status === 'connected').length });
    }).catch(() => {});
    agentsApi.list().then(all => {
      setTeamAgents(all.filter((a: any) => a.type === 'team'));
    }).catch(() => {});
  }, []);

  const activeSession = sessions.find(s => s._id === activeSessionId);
  const activeProvider = activeSession?.provider ?? selectedProvider;

  // Restore agent selector from session when switching conversations or on page load
  useEffect(() => {
    if (activeSession?.activeAgent) {
      setSelectedAgent(activeSession.activeAgent);
    } else if (activeSessionId && activeSession) {
      setSelectedAgent(null);
    }
  }, [activeSessionId, activeSession?.activeAgent]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setCmdPaletteOpen(prev => !prev); } };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Sync URL ↔ activeSessionId (single effect to avoid race conditions)
  useEffect(() => {
    if (urlSessionId && urlSessionId !== activeSessionId) {
      // URL has a session ID that's different from active — load it
      switchSession(urlSessionId);
    } else if (!urlSessionId && activeSessionId) {
      // URL cleared (new chat button) — clear active session
      switchSession('');
    }
  }, [urlSessionId]);

  useEffect(() => {
    if (activeSessionId && activeSessionId !== urlSessionId) {
      // Active session changed (e.g., after creating a new session) — update URL
      navigate(`/chat/${activeSessionId}`, { replace: true });
    }
  }, [activeSessionId]);

  // Deep-link support: ?agent=NAME&prompt=PREFILL
  // Used by the "Build Team with AI" / "Add Agent with AI" buttons in TeamManagerPage.
  // We preselect the agent and prefill the input, then strip the query params
  // so a refresh doesn't re-apply them. The user must click Send themselves
  // — no auto-submit, so they can review/edit the proposed prompt first.
  useEffect(() => {
    const wantedAgent = searchParams.get('agent');
    const wantedPrompt = searchParams.get('prompt');
    if (!wantedAgent && !wantedPrompt) return;

    if (wantedAgent) setSelectedAgent(wantedAgent);
    if (wantedPrompt) {
      // setValue is exposed by ChatInput's forwardRef. Defer to next tick so
      // the input is mounted.
      setTimeout(() => chatInputRef.current?.setValue(wantedPrompt), 0);
    }

    // Strip the params so refresh doesn't re-trigger this effect
    const next = new URLSearchParams(searchParams);
    next.delete('agent');
    next.delete('prompt');
    setSearchParams(next, { replace: true });
  }, [searchParams]);

  async function handleSend(content: string) {
    if (!activeSessionId) {
      const session = await createSession(selectedProvider, selectedModel || undefined);
      navigate(`/chat/${session._id}`, { replace: true });
      sendMessage(content, session._id, selectedAgent ?? undefined);
      return;
    }
    sendMessage(content, undefined, selectedAgent ?? undefined);
  }

  function handleSuggestionClick(prompt: string) { handleSend(prompt); }
  function handleCommandSelect(prompt: string, partial?: boolean) {
    if (partial) { chatInputRef.current?.setValue(prompt); chatInputRef.current?.focus(); }
    else handleSend(prompt);
    setCmdPaletteOpen(false);
  }

  async function handleSaveToLearnings(content: string) {
    try {
      await learningsApi.create({
        content: content.slice(0, 1000), type: 'fact', target: 'agent', tags: ['chat', 'saved'],
        scope: { level: 'global' },
        source: { sourceType: 'manual', workflowName: 'chat', nodeName: 'chat', executionId: activeSessionId ?? '', timestamp: new Date() },
        confidence: 0.8, status: 'active',
      });
    } catch {}
  }

  return (
    <div className="flex-1 flex flex-col h-full min-w-0">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-border/50 flex items-center justify-between bg-surface-50/50 shrink-0">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-accent-blue" />
          <span className="font-heading text-sm font-bold text-white tracking-wider">
            {activeSessionId ? activeSession?.title ?? 'Chat' : 'FlowForge Chat'}
          </span>
          {activeSessionId && activeProvider && (
            <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-200/40 ${PROVIDER_DISPLAY[activeProvider]?.color ?? 'text-gray-500'}`}>
              {PROVIDER_DISPLAY[activeProvider]?.label}
            </span>
          )}
          {selectedAgent && (() => {
            const agentInfo = teamAgents.find((a: any) => a.name === selectedAgent);
            return (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/20">
                @{agentInfo?.displayName ?? selectedAgent}
              </span>
            );
          })()}
        </div>
        <div className="flex items-center gap-2">
          {mcpCount.enabled > 0 && (
            <span className="text-[10px] font-mono flex items-center gap-1 text-gray-600" title={`${mcpCount.connected}/${mcpCount.enabled} MCP`}>
              <Server className="w-3 h-3" />
              <span className={mcpCount.connected > 0 ? 'text-accent-green' : ''}>{mcpCount.connected}/{mcpCount.enabled}</span>
            </span>
          )}
          {activeSessionId && activeSession?.totalCostUsd != null && (
            <span className="text-[10px] text-gray-600 font-mono">${activeSession.totalCostUsd.toFixed(2)}</span>
          )}
          {activeSessionId && (
            <button onClick={() => setLogsOpen(true)} className="p-1.5 rounded-md bg-surface-200/30 hover:bg-surface-200/60 text-gray-500 hover:text-gray-300 transition-all" title="Logs">
              <ScrollText className="w-3.5 h-3.5" />
            </button>
          )}
          <button onClick={() => setCmdPaletteOpen(true)} className="p-1.5 rounded-md bg-surface-200/30 hover:bg-surface-200/60 text-gray-500 hover:text-gray-300 transition-all" title="Commands">
            <Command className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Messages */}
      {loadingMessages && messages.length === 0 && !streaming ? (
        <div className="flex-1 flex items-center justify-center"><div className="text-xs text-gray-600 animate-pulse">Loading...</div></div>
      ) : messages.length === 0 && !activeSessionId && !streaming ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
          <MessageSquare className="w-12 h-12 text-accent-blue/20 mb-4" />
          <h2 className="font-heading text-lg text-white tracking-wider mb-2">FlowForge Chat</h2>
          <p className="text-sm text-gray-500 font-body max-w-md">
            Ask anything about your workflows, repos, and executions. Use <span className="text-accent-blue font-mono">@name</span> to reference resources.
          </p>
        </div>
      ) : (
        <ChatMessageList messages={messages} streamText={streamText} thinkingText={thinkingText} streaming={streaming} activeToolCalls={activeToolCalls} agentThreads={agentThreads} agentReports={agentReports} threadsByMessage={threadsByMessage} spawnedAgents={spawnedAgents} pendingUserQuestion={pendingUserQuestion} onAnswerUserQuestion={answerUserQuestion} activeAgent={activeSession?.activeAgent} onSuggestionClick={handleSuggestionClick} onSaveToLearnings={handleSaveToLearnings} />
      )}

      {/* Agent selector + Input */}
      <div>
        {teamAgents.length > 0 && (() => {
          // Agent is locked once the conversation has messages
          const agentLocked = !!activeSession?.activeAgent && (activeSession?.messageCount ?? 0) > 0;
          return (
            <div className="px-3 pt-2 flex items-center gap-1.5 border-t border-border/30">
              <Users className="w-3 h-3 text-gray-600" />
              <button
                onClick={() => !agentLocked && setSelectedAgent(null)}
                disabled={agentLocked}
                className={`text-[10px] font-mono px-2 py-0.5 rounded transition-colors ${
                  !selectedAgent ? 'bg-accent-blue/10 text-accent-blue border border-accent-blue/20' : agentLocked ? 'text-gray-700 cursor-not-allowed' : 'text-gray-600 hover:text-gray-400'
                }`}
              >
                Assistant
              </button>
              {teamAgents.map((a: any) => (
                <button
                  key={a.name}
                  onClick={() => !agentLocked && setSelectedAgent(selectedAgent === a.name ? null : a.name)}
                  disabled={agentLocked}
                  title={agentLocked ? `Agent locked for this conversation` : (a.displayName ?? a.name)}
                  className={`text-[10px] font-mono px-2 py-0.5 rounded transition-colors ${
                    selectedAgent === a.name
                      ? 'bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/20'
                      : agentLocked ? 'text-gray-700 cursor-not-allowed' : 'text-gray-600 hover:text-gray-400'
                  }`}
                >
                  {a.displayName ?? a.name}
                </button>
              ))}
              {agentLocked && <span className="text-[9px] text-gray-700 font-mono ml-1">locked</span>}
            </div>
          );
        })()}
        <ChatInput
          ref={chatInputRef} onSend={handleSend} onCancel={cancelStream} streaming={streaming}
          disabled={activeSession?.source === 'slack'}
          disabledReason={activeSession?.source === 'slack' ? 'This conversation is managed via Slack. Reply in the Slack thread to continue.' : undefined}
          providers={providers}
          selectedProvider={activeSession?.provider ?? selectedProvider}
          selectedModel={activeSession?.model ?? selectedModel}
          modelLocked={!!activeSessionId}
          onProviderChange={(p, m) => { setSelectedProvider(p); setSelectedModel(m); }}
        />
      </div>

      <CommandPalette open={cmdPaletteOpen} onClose={() => setCmdPaletteOpen(false)} onSelect={handleCommandSelect} />
      {logsOpen && activeSessionId && <ConversationLogs sessionId={activeSessionId} onClose={() => setLogsOpen(false)} />}
    </div>
  );
}
