import {
  isSelectionCardViewModel,
  type SelectionCardViewModel
} from '@desktop-translate/contracts/selection-card';
import { SELECTION_CARD_CHANNELS } from '../shared/selection-card-channels.js';
import type { IpcRendererBridgePort } from './bridge.js';

export type SelectionCardChangedListener = (value: SelectionCardViewModel | undefined) => void;

export interface SelectionCardRendererBridge {
  getCurrent(): Promise<SelectionCardViewModel | undefined>;
  dismiss(): Promise<void>;
  retry(): Promise<void>;
  onChanged(listener: SelectionCardChangedListener): () => void;
}

function isOptionalCard(value: unknown): value is SelectionCardViewModel | undefined {
  return value === undefined || isSelectionCardViewModel(value);
}

export function createSelectionCardRendererBridge(
  ipc: IpcRendererBridgePort
): SelectionCardRendererBridge {
  return Object.freeze({
    async getCurrent() {
      const value = await ipc.invoke(SELECTION_CARD_CHANNELS.getCurrent);
      if (!isOptionalCard(value)) throw new Error('Main returned an invalid selection card');
      return value;
    },
    async dismiss() {
      const result = await ipc.invoke(SELECTION_CARD_CHANNELS.dismiss);
      if (result !== undefined) throw new Error('Main returned an unexpected card response');
    },
    async retry() {
      const result = await ipc.invoke(SELECTION_CARD_CHANNELS.retry);
      if (result !== undefined) throw new Error('Main returned an unexpected card response');
    },
    onChanged(listener: SelectionCardChangedListener) {
      if (typeof listener !== 'function') throw new TypeError('Card listener must be a function');
      const wrapped = (_event: unknown, value: unknown): void => {
        if (isOptionalCard(value)) listener(value);
      };
      ipc.on(SELECTION_CARD_CHANNELS.changed, wrapped);
      return () => ipc.removeListener(SELECTION_CARD_CHANNELS.changed, wrapped);
    }
  });
}
