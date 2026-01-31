/**
 * Renderer entry point - wires up UI components to IPC API.
 */
import { initDropZone } from './components/drop-zone';
import { initProgressBar } from './components/progress-bar';
import { initSettingsPanel } from './components/settings-panel';

declare global {
  interface Window {
    electronAPI: {
      getSettings: () => Promise<any>;
      saveSettings: (settings: any) => Promise<boolean>;
      openFileDialog: () => Promise<string[] | null>;
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

interface FileEntry {
  path: string;
  name: string;
  selectedPages: number[] | null;
  status: 'ready' | 'processing' | 'done' | 'failed';
  outputPath?: string;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number; totalCost: number };
}

let files: FileEntry[] = [];
let activeFileIndex = 0;
let isTranslating = false;

function init() {
  const api = window.electronAPI;

  // Initialize components
  initDropZone(handleFilesSelect);
  initProgressBar();
  initSettingsPanel(api);

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
    if (files.length > 0 && !isTranslating) {
      handleTranslateAll();
    }
  });

  // Select Pages button — opens modal for active file
  document.getElementById('select-pages-btn')!.addEventListener('click', async () => {
    if (files.length === 0) return;
    const entry = files[activeFileIndex];
    if (!entry) return;

    const selectBtn = document.getElementById('select-pages-btn')!;
    selectBtn.textContent = 'Loading...';
    selectBtn.setAttribute('disabled', '');

    try {
      const { pageCount, thumbnails } = await api.getPdfThumbnails(entry.path);
      openPageSelectModal(pageCount, thumbnails);
    } finally {
      updateSelectPagesButton();
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
    // Open the first completed file's output
    const doneFile = files.find(f => f.status === 'done' && f.outputPath);
    if (doneFile?.outputPath) api.openFile(doneFile.outputPath);
  });
  document.getElementById('open-folder-btn')!.addEventListener('click', () => {
    const doneFile = files.find(f => f.status === 'done' && f.outputPath);
    if (doneFile?.outputPath) api.openFolder(doneFile.outputPath);
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

function handleFilesSelect(filePaths: string[]) {
  // Append new files, deduplicate by path
  const existingPaths = new Set(files.map(f => f.path));
  for (const fp of filePaths) {
    if (!existingPaths.has(fp)) {
      files.push({
        path: fp,
        name: fp.split('/').pop() || fp,
        selectedPages: null,
        status: 'ready',
      });
      existingPaths.add(fp);
    }
  }

  // Set active to first new file if nothing was active
  if (files.length > 0 && activeFileIndex >= files.length) {
    activeFileIndex = 0;
  }

  renderFileList();

  // Show translate actions
  document.getElementById('translate-actions')!.style.display = 'flex';
  updateSelectPagesButton();

  // Hide previous output
  document.getElementById('output-section')!.style.display = 'none';
  document.getElementById('progress-section')!.style.display = 'none';
}

function renderFileList() {
  const fileList = document.getElementById('file-list')!;
  fileList.style.display = files.length > 0 ? 'block' : 'none';
  fileList.innerHTML = '';

  files.forEach((entry, index) => {
    const item = document.createElement('div');
    item.className = `file-item${index === activeFileIndex ? ' active' : ''}`;

    const fileInfo = document.createElement('div');
    fileInfo.className = 'file-info';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'filename';
    nameSpan.textContent = entry.name;
    fileInfo.appendChild(nameSpan);

    const meta = document.createElement('div');
    meta.className = 'file-meta';

    // Page selection label
    const pageLabel = document.createElement('span');
    pageLabel.className = 'page-label';
    pageLabel.textContent = entry.selectedPages
      ? `${entry.selectedPages.length} pages`
      : 'All pages';
    meta.appendChild(pageLabel);

    // Status label
    const statusLabel = document.createElement('span');
    statusLabel.className = 'status-label';
    const statusConfig: Record<string, { text: string; color: string }> = {
      ready: { text: 'Ready', color: 'var(--text-secondary)' },
      processing: { text: 'Processing...', color: 'var(--primary)' },
      done: { text: 'Done', color: '#34c759' },
      failed: { text: 'Failed', color: 'var(--danger)' },
    };
    const sc = statusConfig[entry.status];
    statusLabel.textContent = sc.text;
    statusLabel.style.color = sc.color;
    if (entry.status === 'failed' && entry.error) {
      statusLabel.title = entry.error;
    }
    meta.appendChild(statusLabel);

    // Remove button (only when not translating)
    if (!isTranslating) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-btn';
      removeBtn.textContent = '\u00d7';
      removeBtn.title = 'Remove';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        files.splice(index, 1);
        if (activeFileIndex >= files.length) {
          activeFileIndex = Math.max(0, files.length - 1);
        }
        renderFileList();
        updateSelectPagesButton();
        if (files.length === 0) {
          document.getElementById('translate-actions')!.style.display = 'none';
        }
      });
      meta.appendChild(removeBtn);
    }

    item.appendChild(fileInfo);
    item.appendChild(meta);

    // Click to set active
    item.addEventListener('click', () => {
      activeFileIndex = index;
      renderFileList();
      updateSelectPagesButton();
    });

    fileList.appendChild(item);
  });
}

function updateSelectPagesButton() {
  const selectBtn = document.getElementById('select-pages-btn')!;
  if (files.length === 0) return;
  const entry = files[activeFileIndex];
  if (!entry) return;

  if (entry.selectedPages) {
    selectBtn.textContent = `${entry.selectedPages.length} Pages`;
    selectBtn.classList.add('has-selection');
  } else {
    selectBtn.textContent = 'Select Pages';
    selectBtn.classList.remove('has-selection');
  }
}

function openPageSelectModal(pageCount: number, thumbnails: string[]) {
  const modal = document.getElementById('page-select-modal')!;
  const grid = document.getElementById('modal-grid')!;
  grid.innerHTML = '';

  const entry = files[activeFileIndex];
  const currentSelection = entry?.selectedPages;

  for (let i = 0; i < pageCount; i++) {
    const pageNum = i + 1;
    const isSelected = !currentSelection || currentSelection.includes(pageNum);

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
  const entry = files[activeFileIndex];
  if (entry) {
    if (pages.length === totalThumbs || pages.length === 0) {
      entry.selectedPages = null;
    } else {
      entry.selectedPages = pages.sort((a, b) => a - b);
    }
  }

  updateSelectPagesButton();
  renderFileList();
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

async function handleTranslateAll() {
  const api = window.electronAPI;
  isTranslating = true;

  // Hide translate button during translation
  document.getElementById('translate-actions')!.style.display = 'none';

  // Show progress, hide output
  document.getElementById('progress-section')!.style.display = 'block';
  document.getElementById('output-section')!.style.display = 'none';
  document.getElementById('cancel-btn')!.style.display = 'inline-block';

  // Load custom prompt from settings
  const settings = await api.getSettings();
  const customPrompt = settings.customPrompt || undefined;

  const filesToProcess = files.filter(f => f.status === 'ready' || f.status === 'failed');

  for (let i = 0; i < filesToProcess.length; i++) {
    const entry = filesToProcess[i];
    entry.status = 'processing';
    activeFileIndex = files.indexOf(entry);
    renderFileList();

    // Reset progress
    document.getElementById('progress-stage')!.textContent = `Translating ${entry.name}...`;
    document.getElementById('progress-pages')!.textContent = `File ${i + 1} / ${filesToProcess.length}`;
    document.getElementById('progress-bar')!.style.width = '0%';

    const result = await api.translatePdf(entry.path, entry.selectedPages ?? undefined, customPrompt);

    if (result.success && result.outputPath) {
      entry.status = 'done';
      entry.outputPath = result.outputPath;
      entry.usage = result.usage;
    } else {
      entry.status = 'failed';
      entry.error = result.error || 'Unknown error';
    }

    renderFileList();
  }

  document.getElementById('cancel-btn')!.style.display = 'none';
  isTranslating = false;

  // Show output section with summary
  const outputSection = document.getElementById('output-section')!;
  const outputMessage = document.getElementById('output-message')!;

  const doneCount = files.filter(f => f.status === 'done').length;
  const failedCount = files.filter(f => f.status === 'failed').length;

  if (doneCount > 0) {
    let msg = `Translation complete! ${doneCount} file(s) translated.`;
    if (failedCount > 0) {
      msg += ` ${failedCount} file(s) failed.`;
    }
    // Show token usage for all completed files
    const totalUsage = files
      .filter(f => f.usage && (f.usage.inputTokens > 0 || f.usage.outputTokens > 0))
      .reduce((acc, f) => ({
        inputTokens: acc.inputTokens + (f.usage?.inputTokens || 0),
        outputTokens: acc.outputTokens + (f.usage?.outputTokens || 0),
        totalCost: acc.totalCost + (f.usage?.totalCost || 0),
      }), { inputTokens: 0, outputTokens: 0, totalCost: 0 });

    if (totalUsage.inputTokens > 0 || totalUsage.outputTokens > 0) {
      const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
      msg += `\nTokens: ${fmt(totalUsage.inputTokens)} in / ${fmt(totalUsage.outputTokens)} out`;
      if (totalUsage.totalCost > 0) {
        msg += ` · Cost: $${totalUsage.totalCost.toFixed(4)}`;
      }
    }
    outputMessage.textContent = msg;
    document.getElementById('open-file-btn')!.style.display = 'inline-block';
    document.getElementById('open-folder-btn')!.style.display = 'inline-block';
  } else {
    const errors = files
      .filter(f => f.status === 'failed' && f.error)
      .map(f => `${f.name}: ${f.error}`);
    outputMessage.textContent = `All files failed to translate.\n${errors.join('\n')}`;
    document.getElementById('open-file-btn')!.style.display = 'none';
    document.getElementById('open-folder-btn')!.style.display = 'none';
  }

  outputSection.style.display = 'block';

  // Re-show translate button for re-translation
  document.getElementById('translate-actions')!.style.display = 'flex';
}

document.addEventListener('DOMContentLoaded', init);
