/**
 * Type definitions for the 3D Posters application
 */

import type { Scene, Camera, WebGLRenderer } from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import * as THREE from 'three';

/**
 * RGB Color representation
 */
export interface RGBColor {
  r: number;
  g: number;
  b: number;
}

/**
 * HSL Color representation
 */
export interface HSLColor {
  h: number;
  s: number;
  l: number;
}

/**
 * Color in any format (hex, rgb, named)
 */
export type AnyColor = string | RGBColor;

/**
 * Mapping from original color to simplified color
 */
export type ColorMap = Record<string, string>;

/**
 * Mapping from color to height in layers (integer count)
 */
export type ColorHeights = Record<string, number>;

/**
 * Named colors list
 */
export const NAMED_COLOR_LIST = [
  'red', 'green', 'blue', 'yellow', 'cyan', 'magenta', 'black', 'white',
  'gray', 'grey', 'orange', 'purple', 'pink', 'brown', 'maroon', 'navy',
  'teal', 'lime', 'aqua', 'fuchsia', 'silver', 'gold'
];

/**
 * SVG Loader path data from THREE.SVGLoader
 */
export interface SVGPath {
  userData: {
    fill?: string;
    stroke?: string;
    style?: string | Record<string, string>;
    [key: string]: any;
  };
  subPaths: Array<{
    getPoints: () => Array<{ x: number; y: number }>;
  }>;
}

/**
 * Result from parsing SVG with THREE.SVGLoader
 */
export interface SVGLoaderResult {
  paths: SVGPath[];
}

/**
 * Bounding box for SVG elements
 */
export interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

/**
 * Application state for color simplification
 */
export interface AppState {
  originalSVGContent: string;
  simplifiedSVGContent: string;
  flattenedSVGContent: string;
  originalColors: string[];
  colorMap: ColorMap;
  /** Mapping from color to height in layers (not mm) */
  colorHeights: ColorHeights;
  scene: Scene | null;
  camera: Camera | null;
  renderer: WebGLRenderer | null;
  controls: OrbitControls | null;
  /** Reference to the 3D group containing all extruded meshes */
  meshGroup: THREE.Group | null;
  /** Target export dimensions in mm */
  exportWidthMM: number;
  exportHeightMM: number;
  /** Original SVG aspect ratio (width / height) */
  originalAspectRatio: number;
  /** Original SVG bounding box for scaling */
  svgBoundingBox: BoundingBox | null;
  /** Scale factor used for 3D conversion */
  svgScaleFactor: number;
  /** Height of a single layer in millimeters */
  layerHeightMM: number;
}

/**
 * Options for the 3D extrusion
 */
export interface ExtrusionOptions {
  depth: number;
  bevelEnabled: boolean;
  bevelThickness?: number;
  bevelSize?: number;
  bevelOffset?: number;
  bevelSegments?: number;
}

/**
 * Color clustering options
 */
export interface ClusteringOptions {
  targetCount: number;
  maxIterations: number;
  useWeighted: boolean;
}

/**
 * File information
 */
export interface FileInfo {
  name: string;
  size: number;
  type: string;
}
