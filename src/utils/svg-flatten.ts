/**
 * SVG Flattening utilities
 *
 * Flattens an SVG so that no two filled shapes overlap, eliminating z-fighting
 * when the SVG is later extruded to 3D. This is done with real vector boolean
 * operations (subtract / unify) on the shapes' polygon geometry — not raster
 * sampling and not mere color snapping.
 *
 * Pipeline:
 *   1. Color snap (pre-pass): every fill is snapped to the supplied palette.
 *      This normalizes colors so the boolean step can group same-color regions,
 *      and it doubles as the graceful-degradation fallback if the boolean step
 *      throws on a pathological path.
 *   2. Boolean flatten: parse the snapped SVG with THREE.SVGLoader, build a
 *      flatten-js Polygon per shape (outer contour with holes carved out via
 *      subtract), then walk the paint order top->bottom maintaining a `covered`
 *      union. Each shape's visible region is `subtract(shape, covered)`. Same-
 *      color visible regions are then merged with unify.
 *
 * Curves (Bezier / arcs) are flattened to polylines by SVGLoader; boolean ops
 * therefore operate on polygonal approximations. This is the one fidelity
 * trade-off — edges are piecewise-linear in the output rather than smooth
 * curves, which is what we want for clean 3D extrusion anyway.
 */

import { colorToRGB, findClosestCluster, rgbToHex } from './color';
import { RGBColor } from '../types';
import { Polygon, point, vector } from '@flatten-js/core';
import { unify, subtract } from '@flatten-js/boolean-op';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Tolerance (in SVG user units) for collapsing near-duplicate / collinear
// contour points before handing them to the boolean engine. Micro-edges from
// float noise destabilize the boolean ops, so we clean aggressively but well
// below visual resolution.
const CLEAN_EPS = 1e-4;

/**
 * Perturbation magnitude (in SVG user units) used to break tangent / degenerate
 * contacts when a boolean op throws. The @flatten-js boolean engine crashes on
 * pairs whose edges are tangent or exactly collinear — including GENUINE
 * overlaps where a curve boundary touches another edge tangentially (e.g. a
 * circle whose boundary is tangent to a rectangle's edge while overlapping it).
 * A sub-pixel translate of the second operand breaks the tangency and lets the
 * op succeed, so the overlap is actually removed instead of silently kept.
 */
const PERTURB_EPS = 1e-3;
const PERTURB_STEPS: Array<[number, number]> = [
  [PERTURB_EPS, 0],
  [0, PERTURB_EPS],
  [-PERTURB_EPS, 0],
  [0, -PERTURB_EPS],
  [PERTURB_EPS, PERTURB_EPS],
  [-PERTURB_EPS, -PERTURB_EPS],
];

/** Samples per curve segment when flattening Bezier/arc curves to polylines. */
const CURVE_DIVISIONS = 24;

/** Color-like values that must not be snapped (they are references or keywords). */
function isSnappableColor(value: string | null): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  if (!v) return false;
  if (v === 'none' || v === 'inherit' || v === 'currentcolor') return false;
  if (v.startsWith('url(') || v.startsWith('var(')) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Color snap pre-pass (DOM-level). Returns a snapped SVG string.
// ---------------------------------------------------------------------------

