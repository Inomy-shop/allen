import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig(({ mode }) => {
  // Load .env from monorepo root
  const env = loadEnv(mode, resolve(__dirname, '../..'), '');
  const apiPort = env.PORT || '4000';
  const uiPort = parseInt(env.UI_PORT || '5173', 10);
  const wsPort = env.TERMINAL_WS_PORT || String(parseInt(apiPort) + 1);

  return {
    plugins: [react()],
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
      proxy: {
        '/api': {
          target: `http://localhost:${apiPort}`,
          changeOrigin: true,
        },
        '/ws': {
          target: `http://localhost:${wsPort}`,
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});
