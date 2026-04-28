/**
 * LLM-based translator using pi-ai's unified API.
 */
import { getModel, completeSimple } from '@mariozechner/pi-ai';
import { Translator, BatchOptions } from './index';
import { AppSettings } from '../types';

const CONCURRENCY_LIMIT = 5;

const DEFAULT_SYSTEM_PROMPT = `You are a professional translator. Translate the following text accurately and naturally. Output only the translated text, nothing else. Preserve any formatting, numbers, and special characters.`;

/**
 * Resolve a pi-ai Model object. For known providers, looks up the registry
 * and optionally overrides baseUrl. For provider=`custom`, synthesizes a
 * minimal Model bound to the user's baseUrl (treated as OpenAI-compatible).
 */
export function resolveModel(provider: string, modelId: string, customBaseUrl?: string) {
  if (provider === 'custom') {
    if (!customBaseUrl) throw new Error('Custom provider requires a Base URL.');
    if (!modelId) throw new Error('Custom provider requires a model ID.');
    return {
      id: modelId,
      name: modelId,
      api: 'openai-completions',
      provider: 'custom',
      baseUrl: customBaseUrl,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    } as any;
  }
  const baseModel = getModel(provider as any, modelId as any);
  if (!baseModel) {
    throw new Error(`Model "${modelId}" not found for provider "${provider}". Please select a valid model in Settings.`);
  }
  return customBaseUrl ? { ...baseModel, baseUrl: customBaseUrl } : baseModel;
}

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
    const model = resolveModel(provider, modelId, this.settings.llmBaseUrl?.trim());

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
    to: string,
    options?: BatchOptions
  ): Promise<string[]> {
    this.resetUsage();
    const results: string[] = new Array(texts.length);
    const queue = texts.map((text, index) => ({ text, index }));
    let pos = 0;
    let completed = 0;
    let failed = 0;

    const worker = async () => {
      while (pos < queue.length) {
        // Cancel: stop dispatching but don't throw — caller fills remaining slots with originals
        if (options?.abortSignal?.aborted) return;
        const item = queue[pos++];
        try {
          results[item.index] = await this.translate(item.text, from, to);
        } catch {
          // Per-region failure: keep original text so the rest of the job survives
          results[item.index] = item.text;
          failed++;
        }
        completed++;
        options?.onProgress?.(completed, queue.length, failed);
      }
    };

    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(CONCURRENCY_LIMIT, texts.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    // Backfill any items the workers didn't reach (cancellation) with originals
    for (let i = 0; i < texts.length; i++) {
      if (results[i] === undefined) results[i] = texts[i];
    }

    return results;
  }
}
