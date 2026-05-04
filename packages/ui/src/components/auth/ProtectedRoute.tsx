import { useEffect } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';

/**
 * Guard for authenticated routes.
 *
 * - If no refresh token → redirect to /login?from=<current>
 * - If user has mustResetPassword → force /reset-password?from=<current>
 * - Otherwise render the child route. The access token is acquired lazily
 *   on the first API call (via the refresh flow in api.ts).
 */
export default function ProtectedRoute({ adminOnly = false }: { adminOnly?: boolean }) {
  const hydrated = useAuthStore((s) => s.hydrated);
  const hydrate = useAuthStore((s) => s.hydrate);
  const user = useAuthStore((s) => s.user);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const location = useLocation();

  useEffect(() => {
    if (!hydrated) hydrate();
  }, [hydrated, hydrate]);

  if (!hydrated) return null;

  if (!refreshToken || !user) {
    const from = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?from=${from}`} replace />;
  }

  if (user.mustResetPassword && location.pathname !== '/reset-password') {
    const from = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/reset-password?from=${from}`} replace />;
  }

  if (adminOnly && user.role !== 'admin') {
    return <Navigate to="/403" replace />;
  }

  return <Outlet />;
}
