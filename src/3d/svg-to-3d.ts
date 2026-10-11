/**
 * SVG to 3D conversion utilities
 */

import * as THREE from 'three';
import { ColorHeights, BoundingBox } from '../types';
import { colorToRGB, rgbToHex } from '../utils/color';
import { SVGLoader } from './three-setup';
import { Region, svgToRegions, contoursToIslands, faceToContour, ClassifiedContour } from '../utils/svg-flatten';
import { BooleanOperations, Polygon, point } from '@flatten-js/core';

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

  // Assign height (view units: 1mm = 0.5 units) to each region. Regions with
  // h <= 0 (the UI allows 0 layers; negative/NaN degrade the same way) are
  // dropped: a 0-height region is "no material" — taller neighbors wall down
  // to z=0 around it and the model stays closed. Emitting a bottom face for
  // it would make each wall-bottom edge at z=0 shared by 3 triangles.
  const typed: TypedRegion[] = [];
  for (const r of regions) {
    const layers = layersFor(r.color);
    const h = layers * layerHeightMM * 0.5;
    if (h > 0 && !r.polygon.isEmpty()) typed.push({ polygon: r.polygon, h });
  }
  if (!typed.length) return null;

  // Distinct heights (for wall subdivision).
  const allHeights = Array.from(new Set(typed.map((t) => t.h))).sort((a, b) => a - b);

  // Extract islands (outer + holes) per region as point arrays, splitting
  // self-touching rings into simple rings (see splitSelfTouchingIslands) and
  // dropping vertices collinear with their neighbors (see
  // removeRedundantVertices).
  const rawIslands = typed.map((t) =>
    splitSelfTouchingIslands(extractIslands(t.polygon)).map((is) => ({
      outer: removeRedundantVertices(is.outer),
      holes: is.holes.map(removeRedundantVertices),
    }))
  );

  // Global vertex set (snapped) across all rings.
  const vertSet = new Map<string, THREE.Vector2>();
  for (const islands of rawIslands) {
    for (const is of islands) {
      for (const p of is.outer) vertSet.set(vertKey(p), new THREE.Vector2(qv(p.x), qv(p.y)));
      for (const hole of is.holes) for (const p of hole) vertSet.set(vertKey(p), new THREE.Vector2(qv(p.x), qv(p.y)));
    }
  }
  const verts = Array.from(vertSet.values());

  // SVG extent (largest coordinate range) — used to scale the point-contact
  // nudge distance so the hairline gap it opens stays above the STL weld grid
  // after export scaling (see POINT_CONTACT_EPS).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const v of verts) {
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }
  const extent = Math.max(maxX - minX, maxY - minY);
  const pointContactEps = Math.max(POINT_CONTACT_EPS, extent * POINT_CONTACT_EPS_PER_EXTENT);
  const pointContactMinEps = Math.max(2 * MANIFOLD_Q, extent * POINT_CONTACT_MIN_EPS_PER_EXTENT);

  // Incident-edge direction map (per snapped vertex) for the collinear-T-junction filter.
  const allRings: { x: number; y: number }[][] = [];
  for (const islands of rawIslands) {
    for (const is of islands) {
      allRings.push(is.outer);
      for (const hole of is.holes) allRings.push(hole);
    }
  }
  const incident = buildIncident(allRings);

  // Split all rings at T-junction points and at the island's own vertices
  // lying on a ring edge (see splitRing). The vertex grid turns the per-edge
  // candidate scan from O(all vertices) into O(points near the edge).
  const vertGrid = new VertexGrid(verts);
  const splitIslands = rawIslands.map((islands) =>
    islands.map((is) => {
      const islandVerts = new Set<string>();
      for (const p of is.outer) islandVerts.add(vertKey(p));
      for (const h of is.holes) for (const p of h) islandVerts.add(vertKey(p));
      const outerR = splitRing(is.outer, verts, vertGrid, incident, islandVerts);
      const holesR = is.holes.map((h) => splitRing(h, verts, vertGrid, incident, islandVerts));
      return {
        outer: outerR.ring,
        holes: holesR.map((r) => r.ring),
        outerInserted: outerR.inserted,
        holesInserted: holesR.map((r) => r.inserted),
      };
    })
  );

  // Resolve point contacts (regions sharing a vertex but no boundary edge)
  // before building the edge map: both regions extrude a wall through such a
  // vertex, and over the overlapping z-range their vertical wall edges
  // coincide — the same edge used by four triangles — leaving a non-manifold
  // seam that slicers report as "not watertight" and cannot repair. The
  // resolution opens a sub-pixel gap by nudging one side's vertex a hairline
  // into its own region, so each region stays a closed solid.
  resolvePointContacts(splitIslands, typed, allHeights, pointContactEps, pointContactMinEps);

  // Edge -> list of {regionIndex, height} for neighbor lookup.
  const edgeMap = buildEdgeMap(splitIslands, typed);

  // Emit triangles. Each island is triangulated once and the triangulation is
  // reused for the top and bottom faces (see robustTriangulateIsland).
  const positions: number[] = [];
  const triCache = new WeakMap<Island, IslandTriangulation | null>();
  for (let ri = 0; ri < typed.length; ri++) {
    const hR = typed[ri].h;
    emitHorizontal(splitIslands[ri], hR, true, positions, triCache);
    emitHorizontal(splitIslands[ri], 0, false, positions, triCache);
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

  // Validate manifoldness: every edge must be shared by exactly 2 triangles.
  // Non-manifold edges (count != 2) mean the STL will be rejected by slicers.
  // This is a diagnostic — it logs a warning but doesn't modify the geometry.
  const nmCount = countNonManifoldEdges(geo);
  if (nmCount > 0) {
    console.warn(
      `buildManifoldGeometry: ${nmCount} non-manifold edges detected ` +
      `(likely cause: overlapping input regions — the SVG was not flattened). ` +
      `Re-flatten the SVG before exporting.`
    );
  }

  return geo;
}

/**
 * Count edges that are not shared by exactly 2 triangles in a triangle-soup
 * BufferGeometry. Vertices are matched by their float32 bit pattern (the same
 * precision the STL format stores), so this reflects what a slicer would see.
 */
