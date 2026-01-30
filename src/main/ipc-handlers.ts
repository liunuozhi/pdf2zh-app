/**
 * IPC channel registration for the main process.
 */
import { ipcMain, dialog, shell, BrowserWindow, app, net } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { getModels } from '@mariozechner/pi-ai';
import { runPipeline } from './pipeline';
import { AppSettings, DEFAULT_SETTINGS } from './pipeline/types';
import { NodeCanvasFactory } from './pipeline/page-renderer';
import { createCanvas } from 'canvas';

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

const SETTINGS_FILE = 'pdf2zh-settings.json';
let abortFlag = { aborted: false };

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), SETTINGS_FILE);
}

function loadSettings(): AppSettings {
  try {
    const data = fs.readFileSync(getSettingsPath(), 'utf-8');
    return { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings: AppSettings): void {
  fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2));
}

export function registerIpcHandlers(): void {
  // List models for a provider
  ipcMain.handle('list-models', (_event, provider: string) => {
    try {
      const models = getModels(provider as any);
      return models.map((m: any) => m.id);
    } catch {
      return [];
    }
  });

  // Get settings
  ipcMain.handle('get-settings', () => {
    return loadSettings();
  });

  // Save settings
  ipcMain.handle('save-settings', (_event, settings: AppSettings) => {
    saveSettings(settings);
    return true;
  });

  // Open file dialog
  ipcMain.handle('open-file-dialog', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // Get PDF page thumbnails
  ipcMain.handle('get-pdf-thumbnails', async (_event, filePath: string) => {
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = pdfjsLib.getDocument({
      url: filePath,
      useSystemFonts: true,
      CanvasFactory: NodeCanvasFactory,
    });
    const pdfDocument = await loadingTask.promise;
    const pageCount = pdfDocument.numPages;
    const thumbnails: string[] = [];
    const THUMB_WIDTH = 200;

    for (let i = 1; i <= pageCount; i++) {
      const page = await pdfDocument.getPage(i);
      const vp = page.getViewport({ scale: 1.0 });
      const scale = THUMB_WIDTH / vp.width;
      const scaledVp = page.getViewport({ scale });
      const width = Math.floor(scaledVp.width);
      const height = Math.floor(scaledVp.height);

      const canvas = createCanvas(width, height);
      const context = canvas.getContext('2d');
      await page.render({ canvasContext: context, viewport: scaledVp } as any).promise;

      const pngBuffer = canvas.toBuffer('image/png');
      thumbnails.push(`data:image/png;base64,${pngBuffer.toString('base64')}`);
      page.cleanup();
    }

    pdfDocument.destroy();
    return { pageCount, thumbnails };
  });

  // Translate PDF
  ipcMain.handle('translate-pdf', async (event, inputPath: string, selectedPages?: number[], customPrompt?: string) => {
    abortFlag = { aborted: false };
    const settings = loadSettings();

    // Generate output path in temp dir (always writable), then copy to final location
    const ext = path.extname(inputPath);
    const base = path.basename(inputPath, ext);
    const tempOutput = path.join(os.tmpdir(), `${base}_translated${ext}`);
    // Try writing next to input first; fall back to temp dir
    const preferredOutput = path.join(path.dirname(inputPath), `${base}_translated${ext}`);
    let outputPath: string;

    const win = BrowserWindow.fromWebContents(event.sender);

    try {
      // Write to temp first to avoid permission issues
      const pipelineResult = await runPipeline({
        inputPath,
        outputPath: tempOutput,
        settings,
        selectedPages,
        customPrompt,
        abortSignal: abortFlag,
        onProgress: (progress) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send('translation-progress', progress);
          }
        },
      });

      // Try to copy to preferred location next to input
      try {
        fs.copyFileSync(tempOutput, preferredOutput);
        outputPath = preferredOutput;
        fs.unlinkSync(tempOutput);
      } catch {
        // Permission denied — keep temp path
        outputPath = tempOutput;
      }

      return { success: true, outputPath, usage: pipelineResult.usage };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  });

  // Cancel translation
  ipcMain.on('cancel-translation', () => {
    abortFlag.aborted = true;
  });

  // Open file in system viewer
  ipcMain.handle('open-file', (_event, filePath: string) => {
    return shell.openPath(filePath);
  });

  // Open folder containing file
  ipcMain.handle('open-folder', (_event, filePath: string) => {
    shell.showItemInFolder(filePath);
  });

  // Get app version
  ipcMain.handle('get-app-version', () => {
    return app.getVersion();
  });

  // Check for updates via GitHub Releases API
  ipcMain.handle('check-for-updates', async () => {
    const currentVersion = app.getVersion();
    try {
      const response = await net.fetch(
        'https://api.github.com/repos/liunuozhi/pdf2zh-app/releases/latest',
        { headers: { 'User-Agent': 'pdf2zh-app' } }
      );
      if (!response.ok) {
        return { currentVersion, latestVersion: currentVersion, isOutdated: false, releaseUrl: '' };
      }
      const data = await response.json() as { tag_name: string; html_url: string };
      const latestVersion = data.tag_name.replace(/^v/, '');
      const isOutdated = compareVersions(currentVersion, latestVersion) < 0;
      return { currentVersion, latestVersion, isOutdated, releaseUrl: data.html_url };
    } catch {
      return { currentVersion, latestVersion: currentVersion, isOutdated: false, releaseUrl: '' };
    }
  });

  // Open external URL in browser
  ipcMain.handle('open-external-url', (_event, url: string) => {
    return shell.openExternal(url);
  });
}
