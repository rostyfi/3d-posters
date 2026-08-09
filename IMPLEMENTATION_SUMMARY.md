# SVG Flattening Implementation with Paper.js

## Overview
This implementation adds SVG flattening functionality to eliminate z-fighting in 3D extruded SVGs by ensuring that only one shape fills any given pixel.

## Problem
The original application had z-fighting issues when converting SVGs to 3D because:
1. Multiple SVG paths could have the same color but be separate shapes
2. Paths could overlap, with one on top of another
3. When extruded to 3D, these overlapping edges at the same height caused z-fighting

## Solution
Added **Paper.js** library for SVG path boolean operations:
- **Subtract**: Removes overlapping areas from bottom paths based on top paths
- **Unite**: Merges adjacent paths with the same color into single shapes

## Changes Made

### 1. Added Paper.js Dependency
- Added `paper` package to `package.json`
- Loaded Paper.js from CDN in `index.html`

### 2. Created SVG Flattening Utility (`src/utils/svg-flatten.ts`)
Main function: `flattenSVG(svgContent: string): string`

**Algorithm:**
1. Parse SVG dimensions (viewBox, width, height)
2. Setup temporary Paper.js canvas
3. Import SVG into Paper.js
4. Extract and flatten all paths from groups
5. Sort paths by layer order (bottom to top)
6. **Step 1 - Remove Overlaps**: For each path from bottom to top:
   - Subtract all paths above it that have different colors
   - This ensures only the visible parts remain
7. **Step 2 - Merge Same-Color Paths**: 
   - Group paths by fill color
   - Use `unite()` to merge adjacent same-color paths
8. Export flattened SVG with original dimensions

### 3. Updated Main Application (`src/main.ts`)
- Added new DOM element references:
  - `svgDisplayFlattened`: Display area for flattened SVG
  - `flattenedContainer`: Container div
  - `flattenBtn`: Flatten button
- Added `flattenedSVGContent` to `AppState`
- Added `flattenSVGInternal()` function
- Exposed `window.flattenSVG()` for inline event handlers
- Updated all reset functions to also clear flattened state

### 4. Updated UI (`index.html`)
- Added "Flatten SVG" button (enabled after color simplification)
- Added "Flattened" display panel
- Added Paper.js CDN script

### 5. Updated Types (`src/types.ts`)
- Added `flattenedSVGContent: string` to `AppState` interface

## Workflow

1. User loads SVG file
2. User clicks "Simplify Colors" to reduce color palette
3. User clicks "Flatten SVG" which:
   - Removes overlaps (subtracts top paths from bottom paths)
   - Merges adjacent same-color regions
4. User clicks "Create 3D Structure" which uses the flattened SVG

## Result
- The flattened SVG has:
  - No overlapping paths (each pixel has only one color)
  - Adjacent same-color regions merged into single paths
  - Proper layer order preserved
- When extruded to 3D, z-fighting is eliminated

## Technical Details

### Paper.js Boolean Operations
- `path1.subtract(path2)`: Removes path2's area from path1
- `path1.unite(path2)`: Merges path1 and path2 into one path

### Layer Order
- SVG paths are processed from bottom to top
- Higher layers (later in DOM) are subtracted from lower layers (earlier in DOM)
- This ensures that only visible (non-overlapped) parts remain

### Edge Cases Handled
- Transparent/none fill colors are skipped
- Same-color paths are not subtracted from each other
- Empty paths (area = 0) are removed
- Failed operations are logged but don't stop processing
- Original SVG is returned on error

## Limitations

1. **Performance**: O(n²) complexity for n paths due to pairwise subtraction
   - For complex SVGs with many paths, this can be slow
   - Mitigation: Process in web worker for large SVGs

2. **Bezier Curves**: Paper.js preserves Bezier curves, but boolean operations may convert them to polygons
   - This is acceptable for most use cases

3. **Complex Paths**: Some complex paths may fail boolean operations
   - Fallback: Original path is kept, logged as warning

## Future Improvements

1. **Progress Indicators**: Show progress for large SVGs
2. **Web Workers**: Offload processing to background thread
3. **Undo/Redo**: Allow reverting flattening operation
4. **Options**: Allow user to control:
   - Merge tolerance for same-color paths
   - Whether to preserve original paths
   - Boolean operation precision

## Testing

Test SVG (`test-overlapping.svg`) contains:
- Blue rectangle (bottom layer)
- Red rectangle (top layer, overlapping blue)
- Green rectangle (no overlap)
- Two yellow circles (adjacent, same color)

Expected flattened result:
- Blue rectangle with red area subtracted
- Red rectangle (unchanged)
- Green rectangle (unchanged)
- Two yellow circles merged into one shape

## Files Modified

1. `package.json` - Added paper dependency
2. `index.html` - Added Paper.js CDN, flatten button, flattened display
3. `src/types.ts` - Added flattenedSVGContent to AppState
4. `src/main.ts` - Added flatten functionality and UI integration
5. `src/utils/svg-flatten.ts` - New file with flattenSVG function

## Files Added

1. `src/utils/svg-flatten.ts` - SVG flattening utility
2. `test-overlapping.svg` - Test SVG with overlapping paths
3. `IMPLEMENTATION_SUMMARY.md` - This document