function countNonManifoldEdges(geo: THREE.BufferGeometry): number {
  const pos = geo.getAttribute('position');
  if (!pos) return 0;
  const arr = pos.array as Float32Array;
  const nTris = Math.floor(arr.length / 9);
  if (nTris === 0) return 0;

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
  for (const count of edgeMap.values()) {
    if (count !== 2) nm++;
  }
  return nm;
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

/**
 * Uniform grid index over 2D points for "which points lie on this segment"
 * queries. splitRing and refineBoundaryVertices both need, per segment, the
 * subset of vertices lying on it; scanning every vertex per segment is
 * O(edges x vertices) — minutes on real posters. A point lying on a segment
 * is inside the segment's bounding box, so bucketing points into grid cells
 * and querying only the cells a segment's box covers finds the exact same
 * candidates in near-linear time.
 */
class VertexGrid {
  private cell: number;
  private minX = Infinity;
  private minY = Infinity;
  private cells = new Map<string, number[]>();

  constructor(points: Array<{ x: number; y: number }>) {
    let maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < this.minX) this.minX = p.x;
      if (p.y < this.minY) this.minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    // Default cell size targets a handful of points per cell.
    const n = Math.max(points.length, 1);
    const side = Math.max(Math.sqrt(n), 1);
    this.cell = Math.max((Math.max(maxX - this.minX, maxY - this.minY) || 1) / side, 1e-9);
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const cx = Math.floor((p.x - this.minX) / this.cell);
      const cy = Math.floor((p.y - this.minY) / this.cell);
      const k = `${cx},${cy}`;
      let arr = this.cells.get(k);
      if (!arr) { arr = []; this.cells.set(k, arr); }
      arr.push(i);
    }
  }

  /** Indices of points inside the query box (inclusive). */
  query(minX: number, minY: number, maxX: number, maxY: number, out: number[]): void {
    const eps = 1e-4; // covers the on-segment test's perpendicular tolerance
    const cx0 = Math.floor((minX - eps - this.minX) / this.cell);
    const cx1 = Math.floor((maxX + eps - this.minX) / this.cell);
    const cy0 = Math.floor((minY - eps - this.minY) / this.cell);
    const cy1 = Math.floor((maxY + eps - this.minY) / this.cell);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const arr = this.cells.get(`${cx},${cy}`);
        if (arr) for (const i of arr) out.push(i);
      }
    }
  }
}

interface Island {
  outer: { x: number; y: number }[];
  holes: { x: number; y: number }[][];
  /** Vertex keys splitRing inserted into each ring (structural vertices). */
  outerInserted?: Set<string>;
  holesInserted?: Set<string>[];
}

/**
 * Extract a region polygon into islands: each {outer, holes[]} as point arrays.
 *
 * Classification is by WINDING NUMBER (contoursToIslands, shared with the
 * flatten module), robust to any face orientation and to arbitrary nesting.
 * The previous sign-based rule ("last negative-signedArea face wins as outer")
 * inverted the geometry when an island held more than one negative face —
 * e.g. when splitToIslands threw and a multipolygon was treated as one island:
 * the hole would win as "outer" and the true outer became a hole.
 */
function extractIslands(polygon: Region['polygon']): Island[] {
  const contours: ClassifiedContour[] = [];
  for (const f of polygon.faces) {
    const c = faceToContour(f);
    if (c) contours.push(c);
  }
  return contoursToIslands(contours).map((isl) => ({ outer: isl.outer, holes: isl.holes }));
}

/** Ray-casting point-in-ring test. */
function pointInRingXY(p: { x: number; y: number }, ring: { x: number; y: number }[]): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i].x, yi = ring[i].y, xj = ring[j].x, yj = ring[j].y;
    if (((yi > p.y) !== (yj > p.y)) && (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Split a ring that visits a vertex more than once into simple rings, one per
 * lobe, by cutting at the repeated vertices. A self-touching ring (e.g. two
 * lobes of a merged region meeting at a point) is a single contour that visits
 * the pinch vertex twice; the face triangulation (earcut) assumes simple rings
 * and produces a broken triangulation on such a ring — boundary edges end up
 * used by only one triangle, which slicers report as non-manifold. After the
 * split each lobe is a simple ring and triangulates cleanly; the lobes then
 * meet at a point contact, which resolvePointContacts opens with a nudge.
 */
function splitRingAtRepeats(ring: { x: number; y: number }[]): { x: number; y: number }[][] {
  const pieces: { x: number; y: number }[][] = [];
  const stack: { x: number; y: number }[][] = [ring];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur.length < 3) continue;
    const seen = new Map<string, number>();
    let firstAt = -1, dupAt = -1;
    for (let i = 0; i < cur.length; i++) {
      const k = vertKey(cur[i]);
      if (seen.has(k)) { firstAt = seen.get(k)!; dupAt = i; break; }
      seen.set(k, i);
    }
    if (dupAt < 0) { pieces.push(cur); continue; }
    // Cut at the repeated vertex: two rings, each visiting it once.
    const p1 = cur.slice(firstAt, dupAt + 1);
    const p2 = cur.slice(dupAt).concat(cur.slice(0, firstAt + 1));
    if (p1.length >= 2) p1.pop(); // drop the closing duplicate of the pinch vertex
    if (p2.length >= 2) p2.pop();
    if (p1.length >= 3) stack.push(p1);
    if (p2.length >= 3) stack.push(p2);
  }
  return pieces;
}

/**
 * Split every self-touching ring of every island into simple rings, producing
 * one island per lobe. Holes are re-attached to the lobe that contains them.
 */
