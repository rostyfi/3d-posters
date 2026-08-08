/**
 * SVG to 3D conversion utilities
 */

import * as THREE from 'three';
import { ColorHeights, BoundingBox } from '../types';
import { colorToRGB, rgbToHex } from '../utils/color';
import { SVGLoader } from './three-setup';

/**
 * Extract fill color from an SVG path
 * @param path - SVG path object from THREE.SVGLoader
 * @returns Fill color string or empty string
 */
export function extractFillColorFromPath(path: any): string {
  // Get fill color from path userData - try multiple locations
  let fillColor = path.userData?.fill || path.userData?.style?.fill || '';

  // Also check if userData has fill in a different format
  if (!fillColor && path.userData) {
    // userData might have attributes directly
    for (const key in path.userData) {
      if (key.toLowerCase() === 'fill') {
        fillColor = path.userData[key];
        break;
      }
    }
    // Or style might be a string
    if (!fillColor && path.userData.style && typeof path.userData.style === 'string') {
      const fillMatch = path.userData.style.match(/fill:\s*([^;]+)/i);
      if (fillMatch) fillColor = fillMatch[1].trim();
    }
  }

  return fillColor;
}

/**
 * Element bounding box for a single SVG path
 */
export interface ElementBoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Get element bounding box from path data
 * @param path - SVG path object from THREE.SVGLoader
 * @returns Bounding box for this path
 */
export function getElementBoundingBox(path: any): ElementBoundingBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const subPath of path.subPaths) {
    for (const point of subPath.getPoints()) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }

  return { minX, minY, maxX, maxY };
}

/**
 * Create Three.js material from color
 * @param fillColor - Color string (hex, rgb, named)
 * @returns THREE.MeshStandardMaterial
 */
export function createMaterialFromColor(fillColor: string): THREE.MeshStandardMaterial {
  const rgb = colorToRGB(fillColor);
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(rgb.r / 255, rgb.g / 255, rgb.b / 255),
    side: THREE.DoubleSide,
    transparent: false,
  });
}

/**
 * Convert SVG paths to 3D meshes
 * @param paths - SVG paths from THREE.SVGLoader
 * @param colorHeights - Mapping from color to height in mm
 * @param simplifiedColors - Array of colors in the simplified palette
 * @param scaleFactor - Scale factor for converting SVG coordinates to 3D space
 * @param boundingBox - Overall SVG bounding box for positioning
 * @returns THREE.Group containing all 3D meshes
 */
export function create3DMeshesFromPaths(
  paths: any[],
  colorHeights: ColorHeights,
  simplifiedColors: string[],
  scaleFactor: number,
  boundingBox: BoundingBox
): THREE.Group {
  // Create a group to hold all 3D objects with Y flipped
  const group = new THREE.Group();
  group.scale.y = -1; // Flip Y: SVG Y-down to Three.js Y-up
  
  // Position group so top-left corner (minX, minY) is at origin (0, 0)
  // Transform order in Three.js: scale -> rotation -> position
  // With group.scale.y = -1, a point (x, y) becomes (x, -y) then (x + px, -y + py)
  // For (minX * scaleFactor, minY * scaleFactor) to be at (0, 0):
  //   minX * scaleFactor + px = 0  => px = -minX * scaleFactor
  //   -minY * scaleFactor + py = 0 => py = minY * scaleFactor
  group.position.set(
    -boundingBox.minX * scaleFactor,
    boundingBox.minY * scaleFactor,
    0
  );

  // Process each path from the parsed SVG data
  paths.forEach((path: any) => {
    // Get fill color from path
    const fillColor = extractFillColorFromPath(path);

    // Skip if fill is none, inherit, or a URL reference
    if (
      !fillColor ||
      typeof fillColor !== 'string' ||
      fillColor === 'none' ||
      fillColor === 'inherit' ||
      fillColor.startsWith('url(') ||
      fillColor.startsWith('var(')
    ) {
      return;
    }

    // Normalize the color to hex for lookup
    const hexColor = rgbToHex(colorToRGB(fillColor));

    // Find the matching color from our palette
    let matchedColor: string | null = null;
    for (const color of simplifiedColors) {
      const colorHex = rgbToHex(colorToRGB(color));
      if (colorHex === hexColor) {
        matchedColor = color;
        break;
      }
    }

    // If no match found, use the original color
    if (!matchedColor) {
      matchedColor = fillColor;
    }

    const heightMM = colorHeights[matchedColor] || 1;
    const heightUnits = heightMM * 0.5; // Scale mm to Three.js units (1mm = 0.5 units for better visibility)

    // Create material from color
    const material = createMaterialFromColor(fillColor);

    // Create shapes from this path
    const shapes = SVGLoader.createShapes(path);
    for (const shape of shapes) {
      const geometry = new THREE.ExtrudeGeometry(shape as THREE.Shape, {
        depth: heightUnits,
        bevelEnabled: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.scale.set(scaleFactor, scaleFactor, 1);
      // Don't position individually - shapes already have absolute SVG coordinates
      // Just position z for height
      mesh.position.z = heightUnits / 2;
      group.add(mesh);
    }
  });

  return group;
}

/**
 * Calculate scale factor for SVG to 3D conversion
 * @param boundingBox - SVG bounding box
 * @param targetSize - Target size in 3D units (default 100)
 * @returns Scale factor
 */
export function calculateScaleFactor(boundingBox: BoundingBox, targetSize: number = 100): number {
  const maxCoordDim = Math.max(boundingBox.width, boundingBox.height);
  return targetSize / maxCoordDim;
}
