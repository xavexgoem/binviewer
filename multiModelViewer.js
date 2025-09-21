// Multi-Model Viewer Module
// Handles loading and switching between multiple models from zip files

export const MultiModelState = {
  models: [], // Array of {name: string, model: Model, textures: {}}
  currentModelIndex: -1,
  modelSelector: null,
};

// Handle directory input for zip files
export async function handleZipDirectoryInput(e) {
  const files = e.target.files;
  await loadModelsFromDirectory(files);
}

// Loads all zip files from a directory and creates model entries
export async function loadModelsFromDirectory(files) {
  if (!files || files.length === 0) return;

  MultiModelState.models = []; // Clear existing models
  const zipFiles = Array.from(files).filter(file => file.name.toLowerCase().endsWith('.zip'));

  for (const zipFile of zipFiles) {
    try {
      const modelData = await loadZipFile(zipFile);
      if (modelData) {
        MultiModelState.models.push({
          name: zipFile.name.replace('.zip', ''),
          model: modelData.model,
          textures: modelData.textures
        });
      }
    } catch (error) {
      console.error(`Error loading zip file ${zipFile.name}:`, error);
    }
  }

  // If we loaded models, show the model selector and load the first model
  if (MultiModelState.models.length > 0) {
    createModelSelector();
    loadModelByIndex(0);
  }
}

// Create and display the model selector UI
export function createModelSelector() {
  if (MultiModelState.modelSelector) {
    MultiModelState.modelSelector.remove();
  }

  const container = document.querySelector('.viewer');
  if (!container || MultiModelState.models.length <= 1) return;

  const selectorDiv = document.createElement('div');
  selectorDiv.id = 'model-selector';
  selectorDiv.style.cssText = `
    margin: 10px 0;
    padding: 10px;
    background: #f5f5f5;
    border-radius: 5px;
  `;

  const label = document.createElement('label');
  label.textContent = 'Select Model: ';
  label.style.marginRight = '10px';

  const select = document.createElement('select');
  select.id = 'model-select';

  MultiModelState.models.forEach((model, index) => {
    const option = document.createElement('option');
    option.value = index;
    option.textContent = model.name;
    select.appendChild(option);
  });

  select.addEventListener('change', (e) => {
    loadModelByIndex(parseInt(e.target.value));
  });

  selectorDiv.appendChild(label);
  selectorDiv.appendChild(select);

  // Insert the selector above the viewer control
  const viewerControl = document.getElementById('viewer-control');
  if (viewerControl) {
    container.insertBefore(selectorDiv, viewerControl);
  } else {
    container.appendChild(selectorDiv);
  }

  MultiModelState.modelSelector = selectorDiv;
}

// Load a specific model by index
export function loadModelByIndex(index) {
  if (index < 0 || index >= MultiModelState.models.length) return;

  const modelData = MultiModelState.models[index];
  if (!modelData) return;

  MultiModelState.currentModelIndex = index;

  // Update the selector
  const select = document.getElementById('model-select');
  if (select) {
    select.value = index;
  }

  // Use the existing app functions to load the model
  if (window.App && window.App.loadModelWithTextures) {
    window.App.loadModelWithTextures(modelData.model, modelData.textures);
  }
}

// Get current loaded model data
export function getCurrentModel() {
  if (MultiModelState.currentModelIndex >= 0 && MultiModelState.currentModelIndex < MultiModelState.models.length) {
    return MultiModelState.models[MultiModelState.currentModelIndex];
  }
  return null;
}

// Clean up multi-model state
export function cleanup() {
  if (MultiModelState.modelSelector) {
    MultiModelState.modelSelector.remove();
    MultiModelState.modelSelector = null;
  }
  MultiModelState.models = [];
  MultiModelState.currentModelIndex = -1;
}

// Helper function to load a single zip file (extracted from app.js)
async function loadZipFile(zipFile, desiredBinRelativePath = null) {
  try {
    const JSZip = globalThis.JSZip;
    if (!JSZip) throw new Error('JSZip not available');

    const zip = new JSZip();
    const zipData = await zip.loadAsync(zipFile);

    let binFile = null;
    let basePath = '';

    if (desiredBinRelativePath) {
      const normalized = desiredBinRelativePath.replace(/^\/+/, '');
      const entry = zipData.files[normalized];
      if (entry && !entry.dir) {
        binFile = await entry.async('arraybuffer');
        const parts = normalized.split('/');
        basePath = parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : '';
      }
    }

    // If still not found, search for .bin file in root first
    if (!binFile) {
      for (const filename in zipData.files) {
        if (!zipData.files[filename].dir && filename.endsWith('.bin') && !filename.includes('/')) {
          binFile = await zipData.files[filename].async('arraybuffer');
          basePath = '';
          break;
        }
      }
    }

    // If not in root, search in 'obj/' directory
    if (!binFile) {
      for (const filename in zipData.files) {
        if (!zipData.files[filename].dir && filename.startsWith('obj/') && filename.endsWith('.bin')) {
          const pathParts = filename.split('/');
          if (pathParts.length === 2) { // e.g., "obj/model.bin"
            binFile = await zipData.files[filename].async('arraybuffer');
            basePath = 'obj/';
            break;
          }
        }
      }
    }

    if (!binFile) {
      console.log('No .bin file found in zip root or obj/ directory');
      return null;
    }

    const textureFiles = {};
    const textureDir1 = `${basePath}txt/`;
    const textureDir2 = `${basePath}txt16/`;
    for (const filename in zipData.files) {
      const file = zipData.files[filename];
      if (!file.dir && (filename.startsWith(textureDir1) || filename.startsWith(textureDir2))) {
        const blob = await file.async('blob');
        const name = filename.split('/').pop(); // Get just the filename
        textureFiles[name] = new File([blob], name);
      }
    }

    // Use the existing read_bin function from app.js
    const model = window.App?.read_bin(binFile);
    if (model) {
      return { model, textures: textureFiles };
    }

    return null;
  } catch (error) {
    console.error('Error loading zip file:', error);
    return null;
  }
}