function splitSelfTouchingIslands(islands: Island[]): Island[] {
  let anySplit = false;
  for (const isl of islands) {
    if (splitRingAtRepeats(isl.outer).length > 1) { anySplit = true; break; }
    for (const h of isl.holes) {
      if (splitRingAtRepeats(h).length > 1) { anySplit = true; break; }
    }
    if (anySplit) break;
  }
  if (!anySplit) return islands;

  const result: Island[] = [];
  for (const isl of islands) {
    const outerPieces = splitRingAtRepeats(isl.outer);
    const holePieces = isl.holes.flatMap((h) => splitRingAtRepeats(h));
    if (outerPieces.length === 1 && holePieces.length === isl.holes.length) {
      result.push(isl);
      continue;
    }
    for (const outerPiece of outerPieces) {
      const newIsl: Island = { outer: outerPiece, holes: [] };
      for (const hp of holePieces) {
        // Attach the hole to the lobe that contains it (probe: centroid).
        let cx = 0, cy = 0;
        for (const p of hp) { cx += p.x; cy += p.y; }
        cx /= hp.length; cy /= hp.length;
        if (pointInRingXY({ x: cx, y: cy }, outerPiece)) newIsl.holes.push(hp);
      }
      result.push(newIsl);
    }
  }
  return result;
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
 * Split a closed ring at T-junction points and at the island's own vertices
 * lying on a ring edge:
 *
 *  - T-junctions: vertices of other regions that lie on a ring edge AND have
 *    a collinear incident edge (a genuine shared-boundary break, not a tangent
 *    point-contact). Splitting keeps the two regions' shared edges matched.
 *
 *  - Island vertices: a vertex of another ring of the SAME island (e.g. a hole
 *    tangent to the outer boundary) that lies on this ring edge. The face
 *    triangulation is refined (refineBoundaryVertices) to split its edges at
 *    every vertex of the island lying on them, so the ring must be split at
 *    those vertices too — otherwise the face boundary and the walls disagree
 *    and the shared edge is left open.
 *
 * Drops consecutive duplicate points and the closing duplicate.
 */
function splitRing(
  ring: { x: number; y: number }[],
  verts: THREE.Vector2[],
  grid: VertexGrid,
  incident: Map<string, { dx: number; dy: number }[]>,
  islandVerts: Set<string>
): { ring: { x: number; y: number }[]; inserted: Set<string> } {
  const n = ring.length;
  const raw: { x: number; y: number }[] = [];
  const inserted = new Set<string>();
  const candidates: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    raw.push(a);
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-18) continue;
    const len = Math.sqrt(len2);
    const cuts: { t: number; x: number; y: number }[] = [];
    // Only vertices inside this edge's bounding box can lie on it (see
    // VertexGrid); the grid replaces an O(all-vertices) scan per edge.
    candidates.length = 0;
    grid.query(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y), candidates);
    for (const ci of candidates) {
      const v = verts[ci];
      const px = v.x - a.x, py = v.y - a.y;
      const cross = dx * py - dy * px;
      if (Math.abs(cross) > 1e-6 * len + 1e-12) continue;
      const t = dx * px + dy * py;
      if (t <= 1e-9 * len2 || t >= len2 - 1e-9 * len2) continue;
      if (!hasCollinearIncident(incident, v, dx, dy) && !islandVerts.has(vertKey(v))) continue;
      cuts.push({ t, x: v.x, y: v.y });
    }
    cuts.sort((u, v) => u.t - v.t);
    for (const c of cuts) {
      raw.push({ x: c.x, y: c.y });
      inserted.add(vertKey(c));
    }
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
  return { ring: out, inserted };
}

// ---------------------------------------------------------------------------
// Edge map + point-contact resolution.
// ---------------------------------------------------------------------------

/** A region with its extrusion height resolved (view units). */
interface TypedRegion { polygon: Region['polygon']; h: number; }

/** Map each ring edge (quantized, direction-insensitive) to its owners. */
function buildEdgeMap(
  splitIslands: Island[][],
  typed: TypedRegion[]
): Map<string, Array<{ ri: number; h: number }>> {
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
  return edgeMap;
}

/**
 * Minimum nudge distance (SVG user units) used to open a hairline gap at
 * point contacts. Large enough to survive vertex quantization (MANIFOLD_Q)
 * and the float32 rounding of the STL format, small enough to be invisible
 * at print resolution (a 1000-unit-wide poster printed at 100mm gives
 * ~0.1um). The effective nudge also scales with the SVG extent (see
 * POINT_CONTACT_EPS_PER_EXTENT) so the gap stays above the STL weld grid.
 */
const POINT_CONTACT_EPS = 1e-3;

/**
 * The point-contact nudge distance also grows with the SVG extent: the gap
 * in mm after export scaling is `eps * exportWidthMM / extent`, and the STL
 * weld grid (WELD_TOLERANCE in stl-export.ts) is absolute. Scaling eps with
 * the extent keeps the gap at ~1e-3 mm for a 100 mm export regardless of how
 * many SVG units the poster spans, so the weld never closes it and the
 * non-manifold point contact never returns.
 */
const POINT_CONTACT_EPS_PER_EXTENT = 1e-5;

/**
 * Floor for the point-contact nudge distance, also scaled with the SVG
 * extent. A nudge smaller than ~2 STL weld cells (in mm at a 100 mm export)
 * would be merged back together by the vertex weld in stl-export.ts,
 * re-creating the coincident walls. The adaptive shrink in nudgeInward stops
 * at this floor: a contact that cannot be opened by a weld-safe nudge is
 * left in place rather than distorted.
 */
const POINT_CONTACT_MIN_EPS_PER_EXTENT = 4e-6;

/**
 * Cap on point-contact resolution passes. A nudge can break a shared edge
 * whose far endpoint then becomes a new point contact; the loop resolves
 * those in turn. Cascades longer than this are pathological — the defect is
 * left in place rather than distorting large areas.
 */
const POINT_CONTACT_MAX_PASSES = 12;

/**
 * Resolve point contacts between regions: vertices where two regions' rings
 * touch but share no boundary edge (e.g. tangent circles, corner-to-corner
 * touches). Both regions extrude a wall through such a vertex, and over the
 * overlapping z-range their vertical wall edges coincide — the same edge
 * used by four triangles — leaving a non-manifold seam that slicers cannot
 * repair. Nudging one side's vertex a hairline into its own region separates
 * the walls into a sub-pixel gap; each region stays a closed solid.
 *
 * The detector counts, per vertex and per wall z-segment, how many wall
 * triangles use that vertical segment. In a correct tiling every segment is
 * used exactly twice (a region's own wall fold, or one wall each from two
 * regions meeting along an edge); more than two means walls from
 * point-touching regions coincide. Only such vertices are nudged — normal
 * corner contacts (any number of regions) are left untouched.
 */
function resolvePointContacts(
  splitIslands: Island[][],
  typed: TypedRegion[],
  allHeights: number[],
  pointContactEps: number,
  pointContactMinEps: number
): void {
  for (let pass = 0; pass < POINT_CONTACT_MAX_PASSES; pass++) {
    if (!resolvePointContactPass(splitIslands, typed, buildEdgeMap(splitIslands, typed), allHeights, pointContactEps, pointContactMinEps)) {
      break;
    }
  }
}

/**
 * One resolution pass. Returns true if any vertex was nudged (the caller
 * re-runs the pass on the adjusted rings), false when nothing changed.
 */
