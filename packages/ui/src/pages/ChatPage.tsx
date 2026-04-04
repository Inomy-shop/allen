import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useChat } from '../hooks/useChat';
import ChatInput from '../components/chat/ChatInput';
import ChatMessageList from '../components/chat/ChatMessageList';
import DeleteConfirmDialog from '../components/common/DeleteConfirmDialog';
import { useState } from 'react';
import {
  Plus,
  Trash2,
  MessageSquare,
  Circle,
} from 'lucide-react';

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

export default function ChatPage() {
  const { sessionId: urlSessionId } = useParams<{ sessionId?: string }>();
  const navigate = useNavigate();
  const [deletingSession, setDeletingSession] = useState<{ id: string; title: string } | null>(null);

  const {
    sessions,
    activeSessionId,
    messages,
    streaming,
    streamText,
    thinkingText,
    activeToolCalls,
    loadingSessions,
    loadingMessages,
    sendMessage,
    createSession,
    deleteSession,
    switchSession,
    cancelStream,
  } = useChat();

  // Sync URL → active session on mount
  useEffect(() => {
    if (urlSessionId && urlSessionId !== activeSessionId) {
      switchSession(urlSessionId);
    }
  }, [urlSessionId]);

  // Sync active session → URL
  useEffect(() => {
    if (activeSessionId && activeSessionId !== urlSessionId) {
      navigate(`/chat/${activeSessionId}`, { replace: true });
    } else if (!activeSessionId && urlSessionId) {
      navigate('/chat', { replace: true });
    }
  }, [activeSessionId]);

  function handleNewConversation() {
    // Don't create session yet — just clear the current one
    // Session will be created on first message
    switchSession('');
    navigate('/chat', { replace: true });
  }

  async function handleSend(content: string) {
    if (!activeSessionId) {
      // No active session — create one, then send with explicit session ID
      const session = await createSession();
      navigate(`/chat/${session._id}`, { replace: true });
      sendMessage(content, session._id);
      return;
    }
    sendMessage(content);
  }

  function handleSwitchSession(id: string) {
    switchSession(id);
    navigate(`/chat/${id}`, { replace: true });
  }

  async function handleDeleteSession() {
    if (!deletingSession) return;
    await deleteSession(deletingSession.id);
    setDeletingSession(null);
    if (activeSessionId === deletingSession.id) {
      navigate('/chat', { replace: true });
    }
  }

  return (
    <div className="flex h-full">
      {/* Sidebar — conversation list */}
      <div className="w-64 shrink-0 bg-surface-50 border-r border-border/50 flex flex-col">
        <div className="p-3 border-b border-border/50 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-accent-blue" />
            <span className="font-heading text-xs font-bold text-white tracking-widest uppercase">Conversations</span>
          </div>
          <button
            onClick={handleNewConversation}
            className="w-7 h-7 flex items-center justify-center rounded-sm bg-accent-blue/10 text-accent-blue hover:bg-accent-blue/20 transition-colors"
            title="New conversation"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-1">
          {loadingSessions && sessions.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-gray-600">Loading...</div>
          )}

          {!loadingSessions && sessions.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-gray-600">
              No conversations yet.<br />Type a message to start.
            </div>
          )}

          {sessions.map(session => {
            const isActive = session._id === activeSessionId;
            const isExpired = !session.claudeSessionId || session.status === 'archived';

            return (
              <div
                key={session._id}
                className={`group relative flex items-center gap-2 px-3 py-2.5 mx-1 rounded-sm cursor-pointer transition-all duration-150 ${
                  isActive
                    ? 'bg-accent-blue/10 border-l-2 border-accent-blue'
                    : 'border-l-2 border-transparent hover:bg-surface-200/50'
                }`}
                onClick={() => handleSwitchSession(session._id)}
              >
                <Circle className={`w-2 h-2 shrink-0 ${isExpired ? 'text-gray-600' : 'text-green-400 fill-green-400'}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-gray-300 font-body truncate">{session.title}</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-gray-600 font-mono">{session.messageCount} msgs</span>
                    <span className="text-[10px] text-gray-600 font-mono">{timeAgo(session.lastMessageAt)}</span>
                  </div>
                </div>
                <button
                  onClick={e => { e.stopPropagation(); setDeletingSession({ id: session._id, title: session.title }); }}
                  className="opacity-0 group-hover:opacity-100 shrink-0 w-6 h-6 flex items-center justify-center rounded-sm text-gray-600 hover:text-red-400 hover:bg-red-500/10 transition-all"
                  title="Delete conversation"
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
              {activeSessionId ? sessions.find(s => s._id === activeSessionId)?.title ?? 'Chat' : 'FlowForge Chat'}
            </span>
          </div>
          {activeSessionId && (
            <span className="text-[10px] text-gray-600 font-mono">
              {sessions.find(s => s._id === activeSessionId)?.totalCostUsd != null
                ? `$${(sessions.find(s => s._id === activeSessionId)?.totalCostUsd ?? 0).toFixed(2)}`
                : ''}
            </span>
          )}
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
          <ChatMessageList messages={messages} streamText={streamText} thinkingText={thinkingText} streaming={streaming} activeToolCalls={activeToolCalls} />
        )}

        <ChatInput onSend={handleSend} onCancel={cancelStream} streaming={streaming} disabled={false} />
      </div>

      <DeleteConfirmDialog
        open={!!deletingSession}
        resourceType="conversation"
        resourceName={deletingSession?.title ?? ''}
        onConfirm={handleDeleteSession}
        onCancel={() => setDeletingSession(null)}
      />
    </div>
  );
}
