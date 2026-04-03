import { Bot, Cog, MessageSquare, GitBranch, HelpCircle } from 'lucide-react';

interface PaletteItem {
  type: string;
  label: string;
  icon: any;
  color: string;
  bgColor: string;
  defaults: Record<string, any>;
}

const paletteItems: PaletteItem[] = [
  {
    type: 'agent',
    label: 'Agent',
    icon: Bot,
    color: 'text-accent-blue',
    bgColor: 'hover:bg-accent-blue/10',
    defaults: { role: 'developer', prompt: '', outputs: [] },
  },
  {
    type: 'code',
    label: 'Code',
    icon: Cog,
    color: 'text-accent-green',
    bgColor: 'hover:bg-accent-green/10',
    defaults: { type: 'code', function: 'run-build', outputs: [] },
  },
  {
    type: 'human',
    label: 'Human',
    icon: MessageSquare,
    color: 'text-accent-orange',
    bgColor: 'hover:bg-accent-orange/10',
    defaults: { type: 'human', prompt: '', fields: [], outputs: [] },
  },
  {
    type: 'workflow',
    label: 'Workflow',
    icon: GitBranch,
    color: 'text-accent-purple',
    bgColor: 'hover:bg-accent-purple/10',
    defaults: { type: 'workflow', workflow: '', input_map: {}, output_map: {} },
  },
  {
    type: 'condition',
    label: 'Condition',
    icon: HelpCircle,
    color: 'text-accent-yellow',
    bgColor: 'hover:bg-accent-yellow/10',
    defaults: { type: 'condition', conditions: [] },
  },
];

interface Props {
  onAdd: (type: string, defaults: Record<string, any>) => void;
}

export default function NodePalette({ onAdd }: Props) {
  return (
    <div className="flex flex-col gap-1 bg-surface-100/90 backdrop-blur-sm border border-border/50 rounded-sm p-1.5 shadow-lg">
      {paletteItems.map(item => {
        const Icon = item.icon;
        return (
          <button
            key={item.type}
            onClick={() => onAdd(item.type, item.defaults)}
            className={`flex items-center gap-2 px-2.5 py-1.5 rounded-sm transition-all cursor-pointer w-full ${item.bgColor}`}
            title={`Add ${item.label} Node`}
          >
            <Icon className={`w-3.5 h-3.5 shrink-0 ${item.color}`} />
            <span className="text-[10px] text-gray-300 font-label uppercase tracking-wider">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
