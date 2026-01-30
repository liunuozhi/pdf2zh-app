/**
 * Extract text blocks with positions from a PDF page using pdfjs-dist.
 */
import { TextBlock } from './types';

/**
 * Extract text items from a pdfjs-dist page.
 * Returns TextBlock[] with PDF coordinate positions (bottom-left origin).
 */
export async function extractText(page: any): Promise<TextBlock[]> {
  const textContent = await page.getTextContent();
  const blocks: TextBlock[] = [];

  for (const item of textContent.items) {
    if (!item.str || item.str.trim() === '') continue;

    // item.transform = [scaleX, skewY, skewX, scaleY, translateX, translateY]
    const transform = item.transform;
    if (!transform || transform.length < 6) continue;

    const scaleX = Math.abs(transform[0]);
    const scaleY = Math.abs(transform[3]);
    const fontSize = Math.max(scaleX, scaleY);
    const x = transform[4];
    const y = transform[5];

    // Width from item or estimate
    const width = item.width || (item.str.length * fontSize * 0.5);
    const height = item.height || fontSize;

    blocks.push({
      text: item.str,
      x,
      y,
      width,
      height,
      fontSize,
      fontName: item.fontName || '',
    });
  }

  return blocks;
}
