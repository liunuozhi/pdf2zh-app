/**
 * Renders a PDF page to an image buffer using pdfjs-dist + node-canvas.
 * Scales output so the longest side = 1024px.
 *
 * pdfjs-dist v5 renders text glyphs via Path2D objects. node-canvas v3
 * does not natively support Path2D, so we polyfill it here before any
 * rendering takes place.
 */
import { Path2D, applyPath2DToCanvasRenderingContext } from 'path2d';
(globalThis as any).Path2D = Path2D;
import { createCanvas, CanvasRenderingContext2D, type Canvas } from 'canvas';
applyPath2DToCanvasRenderingContext(CanvasRenderingContext2D as any);

import sharp from 'sharp';

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

  // Convert to raw RGB buffer using sharp
  const pngBuffer = canvas.toBuffer('image/png');
  const rgbBuffer = await sharp(pngBuffer)
    .removeAlpha()
    .raw()
    .toBuffer();

  return { rgbBuffer, width, height, scale };
}
