import { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { system } from '../../services/api';

const ONBOARDING_STEP_PATHS: Record<string, string> = {
  health: '/onboarding/health',
  repository: '/onboarding/repository',
  first_workflow: '/onboarding/first-workflow',
};

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
  const [onboardingPath, setOnboardingPath] = useState<string | null>(null);
  const [checkingOnboarding, setCheckingOnboarding] = useState(true);

  useEffect(() => {
    if (!hydrated) hydrate();
  }, [hydrated, hydrate]);

  useEffect(() => {
    const eligible = hydrated
      && Boolean(refreshToken)
      && Boolean(user)
      && !user?.mustResetPassword
      && (!adminOnly || user?.role === 'admin');
    if (!eligible) {
      setCheckingOnboarding(false);
      setOnboardingPath(null);
      return;
    }

    let cancelled = false;
    setCheckingOnboarding(true);
    system.onboardingProgress()
      .then(progress => {
        if (cancelled) return;
        if (progress.complete) {
          setOnboardingPath(null);
          return;
        }
        setOnboardingPath(ONBOARDING_STEP_PATHS[progress.step] ?? '/onboarding/health');
      })
      .catch(() => {
        if (!cancelled) setOnboardingPath(null);
      })
      .finally(() => {
        if (!cancelled) setCheckingOnboarding(false);
      });
    return () => { cancelled = true; };
  }, [adminOnly, hydrated, location.pathname, refreshToken, user]);

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

  if (checkingOnboarding) return null;

  if (onboardingPath) {
    return <Navigate to={onboardingPath} replace />;
  }

  return <Outlet />;
}
