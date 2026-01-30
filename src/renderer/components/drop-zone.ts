/**
 * Drop zone component: drag-and-drop + file browse.
 */
export function initDropZone(onFile: (filePath: string) => void) {
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
      const file = files[0];
      if (file.name.toLowerCase().endsWith('.pdf')) {
        const filePath = window.electronAPI.getPathForFile(file);
        if (filePath) {
          onFile(filePath);
        }
      }
    }
  });

  // Browse button
  browseBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const filePath = await window.electronAPI.openFileDialog();
    if (filePath) {
      onFile(filePath);
    }
  });

  // Click on zone also opens browse
  zone.addEventListener('click', async () => {
    const filePath = await window.electronAPI.openFileDialog();
    if (filePath) {
      onFile(filePath);
    }
  });
}
