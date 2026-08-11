/**
 * Main application for 3D Posters
 * SVG Viewer with color simplification and 3D conversion
 * 
 * Architecture: Each button handler is isolated with its own state and dependencies.
 * Changes to one handler won't affect others.
 */

import * as THREE from 'three';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader';
import { ColorMap, ColorHeights, BoundingBox } from './types';
import {
  colorToRGB,
  rgbToHex,
  getContrastColor,
  weightedKMeansCluster,
  findClosestCluster,
} from './utils/color';
import {
  extractColorsFromSVG,
  countColorsInSVG,
  applyColorMap,
  formatFileSize,
  isLikelySVG,
  isValidSVGContent,
} from './utils/svg';
import {
  initThreeJS,
  clearThreeJSScene,
  addDefaultLights,
  calculateBoundingBox,
  positionCameraForScene,
  ThreeState,
} from './3d/three-setup';
import { create3DMeshesFromPaths, calculateScaleFactor } from './3d/svg-to-3d';
import { flattenSVG } from './utils/svg-flatten';
import { downloadSTL, getSTLStats, createScaledClone } from './3d/stl-export';

// ============================================================================
// DOM Elements - These are the only global DOM references
// ============================================================================
let fileInput: HTMLInputElement;
let dropArea: HTMLElement;
let svgDisplayOriginal: HTMLElement;
let svgDisplaySimplified: HTMLElement;
let svgDisplayFlattened: HTMLElement;
let flattenedContainer: HTMLElement;
let infoText: HTMLElement;
let colorCountText: HTMLElement;
let colorPaletteText: HTMLElement;
let colorCountInput: HTMLInputElement;
let create3DBtn: HTMLButtonElement;
let flattenBtn: HTMLButtonElement;
let exportSTLBtn: HTMLButtonElement;
let stlInfoText: HTMLElement;
let exportSizeContainer: HTMLElement;
let exportWidthInput: HTMLInputElement;
let exportHeightInput: HTMLInputElement;
let container3D: HTMLElement;
let colorHeightsContainer: HTMLElement;
let colorHeightsList: HTMLElement;
let layerHeightInput: HTMLInputElement;

// ============================================================================
// Current File State - Minimal shared state (only what's needed for UI display)
// ============================================================================
interface FileState {
  fileName: string;
  fileSize: number;
  originalSVGContent: string;
}

let fileState: FileState = {
  fileName: '',
  fileSize: 0,
  originalSVGContent: '',
};

// ============================================================================
// Three.js State - Managed separately from file processing
// ============================================================================
let threeState: ThreeState = {
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
};

// ============================================================================
// Isolated State for Each Feature
// ============================================================================

/** State for Simplify Colors feature */
interface SimplifyState {
  simplifiedSVGContent: string;
  colorMap: ColorMap;
  simplifiedColors: string[];
  colorHeights: ColorHeights;
}

let simplifyState: SimplifyState = {
  simplifiedSVGContent: '',
  colorMap: {},
  simplifiedColors: [],
  colorHeights: {},
};

/** State for Flatten SVG feature */
interface FlattenState {
  flattenedSVGContent: string;
}

let flattenState: FlattenState = {
  flattenedSVGContent: '',
};

/** State for 3D Structure feature */
interface StructureState {
  svgContentFor3D: string;
  colorsFor3D: string[];
  boundingBox: BoundingBox | null;
  scaleFactor: number;
  meshGroup: THREE.Group | null;
  aspectRatio: number;
}

let structureState: StructureState = {
  svgContentFor3D: '',
  colorsFor3D: [],
  boundingBox: null,
  scaleFactor: 1,
  meshGroup: null,
  aspectRatio: 1,
};

/** State for Export STL feature */
interface ExportState {
  exportWidthMM: number;
  exportHeightMM: number;
  layerHeightMM: number;
}

let exportState: ExportState = {
  exportWidthMM: 100,
  exportHeightMM: 100,
  layerHeightMM: 0.2,
};

