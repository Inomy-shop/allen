import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import ChatPage from './ChatPage';
import DesignPreviewPanel from '../components/design/DesignPreviewPanel';
import { designRepos } from '../services/designService';

export default function DesignPage() {
  const { sessionId } = useParams<{ sessionId?: string }>();
  const [activeSessionId, setActiveSessionId] = useState<string | null>(sessionId ?? null);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  // null = loading (don't disable yet), false = no repo, true = repo ready
  const [designRepoReady, setDesignRepoReady] = useState<boolean | null>(null);

  useEffect(() => {
    setActiveSessionId(sessionId ?? null);
  }, [sessionId]);

  useEffect(() => {
    designRepos.getDefault().then(repo => {
      setDesignRepoReady(repo !== null && (repo.path ?? '') !== '');
    }).catch(() => {
      setDesignRepoReady(false);
    });
  }, []);

  const chatDisabled = designRepoReady === false;

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
          disabled: chatDisabled,
          disabledReason: 'Set up your design repo in the Preview panel to start chatting.',
        }}
      />
      <DesignPreviewPanel
        chatSessionId={activeSessionId}
        workspaceId={activeWorkspaceId}
        onRepoConfigured={() => setDesignRepoReady(true)}
      />
    </div>
  );
}
