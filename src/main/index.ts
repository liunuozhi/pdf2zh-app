/**
 * Electron main process entry point.
 */
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { registerIpcHandlers } from './ipc-handlers';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
const viewerPayloads = new Map<number, { fileId: string; translationData: any }>();

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

export function getViewerPayload(windowId: number) {
  return viewerPayloads.get(windowId) ?? null;
}

export function createViewerWindow(payload: { fileId: string; translationData: any }): BrowserWindow {
  const viewerWindow = new BrowserWindow({
    width: 1500,
    height: 1000,
    minWidth: 900,
    minHeight: 600,
    title: 'pdf2zh - Viewer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  viewerPayloads.set(viewerWindow.id, payload);
  viewerWindow.on('closed', () => {
    viewerPayloads.delete(viewerWindow.id);
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    viewerWindow.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}/viewer.html`);
  } else {
    viewerWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/viewer.html`)
    );
  }

  return viewerWindow;
}

const createMainWindow = () => {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 600,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    );
  }
};

app.on('ready', () => {
  registerIpcHandlers();
  createMainWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});