// ============================================================================
// Utility Functions
// ============================================================================

/** Reset all feature states to initial values */
function resetAllFeatureStates(): void {
  simplifyState = {
    simplifiedSVGContent: '',
    colorMap: {},
    simplifiedColors: [],
    colorHeights: {},
  };
  flattenState = {
    flattenedSVGContent: '',
  };
  structureState = {
    svgContentFor3D: '',
    colorsFor3D: [],
    boundingBox: null,
    scaleFactor: 1,
    meshGroup: null,
    aspectRatio: 1,
  };
}

/** Update UI button states based on what features are available */
function updateUIState(): void {
  flattenBtn.disabled = !simplifyState.simplifiedSVGContent;
  create3DBtn.disabled = !simplifyState.simplifiedSVGContent;
  exportSTLBtn.disabled = !structureState.meshGroup;
  flattenedContainer.style.display = flattenState.flattenedSVGContent ? 'block' : 'none';
  colorHeightsContainer.style.display = simplifyState.simplifiedColors.length > 0 ? 'block' : 'none';
  container3D.style.display = structureState.meshGroup ? 'block' : 'none';
  if (exportSizeContainer) {
    exportSizeContainer.style.display = structureState.boundingBox ? 'block' : 'none';
  }
}

// ============================================================================
// Pure Business Logic Functions (No side effects, isolated)
// ============================================================================

/**
 * Pure function: Simplify colors in SVG content
 * Takes input, returns output - no global state modifications
 */
function simplifyColorsPure(
  svgContent: string,
  targetColorCount: number
): { simplifiedSVG: string; colorMap: ColorMap; colors: string[] } | null {
  if (!svgContent) return null;
  if (targetColorCount < 1 || targetColorCount > 256) return null;

  const colorCounts = countColorsInSVG(svgContent);
  const allColors = Object.keys(colorCounts);
  const weights = allColors.map((c) => colorCounts[c]);

  if (allColors.length <= 1) return null;

  const rgbColors = allColors.map((c) => colorToRGB(c));

  if (targetColorCount >= rgbColors.length) return null;

  const clusters = weightedKMeansCluster(rgbColors, weights, targetColorCount, 20);

  const colorMap: ColorMap = {};
  allColors.forEach((color, index) => {
    const rgb = rgbColors[index];
    const closestCluster = findClosestCluster(rgb, clusters);
    const newColor = rgbToHex(clusters[closestCluster]);
    colorMap[color] = newColor;
  });

  const simplifiedSVG = applyColorMap(svgContent, colorMap);
  const colors = extractColorsFromSVG(simplifiedSVG);

  return { simplifiedSVG, colorMap, colors };
}

/**
 * Pure function: Flatten SVG content
 * @param svgContent - SVG to flatten
 * @param palette - Palette (hex strings) to snap pixels to, from the Simplify step
 */
async function flattenSVGPure(
  svgContent: string,
  palette?: string[]
): Promise<string | null> {
  if (!svgContent) return null;
  try {
    return await flattenSVG(svgContent, palette);
  } catch (error) {
    console.error('Error flattening SVG:', error);
    return null;
  }
}

/**
 * Pure function: Create 3D meshes from SVG paths
 */
async function create3DPure(
  svgContent: string,
  colorHeights: ColorHeights,
  layerHeightMM: number
): Promise<{
  meshGroup: THREE.Group;
  boundingBox: BoundingBox;
  scaleFactor: number;
  colors: string[];
  aspectRatio: number;
} | null> {
  if (!svgContent) return null;

  const loader = new SVGLoader();
  let svgData;
  try {
    svgData = loader.parse(svgContent);
  } catch (e) {
    console.error('Error parsing SVG:', e);
    return null;
  }

  const paths = svgData.paths;
  if (!paths || paths.length === 0) {
    console.warn('No paths found in parsed SVG');
    return null;
  }

  const boundingBox = calculateBoundingBox(paths);
  const scaleFactor = calculateScaleFactor(boundingBox);
  const colors = extractColorsFromSVG(svgContent);

  const aspectRatio = boundingBox.width > 0 && boundingBox.height > 0
    ? boundingBox.width / boundingBox.height
    : 1;

  const group = create3DMeshesFromPaths(
    paths,
    colorHeights,
    colors,
    scaleFactor,
    boundingBox,
    layerHeightMM
  );

  return { meshGroup: group, boundingBox, scaleFactor, colors, aspectRatio };
}

