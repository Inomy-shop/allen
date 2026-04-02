import {
  ClipboardList, Code, FlaskConical, Eye, Search,
  PenLine, CheckCircle, BarChart3, Telescope,
  GitBranch, LayoutTemplate, Bot,
} from 'lucide-react';

const iconMap: Record<string, any> = {
  clipboard: ClipboardList,
  code: Code,
  flask: FlaskConical,
  eye: Eye,
  search: Search,
  pen: PenLine,
  'check-circle': CheckCircle,
  'bar-chart': BarChart3,
  'magnifying-glass': Telescope,
  'git-branch': GitBranch,
  layout: LayoutTemplate,
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
  const Icon = iconMap[icon ?? ''] ?? Bot;
  return <Icon style={{ color: color ?? '#888' }} width={size} height={size} />;
}
