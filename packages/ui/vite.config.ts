import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { readFileSync } from 'fs';

const rootPackage = JSON.parse(
  readFileSync(resolve(__dirname, '../../package.json'), 'utf8'),
) as { version?: string };

export default defineConfig(({ mode }) => {
  // Load .env from monorepo root
  const env = loadEnv(mode, resolve(__dirname, '../..'), '');
  const apiPort = env.PORT || '4000';
  const uiPort = parseInt(env.UI_PORT || '5173', 10);
  const wsPort = env.TERMINAL_WS_PORT || String(parseInt(apiPort) + 1);

  return {
    plugins: [react()],
    define: {
      __ALLEN_APP_VERSION__: JSON.stringify(rootPackage.version ?? '0.0.0'),
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
    },
    build: {
      chunkSizeWarningLimit: 600,
      rollupOptions: {
        output: {
          manualChunks: {
            mermaid: ['mermaid'],
            monaco: ['@monaco-editor/react'],
            reactflow: ['@xyflow/react'],
          },
        },
      },
    },
    server: {
      port: uiPort,
      hmr: uiPort !== 5173 ? false : undefined,
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${apiPort}`,
          changeOrigin: true,
        },
        '/ws': {
          target: `http://127.0.0.1:${wsPort}`,
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});