// ============================================================================
// Feature-Specific Handlers (Each manages its own state)
// ============================================================================

/**
 * HANDLER: Simplify Colors
 * Isolated: Only modifies simplifyState, reads fileState
 */
function handleSimplifyColors(): void {
  console.log('Simplify Colors handler - START');

  const targetCount = parseInt(colorCountInput.value);
  if (targetCount < 1 || targetCount > 256) {
    alert('Please enter a number between 1 and 256');
    return;
  }

  if (!fileState.originalSVGContent) {
    alert('Please load an SVG first');
    return;
  }

  const result = simplifyColorsPure(fileState.originalSVGContent, targetCount);
  
  if (!result) {
    alert('Could not simplify colors. Check that the SVG has more than one color.');
    return;
  }

  simplifyState.simplifiedSVGContent = result.simplifiedSVG;
  simplifyState.colorMap = result.colorMap;
  simplifyState.simplifiedColors = result.colors;

  simplifyState.colorHeights = {};
  result.colors.forEach((color) => {
    simplifyState.colorHeights[color] = 1;
  });

  svgDisplaySimplified.innerHTML = simplifyState.simplifiedSVGContent;
  
  const count = simplifyState.simplifiedColors.length;
  colorCountText.textContent = count === 1 ? `1 color (simplified)` : `${count} colors (simplified)`;
  
  colorPaletteText.innerHTML =
    'Palette: ' +
    simplifyState.simplifiedColors
      .map((c) => `<span style="background:${c}; color:${getContrastColor(c)}; padding:2px 6px; margin:0 2px; border-radius:3px;">${c}</span>`)
      .join('');

  updateColorHeightsDisplay();
  updateUIState();
  
  flattenState.flattenedSVGContent = '';
  svgDisplayFlattened.innerHTML = '';
  structureState.svgContentFor3D = '';
  structureState.meshGroup = null;
  
  console.log('Simplify Colors handler - COMPLETE');
}

/**
 * HANDLER: Flatten SVG
 * Isolated: Reads simplifyState, writes flattenState only
 */
async function handleFlattenSVG(): Promise<void> {
  console.log('Flatten SVG handler - START');

  if (!simplifyState.simplifiedSVGContent) {
    alert('Please simplify the colors first');
    return;
  }

  const flattened = await flattenSVGPure(
    simplifyState.simplifiedSVGContent,
    simplifyState.simplifiedColors
  );
  
  if (!flattened) {
    alert('Failed to flatten SVG');
    return;
  }

  flattenState.flattenedSVGContent = flattened;

  svgDisplayFlattened.innerHTML = flattenState.flattenedSVGContent;
  
  simplifyState.simplifiedSVGContent = flattenState.flattenedSVGContent;
  svgDisplaySimplified.innerHTML = flattenState.flattenedSVGContent;

  updateUIState();
  
  console.log('Flatten SVG handler - COMPLETE');
}

/**
 * HANDLER: Create 3D Structure
 * Isolated: Reads simplifyState and exportState, writes structureState
 */
