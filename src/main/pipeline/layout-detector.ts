/**
 * Layout detection using ONNX DocLayout-YOLO model.
 * Preprocesses image, runs inference, postprocesses detections.
 */
import * as ort from 'onnxruntime-node';
import { LayoutBox, LAYOUT_CLASSES } from './types';

const MODEL_SIZE = 1024;
const CONF_THRESHOLD = 0.25;
const PAD_VALUE = 114;

let session: ort.InferenceSession | null = null;

/**
 * Load (or reuse) the ONNX model session.
 */
export async function loadModel(modelPath: string): Promise<void> {
  if (!session) {
    session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
    });
  }
}

/**
 * Preprocess image: letterbox resize to 1024x1024, pad with gray, normalize, HWC→CHW.
 */
function preprocess(
  rgbBuffer: Buffer,
  srcWidth: number,
  srcHeight: number
): { tensor: ort.Tensor; padInfo: { scale: number; padX: number; padY: number } } {
  const scale = Math.min(MODEL_SIZE / srcWidth, MODEL_SIZE / srcHeight);
  const newW = Math.round(srcWidth * scale);
  const newH = Math.round(srcHeight * scale);
  const padX = Math.floor((MODEL_SIZE - newW) / 2);
  const padY = Math.floor((MODEL_SIZE - newH) / 2);

  // Create padded float32 CHW tensor
  const channels = 3;
  const data = new Float32Array(channels * MODEL_SIZE * MODEL_SIZE);

  // Fill with pad value (normalized)
  const padNorm = PAD_VALUE / 255.0;
  data.fill(padNorm);

  // We need to resize the source image. For simplicity, use nearest-neighbor
  // since we already rendered at ~1024px via page-renderer.
  for (let y = 0; y < newH; y++) {
    const srcY = Math.min(Math.floor(y / scale), srcHeight - 1);
    for (let x = 0; x < newW; x++) {
      const srcX = Math.min(Math.floor(x / scale), srcWidth - 1);
      const srcIdx = (srcY * srcWidth + srcX) * 3;
      const dstX = x + padX;
      const dstY = y + padY;

      // CHW layout: [C, H, W]
      for (let c = 0; c < 3; c++) {
        data[c * MODEL_SIZE * MODEL_SIZE + dstY * MODEL_SIZE + dstX] =
          rgbBuffer[srcIdx + c] / 255.0;
      }
    }
  }

  const tensor = new ort.Tensor('float32', data, [1, 3, MODEL_SIZE, MODEL_SIZE]);
  return { tensor, padInfo: { scale, padX, padY } };
}

/**
 * Run layout detection on a rendered page image.
 */
export async function detectLayout(
  rgbBuffer: Buffer,
  imgWidth: number,
  imgHeight: number
): Promise<LayoutBox[]> {
  if (!session) {
    throw new Error('ONNX model not loaded. Call loadModel() first.');
  }

  const { tensor, padInfo } = preprocess(rgbBuffer, imgWidth, imgHeight);

  // Run inference
  const inputName = session.inputNames[0];
  const feeds: Record<string, ort.Tensor> = { [inputName]: tensor };
  const results = await session.run(feeds);

  const outputName = session.outputNames[0];
  const output = results[outputName];
  const dims = output.dims as number[];
  const rawData = output.data as Float32Array;

  const boxes: LayoutBox[] = [];

  if (dims.length !== 3) {
    console.warn('Unexpected output dims:', dims);
    return [];
  }

  const numRows = dims[1];
  const numCols = dims[2];

  if (numCols === 6) {
    // Post-NMS format: [1, N, 6] where each row = [x1, y1, x2, y2, conf, classId]
    for (let i = 0; i < numRows; i++) {
      const off = i * 6;
      const conf = rawData[off + 4];
      if (conf < CONF_THRESHOLD) continue;

      const x1 = (rawData[off + 0] - padInfo.padX) / padInfo.scale;
      const y1 = (rawData[off + 1] - padInfo.padY) / padInfo.scale;
      const x2 = (rawData[off + 2] - padInfo.padX) / padInfo.scale;
      const y2 = (rawData[off + 3] - padInfo.padY) / padInfo.scale;
      const classId = Math.round(rawData[off + 5]);

      boxes.push({
        bbox: {
          x: Math.max(0, x1),
          y: Math.max(0, y1),
          width: x2 - x1,
          height: y2 - y1,
        },
        classId,
        className: LAYOUT_CLASSES[classId] || 'plain_text',
        confidence: conf,
      });
    }
  } else {
    // Raw YOLO format: [1, 4+numClasses, N] (transposed) or [1, N, 4+numClasses]
    let numDetections: number;
    let numFields: number;
    let transposed: boolean;

    if (numCols > numRows && numRows <= 20) {
      // [1, F, N] transposed
      numFields = numRows;
      numDetections = numCols;
      transposed = true;
    } else {
      // [1, N, F]
      numDetections = numRows;
      numFields = numCols;
      transposed = false;
    }

    const numClasses = numFields - 4;

    for (let i = 0; i < numDetections; i++) {
      let cx: number, cy: number, w: number, h: number;
      let bestClassId = 0;
      let bestConf = 0;

      if (transposed) {
        cx = rawData[0 * numDetections + i];
        cy = rawData[1 * numDetections + i];
        w = rawData[2 * numDetections + i];
        h = rawData[3 * numDetections + i];
        for (let c = 0; c < numClasses; c++) {
          const val = rawData[(4 + c) * numDetections + i];
          if (val > bestConf) { bestConf = val; bestClassId = c; }
        }
      } else {
        const offset = i * numFields;
        cx = rawData[offset];
        cy = rawData[offset + 1];
        w = rawData[offset + 2];
        h = rawData[offset + 3];
        for (let c = 0; c < numClasses; c++) {
          const val = rawData[offset + 4 + c];
          if (val > bestConf) { bestConf = val; bestClassId = c; }
        }
      }

      if (bestConf < CONF_THRESHOLD) continue;

      const x1 = (cx - w / 2 - padInfo.padX) / padInfo.scale;
      const y1 = (cy - h / 2 - padInfo.padY) / padInfo.scale;
      const bw = w / padInfo.scale;
      const bh = h / padInfo.scale;

      boxes.push({
        bbox: { x: Math.max(0, x1), y: Math.max(0, y1), width: bw, height: bh },
        classId: bestClassId,
        className: LAYOUT_CLASSES[bestClassId] || 'plain_text',
        confidence: bestConf,
      });
    }
  }

  return boxes;
}
