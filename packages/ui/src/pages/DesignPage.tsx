import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import ChatPage from './ChatPage';
import DesignPreviewPanel from '../components/design/DesignPreviewPanel';

export default function DesignPage() {
  const { sessionId } = useParams<{ sessionId?: string }>();
  // Track the effective session id — starts from URL, updates when ChatPage creates a new session
  const [activeSessionId, setActiveSessionId] = useState<string | null>(sessionId ?? null);
  // Track the effective workspace id — propagated from ChatPage when a workspace becomes linked
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);

  // Keep in sync when the URL param changes (e.g., user navigates to a different session)
  useEffect(() => {
    setActiveSessionId(sessionId ?? null);
  }, [sessionId]);

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <ChatPage
        config={{
          routeBase: 'design',
          forcedAgent: 'design-assistant',
          placeholder: "Describe what you'd like to design or build…",
          designMode: true,
          onActiveSessionIdChange: setActiveSessionId,
          onActiveWorkspaceIdChange: setActiveWorkspaceId,
        }}
      />
      <DesignPreviewPanel chatSessionId={activeSessionId} workspaceId={activeWorkspaceId} />
    </div>
  );
}
