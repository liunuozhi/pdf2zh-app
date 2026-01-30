/**
 * Renderer entry point - wires up UI components to IPC API.
 */
import { initDropZone } from './components/drop-zone';
import { initProgressBar } from './components/progress-bar';
import { initSettingsPanel } from './components/settings-panel';
import { initFileList } from './components/file-list';

declare global {
  interface Window {
    electronAPI: {
      getSettings: () => Promise<any>;
      saveSettings: (settings: any) => Promise<boolean>;
      openFileDialog: () => Promise<string | null>;
      translatePdf: (inputPath: string, selectedPages?: number[], customPrompt?: string) => Promise<{
        success: boolean;
        outputPath?: string;
        error?: string;
        usage?: { inputTokens: number; outputTokens: number; totalCost: number };
      }>;
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
    };
  }
}

let currentOutputPath: string | null = null;
let pendingFilePath: string | null = null;
let selectedPages: number[] | null = null;

function init() {
  const api = window.electronAPI;

  // Initialize components
  initDropZone(handleFileSelect);
  initProgressBar();
  initSettingsPanel(api);
  initFileList();

  // Progress listener
  api.onProgress((_event, data) => {
    const progressSection = document.getElementById('progress-section')!;
    const progressStage = document.getElementById('progress-stage')!;
    const progressPages = document.getElementById('progress-pages')!;
    const progressBar = document.getElementById('progress-bar')!;

    progressSection.style.display = 'block';
    progressStage.textContent = data.stage;
    if (data.totalPages > 0) {
      progressPages.textContent = `Page ${data.currentPage} / ${data.totalPages}`;
    }
    progressBar.style.width = `${data.percent}%`;
  });

  // Cancel button
  document.getElementById('cancel-btn')!.addEventListener('click', () => {
    api.cancelTranslation();
  });

  // Translate button
  document.getElementById('translate-btn')!.addEventListener('click', () => {
    if (pendingFilePath) {
      handleFile(pendingFilePath);
    }
  });

  // Select Pages button
  document.getElementById('select-pages-btn')!.addEventListener('click', async () => {
    if (!pendingFilePath) return;
    const selectBtn = document.getElementById('select-pages-btn')!;
    selectBtn.textContent = 'Loading...';
    selectBtn.setAttribute('disabled', '');

    try {
      const { pageCount, thumbnails } = await api.getPdfThumbnails(pendingFilePath);
      openPageSelectModal(pageCount, thumbnails);
    } finally {
      selectBtn.textContent = selectedPages ? `${selectedPages.length} Pages` : 'Select Pages';
      selectBtn.removeAttribute('disabled');
    }
  });

  // Modal buttons
  document.getElementById('modal-cancel')!.addEventListener('click', closePageSelectModal);
  document.getElementById('modal-confirm')!.addEventListener('click', confirmPageSelection);
  document.getElementById('modal-toggle-all')!.addEventListener('click', toggleAllPages);

  // Close modal on overlay click
  document.getElementById('page-select-modal')!.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closePageSelectModal();
  });

  // Output buttons
  document.getElementById('open-file-btn')!.addEventListener('click', () => {
    if (currentOutputPath) api.openFile(currentOutputPath);
  });
  document.getElementById('open-folder-btn')!.addEventListener('click', () => {
    if (currentOutputPath) api.openFolder(currentOutputPath);
  });

  // Version info & update check
  const versionLabel = document.getElementById('version-label');
  const updateLink = document.getElementById('update-link') as HTMLAnchorElement | null;

  api.getAppVersion().then((version) => {
    if (versionLabel) versionLabel.textContent = `v${version}`;
  });

  api.checkForUpdates().then((info) => {
    if (info.isOutdated && updateLink) {
      updateLink.textContent = `Update available: v${info.latestVersion}`;
      updateLink.style.display = 'inline-block';
      updateLink.addEventListener('click', (e) => {
        e.preventDefault();
        api.openExternalUrl(info.releaseUrl);
      });
    }
  });
}

function openPageSelectModal(pageCount: number, thumbnails: string[]) {
  const modal = document.getElementById('page-select-modal')!;
  const grid = document.getElementById('modal-grid')!;
  grid.innerHTML = '';

  for (let i = 0; i < pageCount; i++) {
    const pageNum = i + 1;
    const isSelected = !selectedPages || selectedPages.includes(pageNum);

    const thumb = document.createElement('div');
    thumb.className = `page-thumb${isSelected ? ' selected' : ''}`;
    thumb.dataset.page = String(pageNum);
    thumb.innerHTML = `
      <img src="${thumbnails[i]}" alt="Page ${pageNum}" />
      <div class="page-thumb-label">
        <input type="checkbox" ${isSelected ? 'checked' : ''} />
        <span>${pageNum}</span>
      </div>
    `;

    thumb.addEventListener('click', () => {
      const cb = thumb.querySelector('input[type="checkbox"]') as HTMLInputElement;
      cb.checked = !cb.checked;
      thumb.classList.toggle('selected', cb.checked);
    });

    grid.appendChild(thumb);
  }

  updateToggleAllButton();
  modal.style.display = 'flex';
}

function closePageSelectModal() {
  document.getElementById('page-select-modal')!.style.display = 'none';
}

