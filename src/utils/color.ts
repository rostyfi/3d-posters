/**
 * Color manipulation utilities
 */

import { RGBColor, AnyColor } from '../types';

/**
 * Named colors mapping to RGB values
 */
const NAMED_COLORS: Record<string, RGBColor> = {
  'red': { r: 255, g: 0, b: 0 },
  'green': { r: 0, g: 128, b: 0 },
  'lime': { r: 0, g: 255, b: 0 },
  'blue': { r: 0, g: 0, b: 255 },
  'yellow': { r: 255, g: 255, b: 0 },
  'cyan': { r: 0, g: 255, b: 255 },
  'magenta': { r: 255, g: 0, b: 255 },
  'black': { r: 0, g: 0, b: 0 },
  'white': { r: 255, g: 255, b: 255 },
  'gray': { r: 128, g: 128, b: 128 },
  'grey': { r: 128, g: 128, b: 128 },
  'silver': { r: 192, g: 192, b: 192 },
  'maroon': { r: 128, g: 0, b: 0 },
  'navy': { r: 0, g: 0, b: 128 },
  'teal': { r: 0, g: 128, b: 128 },
  'purple': { r: 128, g: 0, b: 128 },
  'orange': { r: 255, g: 165, b: 0 },
  'pink': { r: 255, g: 192, b: 203 },
  'brown': { r: 165, g: 42, b: 42 },
  'aqua': { r: 0, g: 255, b: 255 },
  'fuchsia': { r: 255, g: 0, b: 255 },
  'gold': { r: 255, g: 215, b: 0 },
};

/**
 * Convert a color string to RGB object
 * @param color - Color in hex, rgb, rgba, or named format
 * @returns RGBColor object, defaults to black for invalid colors
 */
