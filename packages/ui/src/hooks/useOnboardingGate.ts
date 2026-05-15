import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { system } from '../services/api';

type OnboardingStep = 'health' | 'repository' | 'first_workflow';

export function useOnboardingGate(step: OnboardingStep): boolean {
  const navigate = useNavigate();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      setChecking(true);
      try {
        const status = await system.onboardingStatus();
        if (cancelled) return;
        if (status.isFirstRun) {
          navigate('/onboarding/account', { replace: true });
          return;
        }

        const progress = await system.onboardingProgress();
        if (cancelled) return;
        if (progress.complete) {
          navigate('/', { replace: true });
          return;
        }

        await system.updateOnboardingProgress({ step }).catch(() => {});
      } finally {
        if (!cancelled) setChecking(false);
      }
    }

    void check();
    return () => { cancelled = true; };
  }, [navigate, step]);

  return checking;
}