async function handleCreate3DStructure(): Promise<void> {
  console.log('Create 3D Structure handler - START');

  if (!simplifyState.simplifiedSVGContent) {
    alert('Please simplify the colors first');
    return;
  }

  let svgFor3D = simplifyState.simplifiedSVGContent;
  
  try {
    const result = await create3DPure(
      svgFor3D,
      simplifyState.colorHeights,
      exportState.layerHeightMM
    );
    
    if (!result) {
      alert('Failed to create 3D structure');
      return;
    }

    structureState.svgContentFor3D = svgFor3D;
    structureState.colorsFor3D = result.colors;
    structureState.boundingBox = result.boundingBox;
    structureState.scaleFactor = result.scaleFactor;
    structureState.meshGroup = result.meshGroup;
    structureState.aspectRatio = result.aspectRatio;

  if (!threeState.scene) {
    threeState = initThreeJS(container3D);
  }

  clearThreeJSScene(threeState);
  if (threeState.scene) {
    addDefaultLights(threeState.scene);
    threeState.scene.add(result.meshGroup);
  }

  if (threeState.camera && threeState.scene && result.boundingBox) {
    positionCameraForScene(threeState.camera, result.boundingBox, result.scaleFactor);
  }

  if (result.boundingBox.width > 0 && result.boundingBox.height > 0) {
    const defaultSize = 100;
    if (result.boundingBox.width > result.boundingBox.height) {
      exportState.exportWidthMM = defaultSize;
      exportState.exportHeightMM = defaultSize / result.aspectRatio;
    } else {
      exportState.exportHeightMM = defaultSize;
      exportState.exportWidthMM = defaultSize * result.aspectRatio;
    }
    
    if (exportWidthInput) {
      exportWidthInput.value = exportState.exportWidthMM.toFixed(1);
    }
    if (exportHeightInput) {
      exportHeightInput.value = exportState.exportHeightMM.toFixed(1);
    }
  }

  updateUIState();
  if (exportSizeContainer) exportSizeContainer.style.display = 'block';
  
  console.log('Create 3D Structure handler - COMPLETE');
  
  } catch (error) {
    console.error('Error in create3DStructure:', error);
    alert('Error creating 3D structure: ' + (error as Error).message);
  }
}

/**
 * HANDLER: Export STL
 * Isolated: Reads structureState and exportState only
 */
function handleExportSTL(): void {
  console.log('Export STL handler - START');

  if (!structureState.meshGroup) {
    alert('Please create a 3D structure first');
    return;
  }

  if (!structureState.boundingBox) {
    alert('SVG bounding box not available');
    return;
  }

  const fileName = '3d-poster';

  const scaledGroup = createScaledClone(
    structureState.meshGroup,
    structureState.boundingBox,
    structureState.scaleFactor,
    exportState.exportWidthMM,
    exportState.exportHeightMM
  );

  const stats = getSTLStats(scaledGroup);
  
  if (stats.faceCount === 0) {
    alert('No geometry found to export');
    return;
  }

  if (stlInfoText) {
    stlInfoText.textContent = `Exporting ${stats.faceCount} faces (${exportState.exportWidthMM}mm x ${exportState.exportHeightMM}mm) as STL...`;
  }

  downloadSTL(scaledGroup, {
    format: 'binary',
    fileName: fileName,
  });

  scaledGroup.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
    }
  });

  if (stlInfoText) {
    setTimeout(() => {
      stlInfoText.textContent = `Last export: ${stats.faceCount} faces, ${stats.meshCount} meshes (${exportState.exportWidthMM}mm x ${exportState.exportHeightMM}mm)`;
    }, 500);
  }
  
  console.log('Export STL handler - COMPLETE');
}

/**
 * HANDLER: Clear everything
 */
