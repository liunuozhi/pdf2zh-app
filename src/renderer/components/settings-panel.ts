/**
 * Settings panel component: translator configuration UI.
 * Auto-saves on every change.
 */
import { DEFAULT_SETTINGS } from '../../main/pipeline/types';

export function initSettingsPanel(api: Window['electronAPI']) {
  const translatorSelect = document.getElementById('translator-select') as HTMLSelectElement;
  const targetLang = document.getElementById('target-lang') as HTMLSelectElement;
  const llmSettings = document.getElementById('llm-settings')!;
  const llmProvider = document.getElementById('llm-provider') as HTMLSelectElement;
  const llmModel = document.getElementById('llm-model') as HTMLSelectElement;
  const llmModelCustom = document.getElementById('llm-model-custom') as HTMLInputElement;
  const llmApiToken = document.getElementById('llm-api-token') as HTMLInputElement;
  const apiTokenToggle = document.getElementById('api-token-toggle') as HTMLButtonElement;
  const llmBaseUrl = document.getElementById('llm-base-url') as HTMLInputElement;
  const testConnBtn = document.getElementById('test-conn-btn') as HTMLButtonElement;
  const testConnStatus = document.getElementById('test-conn-status') as HTMLSpanElement;

  // Custom Prompt Modal elements
  const customPromptBtn = document.getElementById('custom-prompt-btn')!;
  const promptModal = document.getElementById('prompt-modal')!;
  const promptTextarea = document.getElementById('prompt-textarea') as HTMLTextAreaElement;
  const promptResetBtn = document.getElementById('prompt-reset-btn')!;
  const promptCancelBtn = document.getElementById('prompt-cancel-btn')!;
  const promptSaveBtn = document.getElementById('prompt-save-btn')!;

  let savedCustomPrompt = DEFAULT_SETTINGS.customPrompt;

  // Whichever model field is active depends on the provider
  function currentModelId(): string {
    return llmProvider.value === 'custom' ? llmModelCustom.value.trim() : llmModel.value;
  }

  function updateModelFieldVisibility() {
    const isCustom = llmProvider.value === 'custom';
    llmModel.style.display = isCustom ? 'none' : '';
    llmModelCustom.style.display = isCustom ? '' : 'none';
  }

  // Collect current settings and persist
  function saveSettings() {
    api.saveSettings({
      translatorType: translatorSelect.value,
      targetLanguage: targetLang.value,
      llmProvider: llmProvider.value,
      llmModel: currentModelId(),
      llmApiToken: llmApiToken.value,
      llmBaseUrl: llmBaseUrl.value,
      customPrompt: savedCustomPrompt,
    });
  }

  // Open prompt modal
  customPromptBtn.addEventListener('click', () => {
    promptTextarea.value = savedCustomPrompt;
    promptModal.style.display = 'flex';
  });

  // Close prompt modal on overlay click
  promptModal.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      promptModal.style.display = 'none';
    }
  });

  // Reset default
  promptResetBtn.addEventListener('click', () => {
    promptTextarea.value = DEFAULT_SETTINGS.customPrompt;
  });

  // Cancel
  promptCancelBtn.addEventListener('click', () => {
    promptModal.style.display = 'none';
  });

  // Save prompt
  promptSaveBtn.addEventListener('click', () => {
    savedCustomPrompt = promptTextarea.value.trim() || DEFAULT_SETTINGS.customPrompt;
    saveSettings();
    promptModal.style.display = 'none';
  });

  // Show/hide LLM settings and custom prompt button based on translator selection
  function updateTranslatorVisibility() {
    const isLlm = translatorSelect.value === 'llm';
    llmSettings.style.display = isLlm ? 'block' : 'none';
    customPromptBtn.style.display = isLlm ? 'inline-block' : 'none';
  }

  // Auto-save on change for all select/input fields
  translatorSelect.addEventListener('change', () => {
    updateTranslatorVisibility();
    saveSettings();
  });
  targetLang.addEventListener('change', saveSettings);
  llmProvider.addEventListener('change', () => {
    updateModelFieldVisibility();
    if (llmProvider.value !== 'custom') {
      populateModels(llmProvider.value);
    }
    saveSettings();
  });
  llmModel.addEventListener('change', saveSettings);
  llmModelCustom.addEventListener('change', saveSettings);
  llmApiToken.addEventListener('change', saveSettings);
  llmBaseUrl.addEventListener('change', saveSettings);

  apiTokenToggle.addEventListener('click', () => {
    const reveal = llmApiToken.type === 'password';
    llmApiToken.type = reveal ? 'text' : 'password';
    apiTokenToggle.classList.toggle('revealed', reveal);
    const label = reveal ? 'Hide API token' : 'Show API token';
    apiTokenToggle.setAttribute('aria-label', label);
    apiTokenToggle.setAttribute('title', label);
  });

  testConnBtn.addEventListener('click', async () => {
    saveSettings();
    testConnBtn.disabled = true;
    testConnStatus.className = 'test-conn-status';
    testConnStatus.textContent = 'Testing…';
    const result = await api.testLlmConnection({
      translatorType: translatorSelect.value,
      llmProvider: llmProvider.value,
      llmModel: currentModelId(),
      llmApiToken: llmApiToken.value,
      llmBaseUrl: llmBaseUrl.value,
    });
    testConnStatus.classList.add(result.ok ? 'success' : 'error');
    testConnStatus.textContent = result.ok
      ? `OK (${result.latencyMs} ms)`
      : `Failed: ${result.message}`;
    testConnBtn.disabled = false;
  });

  // Populate model dropdown for a provider, preserving selected value if possible
  async function populateModels(provider: string, selectedModel?: string) {
    const models = await api.listModels(provider);
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
    if (selectedModel && models.includes(selectedModel)) {
      llmModel.value = selectedModel;
    }
  }

  // Load settings on init
  api.getSettings().then((settings) => {
    if (settings) {
      translatorSelect.value = settings.translatorType || 'google';
      targetLang.value = settings.targetLanguage || 'zh-CN';
      llmProvider.value = settings.llmProvider || 'openai';
      llmApiToken.value = settings.llmApiToken || '';
      llmBaseUrl.value = settings.llmBaseUrl || '';
      savedCustomPrompt = settings.customPrompt || DEFAULT_SETTINGS.customPrompt;
      updateTranslatorVisibility();
      updateModelFieldVisibility();

      if (llmProvider.value === 'custom') {
        llmModelCustom.value = settings.llmModel || '';
      } else {
        populateModels(llmProvider.value, settings.llmModel);
      }
    }
  });
}
