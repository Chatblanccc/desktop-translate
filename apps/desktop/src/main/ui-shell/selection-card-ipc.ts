import type { SelectionCardViewModel } from '@desktop-translate/contracts/selection-card';
import { SELECTION_CARD_CHANNELS } from '../../shared/selection-card-channels.js';
import type { InvokeEventLike, IpcMainPort, WindowRole } from './ui-shell-ipc.js';

export interface SelectionCardIpcOptions {
  readonly ipcMain: IpcMainPort;
  readonly resolveRole: (event: InvokeEventLike) => WindowRole | undefined;
  readonly getCurrent: () => SelectionCardViewModel | undefined;
  readonly dismiss: () => void;
}

function assertCard(event: InvokeEventLike, resolveRole: SelectionCardIpcOptions['resolveRole']): void {
  if (
    event.senderFrame === null ||
    event.senderFrame !== event.sender.mainFrame ||
    resolveRole(event) !== 'card'
  ) {
    throw new Error('Selection card request rejected');
  }
}

export function registerSelectionCardIpc(options: SelectionCardIpcOptions): () => void {
  const { ipcMain, resolveRole } = options;
  ipcMain.handle(SELECTION_CARD_CHANNELS.getCurrent, (event, ...args) => {
    assertCard(event, resolveRole);
    if (args.length !== 0) throw new TypeError('Selection card request does not accept arguments');
    return options.getCurrent();
  });
  ipcMain.handle(SELECTION_CARD_CHANNELS.dismiss, (event, ...args) => {
    assertCard(event, resolveRole);
    if (args.length !== 0) throw new TypeError('Selection card request does not accept arguments');
    options.dismiss();
  });
  return () => {
    ipcMain.removeHandler(SELECTION_CARD_CHANNELS.getCurrent);
    ipcMain.removeHandler(SELECTION_CARD_CHANNELS.dismiss);
  };
}
