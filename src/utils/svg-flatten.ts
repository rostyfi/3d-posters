/**
 * SVG Flattening utilities
 * Raster-based approach with rectangle merging
 * Creates merged rectangles for adjacent pixels of the same color
 */

import { colorToRGB, findClosestCluster, rgbToHex } from './color';
import { RGBColor } from '../types';

/**
 * Pack an 8-bit RGB triple into a single non-negative integer.
 * Transparent pixels are represented separately (see colorGrid sentinel).
 */
function packRGB(r: number, g: number, b: number): number {
  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

function packedToHex(packed: number): string {
  const r = (packed >> 16) & 0xff;
  const g = (packed >> 8) & 0xff;
  const b = packed & 0xff;
  return rgbToHex({ r, g, b });
}

/**
 * Flatten SVG by ensuring only one color per pixel.
 *
 * When a `palette` is supplied (the output of the Simplify step), every opaque
 * pixel is snapped to its nearest palette color. This eliminates the
 * anti-aliased fringe colors that rasterization introduces at region edges,
 * so each contiguous region collapses to a single color — i.e. one shape per
 * region instead of thousands of 1-pixel slivers along every boundary.
 *
 * Uses rectangle merging for compact output.
 *
 * @param svgContent - SVG string
 * @param palette - Optional list of hex colors to snap pixels to
 * @returns Flattened SVG string
 */
export async function flattenSVG(
  svgContent: string,
  palette?: string[]
): Promise<string> {
  const viewBoxMatch = svgContent.match(/viewBox="([^"]+)"/);
  const widthMatch = svgContent.match(/width="([^"]+)"/);
  const heightMatch = svgContent.match(/height="([^"]+)"/);

  let width = 800, height = 600;
  if (viewBoxMatch) {
    const parts = viewBoxMatch[1].split(/\s+/);
    if (parts.length >= 4) { width = parseFloat(parts[2]); height = parseFloat(parts[3]); }
  } else if (widthMatch && heightMatch) {
    width = parseInt(widthMatch[1]?.replace(/px$/, '') || '800');
    height = parseInt(heightMatch[1]?.replace(/px$/, '') || '600');
  }

  const maxSize = 2000;
  if (width > maxSize || height > maxSize) {
    const scale = maxSize / Math.max(width, height);
    width = Math.floor(width * scale);
    height = Math.floor(height * scale);
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  try {
    ctx.clearRect(0, 0, width, height);
    // Nearest-neighbour sampling: keeps palette colors intact at edges instead
    // of generating blended intermediate values.
    ctx.imageSmoothingEnabled = false;

    const tempSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    tempSvg.setAttribute('width', width.toString());
    tempSvg.setAttribute('height', height.toString());
    if (viewBoxMatch) tempSvg.setAttribute('viewBox', viewBoxMatch[1]);
    tempSvg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    
    // Extract inner content from svgContent (skip outer <svg> tag if it exists)
    // This handles both full SVG documents and SVG fragments
    let innerContent = svgContent;
    const svgTagMatch = svgContent.match(/^\s*<svg[^>]*>(.*)<\/svg>\s*$/is);
    if (svgTagMatch) {
      innerContent = svgTagMatch[1];
    }
    tempSvg.innerHTML = innerContent;

    const svgData = new XMLSerializer().serializeToString(tempSvg);
    const img = new Image();
    
    await new Promise<void>((resolve, reject) => {
      img.onload = () => { ctx.drawImage(img, 0, 0); resolve(); };
      img.onerror = reject;
      img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svgData)))}`;
    });

    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;

    console.log('Flattening SVG using rectangle merging...');
    console.log(`Canvas size: ${width} x ${height}`);

    // Resolve palette colors to RGB up front so the per-pixel snap is cheap.
    const hasPalette = !!(palette && palette.length > 0);
    const paletteRGB: RGBColor[] = hasPalette
      ? palette!.map((c) => colorToRGB(c))
      : [];
    // Cache packed-RGB -> palette index so each distinct input color is resolved
    // to its nearest palette entry at most once.
    const snapCache = new Map<number, number>();

    const snapToPalette = (packed: number): number => {
      const cached = snapCache.get(packed);
      if (cached !== undefined) return cached;
      const r = (packed >> 16) & 0xff;
      const g = (packed >> 8) & 0xff;
      const b = packed & 0xff;
      const idx = findClosestCluster({ r, g, b }, paletteRGB);
      snapCache.set(packed, idx);
      return idx;
    };

    // Flat color grid: non-negative integer per pixel.
    //   hasPalette: index into paletteRGB (the snapped color).
    //   no palette: packed RGB of the pixel itself.
    //   -1 marks transparent pixels.
    const colorGrid = new Int32Array(width * height);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const i = y * width + x;
        // Use threshold for alpha (anti-aliased edges)
        if (data[idx + 3] < 128) {
          colorGrid[i] = -1;
        } else {
          const packed = packRGB(data[idx], data[idx + 1], data[idx + 2]);
          colorGrid[i] = hasPalette ? snapToPalette(packed) : packed;
        }
      }
    }

    // Merge adjacent pixels into rectangles
    const rects: { color: number, x: number, y: number, w: number, h: number }[] = [];
    const processed = new Uint8Array(width * height);

    // Scan for rectangles
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (processed[i] || colorGrid[i] === -1) continue;

        const color = colorGrid[i];

        // Find the maximum width we can extend to the right
        let maxWidth = 1;
        while (x + maxWidth < width) {
          const ni = y * width + (x + maxWidth);
          if (processed[ni] || colorGrid[ni] !== color) break;
          maxWidth++;
        }

        // Find the maximum height we can extend downward
        let maxHeight = 1;
        while (y + maxHeight < height) {
          let canExtend = true;
          const rowBase = (y + maxHeight) * width + x;
          for (let dx = 0; dx < maxWidth; dx++) {
            const ni = rowBase + dx;
            if (processed[ni] || colorGrid[ni] !== color) {
              canExtend = false;
              break;
            }
          }
          if (!canExtend) break;
          maxHeight++;
        }

        // Mark all pixels in this rectangle as processed
        for (let dy = 0; dy < maxHeight; dy++) {
          const rowBase = (y + dy) * width + x;
          for (let dx = 0; dx < maxWidth; dx++) {
            processed[rowBase + dx] = 1;
          }
        }

        // Add the rectangle
        rects.push({
          color: color,
          x: x,
          y: y,
          w: maxWidth,
          h: maxHeight
        });
      }
    }

    console.log(`Found ${rects.length} rectangles`);
    
    if (rects.length === 0) {
      console.warn('No rectangles found! The SVG might be empty or fully transparent.');
      // Return original content as fallback
      return svgContent;
    }

    // Create the output SVG
    const newSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    newSvg.setAttribute('width', width.toString());
    newSvg.setAttribute('height', height.toString());
    // Rectangles are in canvas pixel space (origin 0,0). Use a viewBox that
    // matches that space rather than the (possibly offset/scaled) source
    // viewBox, so geometry isn't shifted or shrunk on render.
    newSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    newSvg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

    // Create one path per color containing all rectangles
    const rectsByColor: Record<number, { x: number, y: number, w: number, h: number }[]> = {};

    for (const rect of rects) {
      if (!rectsByColor[rect.color]) {
        rectsByColor[rect.color] = [];
      }
      rectsByColor[rect.color].push(rect);
    }

    // Group colors and create paths
    const sortedColors = Object.keys(rectsByColor)
      .map((k) => parseInt(k, 10))
      .sort((a, b) => a - b);

    for (const color of sortedColors) {
      const colorRects = rectsByColor[color];

      // Create one path with all rectangles
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');

      let pathData = '';
      for (const rect of colorRects) {
        pathData += `M ${rect.x} ${rect.y} h ${rect.w} v ${rect.h} h -${rect.w} z `;
      }

      const hex = hasPalette
        ? palette![color]
        : packedToHex(color);

      path.setAttribute('d', pathData.trim());
      path.setAttribute('fill', hex);
      newSvg.appendChild(path);

      console.log(`  Color ${hex}: ${colorRects.length} rectangles`);
    }

    const totalRects = Object.values(rectsByColor).reduce((sum, r) => sum + r.length, 0);
    console.log(`Total rectangles: ${totalRects}, Colors: ${sortedColors.length}`);

    const serializer = new XMLSerializer();
    return serializer.serializeToString(newSvg);

  } catch (error) {
    console.error('Flatten error:', error);
    return svgContent;
  }
}
