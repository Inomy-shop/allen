import { Bot, Cog, MessageSquare, GitBranch, HelpCircle } from 'lucide-react';

interface PaletteItem {
  type: string;
  label: string;
  icon: any;
  color: string;
  defaults: Record<string, any>;
}

const paletteItems: PaletteItem[] = [
  {
    type: 'agent',
    label: 'Agent Node',
    icon: Bot,
    color: 'text-blue-400 border-blue-500/40',
    defaults: { role: 'developer', prompt: '', outputs: [] },
  },
  {
    type: 'code',
    label: 'Code Node',
    icon: Cog,
    color: 'text-green-400 border-green-500/40',
    defaults: { type: 'code', function: 'run-build', outputs: [] },
  },
  {
    type: 'human',
    label: 'Human Node',
    icon: MessageSquare,
    color: 'text-orange-400 border-orange-500/40',
    defaults: { type: 'human', prompt: '', fields: [], outputs: [] },
  },
  {
    type: 'workflow',
    label: 'Workflow Node',
    icon: GitBranch,
    color: 'text-purple-400 border-purple-500/40',
    defaults: { type: 'workflow', workflow: '', input_map: {}, output_map: {} },
  },
  {
    type: 'condition',
    label: 'Condition Node',
    icon: HelpCircle,
    color: 'text-yellow-400 border-yellow-500/40',
    defaults: { type: 'condition', conditions: [] },
  },
];

interface Props {
  onAdd: (type: string, defaults: Record<string, any>) => void;
}

export default function NodePalette({ onAdd }: Props) {
  return (
    <div className="p-3 space-y-1.5">
      <div className="text-xs font-semibold text-gray-400 uppercase mb-2">Add Node</div>
      {paletteItems.map(item => {
        const Icon = item.icon;
        return (
          <button
            key={item.type}
            onClick={() => onAdd(item.type, item.defaults)}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md border bg-surface-200
              hover:bg-surface-300 transition-colors text-left ${item.color}`}
          >
            <Icon className="w-4 h-4 shrink-0" />
            <span className="text-xs text-gray-200">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
