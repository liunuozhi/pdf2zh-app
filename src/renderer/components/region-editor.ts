/**
 * Interactive region editor component.
 * Displays side-by-side original and translated views with draggable/resizable region overlays.
 */

interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TranslatedRegion {
  layoutBox: any;
  textBlocks: any[];
  fullText: string;
  pdfBBox: BBox;
  translatedText: string;
}

interface TranslatePhaseResult {
  inputPath: string;
  pageCount: number;
  processedPages: number[];
  pageRegions: [number, TranslatedRegion[]][];
  pageDimensions: { pageIndex: number; pdfWidth: number; pdfHeight: number }[];
  usage?: { inputTokens: number; outputTokens: number; totalCost: number };
}

interface PageDimension {
  pdfWidth: number;
  pdfHeight: number;
}

export class RegionEditor {
  private inputPath = '';
  private currentPageIndex = 0; // index into allPageIndices
  private allPageIndices: number[] = []; // 0-based page indices with regions
  private pageCount = 0;
  private pageRegions = new Map<number, TranslatedRegion[]>();
  private pageDimensions = new Map<number, PageDimension>();
  private pageImages = new Map<number, { base64: string; width: number; height: number }>();
  private selectedRegionIndex: number | null = null;
  private onExportCallback: ((outputPath: string) => void) | null = null;
  private onCloseCallback: (() => void) | null = null;

  // Drag state
  private isDragging = false;
  private isResizing = false;
  private resizeCorner = '';
  private dragStartX = 0;
  private dragStartY = 0;
  private dragStartBBox: BBox | null = null;

  // DOM elements
  private container: HTMLElement;
  private originalImage: HTMLImageElement;
  private translatedImage: HTMLImageElement;
  private translatedContainer: HTMLElement;
  private overlaysContainer: HTMLElement;
  private textPanel: HTMLElement;
  private originalTextEl: HTMLElement;
  private translatedTextEl: HTMLTextAreaElement;
  private pageLabel: HTMLElement;
  private deleteBtn: HTMLElement;
  private exportBtn: HTMLElement;
  private originalScroll: HTMLElement;
  private translatedScroll: HTMLElement;

  constructor() {
    this.container = document.getElementById('region-editor')!;
    this.originalImage = document.getElementById('editor-original-image') as HTMLImageElement;
    this.translatedImage = document.getElementById('editor-translated-image') as HTMLImageElement;
    this.translatedContainer = document.getElementById('editor-translated-container')!;
    this.overlaysContainer = document.getElementById('editor-overlays')!;
    this.textPanel = document.getElementById('editor-text-panel')!;
    this.originalTextEl = document.getElementById('editor-original-text')!;
    this.translatedTextEl = document.getElementById('editor-translated-text') as HTMLTextAreaElement;
    this.pageLabel = document.getElementById('editor-page-label')!;
    this.deleteBtn = document.getElementById('editor-delete-btn')!;
    this.exportBtn = document.getElementById('editor-export-btn')!;
    this.originalScroll = document.getElementById('editor-original-scroll')!;
    this.translatedScroll = document.getElementById('editor-translated-scroll')!;

    this.bindEvents();
  }

  private bindEvents() {
    document.getElementById('editor-back-btn')!.addEventListener('click', () => this.close());
    document.getElementById('editor-prev-btn')!.addEventListener('click', () => this.prevPage());
    document.getElementById('editor-next-btn')!.addEventListener('click', () => this.nextPage());
    document.getElementById('editor-apply-btn')!.addEventListener('click', () => this.applyTextEdit());
    this.deleteBtn.addEventListener('click', () => this.deleteSelectedRegion());
    this.exportBtn.addEventListener('click', () => this.exportPdf());

    // Synchronized scrolling
    let syncing = false;
    this.originalScroll.addEventListener('scroll', () => {
      if (syncing) return;
      syncing = true;
      this.translatedScroll.scrollTop = this.originalScroll.scrollTop;
      this.translatedScroll.scrollLeft = this.originalScroll.scrollLeft;
      syncing = false;
    });
    this.translatedScroll.addEventListener('scroll', () => {
      if (syncing) return;
      syncing = true;
      this.originalScroll.scrollTop = this.translatedScroll.scrollTop;
      this.originalScroll.scrollLeft = this.translatedScroll.scrollLeft;
      syncing = false;
    });

    // Global mouse events for drag/resize
    document.addEventListener('mousemove', (e) => this.handleMouseMove(e));
    document.addEventListener('mouseup', () => this.handleMouseUp());
  }

