/**
 * Google Translate (free) translator using @vitalets/google-translate-api.
 */
import { Translator } from './index';

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
    to: string
  ): Promise<string[]> {
    const results: string[] = [];
    for (const text of texts) {
      results.push(await this.translate(text, from, to));
      // Rate limiting delay
      await delay(100);
    }
    return results;
  }
}
