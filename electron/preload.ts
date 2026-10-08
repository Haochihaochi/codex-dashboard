import { contextBridge, ipcRenderer } from 'electron';
import type { DashboardAPI, DashboardState } from '../src/shared/types';
const api: DashboardAPI = {
  getState: () => ipcRenderer.invoke('dashboard:state'),
  refresh: () => ipcRenderer.invoke('dashboard:refresh'),
  updateSettings: (patch) => ipcRenderer.invoke('dashboard:settings', patch),
  saveManualUsage: (usage) => ipcRenderer.invoke('dashboard:manual', usage),
  chooseDirectory: (provider) => ipcRenderer.invoke('dashboard:directory', provider),
  exportData: () => ipcRenderer.invoke('dashboard:export'),
  openExternal: (target) => ipcRenderer.invoke('dashboard:external', target),
  showDashboard: () => ipcRenderer.invoke('dashboard:show'),
  onState: (callback) => {
    const listener = (_event: unknown, state: DashboardState) => callback(state);
    ipcRenderer.on('dashboard:changed', listener);
    return () => ipcRenderer.removeListener('dashboard:changed', listener);
  },
};
contextBridge.exposeInMainWorld('codexDashboard', api);