  async open(
    data: TranslatePhaseResult,
    onExport: (outputPath: string) => void,
    onClose: () => void
  ) {
    this.inputPath = data.inputPath;
    this.pageCount = data.pageCount;
    this.onExportCallback = onExport;
    this.onCloseCallback = onClose;

    // Build mutable state from serialized data
    this.pageRegions = new Map(data.pageRegions);
    this.pageDimensions = new Map(
      data.pageDimensions.map((d) => [d.pageIndex, { pdfWidth: d.pdfWidth, pdfHeight: d.pdfHeight }])
    );
    this.pageImages.clear();
    this.selectedRegionIndex = null;

    // Build list of all page indices (0-based) that have regions, sorted
    this.allPageIndices = Array.from(this.pageRegions.keys()).sort((a, b) => a - b);
    // If no pages have regions, include all processed pages
    if (this.allPageIndices.length === 0) {
      this.allPageIndices = data.processedPages.map((p) => p - 1);
    }

    this.currentPageIndex = 0;

    // Set filename
    const filename = data.inputPath.split('/').pop() || data.inputPath.split('\\').pop() || data.inputPath;
    document.getElementById('editor-filename')!.textContent = filename;

    // Show editor
    document.getElementById('app')!.style.display = 'none';
    this.container.style.display = 'flex';

    await this.renderPage();
  }

  close() {
    this.container.style.display = 'none';
    document.getElementById('app')!.style.display = 'grid';
    this.selectedRegionIndex = null;
    this.textPanel.style.display = 'none';
    this.pageImages.clear();
    if (this.onCloseCallback) this.onCloseCallback();
  }

  private get currentPageIdx(): number {
    return this.allPageIndices[this.currentPageIndex] ?? 0;
  }

  private async renderPage() {
    const pageIdx = this.currentPageIdx;
    const pageNumber = pageIdx + 1; // 1-based for IPC

    // Lazy-load page image
    if (!this.pageImages.has(pageIdx)) {
      const targetWidth = Math.floor(window.innerWidth / 2 - 40);
      const imageData = await window.electronAPI.getEditorPageImage(this.inputPath, pageNumber, targetWidth);
      this.pageImages.set(pageIdx, imageData);
    }

    const image = this.pageImages.get(pageIdx)!;
    this.originalImage.src = image.base64;
    this.translatedImage.src = image.base64;

    // Update page nav
    this.pageLabel.textContent = `Page ${pageNumber} of ${this.pageCount}`;

    // Clear selection
    this.selectedRegionIndex = null;
    this.textPanel.style.display = 'none';
    this.deleteBtn.style.display = 'none';

    this.renderRegionOverlays();
  }

