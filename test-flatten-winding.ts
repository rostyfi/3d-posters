/**
 * Winding audit (post-fix verification).
 *
 *  A. flatten-js Face.signedArea() vs local shoelace sign.
 *  B. What windings subtract / unify produce (canonical: outer fj<0, hole fj>0).
 *  C. Emission contract: polygonToIslandDpaths must emit outer subpaths with
 *     POSITIVE local shoelace and hole subpaths with NEGATIVE (enforced).
 *  D. svgToRegions must reconstruct the same regions/areas (round trip).
 *  E. contoursToIslands must never invert geometry: on a polygon whose faces
 *     are ALL negative (non-canonical, e.g. subtract with a CW hole input),
 *     both faces classify as outers — the old sign-based extractIslands rule
 *     picked the hole as the outer.
 *  F. svgToRegions hole attachment: hole vertex ON the outer boundary must
 *     still attach (centroid probe, not hole[0]).
 *  G. svgToRegions robustness: exact duplicate consecutive points in the d
 *     string (from roundPathNumbers rounding) must not drop the region.
 */

import { JSDOM } from 'jsdom';
import { Polygon, point } from '@flatten-js/core';
import { subtract, unify } from '@flatten-js/boolean-op';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
(globalThis as any).DOMParser = dom.window.DOMParser;
(globalThis as any).XMLSerializer = dom.window.XMLSerializer;
(globalThis as any).document = dom.window.document;
(globalThis as any).window = dom.window;
(globalThis as any).MessageChannel = undefined;
let perfStart = Date.now();
(globalThis as any).performance = { now: () => Date.now() - perfStart };

import {
  flattenSVG,
  svgToRegions,
  contoursToIslands,
  faceToContour,
  ClassifiedContour,
} from './src/utils/svg-flatten';

