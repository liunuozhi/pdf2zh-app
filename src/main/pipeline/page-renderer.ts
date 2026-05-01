/**
 * Renders a PDF page to an image buffer using pdfjs-dist + node-canvas.
 * Scales output so the longest side = 1024px.
 *
 * pdfjs-dist v5 renders text glyphs via Path2D objects. node-canvas v3
 * does not natively support Path2D, so we polyfill it here before any
 * rendering takes place. We also expose node-canvas's DOMMatrix as the
 * global DOMMatrix so pdfjs's transform calls produce instances that
 * node-canvas's setTransform accepts (otherwise it throws "Expected DOMMatrix").
 */
import { Path2D, applyPath2DToCanvasRenderingContext } from 'path2d';
(globalThis as any).Path2D = Path2D;
import { createCanvas, CanvasRenderingContext2D, DOMMatrix, type Canvas } from 'canvas';
(globalThis as any).DOMMatrix = DOMMatrix;
applyPath2DToCanvasRenderingContext(CanvasRenderingContext2D as any);

const TARGET_SIZE = 1024;

export interface RenderedPage {
  /** Raw RGB buffer (no alpha) */
  rgbBuffer: Buffer;
  width: number;
  height: number;
  /** Scale factor: image pixels / PDF points */
  scale: number;
}

/**
 * Custom CanvasFactory class for pdfjs-dist that uses node-canvas.
 * Passed to getDocument() so pdfjs-dist uses this instead of @napi-rs/canvas.
 */
export class NodeCanvasFactory {
  create(width: number, height: number) {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(canvasAndContext: any, width: number, height: number) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext: any) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

/**
 * Render a single PDF page to an image buffer.
 * @param page - A pdfjs-dist page proxy
 */
export async function renderPage(page: any): Promise<RenderedPage> {
  const viewport = page.getViewport({ scale: 1.0 });
  const pdfWidth = viewport.width;
  const pdfHeight = viewport.height;

  // Compute scale so longest side = TARGET_SIZE
  const longestSide = Math.max(pdfWidth, pdfHeight);
  const scale = TARGET_SIZE / longestSide;

  const scaledViewport = page.getViewport({ scale });
  const width = Math.floor(scaledViewport.width);
  const height = Math.floor(scaledViewport.height);

  // Create node-canvas
  const canvas: Canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');

  // pdfjs-dist render
  const renderContext = {
    canvasContext: context as any,
    viewport: scaledViewport,
  };

  await page.render(renderContext).promise;

  // Convert to raw RGB buffer directly (skip PNG encode/decode round-trip)
  const bgraBuffer = canvas.toBuffer('raw');
  const pixelCount = width * height;
  const rgbBuffer = Buffer.allocUnsafe(pixelCount * 3);
  for (let i = 0; i < pixelCount; i++) {
    const src = i * 4; // BGRA
    const dst = i * 3; // RGB
    rgbBuffer[dst] = bgraBuffer[src + 2];     // R ← B offset
    rgbBuffer[dst + 1] = bgraBuffer[src + 1]; // G ← G offset
    rgbBuffer[dst + 2] = bgraBuffer[src];     // B ← R offset
  }

  return { rgbBuffer, width, height, scale };
}

/**
 * Render a single PDF page to a base64 PNG data URI.
 * Used by the region editor to display page images on demand.
 */
export async function renderPageToBase64Png(
  page: any,
  targetWidth: number
): Promise<{ base64: string; width: number; height: number }> {
  const vp = page.getViewport({ scale: 1.0 });
  const scale = targetWidth / vp.width;
  const scaledVp = page.getViewport({ scale });
  const width = Math.floor(scaledVp.width);
  const height = Math.floor(scaledVp.height);

  const canvas: Canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');

  await page.render({ canvasContext: context as any, viewport: scaledVp }).promise;

  const pngBuffer = canvas.toBuffer('image/png');
  const base64 = `data:image/png;base64,${pngBuffer.toString('base64')}`;

  return { base64, width, height };
}