function resolvePointContactPass(
  splitIslands: Island[][],
  typed: TypedRegion[],
  edgeMap: Map<string, Array<{ ri: number; h: number }>>,
  allHeights: number[],
  pointContactEps: number,
  pointContactMinEps: number
): boolean {
  // Occurrences of each quantized vertex, with its two incident edge keys.
  // `structural` marks vertices splitRing inserted into this ring: moving
  // one would break the ring/face boundary correspondence (the face is
  // refined to split its edges at the island's other vertices, which stay
  // put), so nudges prefer occurrences whose vertex is original to the ring.
  interface Occ {
    ri: number;
    ring: { x: number; y: number }[];
    idx: number;
    edges: [string, string];
    segs: Map<string, number> | null;
    structural: boolean;
    isHole: boolean;
  }
  const byVertex = new Map<string, Occ[]>();
  for (let ri = 0; ri < splitIslands.length; ri++) {
    for (const is of splitIslands[ri]) {
      const rings: Array<{ ring: { x: number; y: number }[]; inserted: Set<string>; isHole: boolean }> = [
        { ring: is.outer, inserted: is.outerInserted ?? new Set<string>(), isHole: false },
        ...is.holes.map((h, hi) => ({ ring: h, inserted: is.holesInserted?.[hi] ?? new Set<string>(), isHole: true })),
      ];
      for (const { ring, inserted, isHole } of rings) {
        const n = ring.length;
        for (let i = 0; i < n; i++) {
          const key = vertKey(ring[i]);
          let list = byVertex.get(key);
          if (!list) { list = []; byVertex.set(key, list); }
          list.push({
            ri,
            ring,
            idx: i,
            edges: [edgeKey(ring[i], ring[(i + 1) % n]), edgeKey(ring[(i - 1 + n) % n], ring[i])],
            segs: null,
            structural: inserted.has(key),
            isHole,
          });
        }
      }
    }
  }

  // Per z-segment wall usage this occurrence contributes at its vertex
  // (walls subdivided at every distinct height, as in emitWall): for each
  // incident edge that emits a wall, one use of every wall segment.
  const segmentsOf = (o: Occ): Map<string, number> => {
    if (o.segs) return o.segs;
    const segs = new Map<string, number>();
    const hR = typed[o.ri].h;
    for (const ek of o.edges) {
      const list = edgeMap.get(ek) || [];
      let nH = 0;
      if (list.length > 1) {
        const other = list.find((e) => e.ri !== o.ri);
        nH = other ? other.h : hR;
      }
      if (hR > nH + 1e-9) {
        let a = nH;
        for (const h of allHeights) {
          if (h > a + 1e-9 && h < hR - 1e-9) {
            const seg = `${a},${h}`;
            segs.set(seg, (segs.get(seg) || 0) + 1);
            a = h;
          }
        }
        const seg = `${a},${hR}`;
        segs.set(seg, (segs.get(seg) || 0) + 1);
      }
    }
    o.segs = segs;
    return segs;
  };

  const nudged = new Set<Occ>();
  let anyNudged = false;
  for (const [, occs] of byVertex.entries()) {
    if (occs.length < 2) continue;
    // Nudge occurrences until no wall segment at this vertex is used more
    // than twice. Prefer the smallest contributor: removing a 1-use wall
    // from a 3-use segment leaves a valid 2-use fold, while removing a
    // 2-use fold would leave the segment open.
    let progress = true;
    while (progress) {
      progress = false;
      const totals = new Map<string, number>();
      for (const o of occs) {
        if (nudged.has(o)) continue;
        for (const [seg, c] of segmentsOf(o)) totals.set(seg, (totals.get(seg) || 0) + c);
      }
      const over = Array.from(totals.entries()).filter(([, t]) => t > 2).map(([s]) => s);
      if (!over.length) break;
      const overSet = new Set(over);
      const contribution = (o: Occ): number => {
        let c = 0;
        for (const [seg, n] of segmentsOf(o)) if (overSet.has(seg)) c += n;
        return c;
      };
      const candidates = occs
        .filter((o) => !nudged.has(o) && contribution(o) > 0)
        // Smallest contributor first (see above); on ties prefer an original
        // (non-structural) vertex — moving a splitRing-inserted vertex would
        // break the ring/face boundary correspondence.
        .sort((a, b) => contribution(a) - contribution(b) || (a.structural ? 1 : 0) - (b.structural ? 1 : 0));
      for (const o of candidates) {
        if (nudgeInward(o, typed[o.ri].polygon, pointContactEps, pointContactMinEps, o.isHole)) {
          nudged.add(o);
          anyNudged = true;
          progress = true;
          break;
        }
      }
    }
  }
  return anyNudged;
}

/**
 * Move a ring vertex a hairline away from the contact, along the bisector of
 * its two incident edges. The direction is chosen by PROBING: candidate
 * directions are tried at shrinking distances until the probe point lands on
 * the intended side of the boundary. Candidates are the bisector and its
 * opposite first (the opposite covers non-canonically wound rings, where the
 * wedge side is the exterior), then a ring of sampled directions. The
 * sampled directions cover pinch passes of self-touching rings: there the two
 * incident edges belong to different lobes, the bisector points into the
 * empty wedge between them, and the material lies in the perpendicular
 * quadrants — only a direction probe finds it. Sharp spikes and thin slivers
 * can make the full-distance probe exit the region through a nearby third
 * boundary, hence the shrinking distances, down to the weld-safe floor
 * (pointContactMinEps). Returns false — vertex left untouched — when no
 * direction lands on the intended side at a weld-safe distance.
 *
 * For a vertex of the outer ring the probe point must land strictly inside
 * the polygon (the region grows by a hairline triangle on its own side of
 * the old boundary — no overlap with the neighbor). For a vertex of a HOLE
 * ring the probe is inverted: the point must land OUTSIDE the polygon (in
 * the hole). Moving a hole vertex into the region would grow the region into
 * the hole — overlapping the region that fills the hole — while moving it
 * into the hole shrinks the region, leaving a hairline gap.
 */
function nudgeInward(
  o: { ring: { x: number; y: number }[]; idx: number },
  polygon: Region['polygon'],
  pointContactEps: number,
  pointContactMinEps: number,
  intoHole: boolean
): boolean {
  const ring = o.ring;
  const n = ring.length;
  const P = ring[o.idx];
  const prev = ring[(o.idx - 1 + n) % n];
  const next = ring[(o.idx + 1) % n];
  const ax = P.x - prev.x, ay = P.y - prev.y;
  const bx = next.x - P.x, by = next.y - P.y;
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la < 1e-12 || lb < 1e-12) return false;
  // Sum of the two edge normals: the vertex's bisector (either sign — the
  // probe below picks the side that is the local interior).
  let dx = -ay / la - by / lb;
  let dy = ax / la + bx / lb;
  const L = Math.hypot(dx, dy);
  if (L < 1e-6) {
    // Smooth point (edges nearly opposite): fall back to either edge normal.
    dx = -ay / la;
    dy = ax / la;
  } else {
    dx /= L;
    dy /= L;
  }
  // Keep the nudge well inside the adjacent edges (no overshoot) but above
  // the vertex quantization step, else the adjusted ring would still match
  // the neighbor's edges in the edge map.
  const epsMax = Math.min(pointContactEps, 0.25 * Math.min(la, lb));
  if (epsMax < 2 * MANIFOLD_Q) return false;

  // Candidate nudge directions, most-interior first.
  const dirs: Array<[number, number]> = [[dx, dy], [-dx, -dy]];
  for (let k = 0; k < 16; k++) {
    const ang = (k / 16) * 2 * Math.PI;
    dirs.push([Math.cos(ang), Math.sin(ang)]);
  }
  for (const [ux, uy] of dirs) {
    let eps = epsMax;
    while (eps >= pointContactMinEps) {
      // Outer vertex: the probe point must land inside the region. Hole
      // vertex: it must land inside the hole ring (not merely outside the
      // region — that would accept points beyond the outer boundary).
      const ok = intoHole
        ? pointInRingXY({ x: P.x + ux * eps, y: P.y + uy * eps }, ring)
        : polygon.contains(point(P.x + ux * eps, P.y + uy * eps));
      if (ok) break;
      eps *= 0.5;
    }
    if (eps >= pointContactMinEps) {
      ring[o.idx] = { x: P.x + ux * eps, y: P.y + uy * eps };
      return true;
    }
  }
  return false;
}