let failures = 0;
function check(ok: boolean, label: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${label}`);
  if (!ok) failures++;
}

/** Local shoelace sum (2x signed area): positive = CCW in math convention. */
function shoelace(pts: { x: number; y: number }[]): number {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return s;
}

function facePts(f: any): { x: number; y: number }[] {
  const pts = (f.vertices as any[]).map((v) => ({ x: v.x, y: v.y }));
  if (pts.length >= 2) {
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) pts.pop();
  }
  return pts;
}

function describeFace(f: any, label: string): void {
  const pts = facePts(f);
  console.log(
    `    ${label}: fjSignedArea=${f.signedArea().toFixed(1)}  localShoelace=${shoelace(pts).toFixed(1)}  ` +
    `verts=${pts.length}  |area|=${f.area().toFixed(1)}`
  );
}

function makeRect(x0: number, y0: number, x1: number, y1: number, ccw: boolean): Polygon {
  const pts = ccw
    ? [point(x0, y0), point(x1, y0), point(x1, y1), point(x0, y1)]
    : [point(x0, y0), point(x0, y1), point(x1, y1), point(x1, y0)];
  const p = new Polygon();
  p.addFace(pts);
  return p;
}

// ---------------------------------------------------------------------------
console.log('=== A/B: winding conventions ===');
{
  const outerCCW = makeRect(0, 0, 100, 100, true);
  const holeCW = makeRect(20, 20, 80, 80, false);
  const holeCCW = makeRect(20, 20, 80, 80, true);

  console.log('  addFace CCW rect:');
  describeFace(Array.from(outerCCW.faces)[0], 'outerCCW');
  console.log('  addFace CW rect:');
  describeFace(Array.from(holeCW.faces)[0], 'holeCW');
  check(
    Array.from(outerCCW.faces)[0].signedArea() === -10000,
    'fj signedArea = -localShoelace/2 (CCW rect -> negative)'
  );

  console.log('\n  subtract(outerCCW, holeCW) [non-canonical hole input]:');
  const r1 = subtract(outerCCW, holeCW);
  console.log(`    polygon.area()=${r1.area().toFixed(1)} (broken: 10000+3600=13600, hole ADDED)`);
  Array.from(r1.faces).forEach((f, i) => describeFace(f, `face[${i}]`));

  console.log('\n  subtract(outerCCW, holeCCW) [canonical inputs]:');
  const r2 = subtract(outerCCW, holeCCW);
  console.log(`    polygon.area()=${r2.area().toFixed(1)} (donut = 6400)`);
  Array.from(r2.faces).forEach((f, i) => describeFace(f, `face[${i}]`));
  check(Math.abs(r2.area() - 6400) < 1e-6, 'canonical subtract gives correct donut area');

  console.log('\n  unify(two overlapping CCW rects):');
  const r3 = unify(makeRect(0, 0, 60, 60, true), makeRect(30, 30, 90, 90, true));
  console.log(`    polygon.area()=${r3.area().toFixed(1)} (L-shape = 6300)`);
  Array.from(r3.faces).forEach((f, i) => describeFace(f, `face[${i}]`));

  console.log('\n  E: contoursToIslands on the NON-CANONICAL polygon (both faces fj<0):');
  {
    const contours: ClassifiedContour[] = [];
    for (const f of r1.faces) {
      const c = faceToContour(f);
      if (c) contours.push(c);
    }
    const islands = contoursToIslands(contours);
    console.log(`    islands: ${islands.length} (expect 2 — both faces are solids, no inversion)`);
    islands.forEach((isl, i) => {
      console.log(`    island[${i}]: outer |area|=${Math.abs(shoelace(isl.outer) / 2).toFixed(1)}, holes=${isl.holes.length}`);
    });
    check(islands.length === 2, 'non-canonical polygon -> 2 solid islands (no hole-as-outer inversion)');
    // Simulate the OLD extractIslands rule for contrast.
    const faces = Array.from(r1.faces) as any[];
    let oldOuterIdx = -1;
    faces.forEach((f, i) => { if (f.signedArea() < 0) oldOuterIdx = i; });
    check(
      Math.abs(faces[oldOuterIdx].area() - 3600) < 1e-6,
      'old sign-based rule would pick the HOLE (3600) as outer — the bug this fixes'
    );
  }

  console.log('\n  E2: contoursToIslands on the CANONICAL donut polygon:');
  {
    const contours: ClassifiedContour[] = [];
    for (const f of r2.faces) {
      const c = faceToContour(f);
      if (c) contours.push(c);
    }
    const islands = contoursToIslands(contours);
    console.log(`    islands: ${islands.length}, holes in island[0]: ${islands[0]?.holes.length}`);
    check(
      islands.length === 1 && islands[0].holes.length === 1 &&
        Math.abs(Math.abs(shoelace(islands[0].outer) / 2) - 10000) < 1e-6,
      'canonical donut -> 1 island, true outer (10000) + 1 hole'
    );
  }
}

// ---------------------------------------------------------------------------
/** Parse emitted d strings (absolute M/L/z) into subpaths. */
function parseD(d: string): { x: number; y: number }[][] {
  const subpaths: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] | null = null;
  for (const m of d.matchAll(/([MLZz])([^MLZz]*)/g)) {
    const cmd = m[1];
    if (cmd === 'z' || cmd === 'Z') {
      if (current && current.length >= 3) subpaths.push(current);
      current = null;
      continue;
    }
    const coords = m[2].match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g);
    if (!coords) continue;
    if (cmd === 'M') {
      if (current && current.length >= 3) subpaths.push(current);
      current = [];
    }
    if (!current) current = [];
    for (let i = 0; i + 1 < coords.length; i += 2) {
      current.push({ x: parseFloat(coords[i]), y: parseFloat(coords[i + 1]) });
    }
  }
  if (current && current.length >= 3) subpaths.push(current);
  return subpaths;
}

interface ExpectedRegion { color: string; area: number; faces: number; }

async function auditFlattenedSVG(
  name: string,
  flattened: string,
  expected: ExpectedRegion[]
): Promise<void> {
  console.log(`\n=== C/D: ${name} ===`);
  const doc = new DOMParser().parseFromString(flattened, 'image/svg+xml');
  const pathEls = Array.from(doc.querySelectorAll('path'));
  let contractOK = true;
  for (const el of pathEls) {
    const fill = el.getAttribute('fill');
    const d = el.getAttribute('d')!;
    const subs = parseD(d);
    const contours: ClassifiedContour[] = subs.map((pts) => ({
      pts,
      shoelace: shoelace(pts),
      centroid: { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length },
    }));
    const islands = contoursToIslands(contours);
    console.log(`  path fill=${fill}: ${subs.length} subpaths -> ${islands.length} island(s)`);
    for (const isl of islands) {
      const outerOK = shoelace(isl.outer) > 0;
      if (!outerOK) contractOK = false;
      console.log(`    outer: shoelace=${shoelace(isl.outer).toFixed(1)} ${outerOK ? 'OK' : '*** VIOLATION (must be > 0) ***'}`);
      for (const h of isl.holes) {
        const holeOK = shoelace(h) < 0;
        if (!holeOK) contractOK = false;
        console.log(`    hole:  shoelace=${shoelace(h).toFixed(1)} ${holeOK ? 'OK' : '*** VIOLATION (must be < 0) ***'}`);
      }
    }
  }
  check(contractOK, 'emission contract: outers positive shoelace, holes negative');

  const regions = await svgToRegions(flattened);
  if (!regions) {
    check(false, 'svgToRegions returned regions');
    return;
  }
  console.log(`  svgToRegions: ${regions.length} regions (expect ${expected.length})`);
  check(regions.length === expected.length, `region count ${regions.length} == ${expected.length}`);
  for (const exp of expected) {
    const match = regions.filter((r) => r.color === exp.color && Math.abs(r.polygon.area() - exp.area) < 1);
    const faceCounts = regions
      .filter((r) => r.color === exp.color)
      .map((r) => Array.from(r.polygon.faces).length);
    console.log(
      `    expect ${exp.color} area=${exp.area} faces=${exp.faces}; got areas=[${regions
        .filter((r) => r.color === exp.color)
        .map((r) => r.polygon.area().toFixed(1))}] faces=[${faceCounts}]`
    );
    check(match.length >= 1, `region ${exp.color} with area ${exp.area} exists`);
  }
}

async function main() {
  // Donut: bg rect + donut path (outer square, hole square, same fill).
  const donutSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <rect x="0" y="0" width="200" height="200" fill="#35537b"/>
  <path d="M20,20L180,20L180,180L20,180z M60,60L60,140L140,140L140,60z" fill="#e6bb43" stroke="none"/>
</svg>`;
  const flat1 = await flattenSVG(donutSVG, ['#e6bb43', '#35537b']);
  await auditFlattenedSVG('donut (rect bg + square donut)', flat1, [
    { color: '#35537b', area: 14400, faces: 2 }, // rect minus donut outer
    { color: '#35537b', area: 6400, faces: 1 },  // hole area shows background
    { color: '#e6bb43', area: 19200, faces: 2 }, // donut = outer - hole
  ]);

  // Multi-level nesting: outer -> hole -> solid-in-hole (same path).
  const nestedSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <rect x="0" y="0" width="200" height="200" fill="#35537b"/>
  <path d="M10,10L190,10L190,190L10,190z M40,40L40,160L160,160L160,40z M70,70L130,70L130,130L70,130z" fill="#e6bb43" stroke="none"/>
</svg>`;
  const flat2 = await flattenSVG(nestedSVG, ['#e6bb43', '#35537b']);
  await auditFlattenedSVG('nested (outer -> hole -> solid-in-hole)', flat2, [
    { color: '#35537b', area: 7600, faces: 2 },  // rect minus donut outer (40000-32400)
    { color: '#35537b', area: 10800, faces: 2 }, // ring between hole and solid (14400-3600)
    { color: '#e6bb43', area: 18000, faces: 2 }, // donut (32400-14400)
    { color: '#e6bb43', area: 3600, faces: 1 },  // solid in hole
  ]);

  // Circles (curve sampling path).
  const circleSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <rect x="0" y="0" width="200" height="200" fill="#35537b"/>
  <path d="M100,30 A70,70 0 1 1 99.9,30 z M100,70 A30,30 0 1 0 100.1,70 z" fill="#e6bb43" stroke="none"/>
</svg>`;
  const flat3 = await flattenSVG(circleSVG, ['#e6bb43', '#35537b']);
  const regions3 = await svgToRegions(flat3);
  const donut3 = regions3?.find((r) => r.color === '#e6bb43');
  // Arcs are sampled as 24-gons, so allow ~1% tolerance vs the true circle area.
  const expectedDonut = Math.PI * 70 * 70 - Math.PI * 30 * 30;
  console.log(`    circle donut area=${donut3?.polygon.area().toFixed(1)} (true circle area ${expectedDonut.toFixed(1)}, 24-gon approx)`);
  check(
    !!donut3 && Math.abs(donut3.polygon.area() - expectedDonut) < expectedDonut * 0.01 &&
      Array.from(donut3.polygon.faces).length === 2,
    'circle donut round-trips (area within 1% of true, 2 faces)'
  );

  // F: hole whose FIRST VERTEX lies exactly on the outer's boundary.
  console.log('\n=== F: hole attachment with hole vertex on outer boundary ===');
  {
    // Outer rect 0..200; hole square 50..150 whose first vertex (50,50)... is
    // interior. Make the hole touch the outer's edge: hole = 0..100 square
    // sharing the outer's corner (0,0) — hole[0] = (0,0) is ON the boundary.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <path d="M0,0L200,0L200,200L0,200 zM0,0L0,100L100,100L100,0 z" fill="#ff0000" stroke="none"/>
</svg>`;
    const regions = await svgToRegions(svg);
    if (!regions) {
      check(false, 'boundary-hole SVG produced regions');
    } else {
      // The hole shares the corner (0,0) with the outer. Winding classification:
      // hole subpath shoelace: (0,0)->(0,100)->(100,100)->(100,0) = negative -> hole.
      // Expected region: rect minus the 100x100 corner square = 40000-10000=30000.
      const total = regions.reduce((s, r) => s + r.polygon.area(), 0);
      const faces = regions.reduce((s, r) => s + Array.from(r.polygon.faces).length, 0);
      console.log(`    regions=${regions.length}, total area=${total.toFixed(1)}, faces=${faces}`);
      check(
        regions.length === 1 && Math.abs(total - 30000) < 1 && faces === 2,
        'hole attached despite hole[0] on the outer boundary (area 30000, 2 faces)'
      );
    }
  }

  // G: exact duplicate consecutive points in the d string (rounding artifact).
  console.log('\n=== G: duplicate consecutive points (roundPathNumbers artifact) ===');
  {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <path d="M0,0L100,0L100,0L100,100L0,100 z" fill="#ff0000" stroke="none"/>
</svg>`;
    const regions = await svgToRegions(svg);
    if (!regions) {
      check(false, 'duplicate-point SVG produced regions (addFace must not throw)');
    } else {
      const total = regions.reduce((s, r) => s + r.polygon.area(), 0);
      console.log(`    regions=${regions.length}, total area=${total.toFixed(1)}`);
      check(regions.length === 1 && Math.abs(total - 10000) < 1, 'region survives duplicate points (area 10000)');
    }
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
}

main().then(() => { process.exit(failures === 0 ? 0 : 1); })
  .catch((e) => { console.error('Error:', e); process.exit(1); });

setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 60000);
