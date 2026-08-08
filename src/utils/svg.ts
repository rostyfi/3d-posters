/**
 * SVG manipulation utilities
 */

import { ColorMap, NAMED_COLOR_LIST } from '../types';

/**
 * Extract all color values from SVG content
 * @param svgContent - SVG XML content as string
 * @returns Array of unique color strings
 */
export function extractColorsFromSVG(svgContent: string): string[] {
  const colors = new Set<string>();

  // Match hex colors: #rgb, #rrggbb, #rrggbbaa
  const hexRegex = /#([0-9a-fA-F]{3,8})/g;
  let match: RegExpExecArray | null;
  while ((match = hexRegex.exec(svgContent)) !== null) {
    colors.add('#' + match[1]);
  }

  // Match rgb/rgba: rgb(255, 0, 0), rgba(255, 0, 0, 0.5)
  const rgbRegex = /(?:rgb|rgba)\([\s]*(\d+)[\s]*,[\s]*(\d+)[\s]*,[\s]*(\d+)(?:[\s]*,[\s]*(?:\d+\.?\d*|\.\d+))?\)/g;
  while ((match = rgbRegex.exec(svgContent)) !== null) {
    colors.add(`rgb(${match[1]}, ${match[2]}, ${match[3]})`);
  }

  // Match hsl/hsla
  const hslRegex = /(?:hsl|hsla)\([\s]*(\d+)[\s]*,[\s]*(\d+)%[\s]*,[\s]*(\d+)%(?:[\s]*,[\s]*(?:\d+\.?\d*|\.\d+))?\)/g;
  while ((match = hslRegex.exec(svgContent)) !== null) {
    colors.add(`hsl(${match[1]}, ${match[2]}%, ${match[3]}%)`);
  }

  // Match named colors
  const namedRegex = new RegExp('\\b(' + NAMED_COLOR_LIST.join('|') + ')\\b', 'gi');
  while ((match = namedRegex.exec(svgContent)) !== null) {
    colors.add(match[1].toLowerCase());
  }

  return Array.from(colors);
}

/**
 * Count color frequencies in SVG content
 * @param svgContent - SVG XML content as string
 * @returns Record mapping color strings to their occurrence count
 */
export function countColorsInSVG(svgContent: string): Record<string, number> {
  const counts: Record<string, number> = {};

  // Match hex colors
  const hexRegex = /#([0-9a-fA-F]{3,8})/g;
  let match: RegExpExecArray | null;
  while ((match = hexRegex.exec(svgContent)) !== null) {
    const color = '#' + match[1];
    counts[color] = (counts[color] || 0) + 1;
  }

  // Match rgb/rgba
  const rgbRegex = /(?:rgb|rgba)\([\s]*(\d+)[\s]*,[\s]*(\d+)[\s]*,[\s]*(\d+)/g;
  while ((match = rgbRegex.exec(svgContent)) !== null) {
    const color = `rgb(${match[1]}, ${match[2]}, ${match[3]})`;
    counts[color] = (counts[color] || 0) + 1;
  }

  // Match named colors
  const namedRegex = new RegExp('\\b(' + NAMED_COLOR_LIST.join('|') + ')\\b', 'gi');
  while ((match = namedRegex.exec(svgContent)) !== null) {
    const color = match[1].toLowerCase();
    counts[color] = (counts[color] || 0) + 1;
  }

  return counts;
}

/**
 * Apply color map to SVG content
 * @param svgContent - Original SVG content
 * @param colorMap - Mapping from old colors to new colors
 * @returns SVG content with colors replaced
 */
export function applyColorMap(svgContent: string, colorMap: ColorMap): string {
  let result = svgContent;

  for (const [oldColor, newColor] of Object.entries(colorMap)) {
    if (oldColor.startsWith('#')) {
      const oldHex = oldColor.toLowerCase();
      const newHex = newColor.toLowerCase();
      const regex = new RegExp(oldHex, 'gi');
      result = result.replace(regex, newHex);
    }
    // Replace named colors
    else if (/^[a-z]+$/.test(oldColor)) {
      const regex = new RegExp('\\b' + oldColor + '\\b', 'gi');
      result = result.replace(regex, newColor);
    }
    // Replace rgb/rgba - this is more complex, skip for now
    // as it would require parsing the full rgb() expression
  }

  return result;
}

/**
 * Format file size in human-readable format
 * @param bytes - File size in bytes
 * @returns Formatted string (e.g., "1.23 KB")
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' bytes';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

/**
 * Check if a file is likely an SVG file
 * @param file - File object
 * @returns True if file appears to be SVG
 */
export function isLikelySVG(file: File): boolean {
  return file.type.includes('image/svg+xml') || file.name.toLowerCase().endsWith('.svg');
}

/**
 * Check if content appears to be valid SVG
 * @param content - File content as string
 * @returns True if content appears to be SVG
 */
export function isValidSVGContent(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith('<svg') || trimmed.includes('<svg');
}