/**
 * earcut removes collinear boundary vertices, so a triangulated ring edge can
 * span several ring sub-edges — e.g. when a T-junction split inserted a vertex
 * in the middle of a straight edge. The top/bottom faces then don't match the
 * neighboring regions' faces (the shared edge is missing on one side),
 * leaving boundary edges a slicer reports as non-manifold. Refine the
 * triangulation: split every triangle edge at the ring vertices lying
 * strictly inside it, so the triangulation's boundary matches the ring exactly.
 *
 * A triangle edge whose endpoints are both vertices of one ring lies on that
 * ring's boundary; it is split only at that ring's own vertices. Splitting it
 * at some other ring's vertex (e.g. a hole vertex lying on an outer edge, or
 * a vertex another region nudged onto the edge) would make the face boundary
 * disagree with the ring — the ring is split only at its own vertices.
 */
function refineBoundaryVertices(
  tris: number[][],
  merged: THREE.Vector2[],
  ringVerts?: Set<string>[]
): number[][] {
  // Grid over the island's vertices: per triangle edge, only vertices inside
  // the edge's bounding box can lie on it (see VertexGrid).
  const grid = new VertexGrid(merged);
  const candidates: number[] = [];
  const edgePoints = (a: number, b: number): number[] => {
    const ax = merged[a].x, ay = merged[a].y;
    const bx = merged[b].x, by = merged[b].y;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-18) return [];
    // If both endpoints belong to one ring, only that ring's vertices may
    // split this edge.
    let ringSet: Set<string> | null = null;
    if (ringVerts) {
      const ka = vertKey(merged[a]), kb = vertKey(merged[b]);
      for (const rv of ringVerts) {
        if (rv.has(ka) && rv.has(kb)) { ringSet = rv; break; }
      }
    }
    const pts: { t: number; idx: number }[] = [];
    candidates.length = 0;
    grid.query(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by), candidates);
    for (const i of candidates) {
      if (i === a || i === b) continue;
      if (ringSet && !ringSet.has(vertKey(merged[i]))) continue;
      const px = merged[i].x - ax, py = merged[i].y - ay;
      const cross = dx * py - dy * px;
      if (Math.abs(cross) > 1e-6 * Math.sqrt(len2) + 1e-12) continue;
      const t = (dx * px + dy * py) / len2;
      if (t <= 1e-9 || t >= 1 - 1e-9) continue;
      pts.push({ t, idx: i });
    }
    pts.sort((u, v) => u.t - v.t);
    return pts.map((p) => p.idx);
  };
  const out: number[][] = [];
  for (const t of tris) {
    const [a, b, c] = t;
    const ab = edgePoints(a, b);
    const bc = edgePoints(b, c);
    const ca = edgePoints(c, a);
    if (!ab.length && !bc.length && !ca.length) {
      out.push(t);
      continue;
    }
    // The triangle with extra points on its edges is still convex; fan it
    // from corner a over the boundary chain (preserving winding). The chain
    // holds every polygon vertex except a, so the fan needs exactly
    // chain.length - 1 triangles — no closing triangle: the polygon is
    // (a, chain[0], ..., chain[last]) and the wedges [a, chain[i],
    // chain[i+1]] tile it completely. (An extra closing wedge would overlap
    // the fan, duplicating area and leaving edges a slicer reports as
    // non-manifold.)
    const chain = [...ab, b, ...bc, c, ...ca];
    for (let i = 0; i < chain.length - 1; i++) {
      out.push([a, chain[i], chain[i + 1]]);
    }
  }
  return out;
}

/**
 * Drop ring vertices that are collinear with their two neighbors (same
 * direction). Such vertices are artifacts of vectorization/flattening — e.g.
 * a hairline step on an otherwise straight boundary — and they break the
 * ear-clipping triangulation: the triangle fanned over a sub-pixel edge is so
 * flat that earcut's containment tests misfire and it emits overlapping or
 * missing triangles, whose edges slicers report as non-manifold. Removing a
 * collinear vertex is deviation-free (the boundary line is unchanged), so the
 * simplification is invisible. A T-junction this can introduce against a
 * neighbor ring that kept the vertex is repaired by splitRing.
 */
function removeRedundantVertices(ring: { x: number; y: number }[]): { x: number; y: number }[] {
  let cur = ring.slice();
  let changed = true;
  while (changed && cur.length > 3) {
    changed = false;
    for (let i = 0; i < cur.length; i++) {
      const p = cur[(i - 1 + cur.length) % cur.length];
      const c = cur[i];
      const n = cur[(i + 1) % cur.length];
      const d1x = c.x - p.x, d1y = c.y - p.y;
      const d2x = n.x - c.x, d2y = n.y - c.y;
      const l1 = Math.hypot(d1x, d1y), l2 = Math.hypot(d2x, d2y);
      if (l1 < 1e-12 || l2 < 1e-12) { cur.splice(i, 1); changed = true; break; }
      const cross = Math.abs(d1x * d2y - d1y * d2x) / (l1 * l2);
      const dot = (d1x * d2x + d1y * d2y) / (l1 * l2);
      if (cross < 1e-6 && dot > 0) { cur.splice(i, 1); changed = true; break; }
    }
  }
  return cur;
}

interface IslandTriangulation {
  tris: number[][];
  merged: THREE.Vector2[];
}

/** Per-ring vertex key sets (outer first, then each hole) for refinement. */
function ringVertexSets(
  outer: { x: number; y: number }[],
  holes: { x: number; y: number }[][]
): Set<string>[] {
  const sets: Set<string>[] = [new Set(outer.map((p) => vertKey(p)))];
  for (const h of holes) sets.push(new Set(h.map((p) => vertKey(p))));
  return sets;
}

/** One earcut pass over an island's rings, with boundary refinement. */
function triangulateIsland(
  outer: { x: number; y: number }[],
  holes: { x: number; y: number }[][]
): IslandTriangulation | null {
  const ov = outer.map((p) => new THREE.Vector2(p.x, p.y));
  const hv = holes.map((h) => h.map((p) => new THREE.Vector2(p.x, p.y)));
  let tris: number[][];
  try { tris = THREE.ShapeUtils.triangulateShape(ov, hv); } catch { return null; }
  const merged = ov.slice();
  for (const h of hv) merged.push(...h);
  return { tris: refineBoundaryVertices(tris, merged, ringVertexSets(outer, holes)), merged };
}

