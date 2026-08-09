/**
 * Main application for 3D Posters
 * SVG Viewer with color simplification and 3D conversion
 */

import * as THREE from 'three';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader';
import { AppState } from './types';
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

// DOM Elements
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

// Application State
let state: AppState = {
  originalSVGContent: '',
  simplifiedSVGContent: '',
  flattenedSVGContent: '',
  originalColors: [],
  colorMap: {},
  colorHeights: {},
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  meshGroup: null,
  exportWidthMM: 100,
  exportHeightMM: 100,
  originalAspectRatio: 1,
  svgBoundingBox: null,
  svgScaleFactor: 1,
};

let threeState: ThreeState = {
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
};

/**
 * Initialize the application
 */
function initApp(): void {
  // Get DOM elements
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

  // Initialize event listeners
  initEventListeners();

  // Initial UI state
  create3DBtn.disabled = true;
  flattenBtn.disabled = true;
  exportSTLBtn.disabled = true;
  flattenedContainer.style.display = 'none';
  colorHeightsContainer.style.display = 'none';
  container3D.style.display = 'none';
  if (stlInfoText) stlInfoText.textContent = '';
  if (exportSizeContainer) exportSizeContainer.style.display = 'none';

  // Initialize export size inputs
  if (exportWidthInput && exportHeightInput) {
    exportWidthInput.value = String(state.exportWidthMM);
    exportHeightInput.value = String(state.exportHeightMM);
  }

  // Mark app as initialized so window functions work
  appInitialized = true;

  console.log('3D Posters app initialized');
}

/**
 * Initialize event listeners
 */
function initEventListeners(): void {
  // Preview colors when input changes
  colorCountInput.addEventListener('change', previewColorSimplification);

  // Export size inputs - maintain aspect ratio
  if (exportWidthInput && exportHeightInput) {
    exportWidthInput.addEventListener('change', (e) => updateExportSize('width', parseFloat((e.target as HTMLInputElement).value)));
    exportHeightInput.addEventListener('change', (e) => updateExportSize('height', parseFloat((e.target as HTMLInputElement).value)));
  }


  // Handle file selection
  fileInput.addEventListener('change', (e: Event) => {
    const target = e.target as HTMLInputElement;
    if (target.files && target.files.length > 0) {
      displaySVG(target.files[0]);
    }
  });

  // Drag and drop events
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
      displaySVG(files[0]);
    }
  }, false);

  // Click on drop area to open file dialog
  dropArea.addEventListener('click', () => {
    fileInput.click();
  });
}

/**
 * Highlight drop area on drag over
 */
function highlight(e: Event): void {
  dropArea.classList.add('drag-over');
  e.preventDefault();
}

/**
 * Unhighlight drop area on drag leave
 */
function unhighlight(e: Event): void {
  dropArea.classList.remove('drag-over');
  e.preventDefault();
}

/**
 * Display an SVG file
 */
