import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const testHooksEnabled = process.env.DESKTOP_TRANSLATE_BUILD_FLAVOR !== 'production';

export default defineConfig({
  define: {
    __DESKTOP_TRANSLATE_TEST_HOOKS__: JSON.stringify(testHooksEnabled)
  },
  ssr: {
    noExternal: [
      '@desktop-translate/application',
      '@desktop-translate/contracts',
      '@desktop-translate/storage',
      '@desktop-translate/translation'
    ]
  },
  build: {
    ssr: true,
    outDir: '.vite/build',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/main/index.ts'),
        'local-data-reset-helper': resolve(__dirname, 'src/main/local-data-reset-helper.ts')
      },
      external: ['electron'],
      output: {
        entryFileNames: '[name].js',
        format: 'es'
      }
    },
    sourcemap: true,
    target: 'node22'
  }
});
