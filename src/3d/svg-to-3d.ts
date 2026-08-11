/**
 * SVG to 3D conversion utilities
 */

import * as THREE from 'three';
import { ColorHeights, BoundingBox } from '../types';
import { colorToRGB, rgbToHex } from '../utils/color';
import { SVGLoader } from './three-setup';
import { Region, svgToRegions } from '../utils/svg-flatten';

/**
 * Extract fill color from an SVG path
 * @param path - SVG path object from THREE.SVGLoader
 * @returns Fill color string or empty string
 */
export function extractFillColorFromPath(path: any): string {
  // Get fill color from path userData - try multiple locations
  let fillColor = path.userData?.fill || path.userData?.style?.fill || '';

  // Also check if userData has fill in a different format
  if (!fillColor && path.userData) {
    // userData might have attributes directly
    for (const key in path.userData) {
      if (key.toLowerCase() === 'fill') {
        fillColor = path.userData[key];
        break;
      }
    }
    // Or style might be a string
    if (!fillColor && path.userData.style && typeof path.userData.style === 'string') {
      const fillMatch = path.userData.style.match(/fill:\s*([^;]+)/i);
      if (fillMatch) fillColor = fillMatch[1].trim();
    }
  }

  return fillColor;
}

/**
 * Element bounding box for a single SVG path
 */
export interface ElementBoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Get element bounding box from path data
 * @param path - SVG path object from THREE.SVGLoader
 * @returns Bounding box for this path
 */
export function getElementBoundingBox(path: any): ElementBoundingBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const subPath of path.subPaths) {
    for (const point of subPath.getPoints()) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }

  return { minX, minY, maxX, maxY };
}

/**
 * Create Three.js material from color
 * @param fillColor - Color string (hex, rgb, named)
 * @returns THREE.MeshStandardMaterial
 */
export function createMaterialFromColor(fillColor: string): THREE.MeshStandardMaterial {
  const rgb = colorToRGB(fillColor);
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(rgb.r / 255, rgb.g / 255, rgb.b / 255),
    side: THREE.DoubleSide,
    transparent: false,
  });
}

/**
 * Convert SVG paths to 3D meshes
 * @param paths - SVG paths from THREE.SVGLoader
 * @param colorHeights - Mapping from color to height in layers
 * @param simplifiedColors - Array of colors in the simplified palette
 * @param scaleFactor - Scale factor for converting SVG coordinates to 3D space
 * @param boundingBox - Overall SVG bounding box for positioning
 * @param layerHeightMM - Height of a single layer in millimeters
 * @returns THREE.Group containing all 3D meshes
 */