function displaySVG(file: File): void {
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
      colorCountText.textContent = '';
      colorPaletteText.textContent = '';
      state.originalSVGContent = '';
      state.simplifiedSVGContent = '';
      state.flattenedSVGContent = '';
      state.originalColors = [];
      state.colorMap = {};
      container3D.style.display = 'none';
      flattenedContainer.style.display = 'none';
      colorHeightsContainer.style.display = 'none';
      colorHeightsList.innerHTML = '';
      state.colorHeights = {};
      create3DBtn.disabled = true;
      flattenBtn.disabled = true;
      return;
    }

    state.originalSVGContent = content;
    state.simplifiedSVGContent = '';
    state.flattenedSVGContent = '';
    svgDisplayOriginal.innerHTML = content;
    svgDisplaySimplified.innerHTML = '';
    svgDisplayFlattened.innerHTML = '';
    flattenedContainer.style.display = 'none';
    infoText.textContent = `Loaded: ${file.name} (${formatFileSize(file.size)})`;

    // Count colors
    state.originalColors = extractColorsFromSVG(content);
    const count = state.originalColors.length;
    colorCountText.textContent = count === 1 ? `1 color` : `${count} colors`;
    colorPaletteText.textContent = '';

    // Reset color map
    state.colorMap = {};
    state.meshGroup = null;
    state.svgBoundingBox = null;
    state.svgScaleFactor = 1;
    state.originalAspectRatio = 1;
    container3D.style.display = 'none';
    flattenedContainer.style.display = 'none';
    colorHeightsContainer.style.display = 'none';
    colorHeightsList.innerHTML = '';
    if (exportSizeContainer) exportSizeContainer.style.display = 'none';
    state.colorHeights = {};
    create3DBtn.disabled = true;
    flattenBtn.disabled = true;
    exportSTLBtn.disabled = true;
    if (stlInfoText) stlInfoText.textContent = '';
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
    state.colorHeights = {};
    state.meshGroup = null;
    state.svgBoundingBox = null;
    state.svgScaleFactor = 1;
    state.originalAspectRatio = 1;
    create3DBtn.disabled = true;
    flattenBtn.disabled = true;
    exportSTLBtn.disabled = true;
    if (stlInfoText) stlInfoText.textContent = '';
  };

  reader.readAsText(file);
}

/**
 * Preview what colors will remain after simplification
 */
function previewColorSimplification(): void {
  if (!state.originalSVGContent) return;

  const targetCount = parseInt(colorCountInput.value);
  if (targetCount < 1 || targetCount > 256) {
    colorPaletteText.textContent = '';
    return;
  }

  // Extract all colors with their frequencies
  const colorCounts = countColorsInSVG(state.originalSVGContent);
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

  // Cluster colors using weighted k-means
  const clusters = weightedKMeansCluster(rgbColors, weights, targetCount, 20);

  // Get the resulting palette colors
  const paletteColors = clusters.map((c) => rgbToHex(c));

  // Show the preview palette
  colorPaletteText.innerHTML =
    'Preview palette: ' +
    paletteColors
      .map((c) => `<span style="background:${c}; color:${getContrastColor(c)}; padding:2px 6px; margin:0 2px; border-radius:3px;">${c}</span>`)
      .join('');
}

/**
 * Simplify colors to a target number
 */
function simplifyColorsInternal(): void {
  if (!state.originalSVGContent) {
    alert('Please load an SVG first');
    return;
  }

  const targetCount = parseInt(colorCountInput.value);
  if (targetCount < 1 || targetCount > 256) {
    alert('Please enter a number between 1 and 256');
    return;
  }

  // Extract all colors with their frequencies
  const colorCounts = countColorsInSVG(state.originalSVGContent);
  const allColors = Object.keys(colorCounts);
  const weights = allColors.map((c) => colorCounts[c]);

  if (allColors.length <= 1) return;

  const rgbColors = allColors.map((c) => colorToRGB(c));

  // If target is >= current colors, no need to simplify
  if (targetCount >= rgbColors.length) {
    alert('Target color count is not less than current colors');
    return;
  }

  // Cluster colors using weighted k-means
  const clusters = weightedKMeansCluster(rgbColors, weights, targetCount, 20);

  // Create color mapping
  state.colorMap = {};
  allColors.forEach((color, index) => {
    const rgb = rgbColors[index];
    const closestCluster = findClosestCluster(rgb, clusters);
    const newColor = rgbToHex(clusters[closestCluster]);
    state.colorMap[color] = newColor;
  });

  // Apply the color replacements to the SVG
  state.simplifiedSVGContent = applyColorMap(state.originalSVGContent, state.colorMap);
  svgDisplaySimplified.innerHTML = state.simplifiedSVGContent;

  // Update color count and palette
  const newColors = extractColorsFromSVG(state.simplifiedSVGContent);
  const count = newColors.length;
  colorCountText.textContent = count === 1 ? `1 color (simplified)` : `${count} colors (simplified)`;

  // Show the actual color palette from simplified SVG
  colorPaletteText.innerHTML =
    'Palette: ' +
    newColors
      .map((c) => `<span style="background:${c}; color:${getContrastColor(c)}; padding:2px 6px; margin:0 2px; border-radius:3px;">${c}</span>`)
      .join('');

  // Setup color heights UI
  state.colorHeights = {};
  colorHeightsList.innerHTML = newColors
    .map((color) => {
      state.colorHeights[color] = 1; // Default height: 1mm
      return `
        <div style="display: flex; align-items: center; margin: 5px 0; gap: 10px;">
          <span style="background:${color}; color:${getContrastColor(color)}; padding:2px 6px; border-radius:3px; min-width: 60px;">${color}</span>
          <input type="number" value="1" min="0.1" step="0.1" 
                 onchange="window.setColorHeight('${color}', this.value)" 
                 style="width: 60px;" /> mm
        </div>
      `;
    })
    .join('');
  colorHeightsContainer.style.display = 'block';

  // Enable the flatten and 3D buttons
  flattenBtn.disabled = false;
  create3DBtn.disabled = false;
  state.flattenedSVGContent = '';
  svgDisplayFlattened.innerHTML = '';
  flattenedContainer.style.display = 'none';
}

