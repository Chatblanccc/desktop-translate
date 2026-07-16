import { contextBridge, ipcRenderer } from 'electron';
import { createBallRendererBridge } from './bridge.js';

contextBridge.exposeInMainWorld('desktopTranslateBall', createBallRendererBridge(ipcRenderer));
