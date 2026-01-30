/**
 * Translator interface and factory.
 */
import { AppSettings } from '../types';

export interface TranslatorUsage {
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
}

export interface Translator {
  translate(text: string, from: string, to: string): Promise<string>;
  translateBatch(texts: string[], from: string, to: string): Promise<string[]>;
  getUsage?(): TranslatorUsage;
}

export async function createTranslator(settings: AppSettings, customPrompt?: string): Promise<Translator> {
  if (settings.translatorType === 'google') {
    const { GoogleTranslator } = await import('./google');
    return new GoogleTranslator();
  } else {
    const { LLMTranslator } = await import('./llm');
    return new LLMTranslator(settings, customPrompt);
  }
}
