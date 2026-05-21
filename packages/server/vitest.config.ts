import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    globals: false,
    testTimeout: 60000,
    hookTimeout: 120000,
    // mongodb-memory-server downloads a binary once and caches it. If two
    // test files boot it in parallel on a cold cache, they race on the
    // same download path. Keep files serial so there's at most one
    // downloader at a time — tests within a file still run fast.
    fileParallelism: false,
  },
});
