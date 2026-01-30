[中文](README_zh.md)

# pdf2zh-app

Desktop PDF translator that preserves document layout using AI-powered layout detection.

![pdf2zh-app screenshot](assets/screenshot.png) 

## Features

- **Layout-aware translation** — Uses DocLayout-YOLO (ONNX) to detect titles, body text, captions, tables, and formulas, then overlays translated text while preserving the original formatting
- **Multiple translation engines** — Google Translate (free, no API key) or LLM-based translation via OpenAI, Anthropic, Google, Mistral, Ollama, or any custom OpenAI-compatible endpoint
- **Page selection** — Preview page thumbnails and choose which pages to translate

## Download

Get the latest release from the [Releases page](https://github.com/liunuozhi/pdf2zh-app/releases).

## Usage

1. **Open a PDF** — Drag and drop a file onto the app, or click "browse" to select one
2. **Select pages** *(optional)* — Click "Select Pages" to pick specific pages via thumbnail preview
3. **Configure** — Choose a translator (Google or LLM), set the target language, and enter API credentials if using an LLM
4. **Translate** — Click "Translate" and wait for the progress bar to complete. The translated PDF is saved alongside the original file

## LLM Providers

| Provider | Default Model |
|----------|---------------|
| OpenAI | gpt-4o-mini |
| Anthropic | Claude |
| Google | Gemini |
| Mistral | Mistral |
| Ollama | Local models |
| Custom | Any OpenAI-compatible API |

You can also customize the translation prompt in the settings panel.

## Build from Source

```bash
git clone https://github.com/liunuozhi/pdf2zh-app.git
cd pdf2zh-app
npm install
npm start
```

To create distributable packages:

```bash
npm run make
```

## Acknowledgements

This project is inspired by [PDFMathTranslate](https://github.com/PDFMathTranslate/PDFMathTranslate).

## License

[Apache-2.0](LICENSE)
