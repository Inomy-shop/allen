import { Bot, Cog, MessageSquare, GitBranch, HelpCircle } from 'lucide-react';

interface PaletteItem {
  type: string;
  label: string;
  icon: any;
  color: string;
  borderColor: string;
  defaults: Record<string, any>;
}

const paletteItems: PaletteItem[] = [
  {
    type: 'agent',
    label: 'Agent Node',
    icon: Bot,
    color: 'text-accent-blue',
    borderColor: 'border-accent-blue/40',
    defaults: { role: 'developer', prompt: '', outputs: [] },
  },
  {
    type: 'code',
    label: 'Code Node',
    icon: Cog,
    color: 'text-accent-green',
    borderColor: 'border-accent-green/40',
    defaults: { type: 'code', function: 'run-build', outputs: [] },
  },
  {
    type: 'human',
    label: 'Human Node',
    icon: MessageSquare,
    color: 'text-accent-orange',
    borderColor: 'border-accent-orange/40',
    defaults: { type: 'human', prompt: '', fields: [], outputs: [] },
  },
  {
    type: 'workflow',
    label: 'Workflow Node',
    icon: GitBranch,
    color: 'text-accent-purple',
    borderColor: 'border-accent-purple/40',
    defaults: { type: 'workflow', workflow: '', input_map: {}, output_map: {} },
  },
  {
    type: 'condition',
    label: 'Condition Node',
    icon: HelpCircle,
    color: 'text-accent-yellow',
    borderColor: 'border-accent-yellow/40',
    defaults: { type: 'condition', conditions: [] },
  },
];

interface Props {
  onAdd: (type: string, defaults: Record<string, any>) => void;
}

export default function NodePalette({ onAdd }: Props) {
  return (
    <div className="p-3 space-y-1.5">
      <div className="font-heading text-xs font-semibold text-gray-400 uppercase mb-2 tracking-widest">Add Node</div>
      {paletteItems.map(item => {
        const Icon = item.icon;
        return (
          <button
            key={item.type}
            onClick={() => onAdd(item.type, item.defaults)}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-sm border bg-surface-200/80
              hover:bg-surface-300 hover:shadow-glow-blue/10 transition-all text-left ${item.borderColor}`}
          >
            <Icon className={`w-4 h-4 shrink-0 ${item.color}`} />
            <span className="text-xs text-gray-200 font-label uppercase tracking-wider">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
