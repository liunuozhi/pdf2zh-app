/**
 * Settings panel component: translator configuration UI.
 */
export function initSettingsPanel(api: Window['electronAPI']) {
  const translatorSelect = document.getElementById('translator-select') as HTMLSelectElement;
  const targetLang = document.getElementById('target-lang') as HTMLSelectElement;
  const llmSettings = document.getElementById('llm-settings')!;
  const llmProvider = document.getElementById('llm-provider') as HTMLSelectElement;
  const llmModel = document.getElementById('llm-model') as HTMLSelectElement;
  const llmApiToken = document.getElementById('llm-api-token') as HTMLInputElement;
  const llmBaseUrl = document.getElementById('llm-base-url') as HTMLInputElement;
  const saveBtn = document.getElementById('save-settings-btn')!;
  const llmPromptToggle = document.getElementById('llm-prompt-toggle')!;
  const llmPromptEditor = document.getElementById('llm-prompt-editor')!;
  const llmCustomPrompt = document.getElementById('llm-custom-prompt') as HTMLTextAreaElement;

  const DEFAULT_SYSTEM_PROMPT = 'You are a professional translator. Translate the following text accurately and naturally. Output only the translated text, nothing else. Preserve any formatting, numbers, and special characters.';

  // Toggle custom prompt editor visibility
  llmPromptToggle.addEventListener('click', () => {
    const isHidden = llmPromptEditor.style.display === 'none';
    llmPromptEditor.style.display = isHidden ? 'block' : 'none';
    llmPromptToggle.textContent = isHidden ? 'Hide Prompt' : 'Customize Prompt';
    if (isHidden && !llmCustomPrompt.value) {
      llmCustomPrompt.value = DEFAULT_SYSTEM_PROMPT;
    }
  });

  // Show/hide LLM settings based on translator selection
  translatorSelect.addEventListener('change', () => {
    llmSettings.style.display = translatorSelect.value === 'llm' ? 'block' : 'none';
  });

  // Populate model dropdown for a provider, preserving selected value if possible
  async function populateModels(provider: string, selectedModel?: string) {
    const models = await api.listModels(provider);
    // Clear existing options
    llmModel.innerHTML = '';
    if (models.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No models available';
      llmModel.appendChild(opt);
    } else {
      for (const id of models) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = id;
        llmModel.appendChild(opt);
      }
    }
    // Restore selection if it exists in the list
    if (selectedModel && models.includes(selectedModel)) {
      llmModel.value = selectedModel;
    }
  }

  // When provider changes, refresh model list
  llmProvider.addEventListener('change', () => {
    populateModels(llmProvider.value);
  });

  // Load settings on init
  api.getSettings().then((settings) => {
    if (settings) {
      translatorSelect.value = settings.translatorType || 'google';
      targetLang.value = settings.targetLanguage || 'zh-CN';
      llmProvider.value = settings.llmProvider || 'openai';
      llmApiToken.value = settings.llmApiToken || '';
      llmBaseUrl.value = settings.llmBaseUrl || '';
      llmSettings.style.display = settings.translatorType === 'llm' ? 'block' : 'none';

      // Populate models for the saved provider, selecting the saved model
      populateModels(settings.llmProvider || 'openai', settings.llmModel);
    }
  });

  // Save settings
  saveBtn.addEventListener('click', async () => {
    const settings = {
      translatorType: translatorSelect.value,
      targetLanguage: targetLang.value,
      llmProvider: llmProvider.value,
      llmModel: llmModel.value,
      llmApiToken: llmApiToken.value,
      llmBaseUrl: llmBaseUrl.value,
    };
    await api.saveSettings(settings);
    saveBtn.textContent = 'Saved!';
    setTimeout(() => {
      saveBtn.textContent = 'Save Settings';
    }, 1500);
  });
}
