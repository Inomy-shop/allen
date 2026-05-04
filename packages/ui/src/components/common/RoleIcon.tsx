import {
  ClipboardList, Code, FlaskConical, Eye, Search,
  PenLine, CheckCircle, BarChart3, Telescope,
  GitBranch, LayoutTemplate, Bot, Briefcase, Crown,
  Shield, Server, Brain, FileText, Wrench, Zap,
  Terminal, Rocket, Bug, Cpu, Palette, Users,
  BrainCircuit, Sparkles,
} from 'lucide-react';

const iconMap: Record<string, React.ElementType> = {
  // Agent icons
  briefcase: Briefcase,
  crown: Crown,
  code: Code,
  shield: Shield,
  server: Server,
  brain: Brain,
  fileText: FileText,
  barChart3: BarChart3,
  search: Search,
  eye: Eye,
  flask: FlaskConical,
  gitBranch: GitBranch,
  // Legacy names
  clipboard: ClipboardList,
  pen: PenLine,
  'check-circle': CheckCircle,
  'bar-chart': BarChart3,
  'magnifying-glass': Telescope,
  'git-branch': GitBranch,
  layout: LayoutTemplate,
  // Extra
  wrench: Wrench,
  zap: Zap,
  terminal: Terminal,
  rocket: Rocket,
  bug: Bug,
  cpu: Cpu,
  palette: Palette,
  users: Users,
  bot: Bot,
  brainCircuit: BrainCircuit,
  sparkles: Sparkles,
};

export default function RoleIcon({
  icon,
  color,
  size = 16,
}: {
  icon?: string;
  color?: string;
  size?: number;
}) {
  const Icon = iconMap[icon ?? ''] ?? BrainCircuit;
  return <Icon style={{ color: color ?? '#888' }} width={size} height={size} />;
}
