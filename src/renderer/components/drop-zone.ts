/**
 * Drop zone component: drag-and-drop + file browse (multi-file support).
 */
export function initDropZone(onFiles: (filePaths: string[]) => void) {
  const zone = document.getElementById('drop-zone')!;
  const browseBtn = document.getElementById('browse-btn')!;

  // Drag events
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.add('drag-over');
  });

  zone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove('drag-over');
  });

  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove('drag-over');

    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      const pdfPaths: string[] = [];
      for (let i = 0; i < files.length; i++) {
        if (files[i].name.toLowerCase().endsWith('.pdf')) {
          const filePath = window.electronAPI.getPathForFile(files[i]);
          if (filePath) pdfPaths.push(filePath);
        }
      }
      if (pdfPaths.length > 0) {
        onFiles(pdfPaths);
      }
    }
  });

  // Browse button
  browseBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const filePaths = await window.electronAPI.openFileDialog();
    if (filePaths && filePaths.length > 0) {
      onFiles(filePaths);
    }
  });

  // Click on zone also opens browse
  zone.addEventListener('click', async () => {
    const filePaths = await window.electronAPI.openFileDialog();
    if (filePaths && filePaths.length > 0) {
      onFiles(filePaths);
    }
  });
}
