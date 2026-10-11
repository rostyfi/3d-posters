/**
 * Manifold verification: flatten -> regions -> manifold geometry -> STL-ready mesh.
 *
 * For each scenario, assert:
 *   - geometry is produced (non-empty)
 *   - 0 non-manifold edges (every edge shared by exactly 2 triangles, vertices
 *     matched by float32 bit pattern — what a slicer sees)
 *   - signed volume matches the expected height-field volume (catches inverted
 *     or missing faces, not just edge counts)
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
import { flattenSVG, svgToRegions } from './src/utils/svg-flatten';
import { buildManifoldGeometry } from './src/3d/svg-to-3d';

let failures = 0;
function check(ok: boolean, label: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${label}`);
  if (!ok) failures++;
}

/** Count edges not shared by exactly 2 triangles (float32 vertex identity). */
function countNonManifoldEdges(geo: THREE.BufferGeometry): number {
  const pos = geo.getAttribute('position');
  if (!pos) return 0;
  const arr = pos.array as Float32Array;
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

/** Signed volume of a triangle soup (positive for outward-facing closed mesh). */
function signedVolume(geo: THREE.BufferGeometry): number {
  const arr = geo.getAttribute('position')!.array as Float32Array;
  let vol = 0;
  for (let t = 0; t * 9 < arr.length; t++) {
    const b = t * 9;
    const ax = arr[b], ay = arr[b + 1], az = arr[b + 2];
    const bx = arr[b + 3], by = arr[b + 4], bz = arr[b + 5];
    const cx = arr[b + 6], cy = arr[b + 7], cz = arr[b + 8];
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return vol;
}

interface Scenario {
  name: string;
  svg: string;
  palette: string[];
  /** color -> layers */
  heights: Record<string, number>;
  /** expected volume in view units (h = layers * layerHeightMM * 0.5) */
  expectedVolume: number;
  /** relative tolerance for the volume check */
  volTol?: number;
}

const LAYER_MM = 0.2;
const H = (layers: number) => layers * LAYER_MM * 0.5;

const scenarios: Scenario[] = [
  {
    name: 'overlapping rects (different heights)',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <rect x="0" y="0" width="80" height="80" fill="#aa0000"/>
  <rect x="20" y="20" width="80" height="80" fill="#00aa00"/>
</svg>`,
    palette: ['#aa0000', '#00aa00'],
    heights: { '#aa0000': 1, '#00aa00': 2 },
    // red visible = 6400-3600=2800 @1 layer; green = 6400 @2 layers;
    // uncovered corners (800) filled with background at the default 1 layer
    expectedVolume: 2800 * H(1) + 6400 * H(2) + 800 * H(1),
  },
  {
    name: '2x2 grid (4 heights, shared edges + center corner contact)',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <rect x="0" y="0" width="50" height="50" fill="#111111"/>
  <rect x="50" y="0" width="50" height="50" fill="#222222"/>
  <rect x="0" y="50" width="50" height="50" fill="#333333"/>
  <rect x="50" y="50" width="50" height="50" fill="#444444"/>
</svg>`,
    palette: ['#111111', '#222222', '#333333', '#444444'],
    heights: { '#111111': 1, '#222222': 2, '#333333': 3, '#444444': 4 },
    expectedVolume: 2500 * (H(1) + H(2) + H(3) + H(4)),
  },
  {
    name: 'donut (hole must not become a solid)',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <rect x="0" y="0" width="200" height="200" fill="#35537b"/>
  <path d="M20,20L180,20L180,180L20,180z M60,60L60,140L140,140L140,60z" fill="#e6bb43" stroke="none"/>
</svg>`,
    palette: ['#35537b', '#e6bb43'],
    heights: { '#35537b': 1, '#e6bb43': 3 },
    // bg: (40000-25600) + 6400 = 20800 @1; donut 19200 @3
    expectedVolume: 20800 * H(1) + 19200 * H(3),
  },
  {
    name: '10x10 grid (100 cells, 2 colors)',
    svg: (() => {
      const cells: string[] = [];
      for (let y = 0; y < 10; y++) {
        for (let x = 0; x < 10; x++) {
          const c = (x + y) % 2 === 0 ? '#aa0000' : '#00aa00';
          cells.push(`<rect x="${x * 10}" y="${y * 10}" width="10" height="10" fill="${c}"/>`);
        }
      }
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">${cells.join('')}</svg>`;
    })(),
    palette: ['#aa0000', '#00aa00'],
    heights: { '#aa0000': 1, '#00aa00': 2 },
    expectedVolume: 5000 * H(1) + 5000 * H(2),
  },
  {
    name: 'tangent circles (point contact)',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 100" width="120" height="100">
  <rect x="0" y="0" width="120" height="100" fill="#35537b"/>
  <circle cx="30" cy="50" r="30" fill="#e6bb43"/>
  <circle cx="90" cy="50" r="30" fill="#bb43e6"/>
</svg>`,
    palette: ['#35537b', '#e6bb43', '#bb43e6'],
    heights: { '#35537b': 1, '#e6bb43': 2, '#bb43e6': 3 },
    // 24-gon circle area = 0.5*n*r^2*sin(2pi/n); r=30 -> ~2795.2
    expectedVolume:
      (12000 - 2 * 2795.2) * H(1) + 2795.2 * H(2) + 2795.2 * H(3),
    volTol: 0.02,
  },
  {
    name: 'zero-layer color (flat floor region)',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <rect x="0" y="0" width="100" height="100" fill="#35537b"/>
  <rect x="25" y="25" width="50" height="50" fill="#e6bb43"/>
</svg>`,
    palette: ['#35537b', '#e6bb43'],
    heights: { '#35537b': 0, '#e6bb43': 2 },
    // bg is flat floor (0 layers); square 2500 @2 layers
    expectedVolume: 2500 * H(2),
  },
  {
    name: 'same-color overlapping circles (merge path)',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 100" width="120" height="100">
  <rect x="0" y="0" width="120" height="100" fill="#35537b"/>
  <circle cx="45" cy="50" r="30" fill="#e6bb43"/>
  <circle cx="75" cy="50" r="30" fill="#e6bb43"/>
</svg>`,
    palette: ['#35537b', '#e6bb43'],
    heights: { '#35537b': 1, '#e6bb43': 2 },
    // union of two overlapping 24-gon circles ~ 2*2795.2 - overlap(~1300) ; compute via regions instead
    expectedVolume: -1, // computed dynamically below
    volTol: 0.02,
  },
];

async function runScenario(s: Scenario): Promise<void> {
  console.log(`\n=== ${s.name} ===`);
  const flattened = await flattenSVG(s.svg, s.palette);
  const regions = await svgToRegions(flattened);
  if (!regions) {
    check(false, 'regions extracted');
    return;
  }
  console.log(`  regions: ${regions.length}`);
  const geo = buildManifoldGeometry(regions, s.heights, LAYER_MM);
  if (!geo) {
    check(false, 'geometry produced');
    return;
  }
  const tris = geo.getAttribute('position')!.count / 3;
  const nm = countNonManifoldEdges(geo);
  const vol = signedVolume(geo);
  console.log(`  triangles=${tris}, non-manifold edges=${nm}, signed volume=${vol.toFixed(2)}`);
  check(nm === 0, `0 non-manifold edges (got ${nm})`);

  let expected = s.expectedVolume;
  if (expected < 0) {
    // Same-color circles: expected volume = sum over regions of area * h.
    expected = 0;
    for (const r of regions) {
      const layers = s.heights[r.color] ?? 1;
      expected += r.polygon.area() * H(layers);
    }
    console.log(`  expected volume (from regions): ${expected.toFixed(2)}`);
  }
  const tol = (s.volTol ?? 0.005) * Math.abs(expected);
  check(
    Math.abs(vol - expected) <= tol,
    `volume ${vol.toFixed(2)} ≈ expected ${expected.toFixed(2)} (tol ${tol.toFixed(2)})`
  );
}

async function main() {
  for (const s of scenarios) {
    await runScenario(s);
  }
  console.log(`\n${failures === 0 ? 'ALL SCENARIOS PASSED' : failures + ' CHECK(S) FAILED'}`);
}

main().then(() => { process.exit(failures === 0 ? 0 : 1); })
  .catch((e) => { console.error('Error:', e); process.exit(1); });

setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 120000);