/**
 * Set height for a specific color
 */
function setColorHeightInternal(color: string, height: string): void {
  state.colorHeights[color] = parseFloat(height);
}

/**
 * Update export size while maintaining aspect ratio
 * @param changed - Which dimension was changed ('width' or 'height')
 * @param value - The new value in mm
 */
function updateExportSize(changed: 'width' | 'height', value: number): void {
  if (value < 1 || value > 10000) return;

  const aspectRatio = state.originalAspectRatio;

  if (changed === 'width') {
    state.exportWidthMM = value;
    state.exportHeightMM = value / aspectRatio;
  } else {
    state.exportHeightMM = value;
    state.exportWidthMM = value * aspectRatio;
  }

  // Update both input fields
  if (exportWidthInput) {
    exportWidthInput.value = state.exportWidthMM.toFixed(1);
  }
  if (exportHeightInput) {
    exportHeightInput.value = state.exportHeightMM.toFixed(1);
  }
}

// Expose to global scope for inline event handlers
declare global {
  interface Window {
    setColorHeight: (color: string, height: string) => void;
    simplifyColors: () => void;
    flattenSVG: () => void;
    create3DStructure: () => void;
    clearSVG: () => void;
    exportSTL: () => void;
    selectSVGFile: () => void;
  }
}

// Flag to track if app is initialized
let appInitialized = false;

// Expose selectSVGFile to global scope immediately
// This is safe to call even before DOM is ready
window.selectSVGFile = () => {
  const input = document.getElementById('file-input') as HTMLInputElement | null;
  if (input) input.click();
};

// Wrapper functions that check if app is initialized
// These are safe to call from inline event handlers
window.setColorHeight = (color: string, height: string) => {
  if (appInitialized && typeof setColorHeightInternal === 'function') {
    setColorHeightInternal(color, height);
  }
};

window.simplifyColors = () => {
  if (appInitialized && typeof simplifyColorsInternal === 'function') {
    simplifyColorsInternal();
  }
};

window.create3DStructure = async () => {
  if (appInitialized && typeof create3DStructureInternal === 'function') {
    await create3DStructureInternal();
  }
};

window.clearSVG = () => {
  if (appInitialized && typeof clearSVGInternal === 'function') {
    clearSVGInternal();
  }
};

window.flattenSVG = async () => {
  if (appInitialized && typeof flattenSVGInternal === 'function') {
    await flattenSVGInternal();
  }
};

window.exportSTL = () => {
  if (appInitialized && typeof exportSTLInternal === 'function') {
    exportSTLInternal();
  }
};

/**
 * Flatten SVG to remove overlaps and merge same-color regions
 */
