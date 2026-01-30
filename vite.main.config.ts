import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      external: [
        'onnxruntime-node',
        'sharp',
        'canvas',
        'pdfjs-dist/legacy/build/pdf.mjs',
        'bufferutil',
        'utf-8-validate',
      ],
    },
  },
});