export function create3DMeshesFromPaths(
  paths: any[],
  colorHeights: ColorHeights,
  simplifiedColors: string[],
  scaleFactor: number,
  boundingBox: BoundingBox,
  layerHeightMM: number
): THREE.Group {
  // Create a group to hold all 3D objects with Y flipped
  const group = new THREE.Group();
  group.scale.y = -1; // Flip Y: SVG Y-down to Three.js Y-up
  
  // Position group so top-left corner (minX, minY) is at origin (0, 0)
  // Transform order in Three.js: scale -> rotation -> position
  // With group.scale.y = -1, a point (x, y) becomes (x, -y) then (x + px, -y + py)
  // For (minX * scaleFactor, minY * scaleFactor) to be at (0, 0):
  //   minX * scaleFactor + px = 0  => px = -minX * scaleFactor
  //   -minY * scaleFactor + py = 0 => py = minY * scaleFactor
  group.position.set(
    -boundingBox.minX * scaleFactor,
    boundingBox.minY * scaleFactor,
    0
  );

  // Process each path from the parsed SVG data.
  // Each shape is its own mesh with a solid-color material. This keeps colors
  // crisp (no vertex-color gradients at shared boundaries) and lets the z-buffer
  // handle occlusion naturally. The meshes are merged into a single manifold
  // geometry only at STL export time (see mergeToManifold).
  paths.forEach((path: any) => {
    // Get fill color from path
    const fillColor = extractFillColorFromPath(path);

    // Skip if fill is none, inherit, or a URL reference
    if (
      !fillColor ||
      typeof fillColor !== 'string' ||
      fillColor === 'none' ||
      fillColor === 'inherit' ||
      fillColor.startsWith('url(') ||
      fillColor.startsWith('var(')
    ) {
      return;
    }

    // Normalize the color to hex for lookup
    const hexColor = rgbToHex(colorToRGB(fillColor));

    // Find the matching color from our palette
    let matchedColor: string | null = null;
    for (const color of simplifiedColors) {
      const colorHex = rgbToHex(colorToRGB(color));
      if (colorHex === hexColor) {
        matchedColor = color;
        break;
      }
    }

    // If no match found, use the original color
    if (!matchedColor) {
      matchedColor = fillColor;
    }

    const layers = colorHeights[matchedColor] || 1;
    const heightMM = layers * layerHeightMM;
    const heightUnits = heightMM * 0.5; // Scale mm to Three.js units (1mm = 0.5 units for better visibility)

    // Create material from color
    const material = createMaterialFromColor(fillColor);

    // Create shapes from this path. A degenerate path (e.g. a sliver from
    // boolean ops) can make createShapes throw; skip such paths so one bad
    // shape doesn't crash the entire structure.
    let shapes: any[];
    try {
      shapes = SVGLoader.createShapes(path);
    } catch (e) {
      console.warn('createShapes failed for a path, skipping:', e);
      return;
    }
    for (const shape of shapes) {
      // Skip shapes with too few points to extrude (would crash ExtrudeGeometry).
      const pts = shape.extractPoints(12).shape;
      if (pts.length < 3) continue;
      let geometry: THREE.ExtrudeGeometry;
      try {
        geometry = new THREE.ExtrudeGeometry(shape as THREE.Shape, {
          depth: heightUnits,
          bevelEnabled: false,
        });
      } catch (e) {
        console.warn('ExtrudeGeometry failed for a shape, skipping:', e);
        continue;
      }
      const mesh = new THREE.Mesh(geometry, material);
      mesh.scale.set(scaleFactor, scaleFactor, 1);
      // Don't position individually in X/Y - shapes already have absolute SVG coordinates
      // Position at z=0 so the extrusion starts from the base
      mesh.position.z = 0;
      group.add(mesh);
    }
  });

  return group;
}

/**
 * Build a single water-tight (manifold) solid from the flattened SVG regions.
 *
 * The flattened SVG is a set of non-overlapping colored regions that tile the
 * plane. Each region has an extrusion height (from its color). The 3D model is
 * the "height field" solid: {(x,y,z) | 0 <= z <= h(x,y)} where h is the
 * piecewise-constant height of the region covering (x,y).
 *
 * Construction (per region, NO unification — unification loses the shared-edge
 * vertices that adjacent regions need to match):
 *   - Top face:    region polygon at z = hR, facing up.
 *   - Bottom face: region polygon at z = 0, facing down.
 *   - Walls:       for each boundary edge, if this region is taller than its
 *                  neighbor across that edge (or the edge is an outer boundary),
 *                  emit a vertical wall from the neighbor's height up to hR.
 *                  Exactly one wall per shared boundary (the taller side emits),
 *                  so there are no coincident duplicate walls.
 *
 * Two consistency passes guarantee every edge is shared by exactly two faces
 * (closed manifold):
 *
 *   1. T-junction splitting. The flatten step (boolean subtract) leaves
 *      T-junctions: a vertex of region A may lie in the middle of region B's
 *      edge without being a vertex of B. That mismatch would leave B's wall
 *      edge un-split where A's wall meets it. We split every region edge at any
 *      vertex of another region that lies on it AND has an incident edge
 *      collinear with it (the latter filter avoids splitting at mere tangent
 *      point-contacts, which are inherently non-manifold contacts, not shared
 *      boundaries). The same split rings are used for top/bottom triangulation
 *      and walls so their boundaries match.
 *
 *   2. Wall height subdivision. A wall spanning [z0, z1] is split at every
 *      distinct region height strictly between z0 and z1, so its vertical
 *      edges have vertices at every level any neighboring wall starts/ends at.
 *
 * Output is a non-indexed BufferGeometry (triangle soup) in raw SVG coordinates
 * with Z in the same units as the view (1mm = 0.5 units); createScaledClone
 * applies the final mm scaling at export time.
 *
 * @param regions - Flattened regions (color + polygon).
 * @param colorHeights - Color -> layer count mapping.
 * @param layerHeightMM - Physical height of one layer in mm.
 * @returns Manifold BufferGeometry, or null if no regions produced geometry.
 */
