import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'src/preload/index.ts',
    outDir: '.vite/build',
    emptyOutDir: false,
    rollupOptions: {
      external: ['electron'],
      output: {
        entryFileNames: 'preload.cjs',
        format: 'cjs'
      }
    },
    sourcemap: true,
    target: 'node22'
  }
});
