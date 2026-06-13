import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type SlashCommandProvider = 'codex' | 'claude';

export interface SlashCommandInfo {
  name: string;
  description: string;
  provider: SlashCommandProvider | 'all';
  source: 'builtin' | 'project' | 'user';
  kind?: 'builtin' | 'skill' | 'command';
  path?: string;
  dispatchable: boolean;
  unavailableReason?: string;
}

const CLAUDE_BUILTINS: SlashCommandInfo[] = [
  { name: '/clear', description: 'Start a fresh conversation.', provider: 'claude', source: 'builtin', kind: 'builtin', dispatchable: true },
  { name: '/compact', description: 'Compact conversation history.', provider: 'claude', source: 'builtin', kind: 'builtin', dispatchable: true },
  { name: '/context', description: 'Show context usage.', provider: 'claude', source: 'builtin', kind: 'builtin', dispatchable: true },
  { name: '/cost', description: 'Show conversation cost and usage.', provider: 'claude', source: 'builtin', kind: 'builtin', dispatchable: true },
  { name: '/goal', description: 'Set a goal Claude checks before stopping', provider: 'claude', source: 'builtin', kind: 'builtin', dispatchable: true },
  { name: '/init', description: 'Initialize project guidance (CLAUDE.md).', provider: 'claude', source: 'builtin', kind: 'builtin', dispatchable: true },
  { name: '/review', description: 'Run Claude code review.', provider: 'claude', source: 'builtin', kind: 'builtin', dispatchable: true },
  { name: '/security-review', description: 'Run a security-focused review.', provider: 'claude', source: 'builtin', kind: 'builtin', dispatchable: true },
];

const CODEX_BUILTINS: SlashCommandInfo[] = [
  { name: '/compact', description: 'Compact Codex thread context.', provider: 'codex', source: 'builtin', kind: 'builtin', dispatchable: true },
  { name: '/status', description: 'Show Codex app-server thread status.', provider: 'codex', source: 'builtin', kind: 'builtin', dispatchable: true },
  { name: '/model', description: 'Switch Codex model.', provider: 'codex', source: 'builtin', kind: 'builtin', dispatchable: false, unavailableReason: 'Model is locked per Allen conversation after creation.' },
  { name: '/review', description: 'Start Codex review.', provider: 'codex', source: 'builtin', kind: 'builtin', dispatchable: true },
  { name: '/mcp', description: 'Manage Codex MCP servers.', provider: 'codex', source: 'builtin', kind: 'builtin', dispatchable: false, unavailableReason: 'Use Allen MCP settings for now.' },
];

export function listSlashCommands(provider: SlashCommandProvider, cwd?: string): SlashCommandInfo[] {
  const commands = provider === 'claude' ? [...CLAUDE_BUILTINS] : [...CODEX_BUILTINS];
  commands.push(...scanProviderCommands(provider, cwd));

  const byName = new Map<string, SlashCommandInfo>();
  for (const command of commands) {
    if (isUnavailableCodexSkill(command)) continue;
    const existing = byName.get(command.name);
    if (!existing || rankSource(command.source) > rankSource(existing.source)) {
      byName.set(command.name, command);
    }
  }
  return [...byName.values()].sort((a, b) => {
    if (a.dispatchable !== b.dispatchable) return a.dispatchable ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function isUnavailableCodexSkill(command: SlashCommandInfo): boolean {
  if (command.provider !== 'codex' || command.kind !== 'skill') return false;
  const path = command.path ?? '';
  return command.name.startsWith('/figma-')
    || command.name === '/figma-use'
    || path.includes('/.codex/plugins/cache/openai-curated/figma/');
}

function rankSource(source: SlashCommandInfo['source']): number {
  if (source === 'project') return 3;
  if (source === 'user') return 2;
  return 1;
}

function scanProviderCommands(provider: SlashCommandProvider, cwd?: string): SlashCommandInfo[] {
  const roots: Array<{ dir: string; source: 'project' | 'user' }> = [];
  const home = homedir();
  if (provider === 'claude') {
    roots.push({ dir: join(home, '.claude', 'commands'), source: 'user' });
    roots.push({ dir: join(home, '.claude', 'skills'), source: 'user' });
    if (cwd) {
      roots.push({ dir: join(cwd, '.claude', 'commands'), source: 'project' });
      roots.push({ dir: join(cwd, '.claude', 'skills'), source: 'project' });
    }
  } else {
    roots.push({ dir: join(home, '.codex', 'skills'), source: 'user' });
    roots.push({ dir: join(home, '.codex', 'plugins', 'cache'), source: 'user' });
    if (cwd) roots.push({ dir: join(cwd, '.codex', 'skills'), source: 'project' });
  }

  return roots.flatMap(root => scanCommandRoot(provider, root.dir, root.source));
}

function scanCommandRoot(provider: SlashCommandProvider, dir: string, source: 'project' | 'user'): SlashCommandInfo[] {
  if (!existsSync(dir)) return [];
  const out: SlashCommandInfo[] = [];
  const maxDepth = provider === 'codex' && dir.includes(join('.codex', 'plugins', 'cache')) ? 6 : 2;
  const visit = (current: string, depth: number) => {
    if (depth > maxDepth) return;
    for (const entry of safeReadDirEntries(current)) {
      if (entry.name.startsWith('.') && entry.name !== '.system') continue;
      const full = join(current, entry.name);
      if (entry.isFile() && entry.name.endsWith('.md') && depth === 0) {
        out.push(commandFromFile(provider, full, entry.name.replace(/\.md$/, ''), source));
        continue;
      }
      if (!entry.isDirectory()) continue;
      const skillFile = join(full, 'SKILL.md');
      if (existsSync(skillFile)) {
        out.push(commandFromFile(provider, skillFile, entry.name, source));
      } else {
        visit(full, depth + 1);
      }
    }
  };
  visit(dir, 0);
  return out;
}

function commandFromFile(provider: SlashCommandProvider, path: string, fallbackName: string, source: 'project' | 'user'): SlashCommandInfo {
  const content = safeRead(path);
  const name = frontmatterValue(content, 'name') ?? fallbackName;
  const description = frontmatterValue(content, 'description') ?? firstMarkdownLine(content) ?? `${source} ${provider === 'codex' ? 'skill' : 'command'}`;
  return {
    name: `/${name.replace(/^\/+/, '')}`,
    description,
    provider,
    source,
    kind: provider === 'codex' ? 'skill' : 'command',
    path,
    dispatchable: true,
  };
}

function safeReadDirEntries(dir: string): Dirent[] {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function safeRead(path: string): string {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

function frontmatterValue(content: string, key: string): string | undefined {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return undefined;
  const line = match[1].split('\n').find(item => item.trim().startsWith(`${key}:`));
  return line?.slice(line.indexOf(':') + 1).trim().replace(/^['"]|['"]$/g, '') || undefined;
}

function firstMarkdownLine(content: string): string | undefined {
  const body = content.replace(/^---\n[\s\S]*?\n---/, '');
  return body.split('\n').map(line => line.trim()).find(line => line && !line.startsWith('#'))?.slice(0, 160);
}
