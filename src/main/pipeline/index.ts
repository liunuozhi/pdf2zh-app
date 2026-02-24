/**
 * Pipeline orchestrator: coordinates all stages of PDF translation.
 */
import path from 'node:path';
import { app } from 'electron';
import { renderPage, NodeCanvasFactory } from './page-renderer';
import { loadModel, detectLayout } from './layout-detector';
import { extractText } from './text-extractor';
import { matchRegions } from './region-matcher';
import { createTranslator } from './translator';
import { writePdf } from './pdf-writer';
import { TranslatorUsage } from './translator';
import { AppSettings, TranslatedRegion, TranslatePhaseResult, ProgressEvent } from './types';

/**
 * Resolve path to bundled asset. In dev, assets/ is at project root;
 * in production, it's in the app's resources directory.
 */
export function getAssetPath(relativePath: string): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'assets', relativePath);
  }
  return path.join(app.getAppPath(), 'assets', relativePath);
}

export interface PipelineOptions {
  inputPath: string;
  outputPath: string;
  settings: AppSettings;
  onProgress: (event: ProgressEvent) => void;
  abortSignal?: { aborted: boolean };
  selectedPages?: number[];
  customPrompt?: string;
}

export interface PipelineResult {
  usage?: TranslatorUsage;
}

export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const { inputPath, outputPath, settings, onProgress, abortSignal, selectedPages, customPrompt } = options;

  // Load ONNX model
  const modelPath = getAssetPath('models/doclayout_yolo_docstructbench_imgsz1024.onnx');
  onProgress({ stage: 'Loading model...', currentPage: 0, totalPages: 0, percent: 0 });
  await loadModel(modelPath);

  // Load PDF with pdfjs-dist
  onProgress({ stage: 'Loading PDF...', currentPage: 0, totalPages: 0, percent: 5 });

  // Dynamic import of pdfjs-dist for Node.js
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjsLib.getDocument({
    url: inputPath,
    useSystemFonts: true,
    CanvasFactory: NodeCanvasFactory,
  });
  const pdfDocument = await loadingTask.promise;
  const totalPages = pdfDocument.numPages;

  // Create translator
  const translator = await createTranslator(settings, customPrompt);
  const fromLang = 'en';
  const toLang = settings.targetLanguage || 'zh-CN';

  // Font paths
  const fontPath = getAssetPath('fonts/NotoSansSC-Regular.ttf');
  const boldFontPath = getAssetPath('fonts/NotoSansSC-Bold.ttf');

  // Determine which pages to process
  const pagesToProcess: number[] = selectedPages && selectedPages.length > 0
    ? selectedPages.filter((p) => p >= 1 && p <= totalPages)
    : Array.from({ length: totalPages }, (_, i) => i + 1);
  const processCount = pagesToProcess.length;

  // Phase A: Prepare all pages (render, detect, extract, match)
  const pageRegions = new Map<number, TranslatedRegion[]>();
  const allRegionEntries: { pageNum: number; regionIndex: number; region: any }[] = [];
  const pageRegionLists = new Map<number, any[]>();

  for (let idx = 0; idx < processCount; idx++) {
    const pageNum = pagesToProcess[idx];
    if (abortSignal?.aborted) {
      throw new Error('Translation cancelled');
    }

    const basePercent = 10 + (idx / processCount) * 50;

    // Stage 1: Render page to image
    onProgress({
      stage: 'Rendering page...',
      currentPage: idx + 1,
      totalPages: processCount,
      percent: basePercent,
    });
    const page = await pdfDocument.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.0 });
    const rendered = await renderPage(page);

    // Stage 2: Layout detection
    onProgress({
      stage: 'Detecting layout...',
      currentPage: idx + 1,
      totalPages: processCount,
      percent: basePercent + (50 / processCount) * 0.33,
    });
    const layoutBoxes = await detectLayout(
      rendered.rgbBuffer,
      rendered.width,
      rendered.height
    );

    // Stage 3: Text extraction
    onProgress({
      stage: 'Extracting text...',
      currentPage: idx + 1,
      totalPages: processCount,
      percent: basePercent + (50 / processCount) * 0.66,
    });
    const textBlocks = await extractText(page);

    // Stage 4: Region matching
    const regions = matchRegions(
      layoutBoxes,
      textBlocks,
      viewport.height,
      rendered.scale
    );

    page.cleanup();

    if (regions.length === 0) continue;

    pageRegionLists.set(pageNum, regions);
    for (let ri = 0; ri < regions.length; ri++) {
      allRegionEntries.push({ pageNum, regionIndex: ri, region: regions[ri] });
    }
  }

  // Phase B: Translate ALL regions across all pages in a single batch
  if (abortSignal?.aborted) {
    throw new Error('Translation cancelled');
  }

  if (allRegionEntries.length > 0) {
    onProgress({
      stage: 'Translating...',
      currentPage: processCount,
      totalPages: processCount,
      percent: 60,
    });

    const allTexts = allRegionEntries.map((e) => e.region.fullText);
    const allTranslations = await translator.translateBatch(allTexts, fromLang, toLang);

    for (let i = 0; i < allRegionEntries.length; i++) {
      const { pageNum, regionIndex } = allRegionEntries[i];
      const regions = pageRegionLists.get(pageNum)!;
      const translatedRegions = pageRegions.get(pageNum - 1) || [];
      if (translatedRegions.length === 0) {
        pageRegions.set(pageNum - 1, translatedRegions);
      }
      translatedRegions.push({
        ...regions[regionIndex],
        translatedText: allTranslations[i],
      });
    }
  }

  // Stage 6: Write output PDF
  if (abortSignal?.aborted) {
    throw new Error('Translation cancelled');
  }

  onProgress({
    stage: 'Writing PDF...',
    currentPage: processCount,
    totalPages: processCount,
    percent: 95,
  });

  await writePdf(inputPath, outputPath, pageRegions, fontPath, boldFontPath);

  onProgress({
    stage: 'Complete!',
    currentPage: processCount,
    totalPages: processCount,
    percent: 100,
  });

  return {
    usage: translator.getUsage?.(),
  };
}

