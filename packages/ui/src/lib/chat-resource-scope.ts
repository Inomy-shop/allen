import { resourceScopeKey } from '../stores/documentTabStore';

export type ChatWorkspaceResourceTab =
  | { kind: 'session'; sessionId: string }
  | { kind: 'temp'; tempId: string }
  | { kind: 'terminal'; terminalId: string }
  | { kind: 'servers' }
  | { kind: 'code-diff' }
  | { kind: 'file-explorer' };

type ResolveChatResourceScopeOptions = {
  workspaceId?: string | null;
  workspaceTab?: ChatWorkspaceResourceTab | null;
  chatTabId?: string | null;
  terminalTabId?: string | null;
  utilityTabId?: string | null;
  sessionId?: string | null;
};

function surfaceScope(id: string): string {
  return resourceScopeKey('surface', `chat:${id}`);
}

/**
 * Resolve the resource-tab scope for the visible chat-area tab.
 *
 * Persisted and unsent conversations both receive their own chat scope. Other
 * sibling tabs receive non-chat surface scopes so they can never reveal a
 * document or file selected in a conversation tab.
 */
export function resolveChatResourceScope({
  workspaceId,
  workspaceTab,
  chatTabId,
  terminalTabId,
  utilityTabId,
  sessionId,
}: ResolveChatResourceScopeOptions): string {
  if (workspaceId) {
    if (workspaceTab?.kind === 'session') return resourceScopeKey('chat', workspaceTab.sessionId);
    if (workspaceTab?.kind === 'temp') return resourceScopeKey('chat', workspaceTab.tempId);

    if (workspaceTab?.kind === 'terminal') {
      return surfaceScope(`workspace:${workspaceId}:terminal:${workspaceTab.terminalId}`);
    }
    if (workspaceTab) return surfaceScope(`workspace:${workspaceId}:${workspaceTab.kind}`);
    return surfaceScope(`workspace:${workspaceId}:blank`);
  }

  if (terminalTabId) return surfaceScope(`terminal:${terminalTabId}`);
  if (utilityTabId) return surfaceScope(`utility:${utilityTabId}`);
  if (chatTabId) return resourceScopeKey('chat', chatTabId);
  if (sessionId) return resourceScopeKey('chat', sessionId);
  return surfaceScope('new');
}