function handleClearSVG(): void {
  console.log('Clear handler - START');

  fileState = { fileName: '', fileSize: 0, originalSVGContent: '' };
  resetAllFeatureStates();

  if (threeState.scene) {
    clearThreeJSScene(threeState);
    threeState = { scene: null, camera: null, renderer: null, controls: null };
  }

  exportState = { exportWidthMM: 100, exportHeightMM: 100, layerHeightMM: 0.2 };

  svgDisplayOriginal.innerHTML = '';
  svgDisplaySimplified.innerHTML = '';
  svgDisplayFlattened.innerHTML = '';
  infoText.textContent = 'No SVG loaded yet';
  colorCountText.textContent = '';
  colorPaletteText.textContent = '';
  colorHeightsList.innerHTML = '';
  
  if (fileInput) fileInput.value = '';
  container3D.style.display = 'none';
  flattenedContainer.style.display = 'none';
  colorHeightsContainer.style.display = 'none';
  if (exportSizeContainer) exportSizeContainer.style.display = 'none';
  if (layerHeightInput) layerHeightInput.value = '0.2';
  if (exportWidthInput) exportWidthInput.value = '100';
  if (exportHeightInput) exportHeightInput.value = '100';
  if (stlInfoText) stlInfoText.textContent = '';

  updateUIState();
  
  console.log('Clear handler - COMPLETE');
}

/**
 * HANDLER: Load and display SVG file
 */
function handleDisplaySVG(file: File): void {
  console.log('Display SVG handler - START');

  if (!isLikelySVG(file)) {
    infoText.textContent = 'Please select an SVG file';
    svgDisplayOriginal.innerHTML = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    const content = e.target?.result as string;

    if (!content || !isValidSVGContent(content)) {
      infoText.textContent = 'File does not appear to be valid SVG';
      svgDisplayOriginal.innerHTML = '';
      svgDisplaySimplified.innerHTML = '';
      svgDisplayFlattened.innerHTML = '';
      container3D.style.display = 'none';
      flattenedContainer.style.display = 'none';
      colorHeightsContainer.style.display = 'none';
      colorHeightsList.innerHTML = '';
      if (exportSizeContainer) exportSizeContainer.style.display = 'none';
      resetAllFeatureStates();
      updateUIState();
      return;
    }

    fileState = {
      fileName: file.name,
      fileSize: file.size,
      originalSVGContent: content,
    };

    svgDisplayOriginal.innerHTML = content;
    svgDisplaySimplified.innerHTML = '';
    svgDisplayFlattened.innerHTML = '';
    infoText.textContent = `Loaded: ${file.name} (${formatFileSize(file.size)})`;

    const colors = extractColorsFromSVG(content);
    const count = colors.length;
    colorCountText.textContent = count === 1 ? `1 color` : `${count} colors`;
    colorPaletteText.textContent = '';

    resetAllFeatureStates();
    
    container3D.style.display = 'none';
    flattenedContainer.style.display = 'none';
    colorHeightsContainer.style.display = 'none';
    colorHeightsList.innerHTML = '';
    if (exportSizeContainer) exportSizeContainer.style.display = 'none';
    if (stlInfoText) stlInfoText.textContent = '';

    updateUIState();
    
    console.log('Display SVG handler - COMPLETE');
  };

  reader.onerror = () => {
    infoText.textContent = 'Error reading file';
    svgDisplayOriginal.innerHTML = '';
    svgDisplaySimplified.innerHTML = '';
    svgDisplayFlattened.innerHTML = '';
    container3D.style.display = 'none';
    flattenedContainer.style.display = 'none';
    colorHeightsContainer.style.display = 'none';
    colorHeightsList.innerHTML = '';
    if (exportSizeContainer) exportSizeContainer.style.display = 'none';
    resetAllFeatureStates();
    updateUIState();
  };

  reader.readAsText(file);
}

// ============================================================================
// UI Helper Functions
// ============================================================================

function updateColorHeightsDisplay(): void {
  const colors = Object.keys(simplifyState.colorHeights);
  colorHeightsList.innerHTML = colors
    .map((color) => {
      const layers = simplifyState.colorHeights[color];
      const heightMM = exportState.layerHeightMM * layers;
      return `
        <div style="display: flex; align-items: center; margin: 5px 0; gap: 10px;">
          <span style="background:${color}; color:${getContrastColor(color)}; padding:2px 6px; border-radius:3px; min-width: 60px;">${color}</span>
          <input type="number" value="${layers}" min="0" step="1" 
                 onchange="window.setColorHeight('${color}', this.value)" 
                 style="width: 60px;" /> layers
          <span style="color: #888; font-size: 12px;">= ${heightMM.toFixed(2)} mm</span>
        </div>
      `;
    })
    .join('');
}

