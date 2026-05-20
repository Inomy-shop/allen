export const DEFAULT_ONBOARDING_REPO = {
  url: 'https://github.com/Kalpai-poc/test-website',
  branch: 'main',
  name: 'test-website',
};

export const DEFAULT_ONBOARDING_BUG_REPORT = 'Change the readiness widget so a score of exactly 50 shows a custom message, and update the tests.';

export const DEFAULT_ONBOARDING_FEATURE_REQUEST = 'Add a small dark mode toggle to the test website and include tests for any new behavior.';

function normalizeRepoRef(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^git@github\.com:/, 'github.com/')
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
}

export function isDefaultOnboardingRepoUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  return normalizeRepoRef(trimmed) === normalizeRepoRef(DEFAULT_ONBOARDING_REPO.url);
}

export function isDefaultOnboardingRepo(repo: {
  name?: string;
  path?: string;
  url?: string;
  detected?: { remoteUrl?: string };
} | null | undefined): boolean {
  if (!repo) return false;
  if (repo.url && isDefaultOnboardingRepoUrl(repo.url)) return true;
  if (repo.detected?.remoteUrl && isDefaultOnboardingRepoUrl(repo.detected.remoteUrl)) return true;
  if (repo.name === DEFAULT_ONBOARDING_REPO.name) return true;
  return repo.path?.split('/').pop() === DEFAULT_ONBOARDING_REPO.name;
}