/**
 * Count triangulation defects: every ring boundary edge must be used by
 * exactly one triangle and every internal diagonal by exactly two. Any other
 * count means the triangulation overlaps itself or leaves a hole, so the
 * emitted faces do not tile the region — the unmatched edges are what slicers
 * report as non-manifold. Zero-length edges (degenerate folds) are not real
 * edges and are ignored.
 */
function countTriangulationDefects(
  outer: { x: number; y: number }[],
  holes: { x: number; y: number }[][],
  tris: number[][],
  merged: THREE.Vector2[]
): number {
  const boundary = new Set<string>();
  const addRing = (ring: { x: number; y: number }[]) => {
    const n = ring.length;
    for (let i = 0; i < n; i++) boundary.add(edgeKey(ring[i], ring[(i + 1) % n]));
  };
  addRing(outer);
  for (const h of holes) addRing(h);
  const use = new Map<string, number>();
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const a = t[k], b = t[(k + 1) % 3];
      const ka = vertKey(merged[a]), kb = vertKey(merged[b]);
      if (ka === kb) continue;
      const ek = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      use.set(ek, (use.get(ek) || 0) + 1);
    }
  }
  let defects = 0;
  for (const [ek, n] of use.entries()) {
    if (n !== (boundary.has(ek) ? 1 : 2)) defects++;
  }
  for (const ek of boundary) if (!use.has(ek)) defects++;
  return defects;
}

/**
 * Cap on ring-order variations tried when the baseline triangulation is
 * defective. earcut's result depends on the ring's start vertex and winding,
 * and a defective triangulation (overlapping/missing triangles) is usually
 * fixed by a different start; the sweep tries rotations of the outer ring,
 * then the reversed ring, then per-hole rotations/reversals.
 */
const TRIANGULATION_MAX_ATTEMPTS = 64;

/**
 * Triangulate an island, verifying the result tiles the rings exactly (see
 * countTriangulationDefects). Returns the first defect-free triangulation
 * over the ring-order variations, or the least-defective one when none is
 * clean (the defect is then reported by the non-manifold edge count).
 *
 * Two families of variations are tried: the rings as given, and a
 * collinear-vertex-free copy of them. earcut fails on some rings only
 * because of collinear T-junction vertices (a vertex splitRing inserted
 * where a neighbor's corner lies on a straight edge): such a vertex makes
 * the ear test misfire and earcut emits overlapping triangles. The
 * simplified copy is triangulated, its triangle indices are remapped onto
 * the full rings' vertices, and refineBoundaryVertices re-splits the merged
 * edges at the removed vertices — so the face boundary still matches the
 * ring exactly and the walls line up.
 */
function robustTriangulateIsland(
  outer: { x: number; y: number }[],
  holes: { x: number; y: number }[][]
): IslandTriangulation | null {
  type Ring = { x: number; y: number };
  const rot = (ring: Ring[], k: number): Ring[] => ring.slice(k).concat(ring.slice(0, k));
  const variationsOf = (o: Ring[], hs: Ring[][]): Array<[Ring[], Ring[][]]> => {
    const vars: Array<[Ring[], Ring[][]]> = [[o, hs]];
    for (let k = 1; k < o.length; k++) vars.push([rot(o, k), hs]);
    const rev = o.slice().reverse();
    for (let k = 0; k < o.length; k++) vars.push([rot(rev, k), hs]);
    for (let hi = 0; hi < hs.length; hi++) {
      for (let k = 1; k < hs[hi].length; k++) {
        const hs2 = hs.slice(); hs2[hi] = rot(hs[hi], k);
        vars.push([o, hs2]);
      }
      const hs2 = hs.slice(); hs2[hi] = hs[hi].slice().reverse();
      vars.push([o, hs2]);
      for (let k = 1; k < hs[hi].length; k++) {
        const hs3 = hs.slice(); hs3[hi] = rot(hs[hi].slice().reverse(), k);
        vars.push([o, hs3]);
      }
    }
    return vars;
  };

  // Full merged vertex array (outer + holes): the simplified-copy
  // triangulation's vertices always index into this array, and the coverage
  // check runs against the full rings.
  const fullMerged: THREE.Vector2[] = outer.map((p) => new THREE.Vector2(p.x, p.y));
  for (const h of holes) for (const p of h) fullMerged.push(new THREE.Vector2(p.x, p.y));
  const keyToFull = new Map<string, number>();
  for (let i = 0; i < fullMerged.length; i++) {
    const k = vertKey(fullMerged[i]);
    if (!keyToFull.has(k)) keyToFull.set(k, i);
  }

  /** Triangulate a collinear-vertex-free copy, remapped onto the full rings. */
  const triangulateSimplified = (o: Ring[], hs: Ring[][]): IslandTriangulation | null => {
    const ov = o.map((p) => new THREE.Vector2(p.x, p.y));
    const hv = hs.map((h) => h.map((p) => new THREE.Vector2(p.x, p.y)));
    let tris: number[][];
    try { tris = THREE.ShapeUtils.triangulateShape(ov, hv); } catch { return null; }
    const simpMerged = ov.slice();
    for (const h of hv) simpMerged.push(...h);
    const idxMap: number[] = [];
    for (let i = 0; i < simpMerged.length; i++) {
      const fi = keyToFull.get(vertKey(simpMerged[i]));
      if (fi === undefined) return null;
      idxMap.push(fi);
    }
    const remapped = tris.map((t) => t.map((i) => idxMap[i]));
    return { tris: refineBoundaryVertices(remapped, fullMerged, ringVertexSets(outer, holes)), merged: fullMerged };
  };

  const simpOuter = removeRedundantVertices(outer);
  const simpHoles = holes.map(removeRedundantVertices);
  const hasSimplified = simpOuter.length !== outer.length ||
    simpHoles.some((h, i) => h.length !== holes[i].length);

  let best: IslandTriangulation | null = null;
  let bestDefects = Infinity;
  let attempts = 0;
  const consider = (r: IslandTriangulation | null): IslandTriangulation | null => {
    if (!r) return null;
    const defects = countTriangulationDefects(outer, holes, r.tris, r.merged);
    if (defects === 0) return r;
    if (defects < bestDefects) { bestDefects = defects; best = r; }
    return null;
  };

  // Baselines first (cheap, succeed for almost every island).
  const clean = consider(triangulateIsland(outer, holes));
  if (clean) return clean;
  if (hasSimplified) {
    const cleanS = consider(triangulateSimplified(simpOuter, simpHoles));
    if (cleanS) return cleanS;
  }
  // Then ring-order variations (earcut's result depends on the start vertex
  // and winding).
  for (const [o, hs] of variationsOf(outer, holes)) {
    if (attempts >= TRIANGULATION_MAX_ATTEMPTS) break;
    attempts++;
    const c = consider(triangulateIsland(o, hs));
    if (c) return c;
  }
  if (hasSimplified) {
    for (const [o, hs] of variationsOf(simpOuter, simpHoles)) {
      if (attempts >= TRIANGULATION_MAX_ATTEMPTS) break;
      attempts++;
      const c = consider(triangulateSimplified(o, hs));
      if (c) return c;
    }
  }
  return best;
}

