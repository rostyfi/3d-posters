/**
 * End-to-end STL test: SVG -> flatten -> manifold group -> scaled clone ->
 * binary STL -> parse -> count non-manifold edges (float32 bit identity, the
 * same precision the STL format stores — what a slicer sees).
 *
 * This mirrors handleExportSTL in src/main.ts.
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

import { flattenSVG } from './src/utils/svg-flatten';
import {
  createManifoldGroupForExport,
  calculateScaleFactor,
} from './src/3d/svg-to-3d';
import { createScaledClone, exportToSTLBlob, getSTLStats } from './src/3d/stl-export';
import { BoundingBox } from './src/types';

let failures = 0;
function check(ok: boolean, label: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${label}`);
  if (!ok) failures++;
}

/** Parse a binary STL into float32 triangles (exact stored precision). */
function parseBinarySTL(buf: ArrayBuffer): Float32Array[] {
  const dv = new DataView(buf);
  const count = dv.getUint32(80, true);
  const tris: Float32Array[] = [];
  for (let i = 0; i < count; i++) {
    const base = 84 + i * 50;
    const tri = new Float32Array(9);
    for (let k = 0; k < 9; k++) tri[k] = dv.getFloat32(base + 12 + k * 4, true); // skip normal
    tris.push(tri);
  }
  return tris;
}

/** Count edges not shared by exactly 2 triangles, keyed by float32 bit pattern. */
function countNonManifoldSTLEdges(tris: Float32Array[]): number {
  const dv = new DataView(new ArrayBuffer(12));
  const vkey = (tri: Float32Array, k: number): string => {
    dv.setFloat32(0, tri[k * 3], true);
    dv.setFloat32(4, tri[k * 3 + 1], true);
    dv.setFloat32(8, tri[k * 3 + 2], true);
    return `${dv.getUint32(0, true).toString(16)}|${dv.getUint32(4, true).toString(16)}|${dv.getUint32(8, true).toString(16)}`;
  };
  const edgeMap = new Map<string, number>();
  for (const tri of tris) {
    const v0 = vkey(tri, 0), v1 = vkey(tri, 1), v2 = vkey(tri, 2);
    for (const [a, c] of [[v0, v1], [v1, v2], [v2, v0]] as [string, string][]) {
      const k = a < c ? `${a}|${c}` : `${c}|${a}`;
      edgeMap.set(k, (edgeMap.get(k) || 0) + 1);
    }
  }
  let nm = 0;
  for (const count of edgeMap.values()) if (count !== 2) nm++;
  return nm;
}

function signedVolumeSTL(tris: Float32Array[]): number {
  let vol = 0;
  for (const t of tris) {
    const [ax, ay, az] = [t[0], t[1], t[2]];
    const [bx, by, bz] = [t[3], t[4], t[5]];
    const [cx, cy, cz] = [t[6], t[7], t[8]];
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return vol;
}

interface Scenario {
  name: string;
  svg: string;
  palette: string[];
  heights: Record<string, number>;
  size: number; // viewBox size (square)
  /** expected volume in mm^3 (100mm export) */
  expectedVolumeMM3: number;
  volTol?: number;
}

const LAYER_MM = 0.2;
const H = (layers: number) => layers * LAYER_MM; // mm per region (z is scaled x2 at export)

const scenarios: Scenario[] = [
  {
    name: 'overlapping rects',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <rect x="0" y="0" width="80" height="80" fill="#aa0000"/>
  <rect x="20" y="20" width="80" height="80" fill="#00aa00"/>
</svg>`,
    palette: ['#aa0000', '#00aa00'],
    heights: { '#aa0000': 1, '#00aa00': 2 },
    size: 100,
    // view-unit volume 1640 (incl. 800 units^2 background fill at default 1
    // layer); export scale: 100mm/100units = 1mm/unit in XY, z x2
    // mm^3 = viewVolume * (1)^2 * 2
    expectedVolumeMM3: 1640 * 2,
  },
  {
    name: 'donut',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <rect x="0" y="0" width="200" height="200" fill="#35537b"/>
  <path d="M20,20L180,20L180,180L20,180z M60,60L60,140L140,140L140,60z" fill="#e6bb43" stroke="none"/>
</svg>`,
    palette: ['#35537b', '#e6bb43'],
    heights: { '#35537b': 1, '#e6bb43': 3 },
    size: 200,
    // view volume 7840; scale 100mm/200units = 0.5 mm/unit XY, z x2 -> 7840 * 0.25 * 2
    expectedVolumeMM3: 7840 * 0.5,
  },
  {
    name: '10x10 grid',
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
    size: 100,
    expectedVolumeMM3: 1500 * 2,
    volTol: 0.01,
  },
  {
    name: 'tangent circles',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 100" width="120" height="100">
  <rect x="0" y="0" width="120" height="100" fill="#35537b"/>
  <circle cx="30" cy="50" r="30" fill="#e6bb43"/>
  <circle cx="90" cy="50" r="30" fill="#bb43e6"/>
</svg>`,
    palette: ['#35537b', '#e6bb43', '#bb43e6'],
    heights: { '#35537b': 1, '#e6bb43': 2, '#bb43e6': 3 },
    size: 120,
    // view volume ~2045.8; scale 100/120 mm/unit XY, z x2
    expectedVolumeMM3: 2045.8 * (100 / 120) ** 2 * 2,
    volTol: 0.02,
  },
];

async function runScenario(s: Scenario): Promise<void> {
  console.log(`\n=== ${s.name} ===`);
  const flattened = await flattenSVG(s.svg, s.palette);
  const bbox: BoundingBox = {
    minX: 0, minY: 0, maxX: s.size, maxY: s.size,
    width: s.size, height: s.size, centerX: s.size / 2, centerY: s.size / 2,
  };
  const scaleFactor = calculateScaleFactor(bbox, 100);
  const group = await createManifoldGroupForExport(flattened, s.heights, scaleFactor, bbox, LAYER_MM);
  if (!group) {
    check(false, 'manifold group produced');
    return;
  }
  const scaled = createScaledClone(group, bbox, scaleFactor, 100, 100);
  const stats = getSTLStats(scaled);
  const blob = exportToSTLBlob(scaled, { format: 'binary' });
  const buf = await blob.arrayBuffer();
  const tris = parseBinarySTL(buf);
  const nm = countNonManifoldSTLEdges(tris);
  const vol = signedVolumeSTL(tris);
  console.log(`  STL: ${tris.length} triangles (stats said ${stats.faceCount}), non-manifold edges=${nm}, volume=${vol.toFixed(2)} mm^3`);
  check(tris.length > 0, 'STL has triangles');
  check(nm === 0, `0 non-manifold edges in STL (got ${nm})`);
  const tol = (s.volTol ?? 0.005) * s.expectedVolumeMM3;
  check(
    Math.abs(vol - s.expectedVolumeMM3) <= tol,
    `STL volume ${vol.toFixed(2)} ≈ ${s.expectedVolumeMM3.toFixed(2)} mm^3 (tol ${tol.toFixed(2)})`
  );
}

async function main() {
  for (const s of scenarios) {
    await runScenario(s);
  }
  console.log(`\n${failures === 0 ? 'ALL E2E SCENARIOS PASSED' : failures + ' CHECK(S) FAILED'}`);
}

main().then(() => { process.exit(failures === 0 ? 0 : 1); })
  .catch((e) => { console.error('Error:', e); process.exit(1); });

setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 180000);
