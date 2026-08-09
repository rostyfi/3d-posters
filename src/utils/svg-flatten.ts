/**
 * SVG Flattening utilities
 * Raster-based approach with rectangle merging
 * Creates merged rectangles for adjacent pixels of the same color
 */

/**
 * Flatten SVG by ensuring only one color per pixel
 * Uses rectangle merging for better performance
 * @param svgContent - SVG string
 * @returns Flattened SVG string
 */
export async function flattenSVG(svgContent: string): Promise<string> {
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

    // Create a 2D array of colors
    const colorGrid: string[][] = [];
    const alphaGrid: boolean[][] = [];
    
    for (let y = 0; y < height; y++) {
      colorGrid[y] = [];
      alphaGrid[y] = [];
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        // Use threshold for alpha (anti-aliased edges)
        if (data[idx + 3] < 128) {
          colorGrid[y][x] = '';
          alphaGrid[y][x] = false;
        } else {
          colorGrid[y][x] = rgbToHex(data[idx], data[idx + 1], data[idx + 2]);
          alphaGrid[y][x] = true;
        }
      }
    }

    // Merge adjacent pixels into rectangles
    const rects: {color: string, x: number, y: number, w: number, h: number}[] = [];
    const processed: boolean[][] = [];
    
    for (let y = 0; y < height; y++) {
      processed[y] = [];
      for (let x = 0; x < width; x++) {
        processed[y][x] = false;
      }
    }

    // Scan for rectangles
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (processed[y][x] || !alphaGrid[y][x]) continue;
        
        const color = colorGrid[y][x];
        
        // Find the maximum width we can extend to the right
        let maxWidth = 1;
        while (x + maxWidth < width && 
               !processed[y][x + maxWidth] && 
               alphaGrid[y][x + maxWidth] &&
               colorGrid[y][x + maxWidth] === color) {
          maxWidth++;
        }
        
        // Find the maximum height we can extend downward
        let maxHeight = 1;
        let canExtend = true;
        
        while (canExtend && y + maxHeight < height) {
          canExtend = true;
          for (let dx = 0; dx < maxWidth; dx++) {
            if (x + dx >= width || processed[y + maxHeight][x + dx] || 
                !alphaGrid[y + maxHeight][x + dx] ||
                colorGrid[y + maxHeight][x + dx] !== color) {
              canExtend = false;
              break;
            }
          }
          if (canExtend) {
            maxHeight++;
          }
        }
        
        // Mark all pixels in this rectangle as processed
        for (let dy = 0; dy < maxHeight; dy++) {
          for (let dx = 0; dx < maxWidth; dx++) {
            if (y + dy < height && x + dx < width) {
              processed[y + dy][x + dx] = true;
            }
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
    if (viewBoxMatch) newSvg.setAttribute('viewBox', viewBoxMatch[1]);
    newSvg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

    // Create one path per color containing all rectangles
    const rectsByColor: Record<string, {x: number, y: number, w: number, h: number}[]> = {};
    
    for (const rect of rects) {
      if (!rectsByColor[rect.color]) {
        rectsByColor[rect.color] = [];
      }
      rectsByColor[rect.color].push(rect);
    }

    // Group colors and create paths
    const sortedColors = Object.keys(rectsByColor).sort();
    
    for (const color of sortedColors) {
      const colorRects = rectsByColor[color];
      
      // Create one path with all rectangles
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      
      let pathData = '';
      for (const rect of colorRects) {
        pathData += `M ${rect.x} ${rect.y} h ${rect.w} v ${rect.h} h -${rect.w} z `;
      }
      
      path.setAttribute('d', pathData.trim());
      path.setAttribute('fill', color);
      newSvg.appendChild(path);
      
      console.log(`  Color ${color}: ${colorRects.length} rectangles`);
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

/**
 * Convert RGB to hex
 */
function rgbToHex(r: number, g: number, b: number): string {
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toLowerCase()}`;
}