export function buildManifoldGeometry(
  regions: Region[],
  colorHeights: ColorHeights,
  layerHeightMM: number
): THREE.BufferGeometry | null {
  // Normalize colorHeights by hex so palette keys match region colors (both hex).
  const heightsByHex = new Map<string, number>();
  for (const k in colorHeights) {
    heightsByHex.set(rgbToHex(colorToRGB(k)), colorHeights[k]);
  }
  const layersFor = (color: string): number => {
    const hex = rgbToHex(colorToRGB(color));
    return heightsByHex.get(hex) ?? 1;
  };

  // Assign height (view units: 1mm = 0.5 units) to each region.
  interface TypedRegion { polygon: Region['polygon']; h: number; }
  const typed: TypedRegion[] = [];
  for (const r of regions) {
    const layers = layersFor(r.color);
    const h = layers * layerHeightMM * 0.5;
    if (h > 0 && !r.polygon.isEmpty()) typed.push({ polygon: r.polygon, h });
  }
  if (!typed.length) return null;

  // Distinct heights (for wall subdivision).
  const allHeights = Array.from(new Set(typed.map((t) => t.h))).sort((a, b) => a - b);

  // Extract islands (outer + holes) per region as point arrays.
  const rawIslands = typed.map((t) => extractIslands(t.polygon));

  // Global vertex set (snapped) across all rings.
  const vertSet = new Map<string, THREE.Vector2>();
  for (const islands of rawIslands) {
    for (const is of islands) {
      for (const p of is.outer) vertSet.set(vertKey(p), new THREE.Vector2(qv(p.x), qv(p.y)));
      for (const hole of is.holes) for (const p of hole) vertSet.set(vertKey(p), new THREE.Vector2(qv(p.x), qv(p.y)));
    }
  }
  const verts = Array.from(vertSet.values());

  // Incident-edge direction map (per snapped vertex) for the collinear-T-junction filter.
  const allRings: { x: number; y: number }[][] = [];
  for (const islands of rawIslands) {
    for (const is of islands) {
      allRings.push(is.outer);
      for (const hole of is.holes) allRings.push(hole);
    }
  }
  const incident = buildIncident(allRings);

  // Split all rings at T-junction points.
  const splitIslands = rawIslands.map((islands) =>
    islands.map((is) => ({
      outer: splitRing(is.outer, verts, incident),
      holes: is.holes.map((h) => splitRing(h, verts, incident)),
    }))
  );

  // Edge -> list of {regionIndex, height} for neighbor lookup.
  const edgeMap = new Map<string, Array<{ ri: number; h: number }>>();
  for (let ri = 0; ri < typed.length; ri++) {
    for (const is of splitIslands[ri]) {
      for (const ring of [is.outer, ...is.holes]) {
        const n = ring.length;
        for (let i = 0; i < n; i++) {
          const key = edgeKey(ring[i], ring[(i + 1) % n]);
          let list = edgeMap.get(key);
          if (!list) { list = []; edgeMap.set(key, list); }
          list.push({ ri, h: typed[ri].h });
        }
      }
    }
  }

  // Emit triangles.
  const positions: number[] = [];
  for (let ri = 0; ri < typed.length; ri++) {
    const hR = typed[ri].h;
    emitHorizontal(splitIslands[ri], hR, true, positions);
    emitHorizontal(splitIslands[ri], 0, false, positions);
    for (const is of splitIslands[ri]) {
      for (const ring of [is.outer, ...is.holes]) {
        const n = ring.length;
        for (let i = 0; i < n; i++) {
          const pi = ring[i];
          const pj = ring[(i + 1) % n];
          if (Math.abs(pi.x - pj.x) < 1e-9 && Math.abs(pi.y - pj.y) < 1e-9) continue;
          const list = edgeMap.get(edgeKey(pi, pj)) || [];
          let neighborH = 0;
          if (list.length > 1) {
            const other = list.find((e) => e.ri !== ri);
            neighborH = other ? other.h : hR;
          }
          if (hR > neighborH + 1e-9) emitWall(pi, pj, neighborH, hR, allHeights, positions);
        }
      }
    }
  }

  if (positions.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------------------
// Manifold helpers.
// ---------------------------------------------------------------------------

const MANIFOLD_Q = 1e-4;
function qv(v: number): number { return Math.round(v / MANIFOLD_Q) * MANIFOLD_Q; }
function vertKey(p: { x: number; y: number }): string { return `${qv(p.x)},${qv(p.y)}`; }
function edgeKey(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const ka = vertKey(a), kb = vertKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

interface Island { outer: { x: number; y: number }[]; holes: { x: number; y: number }[][]; }

/** Extract a region polygon into islands: each {outer, holes[]} as point arrays. */
function extractIslands(polygon: Region['polygon']): Island[] {
  let islands: Region['polygon'][];
  try { islands = polygon.splitToIslands(); } catch { islands = [polygon]; }
  const out: Island[] = [];
  for (const isl of islands) {
    const faces = Array.from(isl.faces) as any[];
    let outer: { x: number; y: number }[] | null = null;
    const holes: { x: number; y: number }[][] = [];
    for (const f of faces) {
      const pts = facePoints(f);
      if (pts.length < 3) continue;
      // flatten-js: negative signedArea = outer (CCW), positive = hole (CW).
      if (f.signedArea() < 0) outer = pts;
      else holes.push(pts);
    }
    if (!outer) {
      // Fallback: treat the largest-area face as the outer, reversed to CCW.
      let best: any = null, bestArea = 0;
      for (const f of faces) {
        const a = Math.abs(f.signedArea());
        if (a > bestArea) { bestArea = a; best = f; }
      }
      if (!best) continue;
      outer = facePoints(best).reverse();
    }
    out.push({ outer, holes });
  }
  return out;
}

/** Face vertices as plain points, dropping a closing duplicate if present. */
function facePoints(f: any): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = (f.vertices as any[]).map((v) => ({ x: v.x, y: v.y }));
  if (pts.length >= 2) {
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) pts.pop();
  }
  return pts;
}

/**
 * Per-vertex incident edge directions (normalized), used to decide whether a
 * candidate T-junction point has a collinear incident edge (true shared-edge
 * break) vs. a mere tangent point-contact (no collinear edge -> don't split).
 */
function buildIncident(rings: { x: number; y: number }[][]): Map<string, { dx: number; dy: number }[]> {
  const m = new Map<string, { dx: number; dy: number }[]>();
  const add = (p: { x: number; y: number }, d: { x: number; y: number }) => {
    const L = Math.hypot(d.x, d.y);
    if (L < 1e-18) return;
    const k = vertKey(p);
    let a = m.get(k);
    if (!a) { a = []; m.set(k, a); }
    a.push({ dx: d.x / L, dy: d.y / L });
  };
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      add(a, { x: b.x - a.x, y: b.y - a.y });
      add(b, { x: a.x - b.x, y: a.y - b.y });
    }
  }
  return m;
}