function updateExportSize(changed: 'width' | 'height', value: number): void {
  if (value < 1 || value > 10000) return;

  const aspectRatio = structureState.aspectRatio || 1;

  if (changed === 'width') {
    exportState.exportWidthMM = value;
    exportState.exportHeightMM = value / aspectRatio;
  } else {
    exportState.exportHeightMM = value;
    exportState.exportWidthMM = value * aspectRatio;
  }

  if (exportWidthInput) {
    exportWidthInput.value = exportState.exportWidthMM.toFixed(1);
  }
  if (exportHeightInput) {
    exportHeightInput.value = exportState.exportHeightMM.toFixed(1);
  }
}

function handleSetColorHeight(color: string, height: string): void {
  simplifyState.colorHeights[color] = parseInt(height, 10);
  updateColorHeightsDisplay();
}

function previewColorSimplification(): void {
  if (!fileState.originalSVGContent) return;

  const targetCount = parseInt(colorCountInput.value);
  if (targetCount < 1 || targetCount > 256) {
    colorPaletteText.textContent = '';
    return;
  }

  const colorCounts = countColorsInSVG(fileState.originalSVGContent);
  const allColors = Object.keys(colorCounts);
  const weights = allColors.map((c) => colorCounts[c]);

  if (allColors.length <= 1) {
    colorPaletteText.textContent = '';
    return;
  }

  const rgbColors = allColors.map((c) => colorToRGB(c));

  if (targetCount >= rgbColors.length) {
    colorPaletteText.textContent = '';
    return;
  }

  const clusters = weightedKMeansCluster(rgbColors, weights, targetCount, 20);
  const paletteColors = clusters.map((c) => rgbToHex(c));

  colorPaletteText.innerHTML =
    'Preview palette: ' +
    paletteColors
      .map((c) => `<span style="background:${c}; color:${getContrastColor(c)}; padding:2px 6px; margin:0 2px; border-radius:3px;">${c}</span>`)
      .join('');
}

function highlight(e: Event): void {
  dropArea.classList.add('drag-over');
  e.preventDefault();
}

function unhighlight(e: Event): void {
  dropArea.classList.remove('drag-over');
  e.preventDefault();
}

// ============================================================================
// Initialization
// ============================================================================

function initEventListeners(): void {
  colorCountInput.addEventListener('change', previewColorSimplification);

  if (exportWidthInput && exportHeightInput) {
    exportWidthInput.addEventListener('change', (e) => updateExportSize('width', parseFloat((e.target as HTMLInputElement).value)));
    exportHeightInput.addEventListener('change', (e) => updateExportSize('height', parseFloat((e.target as HTMLInputElement).value)));
  }

  if (layerHeightInput) {
    layerHeightInput.addEventListener('change', (e) => {
      exportState.layerHeightMM = parseFloat((e.target as HTMLInputElement).value);
      updateColorHeightsDisplay();
    });
  }

  fileInput.addEventListener('change', (e: Event) => {
    const target = e.target as HTMLInputElement;
    if (target.files && target.files.length > 0) {
      handleDisplaySVG(target.files[0]);
    }
  });

  ['dragenter', 'dragover'].forEach((eventName) => {
    dropArea.addEventListener(eventName, highlight, false);
  });

  ['dragleave', 'drop'].forEach((eventName) => {
    dropArea.addEventListener(eventName, unhighlight, false);
  });

  dropArea.addEventListener('drop', (e) => {
    e.preventDefault();
    const dt = e.dataTransfer;
    const files = dt ? dt.files : [];
    if (files.length > 0) {
      handleDisplaySVG(files[0]);
    }
  }, false);

  dropArea.addEventListener('click', () => {
    fileInput.click();
  });
}

