/**
 * Preload script: exposes typed IPC API to renderer via contextBridge.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';

export interface ElectronAPI {
  getSettings: () => Promise<any>;
  saveSettings: (settings: any) => Promise<boolean>;
  openFileDialog: () => Promise<string[] | null>;
  translatePdf: (inputPath: string, selectedPages?: number[], customPrompt?: string) => Promise<{ success: boolean; translationData?: any; error?: string }>;
  cancelTranslation: () => void;
  getPdfThumbnails: (filePath: string) => Promise<{ pageCount: number; thumbnails: string[] }>;
  getEditorPageImage: (inputPath: string, pageNumber: number, targetWidth: number) => Promise<{ base64: string; width: number; height: number }>;
  exportPdf: (inputPath: string, pageRegions: [number, any[]][]) => Promise<{ success: boolean; outputPath?: string; error?: string }>;
  openFile: (filePath: string) => Promise<string>;
  openFolder: (filePath: string) => Promise<void>;
  onProgress: (callback: (event: any, data: any) => void) => () => void;
  getPathForFile: (file: File) => string;
  listModels: (provider: string) => Promise<string[]>;
  testLlmConnection: (settings: any) => Promise<{ ok: boolean; message: string; latencyMs?: number }>;
  getAppVersion: () => Promise<string>;
  checkForUpdates: () => Promise<{ currentVersion: string; latestVersion: string; isOutdated: boolean; releaseUrl: string }>;
  openExternalUrl: (url: string) => Promise<void>;
  // Viewer-window IPC
  openViewer: (payload: { fileId: string; translationData: any }) => Promise<number>;
  viewerGetData: () => Promise<{ fileId: string; translationData: any } | null>;
  viewerNotifyExport: (fileId: string, outputPath: string) => void;
  viewerNotifyClose: (fileId: string, updatedRegions: [number, any[]][]) => void;
  onViewerExportDone: (callback: (event: any, data: { fileId: string; outputPath: string }) => void) => () => void;
  onViewerClosed: (callback: (event: any, data: { fileId: string; updatedRegions: [number, any[]][] }) => void) => () => void;
}

const api: ElectronAPI = {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  translatePdf: (inputPath, selectedPages, customPrompt) => ipcRenderer.invoke('translate-pdf', inputPath, selectedPages, customPrompt),
  cancelTranslation: () => ipcRenderer.send('cancel-translation'),
  getPdfThumbnails: (filePath) => ipcRenderer.invoke('get-pdf-thumbnails', filePath),
  getEditorPageImage: (inputPath, pageNumber, targetWidth) => ipcRenderer.invoke('get-editor-page-image', inputPath, pageNumber, targetWidth),
  exportPdf: (inputPath, pageRegions) => ipcRenderer.invoke('export-pdf', inputPath, pageRegions),
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
  testLlmConnection: (settings) => ipcRenderer.invoke('test-llm-connection', settings),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  openExternalUrl: (url: string) => ipcRenderer.invoke('open-external-url', url),
  openViewer: (payload) => ipcRenderer.invoke('open-viewer-window', payload),
  viewerGetData: () => ipcRenderer.invoke('viewer-get-data'),
  viewerNotifyExport: (fileId, outputPath) => ipcRenderer.send('viewer-notify-export', fileId, outputPath),
  viewerNotifyClose: (fileId, updatedRegions) => ipcRenderer.send('viewer-notify-close', fileId, updatedRegions),
  onViewerExportDone: (callback) => {
    ipcRenderer.on('viewer-export-done', callback);
    return () => {
      ipcRenderer.removeListener('viewer-export-done', callback);
    };
  },
  onViewerClosed: (callback) => {
    ipcRenderer.on('viewer-closed', callback);
    return () => {
      ipcRenderer.removeListener('viewer-closed', callback);
    };
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);
