/**
 * Coverage check tests: the flattened image must have no holes.
 *
 *  A. Full-coverage input (background rect) -> coverage OK, output unchanged
 *     (no background fill region added).
 *  B. Donut WITHOUT background -> holes detected and filled with white;
 *     flattened regions tile the canvas completely.
 *  C. Disjoint shapes without background -> filled around them.
 *  D. Unit checks of checkFlattenCoverage (exact tiling / real hole / sub-pixel gap).
 *  E. Manifold end-to-end on the filled output (solid slab, 0 non-manifold edges).
 */

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
(globalThis as any).DOMParser = dom.window.DOMParser;
(globalThis as any).XMLSerializer = dom.window.XMLSerializer;
(globalThis as any).document = dom.window.document;
(globalThis as any).window = dom.window;
(globalThis as any).MessageChannel = undefined;
let perfStart = Date.now();
(globalThis as any).performance = { now: () => Date.now() - perfStart };

import * as THREE from 'three';
import { Polygon, point } from '@flatten-js/core';
import {
  flattenSVG,
  svgToRegions,
  checkFlattenCoverage,
  CanvasRect,
  FlattenResult,
} from './src/utils/svg-flatten';
import { buildManifoldGeometry } from './src/3d/svg-to-3d';

let failures = 0;
function check(ok: boolean, label: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${label}`);
  if (!ok) failures++;
}

function rectPoly(x: number, y: number, w: number, h: number): Polygon {
  const p = new Polygon();
  p.addFace([point(x, y), point(x + w, y), point(x + w, y + h), point(x, y + h)]);
  return p;
}

function countNonManifoldEdges(geo: THREE.BufferGeometry): number {
  const arr = geo.getAttribute('position')!.array as Float32Array;
  const nTris = Math.floor(arr.length / 9);
  const vkey = (i: number): string => `${arr[i]}|${arr[i + 1]}|${arr[i + 2]}`;
  const edgeMap = new Map<string, number>();
  for (let t = 0; t < nTris; t++) {
    const b = t * 9;
    const v0 = vkey(b), v1 = vkey(b + 3), v2 = vkey(b + 6);
    for (const [a, c] of [[v0, v1], [v1, v2], [v2, v0]] as [string, string][]) {
      const k = a < c ? `${a}|${c}` : `${c}|${a}`;
      edgeMap.set(k, (edgeMap.get(k) || 0) + 1);
    }
  }
  let nm = 0;
  for (const count of edgeMap.values()) if (count !== 2) nm++;
  return nm;
}

const CANVAS: CanvasRect = { x: 0, y: 0, width: 200, height: 200 };

async function flattenAndReport(name: string, svg: string, palette: string[]) {
  console.log(`\n=== ${name} ===`);
  const flattened = await flattenSVG(svg, palette);
  const regions = await svgToRegions(flattened);
  if (!regions) {
    check(false, 'regions extracted from flattened SVG');
    return { flattened, regions: null };
  }
  const report = checkFlattenCoverage(regions as FlattenResult[], CANVAS);
  console.log(
    `  coverage: ${report.coveredArea.toFixed(1)}/${report.canvasArea.toFixed(1)} units², ` +
    `holes=${report.holeArea.toFixed(1)} (tol ${report.tolerance.toFixed(1)}), hasHoles=${report.hasHoles}`
  );
  const hasWhite = flattened.includes('fill="#ffffff"');
  console.log(`  flattened SVG contains background fill: ${hasWhite}`);
  return { flattened, regions, report, hasWhite };
}

async function main() {
  // A. Donut WITH background rect -> full coverage, no fill added.
  const withBg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <rect x="0" y="0" width="200" height="200" fill="#35537b"/>
  <path d="M20,20L180,20L180,180L20,180z M60,60L60,140L140,140L140,60z" fill="#e6bb43" stroke="none"/>
</svg>`;
  const a = await flattenAndReport('A: donut with background (full coverage)', withBg, ['#35537b', '#e6bb43']);
  check(!!a.regions && !a.report.hasHoles, 'coverage OK — no holes');
  check(!!a.regions && !a.hasWhite, 'no background fill region added (output unchanged)');

  // B. Donut WITHOUT background -> holes filled with white, full coverage.
  const noBg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <path d="M20,20L180,20L180,180L20,180z M60,60L60,140L140,140L140,60z" fill="#e6bb43" stroke="none"/>
</svg>`;
  const b = await flattenAndReport('B: donut without background (holes filled)', noBg, ['#e6bb43']);
  check(!!b.regions && !b.report.hasHoles, 'coverage OK after fill — no holes');
  check(!!b.regions && b.hasWhite, 'background fill region present');
  if (b.regions) {
    const white = b.regions.filter((r) => r.color === '#ffffff');
    const whiteArea = white.reduce((s, r) => s + r.polygon.area(), 0);
    console.log(`  white fill area: ${whiteArea.toFixed(1)} (expect 20800 = 40000 - 19200)`);
    check(Math.abs(whiteArea - 20800) < 1, 'white fill covers exactly the uncovered area');
  }

  // C. Two disjoint rects without background -> filled around them.
  const disjoint = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <rect x="10" y="10" width="50" height="50" fill="#aa0000"/>
  <rect x="100" y="100" width="50" height="50" fill="#00aa00"/>
</svg>`;
  const c = await flattenAndReport('C: disjoint rects without background', disjoint, ['#aa0000', '#00aa00']);
  check(!!c.regions && !c.report.hasHoles, 'coverage OK after fill — no holes');

  // D. Unit checks of checkFlattenCoverage.
  console.log('\n=== D: checkFlattenCoverage unit checks ===');
  {
    const full: FlattenResult[] = [
      { color: '#111111', polygon: rectPoly(0, 0, 200, 200) },
    ];
    const r1 = checkFlattenCoverage(full, CANVAS);
    check(!r1.hasHoles && r1.holeArea === 0, 'exact tiling -> no holes');

    const missing: FlattenResult[] = [
      { color: '#111111', polygon: rectPoly(0, 0, 200, 100) }, // half the canvas
    ];
    const r2 = checkFlattenCoverage(missing, CANVAS);
    check(r2.hasHoles && Math.abs(r2.holeArea - 20000) < 1, 'half missing -> real hole (20000)');

    // Sub-pixel gap: 0.5 units^2 hole, tolerance is 64*1e-3*800 = 51.2.
    const subPixel: FlattenResult[] = [
      { color: '#111111', polygon: rectPoly(0, 0, 200, 200) },
      // overlap-free tiny gap: emulate by shrinking coverage by 0.5
      { color: '#222222', polygon: rectPoly(0, 0, 0, 0) },
    ];
    subPixel[0] = { color: '#111111', polygon: rectPoly(0, 0, 200, 200) };
    // Build a region set covering 40000 - 0.5: a 200x200 rect minus a 0.5 sliver
    // is awkward; instead directly test the tolerance boundary.
    const tiny: FlattenResult[] = [
      { color: '#111111', polygon: rectPoly(0, 0, 200, 199.9975) }, // 39999.5 covered
    ];
    const r3 = checkFlattenCoverage(tiny, CANVAS);
    check(!r3.hasHoles, 'sub-pixel gap (0.5 units²) within tolerance -> no holes');
    check(r3.holeArea === 0.5 || Math.abs(r3.holeArea - 0.5) < 1e-6, 'hole area reported as 0.5');
  }

  // D2. 3x3 grid with the CENTER CELL MISSING: adjacent regions + a hole.
  //     The union-based gap must fill the hole without overlapping the
  //     adjacent cells (this exposed a sequential-subtract bug).
  console.log('\n=== D2: 3x3 grid with missing center cell ===');
  {
    const cells: string[] = [];
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) {
        if (x === 1 && y === 1) continue; // the hole
        const c = (x + y) % 2 === 0 ? '#aa0000' : '#00aa00';
        cells.push(`<rect x="${x * 10}" y="${y * 10}" width="10" height="10" fill="${c}"/>`);
      }
    }
    const svg3 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 30" width="30" height="30">${cells.join('')}</svg>`;
    const flat3 = await flattenSVG(svg3, ['#aa0000', '#00aa00']);
    const regions3 = await svgToRegions(flat3);
    const canvas3: CanvasRect = { x: 0, y: 0, width: 30, height: 30 };
    if (!regions3) {
      check(false, 'regions extracted');
    } else {
      const report3 = checkFlattenCoverage(regions3 as FlattenResult[], canvas3);
      console.log(`  coverage: ${report3.coveredArea.toFixed(2)}/${report3.canvasArea}, holes=${report3.holeArea.toFixed(2)}`);
      check(!report3.hasHoles, 'hole filled — full coverage');
      const white3 = regions3.filter((r) => r.color === '#ffffff');
      const whiteArea3 = white3.reduce((s, r) => s + r.polygon.area(), 0);
      console.log(`  white fill area: ${whiteArea3.toFixed(2)} (expect ~100 - eps-strip)`);
      check(Math.abs(whiteArea3 - 100) < 1, 'white fill covers the missing cell (~100)');
      // Manifold check on the filled output.
      const geo3 = buildManifoldGeometry(regions3, { '#aa0000': 1, '#00aa00': 2 }, 0.2);
      if (!geo3) {
        check(false, 'geometry produced');
      } else {
        const nm3 = countNonManifoldEdges(geo3);
        console.log(`  triangles=${geo3.getAttribute('position')!.count / 3}, non-manifold edges=${nm3}`);
        check(nm3 === 0, '0 non-manifold edges (filled hole is a clean solid)');
      }
    }
  }

  // E. Manifold end-to-end on the filled output (case B).
  console.log('\n=== E: manifold end-to-end on filled output ===');
  if (b.regions) {
    const geo = buildManifoldGeometry(b.regions, { '#e6bb43': 3 }, 0.2);
    if (!geo) {
      check(false, 'geometry produced');
    } else {
      const nm = countNonManifoldEdges(geo);
      const tris = geo.getAttribute('position')!.count / 3;
      console.log(`  triangles=${tris}, non-manifold edges=${nm}`);
      check(nm === 0, '0 non-manifold edges (solid slab)');
      // Expected volume: donut 19200 @3 layers + white 20800 @1 layer (default).
      const H = (l: number) => l * 0.2 * 0.5;
      const expected = 19200 * H(3) + 20800 * H(1);
      let vol = 0;
      const arr = geo.getAttribute('position')!.array as Float32Array;
      for (let t = 0; t * 9 < arr.length; t++) {
        const b9 = t * 9;
        const ax = arr[b9], ay = arr[b9 + 1], az = arr[b9 + 2];
        const bx = arr[b9 + 3], by = arr[b9 + 4], bz = arr[b9 + 5];
        const cx = arr[b9 + 6], cy = arr[b9 + 7], cz = arr[b9 + 8];
        vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
      }
      console.log(`  volume=${vol.toFixed(2)} (expect ~${expected.toFixed(2)})`);
      check(Math.abs(vol - expected) < expected * 0.01, 'volume matches solid slab');
    }
  }

  console.log(`\n${failures === 0 ? 'ALL COVERAGE CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
}

main().then(() => { process.exit(failures === 0 ? 0 : 1); })
  .catch((e) => { console.error('Error:', e); process.exit(1); });

setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 120000);
