import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { availableParallelism } from 'node:os';
import { webBuildIdentityPlugin, workerClosurePlugin, workerEntryFileName } from './tools/web-build.mjs';

export default defineConfig(({ command }) => ({
  base: './',
  // Production publishes the explicitly qualified public/native closure only.
  publicDir: command === 'build' ? false : 'public',
  plugins: [webBuildIdentityPlugin(), react()],
  worker: {
    format: 'es',
    plugins: () => [workerClosurePlugin()],
    // GitHub Pages cannot supply Service-Worker-Allowed. Keep the generic
    // offline worker at the application root so it can own project-subpath
    // navigations; the document worker keeps its content-addressed name.
    rolldownOptions: { output: { codeSplitting: false, entryFileNames: workerEntryFileName } },
  },
  // Keep file-heavy tool fixtures responsive on high-core developer machines.
  test: { include: ['tests/**/*.test.ts'], maxWorkers: Math.min(4, Math.max(1, availableParallelism() - 1)) },
  server: {
    // Only source/UI changes need development transforms. Large generated and
    // captured trees can exhaust watcher capacity and leave stale transforms.
    // Native publication is refreshed through generated/buildIdentity.ts.
    watch: { ignored: ['.build', '.tools', 'reference', 'native', 'test-results*', 'public/wasm']
      .flatMap(directory => [`**/${directory}`, `**/${directory}/**`]) },
  },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2023', sourcemap: true, rolldownOptions: { output: { codeSplitting: false } } },
  // Deliberately use the same unisolated environment as GitHub Pages.
}));
