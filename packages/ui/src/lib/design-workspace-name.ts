import type { Workspace } from '../services/designStudioService';

export function isImportedDesignWorkspace(workspace: Pick<Workspace, 'name' | 'greenfieldBrief' | 'imported'>): boolean {
  return workspace.imported === true
    || /\s+\(imported\)$/i.test(workspace.name)
    || /^(workspace|bundle):/i.test(workspace.greenfieldBrief?.references?.trim() ?? '');
}

export function designWorkspaceDisplayName(name: string): string {
  const cleaned = name
    .replace(/\s+\(imported\)$/i, '')
    .replace(/^(?:feature|feat|fix|bugfix|hotfix|chore|ui|design|allen)[/-]+/i, '')
    .replace(/-([a-z0-9]{6,10})$/i, (match, suffix: string) => (
      /\d/.test(suffix) ? '' : match
    ))
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return name;
  return (cleaned.charAt(0).toUpperCase() + cleaned.slice(1))
    .replace(/\bUi\b/g, 'UI')
    .replace(/\bUx\b/g, 'UX')
    .replace(/\bApi\b/g, 'API')
    .replace(/\bQa\b/g, 'QA');
}
