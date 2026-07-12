import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // FinOS Perspective ships WASM + a module worker: it needs top-level-await
  // output and must not be pre-bundled by esbuild (breaks its asset URLs).
  build: { target: 'esnext' },
  optimizeDeps: {
    exclude: ['@finos/perspective', '@finos/perspective-viewer', '@finos/perspective-viewer-datagrid'],
    // chroma-js is CJS; the excluded datagrid plugin imports it, so it still
    // needs esbuild's CJS→ESM interop.
    include: ['@finos/perspective-viewer-datagrid > chroma-js'],
  },
});
