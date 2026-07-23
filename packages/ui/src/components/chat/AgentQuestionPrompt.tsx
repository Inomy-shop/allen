import { useState } from 'react';
import { HelpCircle, Send } from 'lucide-react';
import RoleIcon from '../common/RoleIcon';

interface AgentQuestionPromptProps {
  question: string;
  fromAgent: string;
  agentInfo?: { displayName?: string; icon?: string; color?: string };
  onAnswer: (answer: string) => void;
}

export function AgentQuestionPrompt({ question, fromAgent, agentInfo, onAnswer }: AgentQuestionPromptProps) {
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const agentColor = agentInfo?.color ?? '#06b6d4';
  const agentName = agentInfo?.displayName ?? fromAgent;

  async function handleSubmit() {
    if (!answer.trim() || submitting) return;
    setSubmitting(true);
    onAnswer(answer.trim());
  }

  return (
    <div className="v8-agent-question mx-4 mb-4 rounded-lg border border-accent-cyan/30 bg-accent-cyan/5 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-accent-cyan/15">
        <div className="w-6 h-6 rounded-full flex items-center justify-center" style={{ backgroundColor: agentColor + '20', border: `1px solid ${agentColor}30` }}>
          <RoleIcon icon={agentInfo?.icon} color={agentColor} size={13} />
        </div>
        <span className="text-[12px] font-heading font-semibold tracking-wider" style={{ color: agentColor }}>{agentName}</span>
        <span className="text-[11px] text-theme-muted font-mono">is asking you:</span>
        <HelpCircle className="w-3.5 h-3.5 text-accent-cyan/60 ml-auto shrink-0" />
      </div>

      {/* Question */}
      <div className="px-4 py-3">
        <p className="text-[13px] text-theme-secondary font-body leading-relaxed">{question}</p>
      </div>

      {/* Answer input */}
      <div className="px-4 pb-3 space-y-2">
        <textarea
          value={answer}
          onChange={e => setAnswer(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); } }}
          placeholder="Type your answer..."
          autoFocus
          rows={3}
          disabled={submitting}
          className="w-full bg-app-muted border border-app rounded-md px-3 py-2 text-sm text-theme-primary placeholder-gray-600 font-body resize-y focus:outline-none focus:border-accent-cyan/50 disabled:opacity-50"
        />
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-theme-subtle font-mono">shift+enter for new line</span>
          <button
            onClick={handleSubmit}
            disabled={!answer.trim() || submitting}
            className="px-4 py-1.5 rounded-md bg-accent-cyan/20 text-accent-cyan text-sm font-mono hover:bg-accent-cyan/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            <Send className="w-3.5 h-3.5" />
            Reply
          </button>
        </div>
      </div>
    </div>
  );
}
