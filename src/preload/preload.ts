/**
 * Preload script: exposes typed IPC API to renderer via contextBridge.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';

export interface ElectronAPI {
  getSettings: () => Promise<any>;
  saveSettings: (settings: any) => Promise<boolean>;
  openFileDialog: () => Promise<string | null>;
  translatePdf: (inputPath: string, selectedPages?: number[], customPrompt?: string) => Promise<{ success: boolean; outputPath?: string; error?: string; usage?: { inputTokens: number; outputTokens: number; totalCost: number } }>;
  cancelTranslation: () => void;
  getPdfThumbnails: (filePath: string) => Promise<{ pageCount: number; thumbnails: string[] }>;
  openFile: (filePath: string) => Promise<string>;
  openFolder: (filePath: string) => Promise<void>;
  onProgress: (callback: (event: any, data: any) => void) => () => void;
  getPathForFile: (file: File) => string;
  listModels: (provider: string) => Promise<string[]>;
  getAppVersion: () => Promise<string>;
  checkForUpdates: () => Promise<{ currentVersion: string; latestVersion: string; isOutdated: boolean; releaseUrl: string }>;
  openExternalUrl: (url: string) => Promise<void>;
}

const api: ElectronAPI = {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  translatePdf: (inputPath, selectedPages, customPrompt) => ipcRenderer.invoke('translate-pdf', inputPath, selectedPages, customPrompt),
  cancelTranslation: () => ipcRenderer.send('cancel-translation'),
  getPdfThumbnails: (filePath) => ipcRenderer.invoke('get-pdf-thumbnails', filePath),
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  openFolder: (filePath) => ipcRenderer.invoke('open-folder', filePath),
  onProgress: (callback) => {
    ipcRenderer.on('translation-progress', callback);
    return () => {
      ipcRenderer.removeListener('translation-progress', callback);
    };
  },
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  listModels: (provider: string) => ipcRenderer.invoke('list-models', provider),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  openExternalUrl: (url: string) => ipcRenderer.invoke('open-external-url', url),
};

contextBridge.exposeInMainWorld('electronAPI', api);