/** Emit the top (up) or bottom (down) faces of a region's islands at height z. */
function emitHorizontal(
  islands: Island[],
  z: number,
  up: boolean,
  out: number[],
  triCache: WeakMap<Island, IslandTriangulation | null>
): void {
  for (const is of islands) {
    let cached = triCache.get(is);
    if (cached === undefined) {
      cached = robustTriangulateIsland(is.outer, is.holes);
      triCache.set(is, cached);
    }
    if (!cached) continue;
    const { tris, merged } = cached;
    for (const t of tris) {
      const a = merged[t[0]], b = merged[t[1]], c = merged[t[2]];
      // Do NOT skip near-zero-area triangles. A degenerate triangle (three
      // collinear vertices, e.g. from a T-junction split on a straight edge)
      // carries no visible area, but skipping it punches a hole in the surface:
      // its three edges become boundary edges (shared by only 1 triangle),
      // which slicers report as non-manifold. Emitting the sliver keeps every
      // edge shared by exactly 2 triangles — the mesh stays watertight.
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

/** Distance from point (px,py) to segment (ax,ay)-(bx,by). */
function pointSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

interface Seg { x1: number; y1: number; x2: number; y2: number; }

function segmentsOf(p: Polygon): Seg[] {
  const segs: Seg[] = [];
  for (const f of p.faces) {
    const vs = f.vertices;
    for (let i = 0; i < vs.length; i++) {
      const u = vs[i], v = vs[(i + 1) % vs.length];
      segs.push({ x1: u.x, y1: u.y, x2: v.x, y2: v.y });
    }
  }
  return segs;
}

/** Does edge (x1,y1)-(x2,y2) lie on one of the given boundary segments? */
function edgeOnSegments(x1: number, y1: number, x2: number, y2: number, segs: Seg[]): boolean {
  const EPS = 1e-6;
  for (const s of segs) {
    if (pointSegDist(x1, y1, s.x1, s.y1, s.x2, s.y2) <= EPS
      && pointSegDist(x2, y2, s.x1, s.y1, s.x2, s.y2) <= EPS) return true;
  }
  return false;
}

interface V2 { x: number; y: number; }

/** A sliver weld: replace b's sub-path p->q (the b-chain) with p, interior..., q. */
interface SliverWeld { p: V2; q: V2; interior: V2[]; bEdges: Seg[]; }

/**
 * Make p a vertex of the ring. If p already is one (within 1e-9) the ring is
 * returned unchanged; if p lies in the interior of an edge (within 1e-6) the
 * edge is split at p. Returns null if p is not on the ring at all.
 */
function ensureRingVertex(ring: V2[], p: V2): V2[] | null {
  const m = ring.length;
  for (let i = 0; i < m; i++) {
    if (Math.abs(ring[i].x - p.x) < 1e-9 && Math.abs(ring[i].y - p.y) < 1e-9) return ring;
  }
  for (let i = 0; i < m; i++) {
    const u = ring[i], v = ring[(i + 1) % m];
    if (pointSegDist(p.x, p.y, u.x, u.y, v.x, v.y) <= 1e-6) {
      return [...ring.slice(0, i + 1), { x: p.x, y: p.y }, ...ring.slice(i + 1)];
    }
  }
  return null;
}

/**
 * Weld an overlapping region pair by exact boundary surgery: for each sliver
 * of the overlap (a face whose boundary is one later-region chain plus one
 * earlier-region chain), replace the later region's chain with the earlier
 * region's chain, so the two share an exactly coincident boundary there. No
 * boolean op is involved — subtracting a hairline sliver with the engine can
 * return a self-intersecting polygon. Returns the welded polygon, or null if
 * no sliver could be welded.
 */
function weldOverlappingPair(a: Polygon, b: Polygon, ov: Polygon): Polygon | null {
  const aSegs = segmentsOf(a), bSegs = segmentsOf(b);
  // Collect sliver welds, one per overlap face that has exactly one
  // later-region ('b') chain.
  const welds: SliverWeld[] = [];
  for (const f of ov.faces) {
    const vs = f.vertices as V2[];
    const m = vs.length;
    if (m < 3) continue;
    const edges: Seg[] = [];
    for (let i = 0; i < m; i++) {
      edges.push({ x1: vs[i].x, y1: vs[i].y, x2: vs[(i + 1) % m].x, y2: vs[(i + 1) % m].y });
    }
    const cls = edges.map((e) =>
      edgeOnSegments(e.x1, e.y1, e.x2, e.y2, aSegs) ? 'a' :
      edgeOnSegments(e.x1, e.y1, e.x2, e.y2, bSegs) ? 'b' : '?');
    if (cls.includes('?')) continue;
    const isB = (i: number) => cls[i] === 'b';
    let runs = 0, start = -1;
    for (let i = 0; i < m; i++) {
      if (isB(i) && !isB((i - 1 + m) % m)) { runs++; start = i; }
    }
    if (runs !== 1) continue;
    let end = start;
    while (isB((end + 1) % m)) end = (end + 1) % m;
    const p = { x: edges[start].x1, y: edges[start].y1 };
    const q = { x: edges[end].x2, y: edges[end].y2 };
    // The a-chain runs from q to p (the rest of this face's boundary). Its
    // interior vertices, reordered to run from p to q, replace the b-chain's
    // interior vertices in b's ring.
    const interior: V2[] = [];
    let idx = (end + 1) % m;
    while (idx !== start) {
      interior.push({ x: edges[idx].x1, y: edges[idx].y1 });
      idx = (idx + 1) % m;
    }
    if (interior.length && interior[0].x === q.x && interior[0].y === q.y) interior.shift();
    interior.reverse();
    const bEdges: Seg[] = [];
    for (let i = start; ; i = (i + 1) % m) {
      bEdges.push(edges[i]);
      if (i === end) break;
    }
    welds.push({ p, q, interior, bEdges });
  }
  if (!welds.length) return null;

  // Apply the welds to b's faces. Each weld splices the a-chain's interior
  // vertices into b's ring between p and q, replacing the b-chain. p and q
  // may lie in the interior of ring edges (the overlap's endpoints are
  // boundary-crossing points), so the ring is split at them first. The
  // b-chain's direction around the ring is found by matching the chain's
  // total length and per-edge coverage against the two candidate sub-paths
  // — an edge-count comparison is not reliable because the chain subdivides
  // ring edges.
  const out = new Polygon();
  let anyApplied = false;
  for (const f of b.faces) {
    let ring: V2[] = (f.vertices as V2[]).map((v) => ({ x: v.x, y: v.y }));
    for (const w of welds) {
      const withP = ensureRingVertex(ring, w.p);
      if (!withP) continue;
      const withQ = ensureRingVertex(withP, w.q);
      if (!withQ) continue;
      ring = withQ;
      const m = ring.length;
      let ip = -1, iq = -1;
      for (let i = 0; i < m; i++) {
        if (ip < 0 && Math.abs(ring[i].x - w.p.x) < 1e-9 && Math.abs(ring[i].y - w.p.y) < 1e-9) ip = i;
        if (iq < 0 && Math.abs(ring[i].x - w.q.x) < 1e-9 && Math.abs(ring[i].y - w.q.y) < 1e-9) iq = i;
      }
      if (ip < 0 || iq < 0 || ip === iq) continue;
      const fwd = (iq - ip + m) % m; // edges from p to q (increasing index)
      const subSegs = (from: number, count: number): Seg[] => {
        const segs: Seg[] = [];
        for (let k = 0; k < count; k++) {
          const u = ring[(from + k) % m], v = ring[(from + k + 1) % m];
          segs.push({ x1: u.x, y1: u.y, x2: v.x, y2: v.y });
        }
        return segs;
      };
      const segLen = (segs: Seg[]) => segs.reduce((s, e) => s + Math.hypot(e.x2 - e.x1, e.y2 - e.y1), 0);
      const bTotal = segLen(w.bEdges);
      const incSegs = subSegs(ip, fwd); // p -> q, increasing index
      const decSegs = subSegs(iq, m - fwd); // q -> p, increasing index
      const covers = (segs: Seg[]) => w.bEdges.every((e) => edgeOnSegments(e.x1, e.y1, e.x2, e.y2, segs));
      const lenOk = (segs: Seg[]) => Math.abs(segLen(segs) - bTotal) <= 1e-6 * Math.max(1, bTotal);
      let next: V2[] | null = null;
      if (lenOk(incSegs) && covers(incSegs)) {
        // b-chain runs p -> q with increasing index: keep the complement
        // (q -> p, increasing) after the a-chain.
        const tail: V2[] = [];
        for (let k = (iq + 1) % m; k !== ip; k = (k + 1) % m) tail.push(ring[k]);
        next = [ring[ip], ...w.interior, ring[iq], ...tail];
      } else if (lenOk(decSegs) && covers(decSegs)) {
        // b-chain runs p -> q with decreasing index: keep the complement
        // (q -> p, decreasing) after the a-chain.
        const tail: V2[] = [];
        for (let k = (iq - 1 + m) % m; k !== ip; k = (k - 1 + m) % m) tail.push(ring[k]);
        next = [ring[ip], ...w.interior, ring[iq], ...tail];
      }
      if (!next) continue;
      ring = next;
      anyApplied = true;
    }
    try { out.addFace(ring.map((v) => point(v.x, v.y))); } catch { return null; }
  }
  if (!anyApplied || out.isEmpty() || !out.isValid()) return null;
  return out;
}

/**
 * Remove residual overlaps between regions (in place).
 *
 * The flatten's regions tile exactly, but rounding the emitted path data can
 * turn a sub-quantum gap between two near-coincident boundaries into a
 * hairline overlap. Overlapping regions make the height-field builder emit
 * coincident bottom faces over the overlap — edges used by four triangles,
 * i.e. the non-manifold STL slicers reject. This pass welds every overlap
 * wider than the builder's vertex quantization (MANIFOLD_Q) from the later
 * region onto the earlier region's boundary, so the regions tile exactly.
 * Overlaps far narrower than MANIFOLD_Q are left alone: the build collapses
 * them to a shared edge.
 */
export async function removeRegionOverlaps(regions: Region[]): Promise<void> {
  const { intersect, subtract, unify } = BooleanOperations;
  let totalFixed = 0, totalRejected = 0;
  for (let i = 0; i < regions.length; i++) {
    const a = regions[i].polygon;
    if (a.isEmpty()) continue;
    for (let j = i + 1; j < regions.length; j++) {
      const b = regions[j].polygon;
      if (b.isEmpty()) continue;
      if (a.box.not_intersect(b.box)) continue;
      let ov: Polygon | null = null;
      try { ov = intersect(a, b); } catch { ov = null; }
      if (!ov || ov.isEmpty()) continue;
      const area = ov.area();
      if (area <= 1e-9) continue;
      // Prefer exact boundary-surgery welding (no engine noise). Fall back to
      // a guarded subtract for shapes the welding cannot handle.
      let next = weldOverlappingPair(a, b, ov);
      if (!next || next.isEmpty() || !next.isValid()) {
        try { next = subtract(b, ov); } catch { next = null; }
      }
      // Accept only if the result is valid, keeps the expected area, and
      // actually clears the overlap (a residual check that throws means the
      // result is not trustworthy). The union check rejects results that
      // clear the overlap by leaving a gap instead of a coincident boundary
      // (an open edge in the STL).
      if (next && !next.isEmpty() && next.isValid()
        && Math.abs(next.area() - (b.area() - area)) <= 1e-6 * Math.max(1, b.area())) {
        let residual: Polygon | null = null;
        let residualThrew = false;
        try { residual = intersect(a, next); } catch { residualThrew = true; }
        if (!residualThrew && residual && (residual.isEmpty() || residual.area() <= 1e-9)) {
          let uni: Polygon | null = null;
          let unionThrew = false;
          try { uni = unify(a, next); } catch { unionThrew = true; }
          if (!unionThrew && uni && !uni.isEmpty()
            && Math.abs(uni.area() - (a.area() + next.area())) <= 1e-6 * Math.max(1, a.area() + next.area())) {
            regions[j].polygon = next;
            totalFixed++;
            continue;
          }
        }
      }
      totalRejected++;
    }
  }
  console.log(`removeRegionOverlaps: fixed=${totalFixed} rejected(failed)=${totalRejected}`);
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
export async function createManifoldGroupForExport(
  svgContent: string,
  colorHeights: ColorHeights,
  scaleFactor: number,
  boundingBox: BoundingBox,
  layerHeightMM: number
): Promise<THREE.Group | null> {
  const regions = await svgToRegions(svgContent);
  if (!regions || regions.length === 0) return null;
  await removeRegionOverlaps(regions);
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
