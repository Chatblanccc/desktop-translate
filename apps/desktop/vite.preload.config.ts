import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => {
  const role = mode === 'settings' ? 'settings' : mode === 'card' ? 'card' : 'ball';

  return {
    build: {
      ssr: true,
      outDir: '.vite/build',
      emptyOutDir: false,
      rollupOptions: {
        input: {
          [`${role}-preload`]: resolve(__dirname, `src/preload/${role}.ts`)
        },
        external: ['electron'],
        output: {
          entryFileNames: '[name].cjs',
          format: 'cjs',
          // Sandboxed Electron preloads cannot require arbitrary local chunks.
          // Build each role independently so every preload is self-contained.
          codeSplitting: false
        }
      },
      sourcemap: true,
      target: 'node22'
    }
  };
});
