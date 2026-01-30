/**
 * LLM-based translator using pi-ai's unified API.
 */
import { getModel, completeSimple } from '@mariozechner/pi-ai';
import { Translator } from './index';
import { AppSettings } from '../types';

const CONCURRENCY_LIMIT = 5;

const DEFAULT_SYSTEM_PROMPT = `You are a professional translator. Translate the following text accurately and naturally. Output only the translated text, nothing else. Preserve any formatting, numbers, and special characters.`;

export class LLMTranslator implements Translator {
  private settings: AppSettings;
  private customPrompt?: string;
  private _inputTokens = 0;
  private _outputTokens = 0;
  private _totalCost = 0;

  constructor(settings: AppSettings, customPrompt?: string) {
    this.settings = settings;
    this.customPrompt = customPrompt;
  }

  getUsage() {
    return {
      inputTokens: this._inputTokens,
      outputTokens: this._outputTokens,
      totalCost: this._totalCost,
    };
  }

  resetUsage() {
    this._inputTokens = 0;
    this._outputTokens = 0;
    this._totalCost = 0;
  }

  async translate(text: string, from: string, to: string): Promise<string> {
    const languageMap: Record<string, string> = {
      'zh-CN': 'Simplified Chinese',
      'zh-TW': 'Traditional Chinese',
      'ja': 'Japanese',
      'ko': 'Korean',
      'fr': 'French',
      'de': 'German',
      'es': 'Spanish',
      'en': 'English',
    };

    const targetLang = languageMap[to] || to;
    const sourceLang = languageMap[from] || from || 'auto-detect';

    const provider = this.settings.llmProvider || 'openai';
    const modelId = this.settings.llmModel || 'gpt-4o-mini';
    const model = getModel(provider as any, modelId as any);
    if (!model) {
      throw new Error(`Model "${modelId}" not found for provider "${provider}". Please select a valid model in Settings.`);
    }

    const systemPrompt = this.customPrompt || DEFAULT_SYSTEM_PROMPT;

    const response = await completeSimple(model, {
      systemPrompt,
      messages: [
        {
          role: 'user' as const,
          content: `Translate from ${sourceLang} to ${targetLang}:\n\n${text}`,
          timestamp: Date.now(),
        },
      ],
    }, {
      apiKey: this.settings.llmApiToken || undefined,
      temperature: 0.3,
    });

    if (response.usage) {
      this._inputTokens += response.usage.input || 0;
      this._outputTokens += response.usage.output || 0;
      this._totalCost += response.usage.cost?.total || 0;
    }

    const textBlock = response.content.find((c: any) => c.type === 'text');
    return (textBlock as any)?.text?.trim() || text;
  }

  async translateBatch(
    texts: string[],
    from: string,
    to: string
  ): Promise<string[]> {
    this.resetUsage();
    const results: string[] = new Array(texts.length);
    const queue = texts.map((text, index) => ({ text, index }));
    let pos = 0;

    const worker = async () => {
      while (pos < queue.length) {
        const item = queue[pos++];
        results[item.index] = await this.translate(item.text, from, to);
      }
    };

    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(CONCURRENCY_LIMIT, texts.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    return results;
  }
}
