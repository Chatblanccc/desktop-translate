import { defineConfig } from 'vite';

export default defineConfig({
  ssr: {
    noExternal: [
      '@desktop-translate/application',
      '@desktop-translate/contracts',
      '@desktop-translate/storage',
      '@desktop-translate/translation'
    ]
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
