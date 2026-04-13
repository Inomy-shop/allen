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
import TeamManagerPage from './pages/TeamManagerPage';
import RepoManagerPage from './pages/RepoManagerPage';
import SettingsPage from './pages/SettingsPage';
import LearningsPage from './pages/LearningsPage';
import ChatPage from './pages/ChatPage';
import AnalyticsPage from './pages/AnalyticsPage';
import WorkspaceListPage from './pages/WorkspaceListPage';
import WorkspaceDetailPage from './pages/WorkspaceDetailPage';
import PullRequestListPage from './pages/PullRequestListPage';
import PullRequestDetailPage from './pages/PullRequestDetailPage';
import CronManagerPage from './pages/CronManagerPage';
import LoginPage from './pages/LoginPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import ForbiddenPage from './pages/ForbiddenPage';
import ProtectedRoute from './components/auth/ProtectedRoute';
import { ToastProvider } from './components/common/Toast';

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  { path: '/403', element: <ForbiddenPage /> },
  {
    element: <ProtectedRoute />,
    children: [
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
          { path: 'teams', element: <TeamManagerPage /> },
          { path: 'chat', element: <ChatPage /> },
          { path: 'chat/:sessionId', element: <ChatPage /> },
          { path: 'workspaces', element: <WorkspaceListPage /> },
          { path: 'workspaces/:id', element: <WorkspaceDetailPage /> },
          { path: 'pull-requests', element: <PullRequestListPage /> },
          { path: 'pull-requests/:id', element: <PullRequestDetailPage /> },
          { path: 'analytics', element: <AnalyticsPage /> },
          { path: 'crons', element: <CronManagerPage /> },
          { path: 'settings', element: <SettingsPage /> },
          { path: 'settings/:tab', element: <SettingsPage /> },
        ],
      },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>
  </React.StrictMode>,
);
