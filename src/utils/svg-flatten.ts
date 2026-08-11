/**
 * SVG Flattening utilities
 * Vector-native approach: preserves original path geometry, snaps colors to a palette.
 *
 * Unlike a raster (canvas) flatten, this keeps the SVG's smooth curves and
 * exact coordinates, so downstream 3D extrusion produces clean edges instead
 * of pixel-grid staircasing.
 */

import { colorToRGB, findClosestCluster, rgbToHex } from './color';
import { RGBColor } from '../types';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Color-like values that must not be snapped (they are references or keywords). */
function isSnappableColor(value: string | null): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  if (!v) return false;
  if (v === 'none' || v === 'inherit' || v === 'currentcolor') return false;
  if (v.startsWith('url(') || v.startsWith('var(')) return false;
  return true;
}

/**
 * Flatten SVG by snapping every fill color to the supplied palette while
 * preserving the original vector geometry.
 *
 * When a `palette` is supplied (the output of the Simplify step), each shape's
 * fill — whether given as a presentation attribute, an inline `style`, or a
 * gradient stop-color — is replaced with the nearest palette color. Shapes
 * keep their original paths/coordinates, so there is no rasterization and no
 * pixel staircasing: each region remains the smooth vector the author drew,
 * and each shape carries exactly one palette color.
 *
 * This also covers cases the Simplify step's regex color swap misses, such as
 * `style="fill: rgb(...)"` and `<stop stop-color="...">`.
 *
 * @param svgContent - SVG string
 * @param palette - Optional list of hex colors to snap fills to
 * @returns Flattened SVG string (vector, same geometry)
 */
export async function flattenSVG(
  svgContent: string,
  palette?: string[]
): Promise<string> {
  const hasPalette = !!(palette && palette.length > 0);
  if (!hasPalette) {
    // Nothing to snap to — return the input unchanged (geometry already clean).
    return svgContent;
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(svgContent, 'image/svg+xml');

  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    console.error('Flatten: SVG parse error:', parseError.textContent);
    return svgContent;
  }

  const root = doc.documentElement;
  if (!root || root.localName.toLowerCase() !== 'svg') {
    console.error('Flatten: root element is not <svg>');
    return svgContent;
  }

  // Ensure namespace is present so the serialized output is a valid SVG document.
  if (!root.getAttribute('xmlns')) {
    root.setAttribute('xmlns', SVG_NS);
  }

  const paletteRGB: RGBColor[] = palette!.map((c) => colorToRGB(c));
  // Cache original color string -> snapped palette hex, so each distinct input
  // color is resolved to its nearest palette entry at most once.
  const snapCache = new Map<string, string>();

  const snapColor = (raw: string): string => {
    const key = raw.trim().toLowerCase();
    const cached = snapCache.get(key);
    if (cached !== undefined) return cached;
    const rgb = colorToRGB(raw);
    const idx = findClosestCluster(rgb, paletteRGB);
    const hex = rgbToHex(paletteRGB[idx]);
    snapCache.set(key, hex);
    return hex;
  };

  /**
   * Snap a `fill`/`stop-color` value found inside an inline `style` attribute.
   * Returns the rewritten style string (unchanged if no snap was needed).
   */
  const snapStyleProperty = (
    style: string,
    prop: 'fill' | 'stop-color'
  ): string => {
    const re = new RegExp(`(^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'gi');
    return style.replace(re, (_m, prefix: string, value: string) => {
      if (!isSnappableColor(value)) return `${prefix}${prop}:${value}`;
      return `${prefix}${prop}:${snapColor(value)}`;
    });
  };

  let snappedCount = 0;
  const elements = root.querySelectorAll('*');
  for (const el of Array.from(elements)) {
    // 1. Presentation attribute: fill="..."
    const fillAttr = el.getAttribute('fill');
    if (isSnappableColor(fillAttr)) {
      el.setAttribute('fill', snapColor(fillAttr!));
      snappedCount++;
    }

    // 2. Gradient stop-color attribute: <stop stop-color="..." />
    const stopAttr = el.getAttribute('stop-color');
    if (isSnappableColor(stopAttr)) {
      el.setAttribute('stop-color', snapColor(stopAttr!));
      snappedCount++;
    }

    // 3. Inline style: style="fill: ...; stop-color: ..."
    const styleAttr = el.getAttribute('style');
    if (styleAttr && /fill|stop-color/i.test(styleAttr)) {
      let next = snapStyleProperty(styleAttr, 'fill');
      next = snapStyleProperty(next, 'stop-color');
      if (next !== styleAttr) {
        el.setAttribute('style', next);
        snappedCount++;
      }
    }
  }

  console.log(
    `Flatten (vector): snapped ${snappedCount} color references to ${paletteRGB.length} palette colors.`
  );

  return new XMLSerializer().serializeToString(root);
}

