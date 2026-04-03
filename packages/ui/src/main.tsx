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
      { path: 'executions', element: <ExecutionListPage /> },
      { path: 'executions/:id', element: <ExecutionDetailPage /> },
      { path: 'roles', element: <RoleManagerPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
