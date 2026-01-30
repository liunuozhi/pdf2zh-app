/**
 * Match text blocks to layout detection boxes.
 * Handles coordinate transformation between PDF space and image space.
 */
import { LayoutBox, TextBlock, TranslatableRegion, BBox, TRANSLATABLE_CLASSES } from './types';

/**
 * Convert a PDF coordinate bounding box to image pixel coordinates.
 * PDF: origin bottom-left, units = points.
 * Image: origin top-left, units = pixels.
 */
function pdfToImageCoords(
  pdfX: number,
  pdfY: number,
  pdfWidth: number,
  pdfHeight: number,
  pageHeight: number,
  scale: number
): BBox {
  return {
    x: pdfX * scale,
    y: (pageHeight - pdfY - pdfHeight) * scale,
    width: pdfWidth * scale,
    height: pdfHeight * scale,
  };
}


/**
 * Compute a tight bounding box in PDF coordinate space from matched text blocks.
 * Adds a small margin (2pt) to ensure full coverage of original text.
 */
function computeTextBBox(blocks: TextBlock[]): BBox {
  const MARGIN = 2;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const b of blocks) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }

  return {
    x: minX - MARGIN,
    y: minY - MARGIN,
    width: maxX - minX + 2 * MARGIN,
    height: maxY - minY + 2 * MARGIN,
  };
}

/**
 * Check if a point is inside a bounding box.
 */
function pointInBox(px: number, py: number, box: BBox): boolean {
  return (
    px >= box.x &&
    px <= box.x + box.width &&
    py >= box.y &&
    py <= box.y + box.height
  );
}

/**
 * Match text blocks to layout boxes, producing translatable regions.
 *
 * @param layoutBoxes - Detected layout boxes in image coordinates
 * @param textBlocks - Text blocks in PDF coordinates
 * @param pageHeight - PDF page height in points
 * @param scale - Scale factor (image pixels / PDF points)
 */
export function matchRegions(
  layoutBoxes: LayoutBox[],
  textBlocks: TextBlock[],
  pageHeight: number,
  scale: number
): TranslatableRegion[] {
  const regions: TranslatableRegion[] = [];

  // Only process translatable layout classes
  const translatableBoxes = layoutBoxes.filter((lb) =>
    TRANSLATABLE_CLASSES.has(lb.className)
  );

  for (const layoutBox of translatableBoxes) {
    const matched: TextBlock[] = [];

    for (const block of textBlocks) {
      // Convert text block center to image coordinates
      const imgCoords = pdfToImageCoords(
        block.x,
        block.y,
        block.width,
        block.height,
        pageHeight,
        scale
      );

      const centerX = imgCoords.x + imgCoords.width / 2;
      const centerY = imgCoords.y + imgCoords.height / 2;

      if (pointInBox(centerX, centerY, layoutBox.bbox)) {
        matched.push(block);
      }
    }

    if (matched.length === 0) continue;

    // Sort in reading order: top-to-bottom, left-to-right
    matched.sort((a, b) => {
      const ay = pageHeight - a.y; // convert to top-down
      const by = pageHeight - b.y;
      const lineDiff = Math.abs(ay - by);
      // If on roughly the same line (within fontSize), sort left-to-right
      if (lineDiff < (a.fontSize || 10)) {
        return a.x - b.x;
      }
      return ay - by;
    });

    const fullText = matched.map((b) => b.text).join(' ');
    if (fullText.trim() === '') continue;

    // Compute PDF bounding box directly from matched text blocks' PDF coordinates
    const pdfBBox = computeTextBBox(matched);

    regions.push({
      layoutBox,
      textBlocks: matched,
      fullText,
      pdfBBox,
    });
  }

  return regions;
}
