import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'artifacts/coverage',
      include: [
        // This Vitest project owns desktop runtime coverage. Workspace packages
        // use their node:test contract suites and remain part of the preceding
        // `pnpm test` gate; including unexecuted package sources here would turn
        // the desktop percentage into a misleading cross-runner denominator.
        'src/main/**/*.ts',
        'src/preload/**/*.ts',
        'src/renderer/**/*.ts',
        'src/renderer/**/*.tsx'
      ],
      exclude: [
        'src/main/index.ts',
        'src/main/phase1-smoke.ts',
        'src/main/phase3-smoke.ts',
        'src/main/phase4-smoke.ts',
        'src/renderer/**/main.tsx',
        'src/renderer/global.d.ts'
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
        'src/main/**/*.ts': {
          lines: 90,
          functions: 90,
          branches: 85,
          statements: 90
        },
        'src/preload/**/*.ts': {
          lines: 90,
          functions: 90,
          branches: 85,
          statements: 90
        },
        'src/renderer/**/*.{ts,tsx}': {
          lines: 80,
          functions: 80,
          branches: 75,
          statements: 80
        }
      }
    }
  }
});