function hasCollinearIncident(
  incident: Map<string, { dx: number; dy: number }[]>,
  p: { x: number; y: number },
  dx: number, dy: number
): boolean {
  const list = incident.get(vertKey(p));
  if (!list) return false;
  const L = Math.hypot(dx, dy);
  if (L < 1e-18) return false;
  const ndx = dx / L, ndy = dy / L;
  for (const e of list) {
    if (Math.abs(ndx * e.dy - ndy * e.dx) < 1e-6) return true;
  }
  return false;
}

/**
 * Split a closed ring at T-junction points: vertices of other regions that lie
 * on a ring edge AND have a collinear incident edge (so the split is a genuine
 * shared-boundary break, not a tangent point-contact). Drops consecutive
 * duplicate points and the closing duplicate.
 */
function splitRing(
  ring: { x: number; y: number }[],
  verts: THREE.Vector2[],
  incident: Map<string, { dx: number; dy: number }[]>
): { x: number; y: number }[] {
  const n = ring.length;
  const raw: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    raw.push(a);
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-18) continue;
    const len = Math.sqrt(len2);
    const cuts: { t: number; x: number; y: number }[] = [];
    for (const v of verts) {
      const px = v.x - a.x, py = v.y - a.y;
      const cross = dx * py - dy * px;
      if (Math.abs(cross) > 1e-6 * len + 1e-12) continue;
      const t = dx * px + dy * py;
      if (t <= 1e-9 * len2 || t >= len2 - 1e-9 * len2) continue;
      if (!hasCollinearIncident(incident, v, dx, dy)) continue;
      cuts.push({ t, x: v.x, y: v.y });
    }
    cuts.sort((u, v) => u.t - v.t);
    for (const c of cuts) raw.push({ x: c.x, y: c.y });
  }
  const out: { x: number; y: number }[] = [];
  for (const p of raw) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-9 && Math.abs(last.y - p.y) < 1e-9) continue;
    out.push(p);
  }
  if (out.length >= 2) {
    const f = out[0], l = out[out.length - 1];
    if (Math.abs(f.x - l.x) < 1e-9 && Math.abs(f.y - l.y) < 1e-9) out.pop();
  }
  return out;
}

