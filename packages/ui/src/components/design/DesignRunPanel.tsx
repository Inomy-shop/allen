import { ExternalLink, Settings } from 'lucide-react';
import ChatMessageList from '../chat/ChatMessageList';
import type { ChatMessage } from '../../hooks/useChat';
import type { DesignMessage, DesignPreviewConfig } from '../../services/designService';

interface DesignRunPanelProps {
  executionId?: string;
  agentRunId?: string;
  messages: DesignMessage[];
  designRepoConfig?: { designPreviewConfig?: DesignPreviewConfig };
  onPreviewClick?: () => void;
}

function previewState(config?: DesignPreviewConfig): 'no_config' | 'validation_failed' | 'ready' {
  if (!config || !config.enabled) return 'no_config';
  const status = config.lastValidationStatus;
  if (status === 'passed') return 'ready';
  return 'validation_failed';
}

/**
 * Adapter: map a DesignMessage to ChatMessage so we can use ChatMessageList
 * for loading/thinking UX parity with the normal chat page.
 *
 * - 'system' role → 'assistant' (ChatMessage has no system role)
 * - Streaming messages are separated out before calling this (see below)
 * - Artifacts are serialized as markdown links appended to content
 */
function designMessageToChatMessage(msg: DesignMessage): ChatMessage {
  let content = msg.content;
  if (msg.artifacts && msg.artifacts.length > 0) {
    const links = msg.artifacts
      .map((a) => `[${a.filename}](${a.url})`)
      .join('\n');
    content = content ? `${content}\n\n${links}` : links;
  }
  return {
    _id: msg._id,
    sessionId: msg.designSessionId,
    role: msg.role === 'system' ? 'assistant' : (msg.role as 'user' | 'assistant'),
    content,
    status: msg.status === 'failed' ? 'failed' : 'completed',
    error: msg.error,
    createdAt: msg.createdAt,
  };
}

export default function DesignRunPanel({
  messages,
  designRepoConfig,
  onPreviewClick,
}: DesignRunPanelProps) {
  const previewStatus = previewState(designRepoConfig?.designPreviewConfig);

  // Separate the streaming message (if any) from completed messages.
  // ChatMessageList takes completed messages in its `messages` prop and
  // shows TypingDots when `streaming=true` + `streamText=''`.
  const streamingMsg = messages.find((m) => m.status === 'streaming');
  const isStreaming = Boolean(streamingMsg);
  const streamText = streamingMsg?.content ?? '';
  const completedMessages = messages.filter((m) => m.status !== 'streaming');
  const chatMessages: ChatMessage[] = completedMessages.map(designMessageToChatMessage);

  const showEmptyState = chatMessages.length === 0 && !isStreaming;

  return (
    <div className="flex h-full flex-col">
      {/* Message area — reuse ChatMessageList for loading/thinking UX parity */}
      <div className="flex-1 min-h-0 relative">
        {showEmptyState ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-[13px] text-theme-muted">
              Start a conversation to generate designs.
            </p>
          </div>
        ) : (
          <ChatMessageList
            messages={chatMessages}
            streamText={streamText}
            streaming={isStreaming}
          />
        )}
      </div>

      {/* Preview bar */}
      <div className="shrink-0 border-t border-app px-4 py-2 flex items-center justify-between gap-3">
        <span className="text-[11.5px] text-theme-muted">Preview</span>

        {previewStatus === 'no_config' && (
          <div className="flex items-center gap-2">
            <span className="text-[11.5px] text-theme-subtle">
              Preview command is not configured for this design repo
            </span>
            <button
              type="button"
              disabled
              aria-label="Open preview (not configured)"
              className="inline-flex items-center gap-1.5 rounded-md border border-app px-2.5 py-1 text-[11.5px] text-theme-muted opacity-40 cursor-not-allowed"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Preview
            </button>
          </div>
        )}

        {previewStatus === 'validation_failed' && (
          <div className="flex items-center gap-2">
            <span className="text-[11.5px] text-theme-subtle">
              Preview config needs validation
            </span>
            <button
              type="button"
              aria-label="Configure or retry preview validation"
              onClick={onPreviewClick}
              className="inline-flex items-center gap-1.5 rounded-md border border-app px-2.5 py-1 text-[11.5px] text-theme-secondary transition-colors hover:border-app-strong hover:text-theme-primary"
            >
              <Settings className="h-3.5 w-3.5" />
              Configure / Retry
            </button>
          </div>
        )}

        {previewStatus === 'ready' && (
          <button
            type="button"
            onClick={onPreviewClick}
            aria-label="Open preview"
            className="inline-flex items-center gap-1.5 rounded-md border border-accent/30 bg-accent-soft px-2.5 py-1 text-[11.5px] font-medium text-accent transition-colors hover:bg-accent/20"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Preview
          </button>
        )}
      </div>
    </div>
  );
}