async function flattenSVGInternal(): Promise<void> {
  if (!state.simplifiedSVGContent) {
    alert('Please simplify the colors first');
    return;
  }

  console.log('Flattening SVG...');
  
  try {
    // Flatten the simplified SVG
    state.flattenedSVGContent = await flattenSVG(state.simplifiedSVGContent);
    
    // Display the flattened SVG
    svgDisplayFlattened.innerHTML = state.flattenedSVGContent;
    flattenedContainer.style.display = 'block';
    
    console.log('SVG flattened successfully');
    
    // Use flattened SVG for 3D conversion
    state.simplifiedSVGContent = state.flattenedSVGContent;
    svgDisplaySimplified.innerHTML = state.flattenedSVGContent;
    
  } catch (error) {
    console.error('Error flattening SVG:', error);
    alert('Error flattening SVG: ' + (error as Error).message);
  }
}

/**
 * Create 3D structure from simplified SVG
 */
async function create3DStructureInternal(): Promise<void> {
  if (!state.simplifiedSVGContent) {
    alert('Please simplify the colors first');
    return;
  }

  // If not yet flattened, flatten automatically
  if (!state.flattenedSVGContent) {
    console.log('Auto-flattening before 3D creation...');
    try {
      const flattened = await flattenSVG(state.simplifiedSVGContent);
      state.flattenedSVGContent = flattened;
      state.simplifiedSVGContent = flattened;
      svgDisplaySimplified.innerHTML = flattened;
      svgDisplayFlattened.innerHTML = flattened;
      flattenedContainer.style.display = 'block';
    } catch (error) {
      console.error('Auto-flattening failed:', error);
      alert('Auto-flattening failed: ' + (error as Error).message);
      return;
    }
  }

  // Show the 3D container
  container3D.style.display = 'block';

  // Initialize Three.js if not already done
  if (!threeState.scene) {
    threeState = initThreeJS(container3D);
    state.scene = threeState.scene;
    state.camera = threeState.camera;
    state.renderer = threeState.renderer;
    state.controls = threeState.controls;
  }

  // Clear existing 3D scene
  clearThreeJSScene(threeState);

  // Re-add lights
  if (threeState.scene) {
    addDefaultLights(threeState.scene);
  }

  // Parse the SVG content
  const loader = new SVGLoader();
  let svgData;
  try {
    svgData = loader.parse(state.simplifiedSVGContent);
  } catch (e) {
    console.error('Error parsing SVG:', e);
    alert('Error parsing SVG: ' + (e as Error).message);
    return;
  }

  const paths = svgData.paths;
  if (!paths || paths.length === 0) {
    console.warn('No paths found in parsed SVG');
    alert('No paths found in SVG');
    return;
  }

  console.log(`Found ${paths.length} paths in SVG`);

  // Calculate bounding box from all paths
  const boundingBox = calculateBoundingBox(paths);

  // Store bounding box and scale factor for later export
  state.svgBoundingBox = boundingBox;

  // Store aspect ratio for export size
  if (boundingBox.width > 0 && boundingBox.height > 0) {
    state.originalAspectRatio = boundingBox.width / boundingBox.height;
    console.log(`SVG aspect ratio: ${state.originalAspectRatio.toFixed(4)}`);
  } else {
    state.originalAspectRatio = 1;
  }

  // Show export size container
  if (exportSizeContainer) {
    exportSizeContainer.style.display = 'block';
  }

  // Calculate scale factor: make the larger dimension ~100 units in Three.js space for better visibility
  const scaleFactor = calculateScaleFactor(boundingBox);
  state.svgScaleFactor = scaleFactor;
  console.log(`SVG dimensions: ${boundingBox.width} x ${boundingBox.height}, scaleFactor: ${scaleFactor}`);

  // Extract colors from simplified SVG for matching
  const simplifiedColors = extractColorsFromSVG(state.simplifiedSVGContent);
  console.log(`Palette has ${simplifiedColors.length} colors:`, simplifiedColors);

  // Create 3D meshes from paths
  const group = create3DMeshesFromPaths(
    paths,
    state.colorHeights,
    simplifiedColors,
    scaleFactor,
    boundingBox
  );

  if (threeState.scene) {
    threeState.scene.add(group);
    console.log(`Total meshes in group: ${group.children.length}`);
  }

  // Store the group reference for STL export
  state.meshGroup = group;

  // Enable STL export button
  exportSTLBtn.disabled = false;

  // Position camera to see the entire scene
  if (threeState.camera && threeState.scene) {
    positionCameraForScene(threeState.camera, boundingBox, scaleFactor);
    console.log(
      `Scene dimensions: ${boundingBox.width * scaleFactor} x ${boundingBox.height * scaleFactor}, camera distance: ${threeState.camera.position.z}`
    );
  }
}

