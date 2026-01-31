/** Shared types for the translation pipeline */

/** A bounding box in pixel coordinates (top-left origin) */
export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Layout detection class labels */
export type LayoutClass =
  | 'title'
  | 'plain_text'
  | 'abandon'
  | 'figure'
  | 'figure_caption'
  | 'table'
  | 'table_caption'
  | 'table_footnote'
  | 'isolate_formula'
  | 'formula_caption';

/** A detected layout region from the ONNX model */
export interface LayoutBox {
  bbox: BBox;
  classId: number;
  className: LayoutClass;
  confidence: number;
}

/** A text block extracted from pdfjs-dist */
export interface TextBlock {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontName: string;
}

/** A matched region combining layout detection and text extraction */
export interface TranslatableRegion {
  layoutBox: LayoutBox;
  textBlocks: TextBlock[];
  fullText: string;
  /** Bounding box in PDF coordinate space (bottom-left origin) */
  pdfBBox: BBox;
}

/** Translation result for a region */
export interface TranslatedRegion extends TranslatableRegion {
  translatedText: string;
}

/** Progress event sent from main to renderer */
export interface ProgressEvent {
  stage: string;
  currentPage: number;
  totalPages: number;
  percent: number;
}

/** Settings stored on disk */
export interface AppSettings {
  translatorType: 'google' | 'llm';
  targetLanguage: string;
  llmProvider: string;
  llmModel: string;
  llmApiToken: string;
  llmBaseUrl: string;
  customPrompt: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  translatorType: 'google',
  targetLanguage: 'zh-CN',
  llmProvider: 'openai',
  llmModel: 'gpt-4o-mini',
  llmApiToken: '',
  llmBaseUrl: '',
  customPrompt: 'You are a professional translator. Translate the following text accurately and naturally. Output only the translated text, nothing else. Preserve any formatting, numbers, and special characters.',
};

/** Layout class ID to name mapping */
export const LAYOUT_CLASSES: LayoutClass[] = [
  'title',
  'plain_text',
  'abandon',
  'figure',
  'figure_caption',
  'table',
  'table_caption',
  'table_footnote',
  'isolate_formula',
  'formula_caption',
];

/** Classes that contain translatable text */
export const TRANSLATABLE_CLASSES: Set<LayoutClass> = new Set([
  'title',
  'plain_text',
  'figure_caption',
  'table_caption',
  'table_footnote',
  'formula_caption',
]);