function initApp(): void {
  fileInput = document.getElementById('file-input') as HTMLInputElement;
  dropArea = document.getElementById('drop-area') as HTMLElement;
  svgDisplayOriginal = document.getElementById('svg-display-original') as HTMLElement;
  svgDisplaySimplified = document.getElementById('svg-display-simplified') as HTMLElement;
  svgDisplayFlattened = document.getElementById('svg-display-flattened') as HTMLElement;
  flattenedContainer = document.getElementById('flattened-container') as HTMLElement;
  infoText = document.getElementById('info') as HTMLElement;
  colorCountText = document.getElementById('color-count') as HTMLElement;
  colorPaletteText = document.getElementById('color-palette') as HTMLElement;
  colorCountInput = document.getElementById('color-count-input') as HTMLInputElement;
  create3DBtn = document.getElementById('create-3d-btn') as HTMLButtonElement;
  flattenBtn = document.getElementById('flatten-btn') as HTMLButtonElement;
  exportSTLBtn = document.getElementById('export-stl-btn') as HTMLButtonElement;
  stlInfoText = document.getElementById('stl-info') as HTMLElement;
  exportSizeContainer = document.getElementById('export-size-container') as HTMLElement;
  exportWidthInput = document.getElementById('export-width') as HTMLInputElement;
  exportHeightInput = document.getElementById('export-height') as HTMLInputElement;
  container3D = document.getElementById('3d-container') as HTMLElement;
  colorHeightsContainer = document.getElementById('color-heights-container') as HTMLElement;
  colorHeightsList = document.getElementById('color-heights-list') as HTMLElement;
  layerHeightInput = document.getElementById('layer-height') as HTMLInputElement;

  if (layerHeightInput) {
    layerHeightInput.value = String(exportState.layerHeightMM);
  }

  if (exportWidthInput && exportHeightInput) {
    exportWidthInput.value = String(exportState.exportWidthMM);
    exportHeightInput.value = String(exportState.exportHeightMM);
  }

  create3DBtn.disabled = true;
  flattenBtn.disabled = true;
  exportSTLBtn.disabled = true;
  flattenedContainer.style.display = 'none';
  colorHeightsContainer.style.display = 'none';
  container3D.style.display = 'none';
  if (stlInfoText) stlInfoText.textContent = '';
  if (exportSizeContainer) exportSizeContainer.style.display = 'none';

  initEventListeners();

  appInitialized = true;
  console.log('3D Posters app initialized');
}

// ============================================================================
// Global Interface (only for HTML inline handlers)
// ============================================================================

let appInitialized = false;

window.selectSVGFile = () => {
  const input = document.getElementById('file-input') as HTMLInputElement | null;
  if (input) input.click();
};

window.setColorHeight = (color: string, height: string) => {
  if (appInitialized) {
    handleSetColorHeight(color, height);
  }
};

window.simplifyColors = () => {
  if (appInitialized) {
    handleSimplifyColors();
  }
};

window.flattenSVG = async () => {
  if (appInitialized) {
    await handleFlattenSVG();
  }
};

window.create3DStructure = async () => {
  if (appInitialized) {
    await handleCreate3DStructure();
  }
};

window.clearSVG = () => {
  if (appInitialized) {
    handleClearSVG();
  }
};

window.exportSTL = () => {
  if (appInitialized) {
    handleExportSTL();
  }
};

declare global {
  interface Window {
    setColorHeight: (color: string, height: string) => void;
    simplifyColors: () => void;
    flattenSVG: () => Promise<void>;
    create3DStructure: () => Promise<void>;
    clearSVG: () => void;
    exportSTL: () => void;
    selectSVGFile: () => void;
  }
}

document.addEventListener('DOMContentLoaded', initApp);
