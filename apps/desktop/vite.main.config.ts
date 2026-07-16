import { defineConfig } from 'vite';

export default defineConfig({
  ssr: {
    noExternal: ['@desktop-translate/contracts', '@desktop-translate/storage']
  },
  build: {
    ssr: 'src/main/index.ts',
    outDir: '.vite/build',
    emptyOutDir: true,
    rollupOptions: {
      external: ['electron'],
      output: {
        entryFileNames: 'main.js',
        format: 'es'
      }
    },
    sourcemap: true,
    target: 'node22'
  }
});
