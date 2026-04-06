import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useChat } from '../hooks/useChat';
import ChatInput from '../components/chat/ChatInput';
import ChatMessageList from '../components/chat/ChatMessageList';
import CommandPalette from '../components/chat/CommandPalette';
import DeleteConfirmDialog from '../components/common/DeleteConfirmDialog';
import {
  Plus, Trash2, MessageSquare, Circle, Command, Server, ScrollText,
} from 'lucide-react';
import ConversationLogs from '../components/chat/ConversationLogs';
import { chat as chatApi, mcp as mcpApi, learnings as learningsApi } from '../services/api';

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

// Provider display config
const PROVIDER_DISPLAY: Record<string, { label: string; color: string }> = {
  codex: { label: 'Codex', color: 'text-accent-green' },
  'claude-cli': { label: 'Claude CLI', color: 'text-accent-blue' },
  gemini: { label: 'Gemini', color: 'text-accent-yellow' },
  'anthropic-api': { label: 'Claude API', color: 'text-accent-purple' },
};

export default function ChatPage() {
  const { sessionId: urlSessionId } = useParams<{ sessionId?: string }>();
  const navigate = useNavigate();
  const [deletingSession, setDeletingSession] = useState<{ id: string; title: string } | null>(null);
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [mcpCount, setMcpCount] = useState<{ enabled: number; connected: number }>({ enabled: 0, connected: 0 });
  const [providers, setProviders] = useState<any[]>([]);
  const [selectedProvider, setSelectedProvider] = useState('codex');
  const [selectedModel, setSelectedModel] = useState('');
  const chatInputRef = useRef<{ setValue: (v: string) => void; focus: () => void } | null>(null);

  const {
    sessions, activeSessionId, messages, streaming, streamText,
    thinkingText, activeToolCalls, loadingSessions, loadingMessages,
    sendMessage, createSession, deleteSession, switchSession, cancelStream,
  } = useChat();

  // Load providers and MCP count on mount
  useEffect(() => {
    chatApi.providers().then(p => {
      setProviders(p);
      if (p.length > 0) {
        setSelectedProvider(p[0].provider);
        setSelectedModel(p[0].defaultModel);
      }
    }).catch(() => {});
    mcpApi.list().then(servers => {
      setMcpCount({
        enabled: servers.filter((s: any) => s.enabled).length,
        connected: servers.filter((s: any) => s.status === 'connected').length,
      });
    }).catch(() => {});
  }, []);

  // Get current session's provider and autonomy for display
  const activeSession = sessions.find(s => s._id === activeSessionId);
  const activeProvider = activeSession?.provider ?? selectedProvider;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setCmdPaletteOpen(prev => !prev); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    if (urlSessionId && urlSessionId !== activeSessionId) switchSession(urlSessionId);
  }, [urlSessionId]);

  useEffect(() => {
    if (activeSessionId && activeSessionId !== urlSessionId) navigate(`/chat/${activeSessionId}`, { replace: true });
    else if (!activeSessionId && urlSessionId) navigate('/chat', { replace: true });
  }, [activeSessionId]);

  function handleNewConversation() {
    switchSession('');
    navigate('/chat', { replace: true });
  }

  async function handleSend(content: string) {
    if (!activeSessionId) {
      const session = await createSession(selectedProvider, selectedModel || undefined);
      navigate(`/chat/${session._id}`, { replace: true });
      sendMessage(content, session._id);
      return;
    }
    sendMessage(content);
  }

  function handleSuggestionClick(prompt: string) { handleSend(prompt); }

  async function handleSaveToLearnings(content: string) {
    try {
      await learningsApi.create({
        content: content.slice(0, 1000),
        type: 'fact',
        target: 'agent',
        tags: ['chat', 'saved'],
        scope: { level: 'global' },
        source: { sourceType: 'manual', workflowName: 'chat', nodeName: 'chat', executionId: activeSessionId ?? '', timestamp: new Date() },
        confidence: 0.8,
        status: 'active',
      });
    } catch (e) { console.error('Failed to save learning:', e); }
  }

  function handleCommandSelect(prompt: string, partial?: boolean) {
    if (partial) { chatInputRef.current?.setValue(prompt); chatInputRef.current?.focus(); }
    else handleSend(prompt);
    setCmdPaletteOpen(false);
  }

  function handleSwitchSession(id: string) { switchSession(id); navigate(`/chat/${id}`, { replace: true }); }

  async function handleDeleteSession() {
    if (!deletingSession) return;
    await deleteSession(deletingSession.id);
    setDeletingSession(null);
    if (activeSessionId === deletingSession.id) navigate('/chat', { replace: true });
  }

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div className="w-64 shrink-0 bg-surface-50 border-r border-border/50 flex flex-col">
        <div className="p-3 border-b border-border/50 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-accent-blue" />
            <span className="font-heading text-xs font-bold text-white tracking-widest uppercase">Conversations</span>
          </div>
          <button onClick={handleNewConversation} className="w-7 h-7 flex items-center justify-center rounded-sm bg-accent-blue/10 text-accent-blue hover:bg-accent-blue/20 transition-colors" title="New conversation">
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-1">
          {loadingSessions && sessions.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-gray-600">Loading...</div>
          )}
          {!loadingSessions && sessions.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-gray-600">No conversations yet.<br />Type a message to start.</div>
          )}
          {sessions.map(session => {
            const isActive = session._id === activeSessionId;
            const prov = PROVIDER_DISPLAY[session.provider] ?? { label: session.provider, color: 'text-gray-500' };
            return (
              <div
                key={session._id}
                className={`group relative flex items-center gap-2 px-3 py-2.5 mx-1 rounded-sm cursor-pointer transition-all duration-150 ${isActive ? 'bg-accent-blue/10 border-l-2 border-accent-blue' : 'border-l-2 border-transparent hover:bg-surface-200/50'}`}
                onClick={() => handleSwitchSession(session._id)}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-gray-300 font-body truncate">{session.title}</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className={`text-[9px] font-mono ${prov.color}`}>{prov.label}</span>
                    <span className="text-[10px] text-gray-600 font-mono">{session.messageCount} msgs</span>
                    <span className="text-[10px] text-gray-600 font-mono">{timeAgo(session.lastMessageAt)}</span>
                  </div>
                </div>
                <button
                  onClick={e => { e.stopPropagation(); setDeletingSession({ id: session._id, title: session.title }); }}
                  className="opacity-0 group-hover:opacity-100 shrink-0 w-6 h-6 flex items-center justify-center rounded-sm text-gray-600 hover:text-red-400 hover:bg-red-500/10 transition-all"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-4 py-3 border-b border-border/50 flex items-center justify-between bg-surface-50/50">
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
          </div>
          <div className="flex items-center gap-3">
            {mcpCount.enabled > 0 && (
              <span className="text-[10px] font-mono flex items-center gap-1 text-gray-600" title={`${mcpCount.connected}/${mcpCount.enabled} MCP servers`}>
                <Server className="w-3 h-3" />
                <span className={mcpCount.connected > 0 ? 'text-accent-green' : 'text-gray-600'}>{mcpCount.connected}/{mcpCount.enabled}</span>
              </span>
            )}
            {activeSessionId && activeSession?.totalCostUsd != null && (
              <span className="text-[10px] text-gray-600 font-mono">${activeSession.totalCostUsd.toFixed(2)}</span>
            )}
            {activeSessionId && (
              <button onClick={() => setLogsOpen(true)} className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-surface-200/40 border border-border/30 hover:bg-surface-200/70 hover:border-accent-blue/30 transition-all text-gray-500 hover:text-gray-300" title="Conversation logs">
                <ScrollText className="w-3 h-3" />
              </button>
            )}
            <button onClick={() => setCmdPaletteOpen(true)} className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-surface-200/40 border border-border/30 hover:bg-surface-200/70 hover:border-accent-blue/30 transition-all text-gray-500 hover:text-gray-300" title="Command palette">
              <Command className="w-3 h-3" /><span className="text-[10px] font-mono">K</span>
            </button>
          </div>
        </div>

        {loadingMessages && messages.length === 0 && !streaming ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-xs text-gray-600 animate-pulse">Loading messages...</div>
          </div>
        ) : messages.length === 0 && !activeSessionId && !streaming ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
            <MessageSquare className="w-12 h-12 text-accent-blue/20 mb-4" />
            <h2 className="font-heading text-lg text-white tracking-wider mb-2">FlowForge Chat</h2>
            <p className="text-sm text-gray-500 font-body max-w-md">
              Ask anything about your workflows, repos, and executions. Use <span className="text-accent-blue font-mono">@name</span> to reference specific resources.
            </p>
          </div>
        ) : (
          <ChatMessageList messages={messages} streamText={streamText} thinkingText={thinkingText} streaming={streaming} activeToolCalls={activeToolCalls} onSuggestionClick={handleSuggestionClick} onSaveToLearnings={handleSaveToLearnings} />
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

      <CommandPalette open={cmdPaletteOpen} onClose={() => setCmdPaletteOpen(false)} onSelect={handleCommandSelect} />
      <DeleteConfirmDialog open={!!deletingSession} resourceType="conversation" resourceName={deletingSession?.title ?? ''} onConfirm={handleDeleteSession} onCancel={() => setDeletingSession(null)} />

      {logsOpen && activeSessionId && (
        <ConversationLogs sessionId={activeSessionId} onClose={() => setLogsOpen(false)} />
      )}
    </div>
  );
}