/** Emit the top (up) or bottom (down) faces of a region's islands at height z. */
function emitHorizontal(
  islands: Island[],
  z: number,
  up: boolean,
  out: number[]
): void {
  for (const is of islands) {
    const outer = is.outer.map((p) => new THREE.Vector2(p.x, p.y));
    const holes = is.holes.map((h) => h.map((p) => new THREE.Vector2(p.x, p.y)));
    let tris: number[][];
    try { tris = THREE.ShapeUtils.triangulateShape(outer, holes); } catch { continue; }
    const merged = outer.slice();
    for (const h of holes) merged.push(...h);
    for (const t of tris) {
      const a = merged[t[0]], b = merged[t[1]], c = merged[t[2]];
      const area2 = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y));
      if (area2 < 1e-12) continue;
      if (up) out.push(a.x, a.y, z, b.x, b.y, z, c.x, c.y, z);
      else out.push(a.x, a.y, z, c.x, c.y, z, b.x, b.y, z); // reversed winding -> downward
    }
  }
}

/** Emit a vertical wall from z0 to z1 along edge pi->pj, split at every height level. */
function emitWall(
  pi: { x: number; y: number },
  pj: { x: number; y: number },
  z0: number, z1: number,
  allHeights: number[],
  out: number[]
): void {
  const cuts = [z0];
  for (const h of allHeights) {
    if (h > z0 + 1e-9 && h < z1 - 1e-9) cuts.push(h);
  }
  cuts.push(z1);
  for (let i = 0; i < cuts.length - 1; i++) {
    const za = cuts[i], zb = cuts[i + 1];
    // Quad (pi,za)-(pj,za)-(pj,zb)-(pi,zb) -> two triangles, outward-facing.
    out.push(pi.x, pi.y, za, pj.x, pj.y, za, pj.x, pj.y, zb);
    out.push(pi.x, pi.y, za, pj.x, pj.y, zb, pi.x, pi.y, zb);
  }
}

/**
 * Build a manifold export group from the flattened SVG.
 *
 * Produces a single-mesh group whose transform mirrors `create3DMeshesFromPaths`
 * (mesh scale = scaleFactor on X/Y; group Y-flip + position offset) so that
 * `createScaledClone` applies the identical export scaling it applies to the
 * display group. The result is a water-tight solid suitable for STL export.
 *
 * @param svgContent - Flattened SVG string.
 * @returns Group containing one manifold mesh, or null on failure.
 */
export function createManifoldGroupForExport(
  svgContent: string,
  colorHeights: ColorHeights,
  scaleFactor: number,
  boundingBox: BoundingBox,
  layerHeightMM: number
): THREE.Group | null {
  const regions = svgToRegions(svgContent);
  if (!regions || regions.length === 0) return null;
  const geometry = buildManifoldGeometry(regions, colorHeights, layerHeightMM);
  if (!geometry) return null;

  const group = new THREE.Group();
  group.scale.y = -1; // Flip Y: SVG Y-down to Three.js Y-up (matches display group)
  group.position.set(
    -boundingBox.minX * scaleFactor,
    boundingBox.minY * scaleFactor,
    0
  );

  const material = new THREE.MeshStandardMaterial({
    color: 0xcccccc,
    side: THREE.DoubleSide,
    transparent: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.scale.set(scaleFactor, scaleFactor, 1);
  mesh.position.z = 0;
  group.add(mesh);
  return group;
}

/**
 * Calculate scale factor for SVG to 3D conversion
 * @param boundingBox - SVG bounding box
 * @param targetSize - Target size in 3D units (default 100)
 * @returns Scale factor
 */
export function calculateScaleFactor(boundingBox: BoundingBox, targetSize: number = 100): number {
  const maxCoordDim = Math.max(boundingBox.width, boundingBox.height);
  return targetSize / maxCoordDim;
}
