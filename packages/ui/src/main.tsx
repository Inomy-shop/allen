import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import App from './App';
import './index.css';

import WorkflowListPage from './pages/WorkflowListPage';
import WorkflowDetailPage from './pages/WorkflowDetailPage';
import WorkflowBuilderPage from './pages/WorkflowBuilderPage';
import ExecutionListPage from './pages/ExecutionListPage';
import ExecutionDetailPage from './pages/ExecutionDetailPage';
import DashboardPage from './pages/DashboardPage';
import RoleManagerPage from './pages/RoleManagerPage';
import SettingsPage from './pages/SettingsPage';
import ChatPage from './pages/ChatPage';
import ThreadsPage from './pages/ThreadsPage';
import WorkspaceListPage from './pages/WorkspaceListPage';
import PullRequestListPage from './pages/PullRequestListPage';
import PullRequestDetailPage from './pages/PullRequestDetailPage';
import InterventionsPage from './pages/InterventionsPage';
import TicketsPage from './pages/TicketsPage';
import LoginPage from './pages/LoginPage';
import OnboardingAccountPage from './pages/OnboardingAccountPage';
import OnboardingHealthPage from './pages/OnboardingHealthPage';
import OnboardingRepositoryPage from './pages/OnboardingRepositoryPage';
import OnboardingFirstWorkflowPage from './pages/OnboardingFirstWorkflowPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import ForbiddenPage from './pages/ForbiddenPage';
import ProtectedRoute from './components/auth/ProtectedRoute';
import { ToastProvider } from './components/common/Toast';

const router = createBrowserRouter([
  { path: '/onboarding', element: <Navigate to="/onboarding/account" replace /> },
  { path: '/onboarding/account', element: <OnboardingAccountPage /> },
  { path: '/onboarding/health', element: <OnboardingHealthPage /> },
  { path: '/onboarding/repository', element: <OnboardingRepositoryPage /> },
  { path: '/onboarding/first-workflow', element: <OnboardingFirstWorkflowPage /> },
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
          { path: 'workflows/:id', element: <WorkflowDetailPage /> },
          { path: 'workflows/:id/edit', element: <WorkflowBuilderPage /> },
          { path: 'repos', element: <Navigate to="/agents?section=repos" replace /> },
          { path: 'learnings', element: <Navigate to="/settings/learnings" replace /> },
          { path: 'executions', element: <ExecutionListPage /> },
          { path: 'executions/:id', element: <ExecutionDetailPage /> },
          { path: 'agents', element: <RoleManagerPage /> },
          { path: 'teams', element: <Navigate to="/agents" replace /> },
          { path: 'chats', element: <ThreadsPage /> },
          { path: 'threads', element: <Navigate to="/chats" replace /> },
          { path: 'chat', element: <ChatPage /> },
          { path: 'chat/:sessionId', element: <ChatPage /> },
          { path: 'workspaces', element: <WorkspaceListPage /> },
          { path: 'workspaces/:id', element: <WorkspaceListPage /> },
          { path: 'pull-requests', element: <PullRequestListPage /> },
          { path: 'pull-requests/:id', element: <PullRequestDetailPage /> },
          { path: 'crons', element: <Navigate to="/settings/schedules" replace /> },
          { path: 'tickets', element: <TicketsPage /> },
          { path: 'monitoring', element: <Navigate to="/settings/analytics" replace /> },
          { path: 'interventions', element: <InterventionsPage /> },
          { path: 'interventions/:id', element: <InterventionsPage /> },
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
