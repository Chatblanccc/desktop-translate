import { readFileSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runStorageMigrations } from '@desktop-translate/storage';
import type { SelectionResult } from '@desktop-translate/contracts/native-ipc';
import type { SelectionCardViewModel } from '@desktop-translate/contracts/selection-card';
import type { TranslationProvider } from '@desktop-translate/translation';
import { describe, expect, it, vi } from 'vitest';
import { TranslationController } from './translation-controller.js';

const SOURCE_CANARY = 'PHASE4_SOURCE_CANARY_7f98562a';
const TRANSLATED_CANARY = 'PHASE4_TRANSLATED_CANARY_3be942d1';

const selection: SelectionResult = {
  selectionId: '123e4567-e89b-42d3-a456-426614174000',
  source: 'uia',
  text: SOURCE_CANARY,
  ranges: [{ start: 0, end: SOURCE_CANARY.length, text: SOURCE_CANARY }],
  confidence: 1,
  physicalRects: [{ x: 10, y: 20, width: 100, height: 20 }],
  releasePoint: { x: 110, y: 40 },
  monitor: {
    id: 'DISPLAY1',
    handle: '0x1234',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    dpiX: 96,
    dpiY: 96,
    scaleFactor: 1
  },
  target: { pid: '100', hwnd: '0xABCD', processName: 'notepad.exe' },
  coordinateSpace: 'physical-px',
  timestamp: '2026-07-16T12:00:00.000Z'
};

describe('Phase 4 translation persistence boundary', () => {
  it('never writes history, favorites, cache, source text, or translated text', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'desktop-translate-phase4-canary-'));
    const databasePath = join(directory, 'phase4.sqlite3');
    const database = new DatabaseSync(databasePath);
    let databaseClosed = false;
    try {
      runStorageMigrations(database, {
        migrationsDirectory: resolve(process.cwd(), '../../packages/storage/migrations')
      });
      const provider: TranslationProvider = {
        id: 'baidu',
        displayName: 'Baidu Translate',
        capabilities: {
          translation: true,
          languageDetection: true,
          dictionary: false,
          pronunciation: false,
          examples: false,
          maxTextLength: 6_000
        },
        translate: async (request, context) => ({
          requestId: request.requestId,
          selectionId: request.selectionId,
          originalText: request.text,
          translatedText: TRANSLATED_CANARY,
          detectedSourceLanguage: 'en',
          targetLanguage: request.targetLanguage,
          attribution: { providerId: 'baidu', providerDisplayName: 'Baidu Translate' },
          receivedAt: context.now().toISOString(),
          fromCache: false
        })
      };
      const cards: SelectionCardViewModel[] = [];
      const controller = new TranslationController({
        provider,
        getSettings: () => ({
          enabled: true,
          providerId: 'baidu',
          sourceLanguage: 'en',
          targetLanguage: 'zh-CN',
          credentialStatus: 'configured',
          consentVersion: 1
        }),
        presentCard: (card) => cards.push(card),
        hideCard: vi.fn(),
        createRequestId: () => '123e4567-e89b-42d3-a456-426614174100',
        now: () => new Date('2026-07-16T12:00:00.000Z')
      });

      controller.handleSelection(selection, { x: 1, y: 2, width: 380, height: 320 });
      await vi.waitFor(() => expect(cards.at(-1)?.kind).toBe('translated'));

      for (const table of ['translation_history', 'favorites', 'translation_cache'] as const) {
        const row = database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as unknown as {
          readonly count: number;
        };
        expect(row.count, `${table} must remain empty in Phase 4`).toBe(0);
      }

      database.close();
      databaseClosed = true;
      const databaseBytes = readFileSync(databasePath);
      expect(databaseBytes.includes(Buffer.from(SOURCE_CANARY, 'utf8'))).toBe(false);
      expect(databaseBytes.includes(Buffer.from(TRANSLATED_CANARY, 'utf8'))).toBe(false);
    } finally {
      if (!databaseClosed) database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
