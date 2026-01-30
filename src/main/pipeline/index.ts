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
import { AppSettings, TranslatedRegion, ProgressEvent } from './types';

/**
 * Resolve path to bundled asset. In dev, assets/ is at project root;
 * in production, it's in the app's resources directory.
 */
function getAssetPath(relativePath: string): string {
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

  // Process each page
  const pageRegions = new Map<number, TranslatedRegion[]>();

  for (let idx = 0; idx < processCount; idx++) {
    const pageNum = pagesToProcess[idx];
    if (abortSignal?.aborted) {
      throw new Error('Translation cancelled');
    }

    const basePercent = 10 + (idx / processCount) * 85;

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
      percent: basePercent + (85 / processCount) * 0.2,
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
      percent: basePercent + (85 / processCount) * 0.4,
    });
    const textBlocks = await extractText(page);

    // Stage 4: Region matching
    const regions = matchRegions(
      layoutBoxes,
      textBlocks,
      viewport.height,
      rendered.scale
    );

    if (regions.length === 0) {
      page.cleanup();
      continue;
    }

    // Stage 5: Translation
    onProgress({
      stage: 'Translating...',
      currentPage: idx + 1,
      totalPages: processCount,
      percent: basePercent + (85 / processCount) * 0.6,
    });

    const texts = regions.map((r) => r.fullText);
    const translations = await translator.translateBatch(texts, fromLang, toLang);

    const translatedRegions: TranslatedRegion[] = regions.map((region, i) => ({
      ...region,
      translatedText: translations[i],
    }));

    pageRegions.set(pageNum - 1, translatedRegions);
    page.cleanup();
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
