/**
 * Viewer window entry — runs in its own Electron BrowserWindow.
 * Owns the RegionEditor; receives translation data via IPC.
 * The Window.electronAPI type is declared in ./index.ts and shared via tsconfig.
 */
import { RegionEditor } from './components/region-editor';

async function init() {
  const api = window.electronAPI;
  const payload = await api.viewerGetData();

  if (!payload) {
    document.body.innerHTML = '<p style="padding:20px">No translation data available.</p>';
    return;
  }

  const { fileId, translationData } = payload;
  const editor = new RegionEditor();

  editor.open(
    translationData,
    (outputPath: string) => {
      api.viewerNotifyExport(fileId, outputPath);
      window.close();
    },
    (updatedRegions?: [number, any[]][]) => {
      if (updatedRegions) {
        api.viewerNotifyClose(fileId, updatedRegions);
      }
      window.close();
    }
  );
}

document.addEventListener('DOMContentLoaded', init);