function snapColors(svgContent: string, palette: string[] | undefined): string {
  const hasPalette = !!(palette && palette.length > 0);
  if (!hasPalette) return svgContent;

  const parser = new DOMParser();
  const doc = parser.parseFromString(svgContent, 'image/svg+xml');
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    console.error('Flatten: SVG parse error:', parseError.textContent);
    return svgContent;
  }
  const root = doc.documentElement;
  if (!root || root.localName.toLowerCase() !== 'svg') {
    console.error('Flatten: root element is not <svg>');
    return svgContent;
  }
  if (!root.getAttribute('xmlns')) root.setAttribute('xmlns', SVG_NS);

  const paletteRGB: RGBColor[] = palette!.map((c) => colorToRGB(c));
  const snapCache = new Map<string, string>();

  const snapColor = (raw: string): string => {
    const key = raw.trim().toLowerCase();
    const cached = snapCache.get(key);
    if (cached !== undefined) return cached;
    const rgb = colorToRGB(raw);
    const idx = findClosestCluster(rgb, paletteRGB);
    const hex = rgbToHex(paletteRGB[idx]);
    snapCache.set(key, hex);
    return hex;
  };

  const snapStyleProperty = (style: string, prop: 'fill' | 'stop-color'): string => {
    const re = new RegExp(`(^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'gi');
    return style.replace(re, (_m, prefix: string, value: string) => {
      if (!isSnappableColor(value)) return `${prefix}${prop}:${value}`;
      return `${prefix}${prop}:${snapColor(value)}`;
    });
  };

  let snappedCount = 0;
  const elements = root.querySelectorAll('*');
  for (const el of Array.from(elements)) {
    const fillAttr = el.getAttribute('fill');
    if (isSnappableColor(fillAttr)) {
      el.setAttribute('fill', snapColor(fillAttr!));
      snappedCount++;
    }
    const stopAttr = el.getAttribute('stop-color');
    if (isSnappableColor(stopAttr)) {
      el.setAttribute('stop-color', snapColor(stopAttr!));
      snappedCount++;
    }
    const styleAttr = el.getAttribute('style');
    if (styleAttr && /fill|stop-color/i.test(styleAttr)) {
      let next = snapStyleProperty(styleAttr, 'fill');
      next = snapStyleProperty(next, 'stop-color');
      if (next !== styleAttr) {
        el.setAttribute('style', next);
        snappedCount++;
      }
    }
  }

  console.log(
    `Flatten (snap): snapped ${snappedCount} color references to ${paletteRGB.length} palette colors.`
  );
  return new XMLSerializer().serializeToString(root);
}

// ---------------------------------------------------------------------------
// Pure boolean core. No DOM dependency — operates on flatten-js Polygons, so
// it is unit-testable in plain Node.
// ---------------------------------------------------------------------------

/** A paint layer: all shapes that share one fill color and one DOM position. */
export interface FlattenLayer {
  color: string;
  polygons: Polygon[];
}

/** A flattened, non-overlapping result region with its fill color. */
export interface FlattenResult {
  color: string;
  polygon: Polygon;
}

/**
 * A single colored region (one shape's polygon, outer minus its own holes).
 * Used by the 3D manifold builder: the flattened SVG is re-parsed into these
 * regions, each of which becomes one solid slab in the height-field model.
 */
export interface Region {
  color: string;
  polygon: Polygon;
}

/**
 * Run a boolean op (subtract/unify), retrying with a sub-pixel translate of the
 * second operand on throw. The @flatten-js boolean engine crashes on tangent /
 * degenerate edge contacts — including GENUINE overlaps where a curve boundary
 * touches another edge tangentially (e.g. a circle tangent to a rectangle's
 * edge while overlapping it). A sub-pixel translate breaks the tangency and
 * lets the op succeed, so the overlap is actually resolved. Returns null only
 * if every attempt fails. `b.translate(...)` produces a fresh polygon, leaving
 * `b` untouched for use against other shapes.
 */
function withPerturbation(
  op: (a: Polygon, b: Polygon) => Polygon,
  a: Polygon,
  b: Polygon
): Polygon | null {
  try {
    return op(a, b);
  } catch {
    // fall through to perturbation retries
  }
  for (const [dx, dy] of PERTURB_STEPS) {
    try {
      return op(a, b.translate(vector(dx, dy)));
    } catch {
      // try next perturbation
    }
  }
  return null;
}

/**
 * subtract that never throws. A thrown subtract does NOT imply "no overlap":
 * if we simply returned `a` unchanged, a genuine overlap with `b` would survive
 * into the output and z-fight. So we retry with perturbation; only if every
 * perturbation fails do we keep `a` unchanged (rare).
 */
function safeSubtract(a: Polygon, b: Polygon): Polygon {
  if (b.isEmpty()) return a;
  const r = withPerturbation(subtract, a, b);
  if (r !== null) return r;
  console.warn('Flatten: subtract failed even after perturbation, keeping shape unsubtracted');
  return a;
}

/**
 * unify with perturbation retry. Returns null if the op cannot succeed even
 * with perturbation, so the caller can keep the regions separate rather than
 * dropping one (which would lose area).
 */
function tryUnify(a: Polygon, b: Polygon): Polygon | null {
  if (a.isEmpty()) return b.isEmpty() ? null : b;
  if (b.isEmpty()) return a;
  return withPerturbation(unify, a, b);
}

/**
 * Flatten a stack of paint layers into a set of non-overlapping colored
 * regions. Layers are given bottom->top (document order). The topmost shape
 * wins any contested pixel; same-color regions are merged where possible.
 *
 * Z-index is applied uniformly: every shape is subtracted by EVERY shape
 * above it, regardless of color. Same-color shapes are extruded to the same
 * height downstream, so any residual same-color overlap would z-fight —
 * subtracting them (rather than relying on a later merge) guarantees no
 * overlap remains even when mergeByColor's unify can't recombine touching
 * pieces.
 *
 * Implementation note: @flatten-js/boolean-op throws on pairs whose edges are
 * collinear/touching (shared boundaries, T-junctions, identical polygons) but
 * succeeds for genuine interior overlap. A thrown subtract means the pair only
 * touches (no interior overlap to remove) and is safely skipped via
 * safeSubtract. We never build a `covered` union — unifying touching above-shapes
 * would throw — so each above shape is subtracted individually.
 *
 * Complexity: O(n^2) subtract attempts, pruned by bounding-box prefilter —
 * acceptable for typical poster SVGs (tens to low-hundreds of paths).
 */
export function flattenPolygons(layers: FlattenLayer[]): FlattenResult[] {
  const emitted: FlattenResult[] = [];

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (!layer.polygons.length) continue;

    // Collect every shape strictly above this layer, regardless of color.
    // Same-color above-shapes MUST be included: they sit at a higher z-index
    // and their overlap with the current shape must be removed, not deferred
    // to a later merge (which can fail on touching pieces and leave a
    // same-color overlap that z-fights in 3D).
    const above: Polygon[] = [];
    for (let j = i + 1; j < layers.length; j++) {
      above.push(...layers[j].polygons);
    }

    for (const poly of layer.polygons) {
      let visible = poly;
      // Same-layer siblings are NOT subtracted from each other: they share a
      // z-level (e.g. the two circles of one <path>), so neither occludes the
      // other. Their overlaps are resolved by mergeByColor afterwards.
      if (above.length) {
        for (const t of above) {
          // Bounding-box reject: disjoint shapes can't overlap, skip the op
          // (which would otherwise no-op or throw on a degenerate touch).
          if (visible.box.not_intersect(t.box)) continue;
          visible = safeSubtract(visible, t);
        }
      }
      if (!visible.isEmpty()) emitted.push({ color: layer.color, polygon: visible });
    }
  }

  return mergeByColor(emitted);
}

/**
 * Merge same-color regions into as few polygons as possible. After the
 * subtraction phase, cross-layer same-color regions are disjoint (the lower was
 * notched); same-layer siblings may still overlap. Unify resolves overlaps;
 * when it can't (total perturbation failure, rare), the region is kept
 * separate rather than dropped, so no area is ever lost.
 */
function mergeByColor(regions: FlattenResult[]): FlattenResult[] {
  const byColor = new Map<string, Polygon[]>();
  for (const r of regions) {
    const arr = byColor.get(r.color);
    if (arr) arr.push(r.polygon);
    else byColor.set(r.color, [r.polygon]);
  }

  const out: FlattenResult[] = [];
  for (const [color, polys] of byColor) {
    let acc = new Polygon();
    const separate: Polygon[] = [];
    for (const p of polys) {
      if (acc.isEmpty()) {
        acc = p;
        continue;
      }
      const merged = tryUnify(acc, p);
      if (merged !== null) {
        acc = merged;
      } else {
        // Couldn't merge p into acc; keep p as its own region (no area lost).
        separate.push(p);
      }
    }
    if (!acc.isEmpty()) out.push({ color, polygon: acc });
    for (const p of separate) if (!p.isEmpty()) out.push({ color, polygon: p });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Contour cleaning + Polygon construction from sampled points.
// ---------------------------------------------------------------------------

interface XY {
  x: number;
  y: number;
}

/** Shoelace signed area of a contour; sign encodes orientation. */
function signedArea(pts: XY[]): number {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return s;
}

/**
 * Clean a sampled closed contour: drop near-duplicate consecutive points,
 * remove the closing duplicate, and collapse collinear interior points.
 * Returns at least 3 distinct points or null if degenerate.
 */
function cleanContour(raw: XY[]): XY[] | null {
  if (!raw || raw.length < 3) return null;

  const pts: XY[] = [];
  for (const p of raw) {
    const last = pts[pts.length - 1];
    if (!last || Math.abs(last.x - p.x) > CLEAN_EPS || Math.abs(last.y - p.y) > CLEAN_EPS) {
      pts.push(p);
    }
  }
  // Drop closing duplicate (first == last).
  if (pts.length >= 2) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (Math.abs(first.x - last.x) <= CLEAN_EPS && Math.abs(first.y - last.y) <= CLEAN_EPS) {
      pts.pop();
    }
  }
  if (pts.length < 3) return null;

  // Collapse collinear interior points (reduces vertex count and stabilizes
  // the boolean engine, especially for rect-like contours sampled from curves).
  const simplified: XY[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const cur = pts[i];
    const next = pts[(i + 1) % n];
    const cross = (cur.x - prev.x) * (next.y - cur.y) - (cur.y - prev.y) * (next.x - cur.x);
    if (Math.abs(cross) <= CLEAN_EPS) continue; // collinear -> drop cur
    simplified.push(cur);
  }
  return simplified.length >= 3 ? simplified : null;
}

/**
 * Build a single-face Polygon from a contour, with a canonical orientation so
 * that every contour fed to the boolean ops shares the same winding (required
 * by @flatten-js/boolean-op: same-meaning faces must share orientation).
 */
function contourToPolygon(contour: XY[]): Polygon | null {
  const cleaned = cleanContour(contour);
  if (!cleaned) return null;

  // Canonicalize to a consistent orientation (positive shoelace area).
  if (signedArea(cleaned) < 0) cleaned.reverse();

  const poly = new Polygon();
  try {
    poly.addFace(cleaned.map((p) => point(p.x, p.y)));
  } catch (e) {
    console.warn('Flatten: addFace failed for contour:', e);
    return null;
  }
  return poly;
}

/**
 * Build a Polygon for one THREE.Shape: outer contour minus its holes, carved
 * via subtract so the result is a proper polygon with correctly-oriented hole
 * faces (no manual winding bookkeeping).
 */
function shapeToPolygon(
  shape: { extractPoints: (d: number) => { shape: XY[]; holes: XY[][] } }
): Polygon | null {
  const { shape: outer, holes } = shape.extractPoints(CURVE_DIVISIONS);
  let poly = contourToPolygon(outer);
  if (!poly) return null;
  for (const hole of holes) {
    const holePoly = contourToPolygon(hole);
    if (!holePoly) continue;
    try {
      poly = subtract(poly, holePoly);
    } catch (e) {
      console.warn('Flatten: hole subtract failed, ignoring hole:', e);
    }
  }
  return poly && !poly.isEmpty() ? poly : null;
}

// ---------------------------------------------------------------------------
// SVG parsing -> layers.
// ---------------------------------------------------------------------------

/**
 * Extract the fill color of an SVGLoader path, normalized to a canonical hex.
 * Mirrors the logic in src/3d/svg-to-3d.ts but kept local to avoid coupling
 * the flatten utility to the 3D module.
 */
function pathFillColor(path: any): string | null {
  let fill: string = path.userData?.fill ?? '';
  if (!fill && path.userData) {
    if (path.userData.style && typeof path.userData.style === 'string') {
      const m = path.userData.style.match(/fill:\s*([^;]+)/i);
      if (m) fill = m[1].trim();
    } else if (path.userData.style?.fill) {
      fill = path.userData.style.fill;
    }
  }
  if (!fill || typeof fill !== 'string') return null;
  const v = fill.trim().toLowerCase();
  if (!v || v === 'none' || v === 'inherit' || v === 'currentcolor') return null;
  if (v.startsWith('url(') || v.startsWith('var(')) return null;
  return rgbToHex(colorToRGB(fill));
}

/** Parse the snapped SVG into paint-ordered layers (bottom -> top). */
function svgToLayers(snappedSVG: string): FlattenLayer[] | null {
  let data: any;
  try {
    data = new SVGLoader().parse(snappedSVG);
  } catch (e) {
    console.error('Flatten: SVGLoader.parse failed:', e);
    return null;
  }
  const paths: any[] = data?.paths ?? [];
  if (!paths.length) return null;

  const layers: FlattenLayer[] = [];
  for (const p of paths) {
    const color = pathFillColor(p);
    if (!color) continue;
    let shapes: any[];
    try {
      shapes = SVGLoader.createShapes(p);
    } catch (e) {
      console.warn('Flatten: createShapes failed for a path, skipping:', e);
      continue;
    }
    const polygons: Polygon[] = [];
    for (const shape of shapes) {
      const poly = shapeToPolygon(shape);
      if (poly && !poly.isEmpty()) polygons.push(poly);
    }
    if (polygons.length) layers.push({ color, polygons });
  }
  return layers.length ? layers : null;
}

// ---------------------------------------------------------------------------
// Output assembly.
// ---------------------------------------------------------------------------

/**
 * Minimum area (in square SVG user units) for a face to be emitted. Faces
 * below this are slivers produced by boolean-op float noise; they carry no
 * visible region but can destabilize downstream shape parsing (e.g. three.js
 * SVGLoader.createShapes crashes on degenerate subpaths whose scanline finds
 * no self-intersection). Filter them out at output time.
 */
const MIN_FACE_AREA = 1e-6;

/** Round numbers in a path `d` string to keep the output compact and stable. */
function roundPathNumbers(d: string): string {
  return d.replace(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi, (m) => {
    const n = parseFloat(m);
    if (!isFinite(n)) return m;
    const r = Math.round(n * 1000) / 1000;
    return String(r);
  });
}

/**
 * Build SVG path-data strings from a result polygon, one per island.
 *
 * Each result polygon may be a multipolygon (multiple disjoint outer contours
 * produced by mergeByColor's unify). If all faces are emitted as subpaths of
 * a single <path>, three.js's createShapes scanline hole-detection can
 * misclassify one outer contour as a hole of another (when their bounding
 * boxes overlap), dropping it from the 3D output. splitToIslands() splits the
 * polygon into islands (each an outer + its holes), and we emit each island
 * as a separate <path> element so createShapes only does hole detection
 * within each island.
 *
 * Degenerate faces (near-zero area or < 3 vertices) are skipped — they carry
 * no visible region and can crash downstream shape parsing.
 *
 * Returns null if the polygon has no valid faces.
 */
function polygonToIslandDpaths(poly: Polygon): string[] | null {
  let islands: Polygon[];
  try {
    islands = poly.splitToIslands();
  } catch (e) {
    console.warn('Flatten: splitToIslands failed, emitting all faces as one path:', e);
    islands = [poly];
  }
  if (!islands || islands.length === 0) return null;

  const dpaths: string[] = [];
  for (const island of islands) {
    const parts: string[] = [];
    for (const face of island.faces) {
      if (face.area() < MIN_FACE_AREA) continue;
      const verts = face.vertices;
      if (verts.length < 3) continue;
      const move = `M${verts[0].x},${verts[0].y}`;
      const lines = verts.slice(1).map((v: { x: number; y: number }) => `L${v.x},${v.y}`).join('');
      parts.push(`${move}${lines} z`);
    }
    if (parts.length) dpaths.push(parts.join(''));
  }
  return dpaths.length ? dpaths : null;
}

/** Build the output SVG document string from flattened regions. */
function buildOutputSVG(rootAttrs: Record<string, string>, results: FlattenResult[]): string {
  const attrStr = Object.entries(rootAttrs)
    .map(([k, v]) => `${k}="${v.replace(/"/g, '&quot;')}"`)
    .join(' ');

  // Emit each island of each result as a separate <path> element (same fill).
  // fill-rule is intentionally omitted: SVGLoader's parseStyle does not extract
  // it and defaults to 'nonzero'; the boolean ops produce correct outer/hole
  // winding so 'nonzero' detects holes correctly. Using the default ensures
  // the browser display and the 3D createShapes use the same rule.
  const lines: string[] = [];
  for (const r of results) {
    const dpaths = polygonToIslandDpaths(r.polygon);
    if (!dpaths) continue;
    for (const d of dpaths) {
      lines.push(`  <path d="${roundPathNumbers(d)}" fill="${r.color}" stroke="none"/>`);
    }
  }

  return `<svg ${attrStr}>\n${lines.join('\n')}\n</svg>`;
}

