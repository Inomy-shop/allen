/**
 * Design Studio — session working surface.
 *
 * Reuses the real chat UI (ChatPage) running the per-session "UI Designer"
 * persona, which works in the workspace's persistent design-system folder.
 * The right panel lists that folder's files with Open-in-browser + Export — no
 * live preview. The workspace id is passed via `?ws=` so the panel knows which
 * design system to show.
 */
import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import ChatPage from './ChatPage';
import WorkspaceFilesPanel from '../components/design-studio/WorkspaceFilesPanel';
import { chat as chatApi } from '../services/api';
import { designStudio } from '../services/designStudioService';

export default function DesignStudioSessionPage() {
  const { sessionId } = useParams<{ sessionId?: string }>();
  const [searchParams] = useSearchParams();
  const [workspaceId, setWorkspaceId] = useState<string | null>(searchParams.get('ws'));
  const [workspaceName, setWorkspaceName] = useState<string>('Allen Design workspace');

  // Fall back to resolving the workspace from the chat session if not in the URL.
  useEffect(() => {
    if (workspaceId || !sessionId) return;
    chatApi.getSession(sessionId)
      .then((s: any) => { if (s?.studioWorkspaceId) setWorkspaceId(s.studioWorkspaceId); })
      .catch(() => {});
  }, [sessionId, workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    designStudio.getWorkspace(workspaceId)
      .then((workspace) => setWorkspaceName(workspace.name))
      .catch(() => {});
  }, [workspaceId]);

  return (
    <div className="v8-design-session">
      <div className="v8-design-session__thread">
        <ChatPage
          config={{
            routeBase: 'studio/sessions',
            designMode: true,
            placeholder: 'Describe the screen or change you want…',
            hidePlanMode: true,
            hideRepoSelector: true,
            defaultReasoningEffort: 'high',
            disabled: !workspaceId,
            disabledReason: 'Open Design Studio from a workspace to start designing.',
            createSessionOverride: async ({ provider, model, agentOverrides }) => {
              if (!workspaceId) throw new Error('Design Studio workspace is required');
              const { chatSessionId } = await designStudio.start(workspaceId, { provider, model, agentOverrides });
              return chatApi.getSession(chatSessionId);
            },
          }}
        />
      </div>
      <WorkspaceFilesPanel workspaceId={workspaceId} workspaceName={workspaceName} />
    </div>
  );
}
