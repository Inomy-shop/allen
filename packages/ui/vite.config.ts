import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig(({ mode }) => {
  // Load .env from monorepo root
  const env = loadEnv(mode, resolve(__dirname, '../..'), '');
  const apiPort = env.PORT || '4000';

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
      port: 5173,
      proxy: {
        '/api': {
          target: `http://localhost:${apiPort}`,
          changeOrigin: true,
        },
        '/ws': {
          target: `http://localhost:4024`,
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});
