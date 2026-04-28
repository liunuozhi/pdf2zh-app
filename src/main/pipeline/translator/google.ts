/**
 * Google Translate (free) translator using @vitalets/google-translate-api.
 */
import { Translator, BatchOptions } from './index';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GoogleTranslator implements Translator {
  async translate(text: string, from: string, to: string): Promise<string> {
    // Dynamic import to handle ESM module
    const { translate } = await import('@vitalets/google-translate-api');
    const result = await translate(text, { from, to });
    return result.text;
  }

  async translateBatch(
    texts: string[],
    from: string,
    to: string,
    options?: BatchOptions
  ): Promise<string[]> {
    const results: string[] = [];
    let failed = 0;
    for (let i = 0; i < texts.length; i++) {
      // Cancel: stop and backfill remaining slots with originals
      if (options?.abortSignal?.aborted) break;
      try {
        results.push(await this.translate(texts[i], from, to));
      } catch {
        results.push(texts[i]);
        failed++;
      }
      options?.onProgress?.(i + 1, texts.length, failed);
      // Rate limiting delay
      await delay(100);
    }
    while (results.length < texts.length) results.push(texts[results.length]);
    return results;
  }
}
