import { contextBridge, ipcRenderer } from 'electron';
import { createSelectionCardRendererBridge } from './card-bridge.js';

contextBridge.exposeInMainWorld(
  'desktopTranslateCard',
  createSelectionCardRendererBridge(ipcRenderer)
);
