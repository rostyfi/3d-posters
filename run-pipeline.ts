/**
 * Headless runner for the full transformation pipeline, mirroring the app flow
 * in src/main.ts with the app's default settings (index.html):
 *
 *   load SVG -> simplify colors (default 4) -> flatten (vector-native, palette
 *   snap) -> manifold 3D group -> scaled clone -> binary STL -> watertight
 *   check on the STL file read back from disk.
 *
 * Usage:
 *   ./run-pipeline.sh <svg-file> [targetColors=4] [layerHeightMM=0.2] [exportLongSideMM=100]
 *
 * run-pipeline.sh bundles this file (esbuild) and runs it with a clean
 * environment. Exit code: 0 = STL is watertight, 1 = pipeline/check failed,
 * 2 = timeout (10 min).
 */

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
(globalThis as any).DOMParser = dom.window.DOMParser;
(globalThis as any).XMLSerializer = dom.window.XMLSerializer;
(globalThis as any).document = dom.window.document;
(globalThis as any).window = dom.window;
(globalThis as any).MessageChannel = undefined;

import * as fs from 'fs';
import * as path from 'path';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader';
import { countColorsInSVG, extractColorsFromSVG, applyColorMap } from './src/utils/svg';
import {
  colorToRGB,
  rgbToHex,
  weightedKMeansCluster,
  findClosestCluster,
} from './src/utils/color';
import { flattenSVG } from './src/utils/svg-flatten';
import { calculateBoundingBox } from './src/3d/three-setup';
import {
  calculateScaleFactor,
  createManifoldGroupForExport,
} from './src/3d/svg-to-3d';
import {
  createScaledClone,
  exportToSTLBlob,
  getSTLStats,
} from './src/3d/stl-export';
import { BoundingBox, ColorHeights, ColorMap } from './src/types';

// ---------------------------------------------------------------------------
// Watertight verification (on the STL bytes read back from disk)
// ---------------------------------------------------------------------------

interface STLCheckResult {
  triangleCount: number;
  nonManifoldEdges: number;   // undirected edges not shared by exactly 2 tris
  badDirectedEdges: number;   // directed edges not appearing exactly once
  edgeCountHistogram: Record<number, number>;
  signedVolumeMM3: number;
  uniqueVertices: number;
  eulerCharacteristic: number;
  bboxMM: { min: number[]; max: number[] };
}

