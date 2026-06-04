import { defineConfig } from 'vitest/config';

export default defineConfig({
  css: {
    // Disable PostCSS processing in tests to avoid missing tailwindcss dep
    postcss: { plugins: [] },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: false,
    testTimeout: 10000,
  },
});