export function colorToRGB(color: AnyColor): RGBColor {
  // Handle null, undefined, or non-string values
  if (!color || typeof color !== 'string') {
    console.warn(`colorToRGB received non-string value:`, color);
    return { r: 0, g: 0, b: 0 };
  }

  // Already an RGB object
  if (typeof color === 'object' && 'r' in color && 'g' in color && 'b' in color) {
    return color as RGBColor;
  }

  // Hex color
  if (color.startsWith('#')) {
    const hex = color.substring(1);
    let r: number, g: number, b: number;

    if (hex.length === 3) {
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
    } else if (hex.length === 4) {
      // #RGBA format (ignoring alpha for RGB conversion)
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
    } else if (hex.length >= 6) {
      r = parseInt(hex.substring(0, 2), 16);
      g = parseInt(hex.substring(2, 4), 16);
      b = parseInt(hex.substring(4, 6), 16);
    } else {
      return { r: 0, g: 0, b: 0 };
    }

    return { r, g, b };
  }

  // RGB/RGBA
  const rgbMatch = color.match(/(?:rgb|rgba)\([\s]*(\d+)[\s]*,[\s]*(\d+)[\s]*,[\s]*(\d+)/);
  if (rgbMatch) {
    return {
      r: parseInt(rgbMatch[1]),
      g: parseInt(rgbMatch[2]),
      b: parseInt(rgbMatch[3]),
    };
  }

  // Named colors
  const lowerColor = color.toLowerCase();
  if (NAMED_COLORS[lowerColor]) {
    return NAMED_COLORS[lowerColor];
  }

  // Default to black if unknown
  return { r: 0, g: 0, b: 0 };
}

/**
 * Convert RGB object to hex string
 * @param rgb - RGBColor object
 * @returns Hex color string (e.g., "#RRGGBB")
 */
export function rgbToHex(rgb: AnyColor): string {
  // Handle invalid input
  if (!rgb || typeof rgb !== 'object') {
    console.warn(`rgbToHex received invalid input:`, rgb);
    return '#000000';
  }

  const r = Math.max(0, Math.min(255, rgb.r || 0));
  const g = Math.max(0, Math.min(255, rgb.g || 0));
  const b = Math.max(0, Math.min(255, rgb.b || 0));

  const toHex = (c: number): string => {
    const hex = c.toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };

  return '#' + toHex(r) + toHex(g) + toHex(b);
}

/**
 * Get contrasting text color for a background color
 * @param hexColor - Background color in hex format
 * @returns '#000' (black) or '#fff' (white) for best contrast
 */
export function getContrastColor(hexColor: string): string {
  const rgb = colorToRGB(hexColor);
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return luminance > 0.5 ? '#000' : '#fff';
}

/**
 * Calculate Euclidean distance between two RGB colors
 * @param c1 - First color
 * @param c2 - Second color
 * @returns Distance value
 */
export function colorDistance(c1: RGBColor, c2: RGBColor): number {
  const dr = c1.r - c2.r;
  const dg = c1.g - c2.g;
  const db = c1.b - c2.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Find the closest cluster for a given RGB color
 * @param color - The color to find closest cluster for
 * @param clusters - Array of cluster centroids
 * @returns Index of the closest cluster
 */
export function findClosestCluster(color: RGBColor, clusters: RGBColor[]): number {
  let minDist = Infinity;
  let closestIdx = 0;

  for (let i = 0; i < clusters.length; i++) {
    const dist = colorDistance(color, clusters[i]);
    if (dist < minDist) {
      minDist = dist;
      closestIdx = i;
    }
  }

  return closestIdx;
}

/**
 * Perform k-means clustering on colors
 * @param colors - Array of RGB colors to cluster
 * @param k - Number of clusters
 * @param maxIterations - Maximum number of iterations
 * @returns Array of cluster centroids
 */
export function kMeansCluster(colors: RGBColor[], k: number, maxIterations: number = 20): RGBColor[] {
  // Initialize centroids randomly from the color set
  const centroids: RGBColor[] = [];
  const usedIndices = new Set<number>();

  for (let i = 0; i < k; i++) {
    let idx: number;
    do {
      idx = Math.floor(Math.random() * colors.length);
    } while (usedIndices.has(idx));
    usedIndices.add(idx);
    centroids.push({ ...colors[idx] });
  }

  // Assign colors to clusters and update centroids
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const clusters: RGBColor[][] = Array(k).fill(null).map(() => []);

    // Assign each color to nearest centroid
    for (const color of colors) {
      let minDist = Infinity;
      let clusterIdx = 0;

      for (let i = 0; i < centroids.length; i++) {
        const dist = colorDistance(color, centroids[i]);
        if (dist < minDist) {
          minDist = dist;
          clusterIdx = i;
        }
      }

      clusters[clusterIdx].push(color);
    }

    // Update centroids
    let changed = false;
    for (let i = 0; i < k; i++) {
      if (clusters[i].length === 0) continue;

      const sum: RGBColor = { r: 0, g: 0, b: 0 };
      for (const color of clusters[i]) {
        sum.r += color.r;
        sum.g += color.g;
        sum.b += color.b;
      }

      const newCentroid: RGBColor = {
        r: Math.round(sum.r / clusters[i].length),
        g: Math.round(sum.g / clusters[i].length),
        b: Math.round(sum.b / clusters[i].length),
      };

      if (
        newCentroid.r !== centroids[i].r ||
        newCentroid.g !== centroids[i].g ||
        newCentroid.b !== centroids[i].b
      ) {
        changed = true;
      }

      centroids[i] = newCentroid;
    }

    if (!changed) break;
  }

  return centroids;
}

/**
 * Perform weighted k-means clustering on colors
 * @param colors - Array of RGB colors to cluster
 * @param weights - Array of weights for each color
 * @param k - Number of clusters
 * @param maxIterations - Maximum number of iterations
 * @returns Array of cluster centroids
 */
export function weightedKMeansCluster(
  colors: RGBColor[],
  weights: number[],
  k: number,
  maxIterations: number = 20
): RGBColor[] {
  // Initialize centroids - prefer colors with higher weights
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const centroids: RGBColor[] = [];
  const usedIndices = new Set<number>();

  for (let i = 0; i < k; i++) {
    // Weighted random selection
    let random = Math.random() * totalWeight;
    let cumulative = 0;
    let idx = 0;

    while (idx < colors.length) {
      cumulative += weights[idx];
      if (cumulative >= random) {
        if (!usedIndices.has(idx)) {
          usedIndices.add(idx);
          break;
        }
        // If already used, continue to next
        random = Math.random() * totalWeight;
        cumulative = 0;
        idx = -1; // Will be incremented to 0
      }
      idx++;
    }

    if (idx < colors.length) {
      centroids.push({ ...colors[idx] });
    }
  }

  // If we couldn't get k unique centroids, fill with random
  while (centroids.length < k) {
    const idx = Math.floor(Math.random() * colors.length);
    if (!usedIndices.has(idx)) {
      centroids.push({ ...colors[idx] });
      usedIndices.add(idx);
    }
  }

  // Assign colors to clusters and update centroids with weights
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const clusters: RGBColor[][] = Array(k).fill(null).map(() => []);
    const clusterWeights: number[] = Array(k).fill(0);

    // Assign each color to nearest centroid
    for (let i = 0; i < colors.length; i++) {
      const color = colors[i];
      const weight = weights[i];
      let minDist = Infinity;
      let clusterIdx = 0;

      for (let j = 0; j < centroids.length; j++) {
        const dist = colorDistance(color, centroids[j]);
        if (dist < minDist) {
          minDist = dist;
          clusterIdx = j;
        }
      }

      clusters[clusterIdx].push(color);
      clusterWeights[clusterIdx] += weight;
    }

    // Update centroids with weighted average
    let changed = false;
    for (let i = 0; i < k; i++) {
      if (clusters[i].length === 0) continue;

      let sum: RGBColor = { r: 0, g: 0, b: 0 };
      for (let j = 0; j < clusters[i].length; j++) {
        const color = clusters[i][j];
        const weight = weights[colors.indexOf(color)];
        sum.r += color.r * weight;
        sum.g += color.g * weight;
        sum.b += color.b * weight;
      }

      const newCentroid: RGBColor = {
        r: Math.round(sum.r / clusterWeights[i]),
        g: Math.round(sum.g / clusterWeights[i]),
        b: Math.round(sum.b / clusterWeights[i]),
      };

      if (
        newCentroid.r !== centroids[i].r ||
        newCentroid.g !== centroids[i].g ||
        newCentroid.b !== centroids[i].b
      ) {
        changed = true;
      }

      centroids[i] = newCentroid;
    }

    if (!changed) break;
  }

  return centroids;
}
