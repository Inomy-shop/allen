import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    __ALLEN_APP_VERSION__: JSON.stringify('0.1.9'),
  },
  css: {
    // Disable PostCSS processing in tests to avoid missing tailwindcss dep
    postcss: { plugins: [] },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: true,
    testTimeout: 10000,
    setupFiles: ['./src/test-setup.ts'],
  },
});
