/**
 * IPC channel registration for the main process.
 */
import { ipcMain, dialog, shell, BrowserWindow, app, net } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { getModels, completeSimple } from '@mariozechner/pi-ai';
import { resolveModel } from './pipeline/translator/llm';
import { runPipeline, runTranslatePhase, getAssetPath } from './pipeline';
import { AppSettings, DEFAULT_SETTINGS, TranslatedRegion } from './pipeline/types';
import { NodeCanvasFactory, renderPageToBase64Png } from './pipeline/page-renderer';
import { writePdf } from './pipeline/pdf-writer';
import { createCanvas } from 'canvas';
import { createViewerWindow, getMainWindow, getViewerPayload } from './index';

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

  // Test LLM connection: small ping call, returns ok/error + latency
  ipcMain.handle('test-llm-connection', async (_event, settings: AppSettings) => {
    const provider = settings.llmProvider || 'openai';
    const modelId = settings.llmModel;
    if (!modelId) return { ok: false, message: 'No model selected' };

    let model: any;
    try {
      model = resolveModel(provider, modelId, settings.llmBaseUrl?.trim());
    } catch (err: any) {
      return { ok: false, message: err?.message || String(err) };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const start = Date.now();
    try {
      await completeSimple(model, {
        systemPrompt: 'Reply with the single word: OK',
        messages: [{ role: 'user' as const, content: 'ping', timestamp: Date.now() }],
      }, {
        apiKey: settings.llmApiToken || undefined,
        temperature: 0,
        maxTokens: 8,
        signal: controller.signal,
      });
      return { ok: true, message: 'Connected', latencyMs: Date.now() - start };
    } catch (err: any) {
      const msg = controller.signal.aborted ? 'Timed out after 15s' : (err?.message || String(err));
      return { ok: false, message: msg };
    } finally {
      clearTimeout(timeout);
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

  // Open file dialog (multi-selection)
  ipcMain.handle('open-file-dialog', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths;
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

  // Translate PDF — runs stages 1-5 and returns translation data for the editor
  ipcMain.handle('translate-pdf', async (event, inputPath: string, selectedPages?: number[], customPrompt?: string) => {
    abortFlag = { aborted: false };
    const settings = loadSettings();
    const win = BrowserWindow.fromWebContents(event.sender);

    try {
      const translationData = await runTranslatePhase({
        inputPath,
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

      return { success: true, translationData };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  });

  // Cancel translation
  ipcMain.on('cancel-translation', () => {
    abortFlag.aborted = true;
  });

  // Get a single page image for the region editor (lazy loading)
  let editorPdfDoc: any = null;
  let editorPdfPath: string | null = null;

  ipcMain.handle('get-editor-page-image', async (_event, inputPath: string, pageNumber: number, targetWidth: number) => {
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

    // Cache the opened PDF document between calls for the same file
    if (editorPdfPath !== inputPath || !editorPdfDoc) {
      if (editorPdfDoc) {
        editorPdfDoc.destroy();
      }
      const loadingTask = pdfjsLib.getDocument({
        url: inputPath,
        useSystemFonts: true,
        CanvasFactory: NodeCanvasFactory,
      });
      editorPdfDoc = await loadingTask.promise;
      editorPdfPath = inputPath;
    }

    const page = await editorPdfDoc.getPage(pageNumber);
    const result = await renderPageToBase64Png(page, targetWidth);
    page.cleanup();
    return result;
  });

  // Export PDF with modified regions from the editor
  ipcMain.handle('export-pdf', async (_event, inputPath: string, serializedRegions: [number, TranslatedRegion[]][]) => {
    try {
      // Reconstruct Map from serialized array
      const pageRegions = new Map<number, TranslatedRegion[]>(serializedRegions);

      // Font paths
      const fontPath = getAssetPath('fonts/NotoSansSC-Regular.ttf');
      const boldFontPath = getAssetPath('fonts/NotoSansSC-Bold.ttf');

      // Determine output path
      const ext = path.extname(inputPath);
      const base = path.basename(inputPath, ext);
      const tempOutput = path.join(os.tmpdir(), `${base}_translated${ext}`);
      const preferredOutput = path.join(path.dirname(inputPath), `${base}_translated${ext}`);

      await writePdf(inputPath, tempOutput, pageRegions, fontPath, boldFontPath);

      let outputPath: string;
      try {
        fs.copyFileSync(tempOutput, preferredOutput);
        outputPath = preferredOutput;
        fs.unlinkSync(tempOutput);
      } catch {
        outputPath = tempOutput;
      }

      return { success: true, outputPath };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
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

  // Open the result viewer in a separate BrowserWindow.
  // The payload is stashed by window id; the viewer renderer fetches it via 'viewer-get-data'.
  ipcMain.handle('open-viewer-window', (_event, payload: { fileId: string; translationData: any }) => {
    const win = createViewerWindow(payload);
    return win.id;
  });

  // Viewer renderer fetches its initial data on load.
  ipcMain.handle('viewer-get-data', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    return getViewerPayload(win.id);
  });

  // Viewer notifies main window that an export completed.
  ipcMain.on('viewer-notify-export', (_event, fileId: string, outputPath: string) => {
    const main = getMainWindow();
    if (main) {
      main.webContents.send('viewer-export-done', { fileId, outputPath });
    }
  });

  // Viewer notifies main window of edited regions on close.
  ipcMain.on('viewer-notify-close', (_event, fileId: string, updatedRegions: [number, TranslatedRegion[]][]) => {
    const main = getMainWindow();
    if (main) {
      main.webContents.send('viewer-closed', { fileId, updatedRegions });
    }
  });
}