function confirmPageSelection() {
  const thumbs = document.querySelectorAll('#modal-grid .page-thumb');
  const pages: number[] = [];
  thumbs.forEach((thumb) => {
    const cb = thumb.querySelector('input[type="checkbox"]') as HTMLInputElement;
    if (cb.checked) {
      pages.push(Number((thumb as HTMLElement).dataset.page));
    }
  });

  const totalThumbs = thumbs.length;
  if (pages.length === totalThumbs || pages.length === 0) {
    // All selected or none → translate all
    selectedPages = null;
  } else {
    selectedPages = pages.sort((a, b) => a - b);
  }

  const selectBtn = document.getElementById('select-pages-btn')!;
  if (selectedPages) {
    selectBtn.textContent = `${selectedPages.length} Pages`;
    selectBtn.classList.add('has-selection');
  } else {
    selectBtn.textContent = 'Select Pages';
    selectBtn.classList.remove('has-selection');
  }

  closePageSelectModal();
}

function toggleAllPages() {
  const thumbs = document.querySelectorAll('#modal-grid .page-thumb');
  const allChecked = Array.from(thumbs).every((t) =>
    (t.querySelector('input[type="checkbox"]') as HTMLInputElement).checked
  );

  thumbs.forEach((thumb) => {
    const cb = thumb.querySelector('input[type="checkbox"]') as HTMLInputElement;
    cb.checked = !allChecked;
    thumb.classList.toggle('selected', !allChecked);
  });

  updateToggleAllButton();
}

function updateToggleAllButton() {
  const thumbs = document.querySelectorAll('#modal-grid .page-thumb');
  const allChecked = Array.from(thumbs).every((t) =>
    (t.querySelector('input[type="checkbox"]') as HTMLInputElement).checked
  );
  document.getElementById('modal-toggle-all')!.textContent = allChecked ? 'Deselect All' : 'Select All';
}

function handleFileSelect(filePath: string) {
  pendingFilePath = filePath;
  selectedPages = null;
  document.getElementById('select-pages-btn')!.textContent = 'Select Pages';
  document.getElementById('select-pages-btn')!.classList.remove('has-selection');

  // Show file name in file list
  const fileList = document.getElementById('file-list')!;
  fileList.style.display = 'block';
  fileList.innerHTML = `<div class="file-item"><span class="filename">${filePath.split('/').pop() || filePath}</span><span>Ready</span></div>`;

  // Show translate button
  document.getElementById('translate-actions')!.style.display = 'block';

  // Hide previous output
  document.getElementById('output-section')!.style.display = 'none';
  document.getElementById('progress-section')!.style.display = 'none';
}

async function handleFile(filePath: string) {
  const api = window.electronAPI;

  // Hide translate button during translation
  document.getElementById('translate-actions')!.style.display = 'none';

  // Show progress, hide output
  document.getElementById('progress-section')!.style.display = 'block';
  document.getElementById('output-section')!.style.display = 'none';
  document.getElementById('cancel-btn')!.style.display = 'inline-block';

  // Reset progress
  document.getElementById('progress-stage')!.textContent = 'Starting...';
  document.getElementById('progress-pages')!.textContent = '';
  document.getElementById('progress-bar')!.style.width = '0%';

  // Update file list
  const fileList = document.getElementById('file-list')!;
  fileList.style.display = 'block';
  fileList.innerHTML = `<div class="file-item"><span class="filename">${filePath.split('/').pop() || filePath}</span><span>Processing...</span></div>`;

  const customPrompt = (document.getElementById('llm-custom-prompt') as HTMLTextAreaElement)?.value || undefined;
  const result = await api.translatePdf(filePath, selectedPages ?? undefined, customPrompt);

  document.getElementById('cancel-btn')!.style.display = 'none';

  const outputSection = document.getElementById('output-section')!;
  const outputMessage = document.getElementById('output-message')!;

  if (result.success && result.outputPath) {
    currentOutputPath = result.outputPath;
    outputSection.style.display = 'block';
    let msg = `Translation complete! Saved to: ${result.outputPath.split('/').pop()}`;
    if (result.usage && (result.usage.inputTokens > 0 || result.usage.outputTokens > 0)) {
      const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
      msg += `\nTokens: ${fmt(result.usage.inputTokens)} in / ${fmt(result.usage.outputTokens)} out`;
      if (result.usage.totalCost > 0) {
        msg += ` · Cost: $${result.usage.totalCost.toFixed(4)}`;
      }
    }
    outputMessage.textContent = msg;
    fileList.innerHTML = `<div class="file-item"><span class="filename">${filePath.split('/').pop()}</span><span style="color: green;">Done</span></div>`;
  } else {
    outputSection.style.display = 'block';
    outputMessage.textContent = `Error: ${result.error || 'Unknown error'}`;
    document.getElementById('open-file-btn')!.style.display = 'none';
    document.getElementById('open-folder-btn')!.style.display = 'none';
    fileList.innerHTML = `<div class="file-item"><span class="filename">${filePath.split('/').pop()}</span><span style="color: red;">Failed</span></div>`;
  }

  // Re-show translate button for re-translation
  document.getElementById('translate-actions')!.style.display = 'block';
}

document.addEventListener('DOMContentLoaded', init);
