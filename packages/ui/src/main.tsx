import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import App from './App';
import './index.css';

import WorkflowListPage from './pages/WorkflowListPage';
import WorkflowBuilderPage from './pages/WorkflowBuilderPage';
import ExecutionListPage from './pages/ExecutionListPage';
import ExecutionDetailPage from './pages/ExecutionDetailPage';
import DashboardPage from './pages/DashboardPage';
import RoleManagerPage from './pages/RoleManagerPage';
import RepoManagerPage from './pages/RepoManagerPage';
import SettingsPage from './pages/SettingsPage';
import LearningsPage from './pages/LearningsPage';
import ChatPage from './pages/ChatPage';
import AnalyticsPage from './pages/AnalyticsPage';
import WorkspaceListPage from './pages/WorkspaceListPage';
import WorkspaceDetailPage from './pages/WorkspaceDetailPage';

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'workflows', element: <WorkflowListPage /> },
      { path: 'workflows/new', element: <WorkflowBuilderPage /> },
      { path: 'workflows/:id/edit', element: <WorkflowBuilderPage /> },
      { path: 'repos', element: <RepoManagerPage /> },
      { path: 'learnings', element: <LearningsPage /> },
      { path: 'executions', element: <ExecutionListPage /> },
      { path: 'executions/:id', element: <ExecutionDetailPage /> },
      { path: 'agents', element: <RoleManagerPage /> },
      { path: 'chat', element: <ChatPage /> },
      { path: 'chat/:sessionId', element: <ChatPage /> },
      { path: 'workspaces', element: <WorkspaceListPage /> },
      { path: 'workspaces/:id', element: <WorkspaceDetailPage /> },
      { path: 'analytics', element: <AnalyticsPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'settings/:tab', element: <SettingsPage /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
