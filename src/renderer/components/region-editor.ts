/**
 * Interactive region editor component.
 * Displays side-by-side original and translated views with draggable/resizable region overlays.
 * All pages are stacked vertically in a continuous scroll view with lazy-loaded images.
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
  private allPageIndices: number[] = []; // 0-based page indices with regions
  private pageCount = 0;
  private pageRegions = new Map<number, TranslatedRegion[]>();
  private pageDimensions = new Map<number, PageDimension>();
  private pageImages = new Map<number, { base64: string; width: number; height: number }>();
  private selectedRegionIndex: number | null = null;
  private selectedPageIdx: number | null = null;
  private onExportCallback: ((outputPath: string) => void) | null = null;
  private onCloseCallback: (() => void) | null = null;

  // Lazy loading
  private loadedPages = new Set<number>();
  private intersectionObserver: IntersectionObserver | null = null;

  // Drag state
  private isDragging = false;
  private isResizing = false;
  private resizeCorner = '';
  private dragStartX = 0;
  private dragStartY = 0;
  private dragStartBBox: BBox | null = null;
  private dragThresholdMet = false;
  private mouseDownX = 0;
  private mouseDownY = 0;
  private activeOverlayEl: HTMLElement | null = null;
  // Cached scale factors computed once at drag/resize start
  private cachedScaleX = 0;
  private cachedScaleY = 0;

  // ResizeObserver
  private resizeObserver: ResizeObserver | null = null;
  private resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // DOM elements
  private container: HTMLElement;
  private deleteBtn: HTMLElement;
  private exportBtn: HTMLElement;
  private originalScroll: HTMLElement;
  private translatedScroll: HTMLElement;

  constructor() {
    this.container = document.getElementById('region-editor')!;
    this.deleteBtn = document.getElementById('editor-delete-btn')!;
    this.exportBtn = document.getElementById('editor-export-btn')!;
    this.originalScroll = document.getElementById('editor-original-scroll')!;
    this.translatedScroll = document.getElementById('editor-translated-scroll')!;

    this.bindEvents();
  }

  private bindEvents() {
    document.getElementById('editor-back-btn')!.addEventListener('click', () => this.close());
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

    // Event delegation on translated scroll container for all overlays
    this.translatedScroll.addEventListener('mousedown', (e) => {
      const target = e.target as HTMLElement;

      // Find the overlay element (target or ancestor)
      const overlay = target.closest('.region-overlay') as HTMLElement | null;

      if (!overlay) {
        // Click on empty area (scroll container, page wrapper, or image) → deselect
        this.deselectRegion();
        return;
      }

      e.stopPropagation();

      // Find the page wrapper to get the page index
      const pageWrapper = overlay.closest('.editor-page-wrapper') as HTMLElement | null;
      if (!pageWrapper) return;
      const pageIdx = parseInt(pageWrapper.dataset.page!, 10);
      const index = parseInt(overlay.dataset.index!, 10);

      // Resize handle click
      if (target.classList.contains('resize-handle')) {
        const corner = ['nw', 'ne', 'sw', 'se'].find((c) => target.classList.contains(c)) || '';
        this.selectRegion(pageIdx, index);
        this.startResize(e, pageIdx, index, corner, overlay);
        return;
      }

      // Select and start drag
      this.selectRegion(pageIdx, index);
      this.startDrag(e, pageIdx, index, overlay);
    });

    // Global mouse events for drag/resize
    document.addEventListener('mousemove', (e) => this.handleMouseMove(e));
    document.addEventListener('mouseup', () => this.handleMouseUp());

    // ResizeObserver: re-render overlays when container size changes
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeDebounceTimer) clearTimeout(this.resizeDebounceTimer);
      this.resizeDebounceTimer = setTimeout(() => {
        if (this.container.style.display !== 'none') {
          this.renderAllOverlays();
        }
      }, 100);
    });
    this.resizeObserver.observe(this.translatedScroll);
  }

  /** Cache scale factors at drag/resize start to avoid getBoundingClientRect() on every mousemove. */
  private cacheScaleFactors(pageIdx: number) {
    const dims = this.pageDimensions.get(pageIdx);
    if (!dims) return;
    const img = this.translatedScroll.querySelector(
      `.editor-page-wrapper[data-page="${pageIdx}"] img`
    ) as HTMLImageElement | null;
    if (!img) return;
    const imgRect = img.getBoundingClientRect();
    this.cachedScaleX = dims.pdfWidth / imgRect.width;
    this.cachedScaleY = dims.pdfHeight / imgRect.height;
  }

  private startDrag(e: MouseEvent, pageIdx: number, index: number, overlay: HTMLElement) {
    const regions = this.pageRegions.get(pageIdx);
    if (!regions || index >= regions.length) return;

    this.isDragging = true;
    this.dragThresholdMet = false;
    this.mouseDownX = e.clientX;
    this.mouseDownY = e.clientY;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
    this.dragStartBBox = { ...regions[index].pdfBBox };
    this.activeOverlayEl = overlay;
    this.cacheScaleFactors(pageIdx);
  }

  private startResize(e: MouseEvent, pageIdx: number, index: number, corner: string, overlay: HTMLElement) {
    const regions = this.pageRegions.get(pageIdx);
    if (!regions || index >= regions.length) return;

    this.isResizing = true;
    this.dragThresholdMet = false;
    this.mouseDownX = e.clientX;
    this.mouseDownY = e.clientY;
    this.resizeCorner = corner;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
    this.dragStartBBox = { ...regions[index].pdfBBox };
    this.activeOverlayEl = overlay;
    this.cacheScaleFactors(pageIdx);
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
    this.loadedPages.clear();
    this.selectedRegionIndex = null;
    this.selectedPageIdx = null;

    // Build list of all page indices (0-based) that have regions, sorted
    this.allPageIndices = Array.from(this.pageRegions.keys()).sort((a, b) => a - b);
    // If no pages have regions, include all processed pages
    if (this.allPageIndices.length === 0) {
      this.allPageIndices = data.processedPages.map((p) => p - 1);
    }

    // Set filename
    const filename = data.inputPath.split('/').pop() || data.inputPath.split('\\').pop() || data.inputPath;
    document.getElementById('editor-filename')!.textContent = filename;

    // Show editor
    document.getElementById('app')!.style.display = 'none';
    this.container.style.display = 'flex';

    this.renderAllPages();
  }

  close() {
    this.container.style.display = 'none';
    document.getElementById('app')!.style.display = 'grid';
    this.selectedRegionIndex = null;
    this.selectedPageIdx = null;
    this.pageImages.clear();
    this.loadedPages.clear();

    // Disconnect IntersectionObserver
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect();
      this.intersectionObserver = null;
    }

    // Clear dynamically created page elements
    this.originalScroll.innerHTML = '';
    this.translatedScroll.innerHTML = '';

    if (this.onCloseCallback) this.onCloseCallback();
  }

  /**
   * Create page wrapper elements for all pages in both scroll containers
   * and set up IntersectionObserver for lazy loading.
   */
  private renderAllPages() {
    this.originalScroll.innerHTML = '';
    this.translatedScroll.innerHTML = '';

    const originalFragment = document.createDocumentFragment();
    const translatedFragment = document.createDocumentFragment();

    for (const pageIdx of this.allPageIndices) {
      const dims = this.pageDimensions.get(pageIdx);
      // Use aspect ratio from pageDimensions for placeholder sizing
      const aspectRatio = dims ? dims.pdfWidth / dims.pdfHeight : 8.5 / 11;

      // Original side wrapper
      const origWrapper = document.createElement('div');
      origWrapper.className = 'editor-page-wrapper';
      origWrapper.dataset.page = String(pageIdx);

      const origImgContainer = document.createElement('div');
      origImgContainer.className = 'editor-image-container';

      const origImg = document.createElement('img');
      origImg.alt = `Original page ${pageIdx + 1}`;
      origImg.style.aspectRatio = String(aspectRatio);
      origImg.style.width = '100%';
      origImg.style.background = '#e5e5ea';
      origImgContainer.appendChild(origImg);
      origWrapper.appendChild(origImgContainer);
      originalFragment.appendChild(origWrapper);

      // Translated side wrapper
      const transWrapper = document.createElement('div');
      transWrapper.className = 'editor-page-wrapper';
      transWrapper.dataset.page = String(pageIdx);

      const transImgContainer = document.createElement('div');
      transImgContainer.className = 'editor-image-container';

      const transImg = document.createElement('img');
      transImg.alt = `Translated page ${pageIdx + 1}`;
      transImg.style.aspectRatio = String(aspectRatio);
      transImg.style.width = '100%';
      transImg.style.background = '#e5e5ea';
      transImgContainer.appendChild(transImg);

      const overlaysDiv = document.createElement('div');
      overlaysDiv.className = 'editor-overlays';
      transImgContainer.appendChild(overlaysDiv);

      transWrapper.appendChild(transImgContainer);
      translatedFragment.appendChild(transWrapper);
    }

    this.originalScroll.appendChild(originalFragment);
    this.translatedScroll.appendChild(translatedFragment);

    // Set up IntersectionObserver on translated-side wrappers for lazy loading
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect();
    }

    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const wrapper = entry.target as HTMLElement;
            const pageIdx = parseInt(wrapper.dataset.page!, 10);
            if (!this.loadedPages.has(pageIdx)) {
              this.loadPageImage(pageIdx);
            }
          }
        }
      },
      {
        root: this.translatedScroll,
        rootMargin: '200px 0px',
      }
    );

    // Observe all translated-side page wrappers
    const translatedWrappers = this.translatedScroll.querySelectorAll('.editor-page-wrapper');
    translatedWrappers.forEach((wrapper) => {
      this.intersectionObserver!.observe(wrapper);
    });
  }

  /** Load images for a specific page and render its overlays. */
  private async loadPageImage(pageIdx: number) {
    if (this.loadedPages.has(pageIdx)) return;
    this.loadedPages.add(pageIdx);

    const pageNumber = pageIdx + 1; // 1-based for IPC

    // Fetch image if not cached
    if (!this.pageImages.has(pageIdx)) {
      const targetWidth = Math.floor(window.innerWidth / 2 - 40);
      const imageData = await window.electronAPI.getEditorPageImage(this.inputPath, pageNumber, targetWidth);
      this.pageImages.set(pageIdx, imageData);
    }

    const image = this.pageImages.get(pageIdx)!;

    // Set src on both original and translated images for this page
    const origImg = this.originalScroll.querySelector(
      `.editor-page-wrapper[data-page="${pageIdx}"] img`
    ) as HTMLImageElement | null;
    const transImg = this.translatedScroll.querySelector(
      `.editor-page-wrapper[data-page="${pageIdx}"] img`
    ) as HTMLImageElement | null;

    if (origImg) {
      origImg.src = image.base64;
      origImg.style.background = '';
    }
    if (transImg) {
      transImg.src = image.base64;
      transImg.style.background = '';
    }

    this.renderPageOverlays(pageIdx);
  }

  /** Compute median body font size from non-title regions on a page (replicates pdf-writer logic). */
  private computeBodyFontSize(regions: TranslatedRegion[]): number {
    const bodyFontSizes: number[] = [];
    for (const region of regions) {
      const cls = region.layoutBox.className;
      if (
        cls === 'plain_text' ||
        cls === 'figure_caption' ||
        cls === 'table_caption' ||
        cls === 'table_footnote' ||
        cls === 'formula_caption'
      ) {
        for (const block of region.textBlocks) {
          bodyFontSizes.push(block.fontSize);
        }
      }
    }
    bodyFontSizes.sort((a, b) => a - b);
    return bodyFontSizes.length > 0
      ? bodyFontSizes[Math.floor(bodyFontSizes.length / 2)]
      : 10;
  }

  /** Compute font size for a specific region (replicates pdf-writer logic). */
  private computeRegionFontSize(region: TranslatedRegion, uniformBodySize: number): number {
    if (region.layoutBox.className === 'title') {
      const sizes = region.textBlocks.map((b: any) => b.fontSize);
      return sizes.length > 0
        ? sizes.reduce((a: number, b: number) => a + b, 0) / sizes.length
        : uniformBodySize;
    }
    return uniformBodySize;
  }

  /**
   * Binary search for the largest font size that fits within the element.
   * O(log n) reflows instead of O(n) with the linear decrement approach.
   */
  private autoShrinkText(textDiv: HTMLElement, initialFontSize: number, minSize: number) {
    textDiv.style.fontSize = `${initialFontSize}px`;
    if (textDiv.scrollHeight <= textDiv.clientHeight) return; // already fits

    let lo = minSize;
    let hi = initialFontSize;

    while (hi - lo > 0.5) {
      const mid = (lo + hi) / 2;
      textDiv.style.fontSize = `${mid}px`;
      if (textDiv.scrollHeight > textDiv.clientHeight) {
        hi = mid;
      } else {
        lo = mid;
      }
    }
    textDiv.style.fontSize = `${lo}px`;
  }

  /** Render overlays for a single page. */
  private renderPageOverlays(pageIdx: number) {
    const overlaysContainer = this.translatedScroll.querySelector(
      `.editor-page-wrapper[data-page="${pageIdx}"] .editor-overlays`
    ) as HTMLElement | null;
    if (!overlaysContainer) return;

    overlaysContainer.innerHTML = '';

    const regions = this.pageRegions.get(pageIdx);
    const dims = this.pageDimensions.get(pageIdx);
    if (!regions || !dims) return;

    const { pdfWidth, pdfHeight } = dims;
    const uniformBodySize = this.computeBodyFontSize(regions);

    // Display scale: how many CSS pixels per PDF point
    const img = this.translatedScroll.querySelector(
      `.editor-page-wrapper[data-page="${pageIdx}"] img`
    ) as HTMLImageElement | null;
    if (!img) return;
    const imgDisplayHeight = img.clientHeight || img.naturalHeight;
    const scale = imgDisplayHeight / pdfHeight;
    const minDisplaySize = 4; // minimum font size in CSS pixels

    // Build all overlays in a DocumentFragment to minimize reflows during construction
    const fragment = document.createDocumentFragment();

    // Track text divs and their initial font sizes for auto-shrink pass
    const textEntries: { el: HTMLElement; initialSize: number }[] = [];

    const isSelectedPage = this.selectedPageIdx === pageIdx;

    regions.forEach((region, index) => {
      const bbox = region.pdfBBox;

      // Convert PDF coordinates (bottom-left origin) to CSS percentages
      const leftPct = (bbox.x / pdfWidth) * 100;
      const topPct = ((pdfHeight - bbox.y - bbox.height) / pdfHeight) * 100;
      const widthPct = (bbox.width / pdfWidth) * 100;
      const heightPct = (bbox.height / pdfHeight) * 100;

      const overlay = document.createElement('div');
      overlay.className = `region-overlay${isSelectedPage && index === this.selectedRegionIndex ? ' selected' : ''}`;
      overlay.style.left = `${leftPct}%`;
      overlay.style.top = `${topPct}%`;
      overlay.style.width = `${widthPct}%`;
      overlay.style.height = `${heightPct}%`;
      overlay.dataset.index = String(index);

      // Render translated text inside the overlay
      if (region.translatedText) {
        const pdfFontSize = this.computeRegionFontSize(region, uniformBodySize);
        const padding = Math.max(2, pdfFontSize * 0.15) * scale;
        const isTitle = region.layoutBox.className === 'title';
        const initialSize = pdfFontSize * scale;

        const textDiv = document.createElement('div');
        textDiv.className = 'region-overlay-text';
        textDiv.textContent = region.translatedText;
        textDiv.style.fontSize = `${initialSize}px`;
        textDiv.style.padding = `${padding}px`;
        textDiv.style.lineHeight = '1.2';
        textDiv.style.wordBreak = 'break-all';
        textDiv.style.fontFamily = "'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif";
        if (isTitle) {
          textDiv.style.fontWeight = 'bold';
        }
        overlay.appendChild(textDiv);
        textEntries.push({ el: textDiv, initialSize });
      }

      // Add resize handles for selected region
      if (isSelectedPage && index === this.selectedRegionIndex) {
        this.appendResizeHandles(overlay);
      }

      fragment.appendChild(overlay);
    });

    // Single DOM insertion
    overlaysContainer.appendChild(fragment);

    // Auto-shrink text pass using binary search (elements must be in DOM to measure)
    for (const { el, initialSize } of textEntries) {
      this.autoShrinkText(el, initialSize, minDisplaySize);
    }
  }

  /** Render overlays for all loaded pages. */
  private renderAllOverlays() {
    for (const pageIdx of this.loadedPages) {
      this.renderPageOverlays(pageIdx);
    }
  }

  /** Append resize handle elements to an overlay. */
  private appendResizeHandles(overlay: HTMLElement) {
    for (const corner of ['nw', 'ne', 'sw', 'se']) {
      const handle = document.createElement('div');
      handle.className = `resize-handle ${corner}`;
      overlay.appendChild(handle);
    }
  }

  /** Remove resize handle elements from an overlay. */
  private removeResizeHandles(overlay: HTMLElement) {
    overlay.querySelectorAll('.resize-handle').forEach((h) => h.remove());
  }

  /** Select a region without full DOM rebuild. */
  private selectRegion(pageIdx: number, index: number) {
    if (this.selectedPageIdx === pageIdx && this.selectedRegionIndex === index) return;

    const regions = this.pageRegions.get(pageIdx);
    if (!regions || index >= regions.length) return;

    // Deselect previous overlay in-place (possibly on a different page)
    if (this.selectedRegionIndex !== null && this.selectedPageIdx !== null) {
      const prevOverlaysContainer = this.translatedScroll.querySelector(
        `.editor-page-wrapper[data-page="${this.selectedPageIdx}"] .editor-overlays`
      );
      if (prevOverlaysContainer) {
        const prevOverlay = prevOverlaysContainer.querySelector(
          `.region-overlay[data-index="${this.selectedRegionIndex}"]`
        ) as HTMLElement | null;
        if (prevOverlay) {
          prevOverlay.classList.remove('selected');
          this.removeResizeHandles(prevOverlay);
        }
      }
    }

    // Select new overlay in-place
    this.selectedPageIdx = pageIdx;
    this.selectedRegionIndex = index;

    const overlaysContainer = this.translatedScroll.querySelector(
      `.editor-page-wrapper[data-page="${pageIdx}"] .editor-overlays`
    );
    if (overlaysContainer) {
      const overlay = overlaysContainer.querySelector(
        `.region-overlay[data-index="${index}"]`
      ) as HTMLElement | null;
      if (overlay) {
        overlay.classList.add('selected');
        this.appendResizeHandles(overlay);
      }
    }

    this.deleteBtn.style.display = 'inline-block';
  }

  /** Deselect current region without full DOM rebuild. */
  private deselectRegion() {
    if (this.selectedRegionIndex === null || this.selectedPageIdx === null) return;

    const overlaysContainer = this.translatedScroll.querySelector(
      `.editor-page-wrapper[data-page="${this.selectedPageIdx}"] .editor-overlays`
    );
    if (overlaysContainer) {
      const prevOverlay = overlaysContainer.querySelector(
        `.region-overlay[data-index="${this.selectedRegionIndex}"]`
      ) as HTMLElement | null;
      if (prevOverlay) {
        prevOverlay.classList.remove('selected');
        this.removeResizeHandles(prevOverlay);
      }
    }

    this.selectedRegionIndex = null;
    this.selectedPageIdx = null;
    this.deleteBtn.style.display = 'none';
  }

  private handleMouseMove(e: MouseEvent) {
    if (!this.isDragging && !this.isResizing) return;
    if (!this.dragStartBBox || this.selectedPageIdx === null || this.selectedRegionIndex === null) return;

    // Drag threshold: don't start moving until mouse has moved >= 3px
    if (!this.dragThresholdMet) {
      const dx = e.clientX - this.mouseDownX;
      const dy = e.clientY - this.mouseDownY;
      if (Math.sqrt(dx * dx + dy * dy) < 3) return;
      this.dragThresholdMet = true;
      // Apply dragging class to suppress CSS transitions
      if (this.activeOverlayEl) {
        this.activeOverlayEl.classList.add('dragging');
      }
    }

    const pageIdx = this.selectedPageIdx;
    const regions = this.pageRegions.get(pageIdx);
    const dims = this.pageDimensions.get(pageIdx);
    if (!regions || !dims || this.selectedRegionIndex >= regions.length) return;

    const region = regions[this.selectedRegionIndex];
    const { pdfWidth, pdfHeight } = dims;

    // Use cached scale factors (computed once at drag start)
    const scaleX = this.cachedScaleX;
    const scaleY = this.cachedScaleY;

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

    // Direct style mutation on the active overlay element (no DOM rebuild)
    if (this.activeOverlayEl) {
      const bbox = region.pdfBBox;
      const leftPct = (bbox.x / pdfWidth) * 100;
      const topPct = ((pdfHeight - bbox.y - bbox.height) / pdfHeight) * 100;
      const widthPct = (bbox.width / pdfWidth) * 100;
      const heightPct = (bbox.height / pdfHeight) * 100;
      this.activeOverlayEl.style.left = `${leftPct}%`;
      this.activeOverlayEl.style.top = `${topPct}%`;
      this.activeOverlayEl.style.width = `${widthPct}%`;
      this.activeOverlayEl.style.height = `${heightPct}%`;
    }
  }

  private handleMouseUp() {
    const wasDragging = this.dragThresholdMet;
    const activeEl = this.activeOverlayEl;
    this.isDragging = false;
    this.isResizing = false;
    this.dragStartBBox = null;
    this.dragThresholdMet = false;
    this.activeOverlayEl = null;

    // Only auto-shrink the moved/resized overlay's text (not a full re-render)
    if (wasDragging && activeEl && this.selectedPageIdx !== null && this.selectedRegionIndex !== null) {
      activeEl.classList.remove('dragging');
      const textDiv = activeEl.querySelector('.region-overlay-text') as HTMLElement | null;
      if (textDiv) {
        const index = this.selectedRegionIndex;
        const pageIdx = this.selectedPageIdx;
        const regions = this.pageRegions.get(pageIdx);
        const dims = this.pageDimensions.get(pageIdx);
        if (regions && dims && index < regions.length) {
          const region = regions[index];
          const uniformBodySize = this.computeBodyFontSize(regions);
          const pdfFontSize = this.computeRegionFontSize(region, uniformBodySize);
          const img = this.translatedScroll.querySelector(
            `.editor-page-wrapper[data-page="${pageIdx}"] img`
          ) as HTMLImageElement | null;
          const imgDisplayHeight = img ? (img.clientHeight || img.naturalHeight) : 0;
          if (imgDisplayHeight > 0) {
            const scale = imgDisplayHeight / dims.pdfHeight;
            this.autoShrinkText(textDiv, pdfFontSize * scale, 4);
          }
        }
      }
    }
  }

  private deleteSelectedRegion() {
    if (this.selectedRegionIndex === null || this.selectedPageIdx === null) return;

    const pageIdx = this.selectedPageIdx;
    const regions = this.pageRegions.get(pageIdx);
    if (!regions) return;

    regions.splice(this.selectedRegionIndex, 1);
    this.selectedRegionIndex = null;
    this.selectedPageIdx = null;
    this.deleteBtn.style.display = 'none';
    // Full re-render needed for this page because indices shift after splice
    this.renderPageOverlays(pageIdx);
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