/** Read the <svg> root attributes that downstream 3D sizing depends on. */
function readRootAttrs(svgContent: string): Record<string, string> {
  const attrs: Record<string, string> = { xmlns: SVG_NS };
  try {
    const doc = new DOMParser().parseFromString(svgContent, 'image/svg+xml');
    const root = doc.documentElement;
    if (root && root.localName.toLowerCase() === 'svg') {
      for (const name of ['xmlns', 'viewBox', 'width', 'height']) {
        const v = root.getAttribute(name);
        if (v) attrs[name] = v;
      }
    }
  } catch {
    // ignore — defaults (xmlns only) still produce valid SVG
  }
  return attrs;
}

// ---------------------------------------------------------------------------
// Region extraction (for 3D manifold export).
// ---------------------------------------------------------------------------

/**
 * Parse an already-flattened SVG into a list of colored regions.
 *
 * The flatten step emits one `<path>` per island (outer + holes), so re-parsing
 * yields one polygon per shape with its own holes carved out. The resulting
 * regions are non-overlapping and tile the plane (a property the manifold
 * builder relies on). No boolean flatten is re-run here — the input is assumed
 * to be the flattened SVG string.
 *
 * @param svgContent - Flattened SVG string.
 * @returns Regions (color + polygon) or null if no fillable shapes were found.
 */