  private renderRegionOverlays() {
    this.overlaysContainer.innerHTML = '';

    const pageIdx = this.currentPageIdx;
    const regions = this.pageRegions.get(pageIdx);
    const dims = this.pageDimensions.get(pageIdx);
    if (!regions || !dims) return;

    const { pdfWidth, pdfHeight } = dims;

    regions.forEach((region, index) => {
      const bbox = region.pdfBBox;

      // Convert PDF coordinates (bottom-left origin) to CSS percentages
      const leftPct = (bbox.x / pdfWidth) * 100;
      const topPct = ((pdfHeight - bbox.y - bbox.height) / pdfHeight) * 100;
      const widthPct = (bbox.width / pdfWidth) * 100;
      const heightPct = (bbox.height / pdfHeight) * 100;

      const overlay = document.createElement('div');
      overlay.className = `region-overlay${index === this.selectedRegionIndex ? ' selected' : ''}`;
      overlay.style.left = `${leftPct}%`;
      overlay.style.top = `${topPct}%`;
      overlay.style.width = `${widthPct}%`;
      overlay.style.height = `${heightPct}%`;
      overlay.dataset.index = String(index);

      // Click to select
      overlay.addEventListener('mousedown', (e) => {
        e.stopPropagation();

        // Check if this is a resize handle click
        if ((e.target as HTMLElement).classList.contains('resize-handle')) {
          return; // Handled by resize handle listener
        }

        this.selectRegion(index);

        // Start drag
        this.isDragging = true;
        this.dragStartX = e.clientX;
        this.dragStartY = e.clientY;
        this.dragStartBBox = { ...bbox };
      });

      // Add resize handles for selected region
      if (index === this.selectedRegionIndex) {
        const corners = ['nw', 'ne', 'sw', 'se'];
        corners.forEach((corner) => {
          const handle = document.createElement('div');
          handle.className = `resize-handle ${corner}`;
          handle.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            this.isResizing = true;
            this.resizeCorner = corner;
            this.dragStartX = e.clientX;
            this.dragStartY = e.clientY;
            this.dragStartBBox = { ...bbox };
          });
          overlay.appendChild(handle);
        });
      }

      this.overlaysContainer.appendChild(overlay);
    });

    // Click on empty area to deselect
    this.overlaysContainer.addEventListener('mousedown', (e) => {
      if (e.target === this.overlaysContainer) {
        this.deselectRegion();
      }
    });
  }

  private selectRegion(index: number) {
    this.selectedRegionIndex = index;

    const pageIdx = this.currentPageIdx;
    const regions = this.pageRegions.get(pageIdx);
    if (!regions || index >= regions.length) return;

    const region = regions[index];

    // Show text panel
    this.originalTextEl.textContent = region.fullText;
    this.translatedTextEl.value = region.translatedText;
    this.textPanel.style.display = 'flex';
    this.deleteBtn.style.display = 'inline-block';

    this.renderRegionOverlays();
  }

  private deselectRegion() {
    this.selectedRegionIndex = null;
    this.textPanel.style.display = 'none';
    this.deleteBtn.style.display = 'none';
    this.renderRegionOverlays();
  }

  private handleMouseMove(e: MouseEvent) {
    if (!this.isDragging && !this.isResizing) return;
    if (!this.dragStartBBox) return;

    const pageIdx = this.currentPageIdx;
    const regions = this.pageRegions.get(pageIdx);
    const dims = this.pageDimensions.get(pageIdx);
    if (!regions || !dims || this.selectedRegionIndex === null) return;

    const region = regions[this.selectedRegionIndex];
    const { pdfWidth, pdfHeight } = dims;

    // Get the image element's rendered dimensions to compute the scale
    const imgRect = this.translatedImage.getBoundingClientRect();
    const scaleX = pdfWidth / imgRect.width;
    const scaleY = pdfHeight / imgRect.height;

    const dxScreen = e.clientX - this.dragStartX;
    const dyScreen = e.clientY - this.dragStartY;

    // Convert screen delta to PDF delta (Y is inverted in PDF coords)
    const dxPdf = dxScreen * scaleX;
    const dyPdf = -dyScreen * scaleY;

    if (this.isDragging) {
      region.pdfBBox.x = this.dragStartBBox.x + dxPdf;
      region.pdfBBox.y = this.dragStartBBox.y + dyPdf;

      // Clamp to page bounds
      region.pdfBBox.x = Math.max(0, Math.min(pdfWidth - region.pdfBBox.width, region.pdfBBox.x));
      region.pdfBBox.y = Math.max(0, Math.min(pdfHeight - region.pdfBBox.height, region.pdfBBox.y));
    } else if (this.isResizing) {
      const startBBox = this.dragStartBBox;
      const minSize = 10; // minimum size in PDF points

      switch (this.resizeCorner) {
        case 'se': // bottom-right in screen = right + lower-y in PDF
          region.pdfBBox.width = Math.max(minSize, startBBox.width + dxPdf);
          region.pdfBBox.height = Math.max(minSize, startBBox.height - dyPdf);
          region.pdfBBox.y = startBBox.y + dyPdf;
          if (region.pdfBBox.height <= minSize) region.pdfBBox.y = startBBox.y + startBBox.height - minSize;
          break;
        case 'sw': // bottom-left in screen
          region.pdfBBox.x = startBBox.x + dxPdf;
          region.pdfBBox.width = Math.max(minSize, startBBox.width - dxPdf);
          if (region.pdfBBox.width <= minSize) region.pdfBBox.x = startBBox.x + startBBox.width - minSize;
          region.pdfBBox.height = Math.max(minSize, startBBox.height - dyPdf);
          region.pdfBBox.y = startBBox.y + dyPdf;
          if (region.pdfBBox.height <= minSize) region.pdfBBox.y = startBBox.y + startBBox.height - minSize;
          break;
        case 'ne': // top-right in screen = right + higher-y in PDF
          region.pdfBBox.width = Math.max(minSize, startBBox.width + dxPdf);
          region.pdfBBox.height = Math.max(minSize, startBBox.height + dyPdf);
          break;
        case 'nw': // top-left in screen
          region.pdfBBox.x = startBBox.x + dxPdf;
          region.pdfBBox.width = Math.max(minSize, startBBox.width - dxPdf);
          if (region.pdfBBox.width <= minSize) region.pdfBBox.x = startBBox.x + startBBox.width - minSize;
          region.pdfBBox.height = Math.max(minSize, startBBox.height + dyPdf);
          break;
      }
    }

    this.renderRegionOverlays();
  }

  private handleMouseUp() {
    this.isDragging = false;
    this.isResizing = false;
    this.dragStartBBox = null;
  }

  private applyTextEdit() {
    if (this.selectedRegionIndex === null) return;

    const pageIdx = this.currentPageIdx;
    const regions = this.pageRegions.get(pageIdx);
    if (!regions) return;

    const region = regions[this.selectedRegionIndex];
    region.translatedText = this.translatedTextEl.value;
  }

  private deleteSelectedRegion() {
    if (this.selectedRegionIndex === null) return;

    const pageIdx = this.currentPageIdx;
    const regions = this.pageRegions.get(pageIdx);
    if (!regions) return;

    regions.splice(this.selectedRegionIndex, 1);
    this.selectedRegionIndex = null;
    this.textPanel.style.display = 'none';
    this.deleteBtn.style.display = 'none';
    this.renderRegionOverlays();
  }

  private async prevPage() {
    if (this.currentPageIndex > 0) {
      this.currentPageIndex--;
      await this.renderPage();
    }
  }

  private async nextPage() {
    if (this.currentPageIndex < this.allPageIndices.length - 1) {
      this.currentPageIndex++;
      await this.renderPage();
    }
  }

  private async exportPdf() {
    this.exportBtn.setAttribute('disabled', '');
    this.exportBtn.textContent = 'Exporting...';

    try {
      // Serialize pageRegions Map to array of tuples
      const serializedRegions: [number, TranslatedRegion[]][] = Array.from(this.pageRegions.entries());

      const result = await window.electronAPI.exportPdf(this.inputPath, serializedRegions);

      if (result.success && result.outputPath) {
        this.container.style.display = 'none';
        document.getElementById('app')!.style.display = 'grid';
        if (this.onExportCallback) this.onExportCallback(result.outputPath);
      } else {
        alert(`Export failed: ${result.error || 'Unknown error'}`);
      }
    } finally {
      this.exportBtn.removeAttribute('disabled');
      this.exportBtn.textContent = 'Export PDF';
    }
  }
}
