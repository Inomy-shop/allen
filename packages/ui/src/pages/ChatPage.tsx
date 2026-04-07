import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
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
  gemini: { label: 'Gemini', color: 'text-accent-yellow' },
  'anthropic-api': { label: 'Claude API', color: 'text-accent-purple' },
};

export default function ChatPage() {
  const { sessionId: urlSessionId } = useParams<{ sessionId?: string }>();
  const navigate = useNavigate();
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
    thinkingText, activeToolCalls, agentThreads, agentReports,
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

  // Restore agent selector from session when switching conversations
  useEffect(() => {
    if (activeSession?.activeAgent) {
      setSelectedAgent(activeSession.activeAgent);
    } else if (activeSessionId) {
      setSelectedAgent(null);
    }
  }, [activeSessionId]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setCmdPaletteOpen(prev => !prev); } };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => { if (urlSessionId && urlSessionId !== activeSessionId) switchSession(urlSessionId); }, [urlSessionId]);
  useEffect(() => {
    if (activeSessionId && activeSessionId !== urlSessionId) navigate(`/chat/${activeSessionId}`, { replace: true });
    else if (!activeSessionId && urlSessionId) navigate('/chat', { replace: true });
  }, [activeSessionId]);

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
          {selectedAgent && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/20">
              @{selectedAgent}
            </span>
          )}
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
        <ChatMessageList messages={messages} streamText={streamText} thinkingText={thinkingText} streaming={streaming} activeToolCalls={activeToolCalls} agentThreads={agentThreads} agentReports={agentReports} onSuggestionClick={handleSuggestionClick} onSaveToLearnings={handleSaveToLearnings} />
      )}

      {/* Agent selector + Input */}
      <div>
        {teamAgents.length > 0 && (
          <div className="px-3 pt-2 flex items-center gap-1.5 border-t border-border/30">
            <Users className="w-3 h-3 text-gray-600" />
            <button
              onClick={() => setSelectedAgent(null)}
              className={`text-[10px] font-mono px-2 py-0.5 rounded transition-colors ${
                !selectedAgent ? 'bg-accent-blue/10 text-accent-blue border border-accent-blue/20' : 'text-gray-600 hover:text-gray-400'
              }`}
            >
              Assistant
            </button>
            {teamAgents.map((agent: any) => (
              <button
                key={agent.name}
                onClick={() => setSelectedAgent(selectedAgent === agent.name ? null : agent.name)}
                title={agent.displayName ?? agent.name}
                className={`text-[10px] font-mono px-2 py-0.5 rounded transition-colors ${
                  selectedAgent === agent.name
                    ? 'bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/20'
                    : 'text-gray-600 hover:text-gray-400'
                }`}
              >
                {agent.displayName ?? agent.name}
              </button>
            ))}
          </div>
        )}
        <ChatInput
          ref={chatInputRef} onSend={handleSend} onCancel={cancelStream} streaming={streaming} disabled={false}
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