export function svgToRegions(svgContent: string): Region[] | null {
  const layers = svgToLayers(svgContent);
  if (!layers) return null;
  const regions: Region[] = [];
  for (const layer of layers) {
    for (const poly of layer.polygons) {
      if (!poly.isEmpty()) regions.push({ color: layer.color, polygon: poly });
    }
  }
  return regions.length ? regions : null;
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/**
 * Flatten an SVG by snapping fills to the palette and then applying real
 * vector boolean subtraction so that exactly one shape covers any pixel.
 *
 * @param svgContent - SVG string
 * @param palette - Optional list of hex colors to snap fills to (Simplify output)
 * @returns Flattened SVG string. On any boolean-op failure, degrades to the
 *          color-snapped SVG (still valid, just possibly overlapping).
 */
export async function flattenSVG(
  svgContent: string,
  palette?: string[]
): Promise<string> {
  // 1. Color snap (also the fallback output if the boolean step fails).
  const snapped = snapColors(svgContent, palette);

  // 2. Boolean flatten.
  try {
    const layers = svgToLayers(snapped);
    if (!layers) {
      console.log('Flatten: no fillable shapes found, returning snapped SVG.');
      return snapped;
    }

    const results = flattenPolygons(layers);
    if (!results.length) {
      console.log('Flatten: boolean pass produced no regions, returning snapped SVG.');
      return snapped;
    }

    const rootAttrs = readRootAttrs(snapped);
    const out = buildOutputSVG(rootAttrs, results);
    console.log(
      `Flatten (boolean): ${layers.length} layers -> ${results.length} non-overlapping regions.`
    );
    return out;
  } catch (e) {
    console.error('Flatten: boolean pass failed, returning snapped SVG:', e);
    return snapped;
  }
}
