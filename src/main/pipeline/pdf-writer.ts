/**
 * PDF writer: overlays white rectangles over original text and draws translated text.
 * Uses pdf-lib with embedded Noto Sans SC font.
 */
import { PDFDocument, rgb, StandardFonts, PDFName, PDFArray, PDFDict, PDFNumber } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import fs from 'node:fs';
import { TranslatedRegion, BBox } from './types';

const MIN_FONT_SIZE = 6;

/**
 * Create a modified PDF with translated text overlaid.
 *
 * @param inputPath - Path to the original PDF
 * @param outputPath - Path to save the modified PDF
 * @param pageRegions - Map of page index to translated regions
 * @param fontPath - Path to the CJK font TTF file
 */
export async function writePdf(
  inputPath: string,
  outputPath: string,
  pageRegions: Map<number, TranslatedRegion[]>,
  fontPath: string,
  boldFontPath?: string
): Promise<void> {
  const pdfBytes = fs.readFileSync(inputPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);

  pdfDoc.registerFontkit(fontkit);

  // Embed fonts
  let customFont;
  let boldFont;
  try {
    const fontBytes = fs.readFileSync(fontPath);
    customFont = await pdfDoc.embedFont(fontBytes, { subset: false });
  } catch (err) {
    console.warn('Failed to embed custom font, falling back to Helvetica:', err);
    customFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  }
  try {
    if (boldFontPath) {
      const boldFontBytes = fs.readFileSync(boldFontPath);
      boldFont = await pdfDoc.embedFont(boldFontBytes, { subset: false });
    }
  } catch (err) {
    console.warn('Failed to embed bold font, titles will use regular weight:', err);
  }

  const pages = pdfDoc.getPages();

  for (const [pageIndex, regions] of pageRegions) {
    if (pageIndex >= pages.length) continue;
    const page = pages[pageIndex];
    const { height: pageHeight } = page.getSize();

    // Compute uniform body font size from all non-title translatable regions on this page
    const bodyFontSizes: number[] = [];
    for (const region of regions) {
      if (region.layoutBox.className === 'plain_text' ||
          region.layoutBox.className === 'figure_caption' ||
          region.layoutBox.className === 'table_caption' ||
          region.layoutBox.className === 'table_footnote' ||
          region.layoutBox.className === 'formula_caption') {
        for (const block of region.textBlocks) {
          bodyFontSizes.push(block.fontSize);
        }
      }
    }
    // Median body font size (fallback to 10)
    bodyFontSizes.sort((a, b) => a - b);
    const uniformBodySize = bodyFontSizes.length > 0
      ? bodyFontSizes[Math.floor(bodyFontSizes.length / 2)]
      : 10;

    for (const region of regions) {
      const bbox = region.pdfBBox;

      // Draw white rectangle to cover original text
      // pdfBBox.y is in PDF coords (bottom-left origin)
      page.drawRectangle({
        x: bbox.x,
        y: bbox.y,
        width: bbox.width,
        height: bbox.height,
        color: rgb(1, 1, 1),
      });

      // Draw translated text with auto-sizing
      const text = region.translatedText;
      if (!text || text.trim() === '') continue;

      // Determine target font size and font weight based on region type
      const isTitle = region.layoutBox.className === 'title';
      const regionFont = (isTitle && boldFont) ? boldFont : customFont;
      let targetFontSize: number;
      if (isTitle) {
        // Titles: use their own average font size
        const sizes = region.textBlocks.map(b => b.fontSize);
        targetFontSize = sizes.length > 0
          ? sizes.reduce((a, b) => a + b, 0) / sizes.length
          : uniformBodySize;
      } else {
        // Body text: uniform size
        targetFontSize = uniformBodySize;
      }

      const padding = Math.max(2, targetFontSize * 0.15);
      const availWidth = bbox.width - padding * 2;
      const availHeight = bbox.height - padding * 2;

      // Start with the target font size, shrink if text doesn't fit
      let fontSize = targetFontSize;

      // Auto-shrink until text fits
      while (fontSize > MIN_FONT_SIZE) {
        const lines = wrapText(text, regionFont, fontSize, availWidth);
        const totalHeight = lines.length * fontSize * 1.2;
        if (totalHeight <= availHeight) break;
        fontSize -= 0.5;
      }

      const lines = wrapText(text, regionFont, fontSize, availWidth);
      const lineHeight = fontSize * 1.2;

      // Draw lines from top of box
      for (let i = 0; i < lines.length; i++) {
        const lineY = bbox.y + bbox.height - padding - (i + 1) * lineHeight + (lineHeight - fontSize);
        if (lineY < bbox.y) break; // Don't draw outside box

        page.drawText(lines[i], {
          x: bbox.x + padding,
          y: lineY,
          size: fontSize,
          font: regionFont,
          color: rgb(0, 0, 0),
        });
      }
    }

    // Remove link annotations that overlap with translated regions
    // These cause visible box outlines over the translated text
    const annots = page.node.Annots();
    if (annots) {
      const indicesToRemove: number[] = [];
      for (let i = 0; i < annots.size(); i++) {
        const annotDict = annots.lookupMaybe(i, PDFDict);
        if (!annotDict) continue;

        const subtype = annotDict.get(PDFName.of('Subtype'));
        if (!subtype || subtype !== PDFName.of('Link')) continue;

        // Get annotation rectangle [x1, y1, x2, y2] in PDF coords
        const rect = annotDict.lookup(PDFName.of('Rect'), PDFArray);
        if (!rect || rect.size() < 4) continue;

        const ax1 = (rect.lookup(0, PDFNumber) as PDFNumber).asNumber();
        const ay1 = (rect.lookup(1, PDFNumber) as PDFNumber).asNumber();
        const ax2 = (rect.lookup(2, PDFNumber) as PDFNumber).asNumber();
        const ay2 = (rect.lookup(3, PDFNumber) as PDFNumber).asNumber();

        const annotBox = {
          x: Math.min(ax1, ax2),
          y: Math.min(ay1, ay2),
          width: Math.abs(ax2 - ax1),
          height: Math.abs(ay2 - ay1),
        };

        // Check if annotation overlaps any translated region
        for (const region of regions) {
          const rb = region.pdfBBox;
          const overlaps =
            annotBox.x < rb.x + rb.width &&
            annotBox.x + annotBox.width > rb.x &&
            annotBox.y < rb.y + rb.height &&
            annotBox.y + annotBox.height > rb.y;
          if (overlaps) {
            indicesToRemove.push(i);
            break;
          }
        }
      }
      // Remove in reverse order to preserve indices
      for (let i = indicesToRemove.length - 1; i >= 0; i--) {
        annots.remove(indicesToRemove[i]);
      }
    }
  }

  const modifiedBytes = await pdfDoc.save();
  fs.writeFileSync(outputPath, modifiedBytes);
}

/**
 * Wrap text to fit within a given width, character by character (for CJK).
 */
function wrapText(
  text: string,
  font: any,
  fontSize: number,
  maxWidth: number
): string[] {
  const lines: string[] = [];
  let currentLine = '';

  for (const char of text) {
    if (char === '\n') {
      lines.push(currentLine);
      currentLine = '';
      continue;
    }

    const testLine = currentLine + char;
    let testWidth: number;
    try {
      testWidth = font.widthOfTextAtSize(testLine, fontSize);
    } catch {
      // If character can't be measured (missing glyph), use estimate
      testWidth = testLine.length * fontSize * 0.5;
    }

    if (testWidth > maxWidth && currentLine.length > 0) {
      lines.push(currentLine);
      currentLine = char;
    } else {
      currentLine = testLine;
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
}