/**
 * Clear the display
 */
function clearSVGInternal(): void {
  svgDisplayOriginal.innerHTML = '';
  svgDisplaySimplified.innerHTML = '';
  svgDisplayFlattened.innerHTML = '';
  infoText.textContent = 'No SVG loaded yet';
  colorCountText.textContent = '';
  colorPaletteText.textContent = '';
  fileInput.value = '';
  container3D.style.display = 'none';
  flattenedContainer.style.display = 'none';
  colorHeightsContainer.style.display = 'none';
  colorHeightsList.innerHTML = '';
  if (exportSizeContainer) exportSizeContainer.style.display = 'none';
  state.colorHeights = {};
  state.flattenedSVGContent = '';
  state.meshGroup = null;
  state.svgBoundingBox = null;
  state.svgScaleFactor = 1;
  state.originalAspectRatio = 1;
  state.exportWidthMM = 100;
  state.exportHeightMM = 100;
  if (exportWidthInput) exportWidthInput.value = '100';
  if (exportHeightInput) exportHeightInput.value = '100';
  create3DBtn.disabled = true;
  flattenBtn.disabled = true;
  exportSTLBtn.disabled = true;
  if (stlInfoText) stlInfoText.textContent = '';
}

/**
 * Export the 3D structure as STL file for 3D printing
 */
function exportSTLInternal(): void {
  if (!state.meshGroup) {
    alert('Please create a 3D structure first');
    return;
  }

  if (!state.svgBoundingBox) {
    alert('SVG bounding box not available');
    return;
  }

  const fileName = '3d-poster';

  // Create a scaled clone based on export dimensions
  const scaledGroup = createScaledClone(
    state.meshGroup,
    state.svgBoundingBox,
    state.svgScaleFactor,
    state.exportWidthMM,
    state.exportHeightMM
  );

  const stats = getSTLStats(scaledGroup);
  
  if (stats.faceCount === 0) {
    alert('No geometry found to export');
    return;
  }

  console.log(`Exporting 3D structure: ${stats.meshCount} meshes, ${stats.faceCount} faces`);
  console.log(`Export size: ${state.exportWidthMM}mm x ${state.exportHeightMM}mm`);
  
  // Update STL info display
  if (stlInfoText) {
    stlInfoText.textContent = `Exporting ${stats.faceCount} faces (${state.exportWidthMM}mm x ${state.exportHeightMM}mm) as STL...`;
  }

  // Download the STL file
  downloadSTL(scaledGroup, {
    format: 'binary',
    fileName: fileName,
  });

  // Clean up the scaled clone
  scaledGroup.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
    }
  });

  // Update STL info after export
  if (stlInfoText) {
    setTimeout(() => {
      stlInfoText.textContent = `Last export: ${stats.faceCount} faces, ${stats.meshCount} meshes (${state.exportWidthMM}mm x ${state.exportHeightMM}mm)`;
    }, 500);
  }
}

// Initialize the app when DOM is loaded
document.addEventListener('DOMContentLoaded', initApp);