export interface TranslatePhaseOptions {
  inputPath: string;
  settings: AppSettings;
  onProgress: (event: ProgressEvent) => void;
  abortSignal?: { aborted: boolean };
  selectedPages?: number[];
  customPrompt?: string;
}

/**
 * Run stages 1-5 of the pipeline (translate) without writing the output PDF.
 * Returns serializable TranslatePhaseResult for the renderer to display in the editor.
 */
export async function runTranslatePhase(options: TranslatePhaseOptions): Promise<TranslatePhaseResult> {
  const { inputPath, settings, onProgress, abortSignal, selectedPages, customPrompt } = options;

  // Load ONNX model
  const modelPath = getAssetPath('models/doclayout_yolo_docstructbench_imgsz1024.onnx');
  onProgress({ stage: 'Loading model...', currentPage: 0, totalPages: 0, percent: 0 });
  await loadModel(modelPath);

  // Load PDF with pdfjs-dist
  onProgress({ stage: 'Loading PDF...', currentPage: 0, totalPages: 0, percent: 5 });
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjsLib.getDocument({
    url: inputPath,
    useSystemFonts: true,
    CanvasFactory: NodeCanvasFactory,
  });
  const pdfDocument = await loadingTask.promise;
  const totalPages = pdfDocument.numPages;

  // Create translator
  const translator = await createTranslator(settings, customPrompt);
  const fromLang = 'en';
  const toLang = settings.targetLanguage || 'zh-CN';

  // Determine which pages to process
  const pagesToProcess: number[] = selectedPages && selectedPages.length > 0
    ? selectedPages.filter((p) => p >= 1 && p <= totalPages)
    : Array.from({ length: totalPages }, (_, i) => i + 1);
  const processCount = pagesToProcess.length;

  // Phase A: Prepare all pages (render, detect, extract, match)
  const pageRegions = new Map<number, TranslatedRegion[]>();
  const pageDimensions: { pageIndex: number; pdfWidth: number; pdfHeight: number }[] = [];
  const allRegionEntries: { pageNum: number; regionIndex: number; region: any }[] = [];
  const pageRegionLists = new Map<number, any[]>();

  for (let idx = 0; idx < processCount; idx++) {
    const pageNum = pagesToProcess[idx];
    if (abortSignal?.aborted) {
      throw new Error('Translation cancelled');
    }

    const basePercent = 10 + (idx / processCount) * 50;

    // Stage 1: Render page to image
    onProgress({
      stage: 'Rendering page...',
      currentPage: idx + 1,
      totalPages: processCount,
      percent: basePercent,
    });
    const page = await pdfDocument.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.0 });
    const rendered = await renderPage(page);

    // Collect page dimensions
    pageDimensions.push({
      pageIndex: pageNum - 1,
      pdfWidth: viewport.width,
      pdfHeight: viewport.height,
    });

    // Stage 2: Layout detection
    onProgress({
      stage: 'Detecting layout...',
      currentPage: idx + 1,
      totalPages: processCount,
      percent: basePercent + (50 / processCount) * 0.33,
    });
    const layoutBoxes = await detectLayout(
      rendered.rgbBuffer,
      rendered.width,
      rendered.height
    );

    // Stage 3: Text extraction
    onProgress({
      stage: 'Extracting text...',
      currentPage: idx + 1,
      totalPages: processCount,
      percent: basePercent + (50 / processCount) * 0.66,
    });
    const textBlocks = await extractText(page);

    // Stage 4: Region matching
    const regions = matchRegions(
      layoutBoxes,
      textBlocks,
      viewport.height,
      rendered.scale
    );

    page.cleanup();

    if (regions.length === 0) continue;

    pageRegionLists.set(pageNum, regions);
    for (let ri = 0; ri < regions.length; ri++) {
      allRegionEntries.push({ pageNum, regionIndex: ri, region: regions[ri] });
    }
  }

  // Phase B: Translate ALL regions across all pages in a single batch
  if (abortSignal?.aborted) {
    throw new Error('Translation cancelled');
  }

  if (allRegionEntries.length > 0) {
    onProgress({
      stage: 'Translating...',
      currentPage: processCount,
      totalPages: processCount,
      percent: 60,
    });

    const allTexts = allRegionEntries.map((e) => e.region.fullText);
    const allTranslations = await translator.translateBatch(allTexts, fromLang, toLang);

    for (let i = 0; i < allRegionEntries.length; i++) {
      const { pageNum, regionIndex } = allRegionEntries[i];
      const regions = pageRegionLists.get(pageNum)!;
      const translatedRegions = pageRegions.get(pageNum - 1) || [];
      if (translatedRegions.length === 0) {
        pageRegions.set(pageNum - 1, translatedRegions);
      }
      translatedRegions.push({
        ...regions[regionIndex],
        translatedText: allTranslations[i],
      });
    }
  }

  onProgress({
    stage: 'Translation complete!',
    currentPage: processCount,
    totalPages: processCount,
    percent: 100,
  });

  pdfDocument.destroy();

  return {
    inputPath,
    pageCount: totalPages,
    processedPages: pagesToProcess,
    pageRegions: Array.from(pageRegions.entries()),
    pageDimensions,
    usage: translator.getUsage?.(),
  };
}
