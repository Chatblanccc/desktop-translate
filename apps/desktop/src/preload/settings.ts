import { contextBridge, ipcRenderer } from 'electron';
import { createSettingsRendererBridge } from './bridge.js';

contextBridge.exposeInMainWorld(
  'desktopTranslateSettings',
  createSettingsRendererBridge(ipcRenderer)
);
