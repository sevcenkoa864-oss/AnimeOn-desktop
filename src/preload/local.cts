// Preload for the app's own local pages only (shell + settings). The animeon.cc view gets no preload.
import { contextBridge, ipcRenderer } from 'electron';
import type { ShellState } from '../main/main.js' with { 'resolution-mode': 'import' };
import type { Settings } from '../main/store.js' with { 'resolution-mode': 'import' };

const api = {
  platform: process.platform,
  getShellState: (): Promise<ShellState> => ipcRenderer.invoke('shell:state'),
  onShellState: (cb: (s: ShellState) => void): void => {
    ipcRenderer.on('shell:state', (_e, s: ShellState) => cb(s));
  },
  retry: (): void => ipcRenderer.send('shell:retry'),

  getSettings: (): Promise<{ settings: Settings; version: string }> => ipcRenderer.invoke('settings:get'),
  onSettingsChanged: (cb: (s: Settings) => void): void => {
    ipcRenderer.on('settings:changed', (_e, s: Settings) => cb(s));
  },
  setSetting: <K extends keyof Settings>(key: K, value: Settings[K]): Promise<Settings> =>
    ipcRenderer.invoke('settings:set', key, value),
  clearData: (): Promise<boolean> => ipcRenderer.invoke('data:clear'),
  relaunch: (): Promise<void> => ipcRenderer.invoke('app:relaunch'),
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