function checkSTLFile(filePath: string): STLCheckResult {
  const buf = fs.readFileSync(filePath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const dv = new DataView(ab);
  const count = dv.getUint32(80, true);
  if (buf.length !== 84 + count * 50) {
    throw new Error(
      `STL size mismatch: file ${buf.length} bytes, header says ${count} triangles ` +
      `(${84 + count * 50} expected)`
    );
  }

  const vdv = new DataView(new ArrayBuffer(12));
  const vkey = (x: number, y: number, z: number): string => {
    vdv.setFloat32(0, x, true);
    vdv.setFloat32(4, y, true);
    vdv.setFloat32(8, z, true);
    return `${vdv.getUint32(0, true).toString(16)}|${vdv.getUint32(4, true).toString(16)}|${vdv.getUint32(8, true).toString(16)}`;
  };

  const edgeMap = new Map<string, number>();       // undirected -> count
  const directedMap = new Map<string, number>();   // directed -> count
  const vertSet = new Set<string>();
  const hist: Record<number, number> = {};
  let vol = 0;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (let i = 0; i < count; i++) {
    const base = 84 + i * 50;
    const t = new Float32Array(9);
    for (let k = 0; k < 9; k++) t[k] = dv.getFloat32(base + 12 + k * 4, true);

    const [ax, ay, az] = [t[0], t[1], t[2]];
    const [bx, by, bz] = [t[3], t[4], t[5]];
    const [cx, cy, cz] = [t[6], t[7], t[8]];
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;

    const keys = [vkey(ax, ay, az), vkey(bx, by, bz), vkey(cx, cy, cz)];
    for (const k of keys) {
      vertSet.add(k);
      const c = [t[keys.indexOf(k) * 3], t[keys.indexOf(k) * 3 + 1], t[keys.indexOf(k) * 3 + 2]];
      for (let a = 0; a < 3; a++) {
        if (c[a] < min[a]) min[a] = c[a];
        if (c[a] > max[a]) max[a] = c[a];
      }
    }

    for (let e = 0; e < 3; e++) {
      const a = keys[e];
      const c = keys[(e + 1) % 3];
      const uk = a < c ? `${a}|${c}` : `${c}|${a}`;
      edgeMap.set(uk, (edgeMap.get(uk) || 0) + 1);
      directedMap.set(`${a}|${c}`, (directedMap.get(`${a}|${c}`) || 0) + 1);
    }
  }

  let nonManifold = 0;
  for (const [k, c] of edgeMap) {
    hist[c] = (hist[c] || 0) + 1;
    if (c !== 2) {
      nonManifold++;
      if (nonManifold <= 5) console.log(`    non-manifold edge (${c} tris): ${k}`);
    }
  }
  let badDirected = 0;
  for (const c of directedMap.values()) if (c !== 1) badDirected++;

  return {
    triangleCount: count,
    nonManifoldEdges: nonManifold,
    badDirectedEdges: badDirected,
    edgeCountHistogram: hist,
    signedVolumeMM3: vol,
    uniqueVertices: vertSet.size,
    eulerCharacteristic: vertSet.size - edgeMap.size + count,
    bboxMM: { min, max },
  };
}

// ---------------------------------------------------------------------------
// Pipeline (mirrors src/main.ts handlers with app defaults)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const svgPath = process.argv[2];
  if (!svgPath) {
    console.error('Usage: node .run-pipeline.cjs <svg-file> [targetColors=4] [layerHeightMM=0.2] [exportLongSideMM=100]');
    process.exit(1);
  }
  const targetColors = parseInt(process.argv[3] ?? '4', 10);
  const layerHeightMM = parseFloat(process.argv[4] ?? '0.2');
  const exportLongSideMM = parseFloat(process.argv[5] ?? '100');

  const originalSVG = fs.readFileSync(svgPath, 'utf8');
  console.log(`Input: ${svgPath} (${(originalSVG.length / 1024).toFixed(1)} KB)`);

  // --- 1. Simplify colors (handleSimplifyColors / simplifyColorsPure) ---
  console.log(`\n[1/5] Simplify colors -> ${targetColors}`);
  const colorCounts = countColorsInSVG(originalSVG);
  const allColors = Object.keys(colorCounts);
  console.log(`  ${allColors.length} distinct colors in source`);
  let simplifiedSVG = originalSVG;
  let palette: string[];
  if (allColors.length > targetColors) {
    const weights = allColors.map((c) => colorCounts[c]);
    const rgbColors = allColors.map((c) => colorToRGB(c));
    const clusters = weightedKMeansCluster(rgbColors, weights, targetColors, 20);
    const colorMap: ColorMap = {};
    allColors.forEach((color, index) => {
      colorMap[color] = rgbToHex(clusters[findClosestCluster(rgbColors[index], clusters)]);
    });
    simplifiedSVG = applyColorMap(originalSVG, colorMap);
    palette = extractColorsFromSVG(simplifiedSVG);
  } else {
    // The app refuses to simplify at/below the target count; the headless
    // runner proceeds with the source palette instead (weightedKMeansCluster
    // cannot produce more clusters than there are input colors).
    palette = allColors;
    console.log(`  ${allColors.length} colors <= target ${targetColors}; skipping simplification`);
  }
  const colorHeights: ColorHeights = {};
  palette.forEach((c) => { colorHeights[c] = 1; });
  console.log(`  palette (${palette.length}): ${palette.join(' ')}`);
  console.log(`  heights: all colors 1 layer (${layerHeightMM} mm/layer)`);

  // --- 2. Flatten (handleFlattenSVG) ---
  console.log('\n[2/5] Flatten SVG (vector-native boolean flatten, palette snap)');
  const t0 = Date.now();
  const flattened = await flattenSVG(simplifiedSVG, palette, (s) => {
    process.stdout.write(`\r  flatten: ${s}...   `);
  });
  console.log(`\r  flatten done in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
    `(${flattened.length / 1024} KB output)`);

  // --- 3. Bounding box + scale (create3DPure) ---
  console.log('\n[3/5] Parse flattened SVG, compute bounding box + scale factor');
  const svgData = new SVGLoader().parse(flattened);
  const bbox: BoundingBox = calculateBoundingBox(svgData.paths);
  const scaleFactor = calculateScaleFactor(bbox);
  console.log(`  bbox: ${bbox.width.toFixed(2)} x ${bbox.height.toFixed(2)} view units ` +
    `(min ${bbox.minX.toFixed(2)},${bbox.minY.toFixed(2)})`);
  console.log(`  scaleFactor: ${scaleFactor.toFixed(6)} (target 100 three.js units)`);

  // --- 4. Manifold group + scaled clone + binary STL (handleExportSTL) ---
  console.log('\n[4/5] Build manifold group, scale, export binary STL');
  const group = await createManifoldGroupForExport(
    flattened, colorHeights, scaleFactor, bbox, layerHeightMM
  );
  if (!group) throw new Error('manifold group construction failed');

  // Export size defaults (handleCreate3DStructure): long side = exportLongSideMM.
  const aspect = bbox.width / bbox.height;
  const exportW = bbox.width > bbox.height ? exportLongSideMM : exportLongSideMM * aspect;
  const exportH = bbox.width > bbox.height ? exportLongSideMM / aspect : exportLongSideMM;
  console.log(`  export size: ${exportW.toFixed(2)} x ${exportH.toFixed(2)} mm`);

  const scaled = createScaledClone(group, bbox, scaleFactor, exportW, exportH);
  const stats = getSTLStats(scaled);
  console.log(`  mesh stats: ${stats.faceCount} faces, ${stats.meshCount} mesh(es)`);

  const blob = exportToSTLBlob(scaled, { format: 'binary', fileName: '3d-poster' });
  const stlBuf = Buffer.from(await blob.arrayBuffer());
  const stlPath = svgPath.replace(/\.svg$/i, '') + '.stl';
  fs.writeFileSync(stlPath, stlBuf);
  console.log(`  wrote ${stlPath} (${(stlBuf.length / 1024).toFixed(1)} KB)`);

  // --- 5. Watertight check on the file read back from disk ---
  console.log('\n[5/5] Watertight check (STL re-read from disk, float32 bit identity)');
  const r = checkSTLFile(stlPath);
  console.log(`  triangles:            ${r.triangleCount}`);
  console.log(`  unique vertices:      ${r.uniqueVertices}`);
  console.log(`  edge count histogram: ${JSON.stringify(r.edgeCountHistogram)} ` +
    `(key = #triangles sharing an edge)`);
  console.log(`  non-manifold edges:   ${r.nonManifoldEdges} (must be 0)`);
  console.log(`  mis-oriented edges:  ${r.badDirectedEdges} (must be 0)`);
  console.log(`  signed volume:        ${r.signedVolumeMM3.toFixed(2)} mm^3 (must be > 0)`);
  console.log(`  Euler V-E+F:          ${r.eulerCharacteristic}`);
  console.log(`  bbox:                 x [${r.bboxMM.min[0].toFixed(3)}, ${r.bboxMM.max[0].toFixed(3)}] ` +
    `y [${r.bboxMM.min[1].toFixed(3)}, ${r.bboxMM.max[1].toFixed(3)}] ` +
    `z [${r.bboxMM.min[2].toFixed(3)}, ${r.bboxMM.max[2].toFixed(3)}] mm`);

  const watertight =
    r.nonManifoldEdges === 0 &&
    r.badDirectedEdges === 0 &&
    r.signedVolumeMM3 > 0 &&
    r.triangleCount > 0;
  console.log(`\n${watertight ? 'WATERTIGHT: PASS' : 'WATERTIGHT: FAIL'}`);
  process.exit(watertight ? 0 : 1);
}

main().catch((e) => {
  console.error('Pipeline error:', e);
  process.exit(1);
});

setTimeout(() => {
  console.log('TIMEOUT (10 min)');
  process.exit(2);
}, 600000);
