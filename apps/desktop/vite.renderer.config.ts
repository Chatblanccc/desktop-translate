import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const desktopPackage = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf8')
) as { readonly version: string };

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(desktopPackage.version)
  },
  build: {
    outDir: resolve(__dirname, '.vite/renderer'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'chrome142',
    rollupOptions: {
      input: {
        ball: resolve(__dirname, 'src/renderer/ball/index.html'),
        card: resolve(__dirname, 'src/renderer/card/index.html'),
        settings: resolve(__dirname, 'src/renderer/settings/index.html')
      }
    }
  }
});
