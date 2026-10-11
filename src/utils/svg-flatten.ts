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
import { BooleanOperations, Polygon, point, vector } from '@flatten-js/core';

// Boolean ops come from @flatten-js/core's BooleanOperations (the maintained
// sweep inside core 1.6.x), NOT from @flatten-js/boolean-op@1.1.4: the old
// boolean-op package bundles a stale copy of the sweep whose addToIntPoints
// crashes with `Cannot read properties of null (reading 'length')` whenever an
// intersection point lands exactly on an edge's start vertex (core 1.6's
// Segment.split returns [null, shape] there). Vertex-coincident intersections
// are the NORM in poster geometry (adjacent regions share vertices), so the
// old engine threw constantly and every throw burned the full perturbation
// ladder. Core's sweep handles the null split correctly.
const { unify, subtract } = BooleanOperations;
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Tolerance (in SVG user units) for collapsing near-duplicate / collinear
// contour points before handing them to the boolean engine. Micro-edges from
// float noise destabilize the boolean ops, so we clean aggressively but well
// below visual resolution.
const CLEAN_EPS = 1e-4;

/**
 * Perturbation magnitudes (in SVG user units) used to break tangent /
 * degenerate contacts when a boolean op throws. The @flatten-js boolean
 * engine crashes on pairs whose edges are tangent or exactly collinear —
 * including GENUINE overlaps where a curve boundary touches another edge
 * tangentially (e.g. a circle whose boundary is tangent to a rectangle's
 * edge while overlapping it). A sub-pixel translate of the second operand
 * breaks the tangency and lets the op succeed, so the overlap is actually
 * removed instead of silently kept.
 *
 * The crash is configuration-specific: no single magnitude works for every
 * pair. Measured on real poster geometry, a pair that crashes at 1e-3 can
 * succeed at 1e-4 or 1e-5 (and vice versa), and the working directions vary
 * per pair — so the ladder sweeps several magnitudes x 8 directions and
 * takes the FIRST success. Magnitudes are tried smallest-first: a perturbed
 * subtract leaves a sliver strip up to one magnitude wide along the shared
 * boundary, and the smallest strip is the least visible (it stays far below
 * the STL weld grid at export time). All magnitudes stay <= PERTURB_EPS so
 * the existing SLIVER_EPS cleanup still covers the widest strip.
 */
const PERTURB_EPS = 1e-3;
const PERTURB_MAGS: number[] = [1e-5, 1e-4, PERTURB_EPS];
const PERTURB_STEPS: Array<[number, number]> = (() => {
  const steps: Array<[number, number]> = [];
  const dirs: Array<[number, number]> = [
    [1, 0], [0, 1], [-1, 0], [0, -1],
    [1, 1], [-1, -1], [1, -1], [-1, 1],
  ];
  for (const mag of PERTURB_MAGS) {
    for (const [ux, uy] of dirs) steps.push([ux * mag, uy * mag]);
  }
  return steps;
})();

/**
 * Width (in SVG user units) below which a face produced by a PERTURBED boolean
 * op is discarded as an artifact. Perturbation translates the second operand
 * by PERTURB_EPS, so the slivers it leaves behind are at most that wide; 4x
 * gives margin while staying far below print resolution.
 */
const SLIVER_EPS = 4 * PERTURB_EPS;

/**
 * Area-to-perimeter ratio below which a face produced by a PERTURBED boolean op
 * is discarded as an artifact. Perturbation slivers are at most PERTURB_EPS
 * thick, so their ratio is always ~PERTURB_EPS/2 no matter how long they are
 * (including L-shaped corner remnants whose bounding box is not thin). Genuine
 * shapes bottom out at ~min_dimension/4, so the threshold only discards
 * sub-pixel features.
 */
const SLIVER_AREA_RATIO = 1e-3;

/**
 * Minimum area (in square SVG user units) for a face to be emitted. Faces
 * below this are slivers produced by boolean-op float noise; they carry no
 * visible region but can destabilize downstream shape parsing (e.g. three.js
 * SVGLoader.createShapes crashes on degenerate subpaths whose scanline finds
 * no self-intersection). Filter them out at output time.
 */
const MIN_FACE_AREA = 1e-6;

/** Samples per curve segment when flattening Bezier/arc curves to polylines. */
const CURVE_DIVISIONS = 24;

/**
 * Maximum chord deviation (SVG user units) for adaptive curve flattening.
 * The previous fixed CURVE_DIVISIONS samples per curve produced polygons with
 * tens of thousands of vertices on real posters (one 658-curve path became
 * ~8.6k points), making every boolean op take seconds and the whole flatten
 * many minutes. Flatness-based adaptive subdivision emits only as many points
 * as the curve's curvature requires — a straight segment costs 2 points —
 * cutting vertex counts several-fold while keeping the deviation far below
 * print resolution (0.01 units is ~0.001 mm on a 100 mm print of a 1200-unit
 * canvas, and below the 3-decimal rounding of the emitted path data).
 */
const CURVE_TOLERANCE = 0.01;

// TEMP INSTRUMENTATION — remove before finishing.
export const __FLAT_STATS = {
  parseTime: 0, parsePoints: 0, parsePolys: 0, maxPathPoints: 0,
  ops: 0, opTime: 0, opEdgesA: 0, opEdgesB: 0, maxEdgesA: 0, maxEdgesB: 0,
  throws: 0, perturbRetries: 0, subtractFails: 0,
  mergeTime: 0, mergeOps: 0, coverageTime: 0, buildTime: 0, snapTime: 0,
  worstOps: [] as { t: number; ea: number; eb: number; threw: boolean; retries: number }[],
  reset() {
    this.parseTime = 0; this.parsePoints = 0; this.parsePolys = 0; this.maxPathPoints = 0;
    this.ops = 0; this.opTime = 0; this.opEdgesA = 0; this.opEdgesB = 0;
    this.maxEdgesA = 0; this.maxEdgesB = 0;
    this.throws = 0; this.perturbRetries = 0; this.subtractFails = 0;
    this.mergeTime = 0; this.mergeOps = 0; this.coverageTime = 0; this.buildTime = 0; this.snapTime = 0;
    this.worstOps = [];
  },
};
function polyEdges(p: Polygon): number {
  let n = 0;
  for (const f of p.faces) n += f.vertices.length;
  return n;
}

// ---------------------------------------------------------------------------
// Cooperative yielding. The boolean pipeline is CPU-heavy (seconds on real
// posters); running it as one synchronous block freezes the page until the
// browser offers to kill the task. The loops below periodically hand control
// back to the event loop so the page stays responsive and progress can be
// shown. MessageChannel is used instead of setTimeout because it is not
// clamped to ~4ms per yield after nesting depth 5.
// ---------------------------------------------------------------------------

const yieldChannel: MessageChannel | null =
  typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;

function yieldToUI(): Promise<void> {
  if (!yieldChannel) return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => {
    yieldChannel.port1.onmessage = () => resolve();
    yieldChannel.port2.postMessage(null);
  });
}

/** Yield at most once per YIELD_INTERVAL_MS of work. */
const YIELD_INTERVAL_MS = 50;
let lastYieldTime = 0;

async function maybeYield(): Promise<void> {
  const now = performance.now();
  if (now - lastYieldTime < YIELD_INTERVAL_MS) return;
  lastYieldTime = now;
  await yieldToUI();
  lastYieldTime = performance.now();
}

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

async function snapColors(svgContent: string, palette: string[] | undefined): Promise<string> {
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
    await maybeYield();
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

/** Is this face a perturbation/float-noise artifact? (see removeSliverFaces) */
function isSliverFace(face: {
  box: { xmin: number; ymin: number; xmax: number; ymax: number };
  area(): number;
  perimeter: number;
}): boolean {
  const box = face.box;
  return (
    box.xmax - box.xmin <= SLIVER_EPS ||
    box.ymax - box.ymin <= SLIVER_EPS ||
    Math.abs(face.area()) / face.perimeter < SLIVER_AREA_RATIO ||
    Math.abs(face.area()) < MIN_FACE_AREA
  );
}

/**
 * Drop perturbation-scale sliver faces from a polygon. A perturbed op
 * succeeds by moving the second operand, so the region it was supposed to
 * remove can survive as a face at most PERTURB_EPS wide (e.g. a fully
 * occluded shape leaving two hairline strips, or an L-shaped corner remnant
 * whose bounding box is not thin). Such faces are artifacts: they carry no
 * visible region, slip past the area filter, and extrude as razor walls that
 * z-fight in 3D. Faces below MIN_FACE_AREA are dropped as well.
 *
 * Returns the original polygon when nothing was dropped.
 */
function removeSliverFaces(poly: Polygon): Polygon {
  if (poly.isEmpty()) return poly;
  let needsFilter = false;
  for (const face of poly.faces) {
    if (isSliverFace(face)) {
      needsFilter = true;
      break;
    }
  }
  if (!needsFilter) return poly;
  const kept = new Polygon();
  for (const face of poly.faces) {
    if (!isSliverFace(face)) kept.addFace(face);
  }
  return kept;
}

/**
 * Run a boolean op (subtract/unify), retrying with a sub-pixel translate of the
 * second operand on throw. The @flatten-js boolean engine crashes on tangent /
 * degenerate edge contacts — including GENUINE overlaps where a curve boundary
 * touches another edge tangentially (e.g. a circle tangent to a rectangle's
 * edge while overlapping it). A sub-pixel translate breaks the tangency and
 * lets the op succeed, so the overlap is actually resolved. Perturbed results
 * are stripped of perturbation-scale sliver faces (see removeSliverFaces).
 * Returns null only if every attempt fails. `b.translate(...)` produces a
 * fresh polygon, leaving `b` untouched for use against other shapes.
 */
function withPerturbation(
  op: (a: Polygon, b: Polygon) => Polygon,
  a: Polygon,
  b: Polygon
): Polygon | null {
  const t0 = performance.now();
  const ea = polyEdges(a), eb = polyEdges(b);
  const report = (attempt: number, ok: boolean, err?: unknown) => {
    (globalThis as any).__FLAT_ATTEMPT_DUMP?.({
      attempt, ms: +(performance.now() - t0).toFixed(0), ea, eb, ok,
      err: err ? String(err).slice(0, 160) : undefined,
      stack: err && (err as any).stack ? String((err as any).stack).split('\n').slice(1, 4).join(' | ') : undefined,
    });
  };
  try {
    const r = op(a, b);
    report(0, true);
    return r;
  } catch (e) {
    report(0, false, e);
    __FLAT_STATS.throws++;
    // fall through to perturbation retries
  }
  for (const [dx, dy] of PERTURB_STEPS) {
    __FLAT_STATS.perturbRetries++;
    try {
      const r = removeSliverFaces(op(a, b.translate(vector(dx, dy))));
      report(__FLAT_STATS.perturbRetries, true);
      return r;
    } catch (e) {
      report(__FLAT_STATS.perturbRetries, false, e);
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
  if (a.isEmpty() || b.isEmpty()) return a;
  const t0 = performance.now();
  const ea = polyEdges(a), eb = polyEdges(b);
  const r = withPerturbation(subtract, a, b);
  const dt = performance.now() - t0;
  __FLAT_STATS.ops++;
  __FLAT_STATS.opTime += dt;
  __FLAT_STATS.opEdgesA += ea;
  __FLAT_STATS.opEdgesB += eb;
  if (ea > __FLAT_STATS.maxEdgesA) __FLAT_STATS.maxEdgesA = ea;
  if (eb > __FLAT_STATS.maxEdgesB) __FLAT_STATS.maxEdgesB = eb;
  if (__FLAT_STATS.worstOps.length < 12 || dt > __FLAT_STATS.worstOps[__FLAT_STATS.worstOps.length - 1].t) {
    __FLAT_STATS.worstOps.push({ t: dt, ea, eb, threw: r === null, retries: 0 });
    __FLAT_STATS.worstOps.sort((x, y) => y.t - x.t);
    if (__FLAT_STATS.worstOps.length > 12) __FLAT_STATS.worstOps.length = 12;
  }
  if (__FLAT_STATS.ops % 25 === 0) {
    (globalThis as any).__FLAT_STATS_DUMP?.(__FLAT_STATS);
  }
  if (r !== null) return r;
  __FLAT_STATS.subtractFails++;
  console.warn('Flatten: subtract failed even after perturbation, keeping shape unsubtracted');
  return a;
}

/**
 * unify WITHOUT perturbation retry. A direct unify succeeds for genuine
 * interior overlap and for disjoint regions (multipolygon result); it throws
 * on tangent/collinear contacts. A thrown unify means the regions only touch
 * (a shared boundary left by the subtraction phase, or a point contact) —
 * keeping them separate is then CORRECT: their interiors are disjoint, they
 * still tile the plane, and the 3D builder stitches shared boundaries.
 *
 * The perturbation retry used for subtract is NOT safe here: unify(a, b+δ)
 * claims the shifted strip of b beyond b, so the merged region overlaps
 * neighboring regions of other colors — breaking the non-overlapping
 * guarantee and producing non-manifold STL edges (observed as corner-touching
 * same-color cells merging into sliver-overlapping regions). Returns null
 * when the op throws, so the caller keeps the regions separate rather than
 * dropping one (which would lose area).
 */
function tryUnify(a: Polygon, b: Polygon): Polygon | null {
  if (a.isEmpty()) return b.isEmpty() ? null : b;
  if (b.isEmpty()) return a;
  try {
    return unify(a, b);
  } catch {
    return null;
  }
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
 * Implementation note: the boolean engine throws on pairs whose edges are
 * collinear/touching (shared boundaries, T-junctions, identical polygons) but
 * succeeds for genuine interior overlap. A thrown subtract means the pair only
 * touches (no interior overlap to remove) and is safely skipped via
 * safeSubtract. We never build a `covered` union — unifying touching above-shapes
 * would throw — so each above shape is subtracted individually.
 *
 * Complexity: O(n^2) subtract attempts, pruned by bounding-box prefilter —
 * acceptable for typical poster SVGs (tens to low-hundreds of paths).
 *
 * Cooperatively async: yields to the event loop between boolean ops so the
 * caller's UI stays responsive on large inputs, and reports per-shape progress
 * through `onProgress` (fired once per processed shape).
 */
export async function flattenPolygons(
  layers: FlattenLayer[],
  onProgress?: (done: number, total: number) => void
): Promise<FlattenResult[]> {
  const emitted: FlattenResult[] = [];

  // Flat list of all shapes in paint order, with the end offset of each layer.
  // Shapes above layer i are exactly entries[layerEnds[i-1] .. ] — walked in
  // place, with no per-layer suffix copies (and no spread, which overflows the
  // engine's argument limit on large SVGs).
  const shapes: Polygon[] = [];
  const layerEnds: number[] = [];
  for (const layer of layers) {
    for (const poly of layer.polygons) shapes.push(poly);
    layerEnds.push(shapes.length);
  }

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (!layer.polygons.length) continue;

    const start = i === 0 ? 0 : layerEnds[i - 1];
    const end = layerEnds[i];

    for (let s = start; s < end; s++) {
      await maybeYield();
      onProgress?.(s, shapes.length);
      let visible = shapes[s];
      // Same-layer siblings are NOT subtracted from each other: they share a
      // z-level (e.g. the two circles of one <path>), so neither occludes the
      // other. Their overlaps are resolved by mergeByColor afterwards.
      for (let t = end; t < shapes.length; t++) {
        await maybeYield();
        // Once fully occluded there is nothing left to subtract; also, an
        // empty polygon's box has no extents, so the prefilter below would
        // pass every remaining shape through a pointless boolean op.
        if (visible.isEmpty()) break;
        const abovePoly = shapes[t];
        // Bounding-box reject: disjoint shapes can't overlap, skip the op
        // (which would otherwise no-op or throw on a degenerate touch).
        if (visible.box.not_intersect(abovePoly.box)) continue;
        visible = safeSubtract(visible, abovePoly);
      }
      if (!visible.isEmpty()) emitted.push({ color: layer.color, polygon: visible });
    }
  }

  onProgress?.(shapes.length, shapes.length);
  return mergeByColor(emitted);
}

/**
 * Merge same-color regions into as few polygons as possible. After the
 * subtraction phase, cross-layer same-color regions are disjoint (the lower was
 * notched); same-layer siblings may still overlap. Unify resolves overlaps;
 * when it can't (tangent/collinear contact — the regions then only touch, so
 * their interiors are disjoint), the region is kept separate rather than
 * dropped, so no area is ever lost and the non-overlapping guarantee holds.
 *
 * Regions whose bounding boxes are disjoint can neither overlap nor z-fight,
 * and the output emits islands separately anyway — so they skip the boolean
 * unify entirely. Unifying a growing multipolygon is the dominant merge cost,
 * and typical posters have many small same-color islands that would all be
 * funneled through it.
 */
export async function mergeByColor(regions: FlattenResult[]): Promise<FlattenResult[]> {
  const t0 = performance.now();
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
      await maybeYield();
      if (acc.isEmpty()) {
        acc = p;
        continue;
      }
      if (acc.box.not_intersect(p.box)) {
        // Disjoint from acc: it may still overlap a region that previously
        // failed to merge, so give those a (cheap, bbox-prefiltered) chance.
        let mergedInto: number = -1;
        for (let k = 0; k < separate.length; k++) {
          const q = separate[k];
          if (p.box.not_intersect(q.box)) continue;
          const merged = tryUnify(q, p);
          if (merged !== null) {
            separate[k] = merged;
            mergedInto = k;
            break;
          }
        }
        if (mergedInto < 0) separate.push(p);
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
  __FLAT_STATS.mergeTime += performance.now() - t0;
  return out;
}

// ---------------------------------------------------------------------------
// Coverage check: the flattened regions must tile the canvas with no holes.
// ---------------------------------------------------------------------------

/**
 * Fill color for uncovered (hole) areas. White matches the page background the
 * holes currently render as, so the flattened image looks unchanged — but is
 * now fully covered, and the 3D model gets a solid slab there (the background
 * extrudes at the default height; set it to 0 layers to exclude it).
 */
const HOLE_FILL_COLOR = '#ffffff';

/** Canvas rectangle in SVG user units. */
export interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Result of a flatten coverage check. */
export interface CoverageReport {
  canvasArea: number;
  coveredArea: number;
  /** Uncovered area within the canvas (0 when fully covered). */
  holeArea: number;
  /** holeArea / canvasArea. */
  holeRatio: number;
  /** Sub-pixel noise allowance (perturbation slivers from boolean retries). */
  tolerance: number;
  /** True when holeArea exceeds the tolerance — the flatten lost area. */
  hasHoles: boolean;
}

/**
 * Check that flattened regions tile the canvas with no holes. The regions are
 * disjoint after the boolean pass, so the covered area is the plain sum of
 * polygon areas; any canvas area not covered by a region is a hole.
 *
 * The tolerance absorbs sub-pixel gaps left by perturbed boolean retries
 * (at most PERTURB_EPS wide along shape boundaries) — those are invisible at
 * print resolution and harmless to the manifold STL. Anything larger is a real
 * hole: either the source SVG does not cover the canvas (no background) or the
 * flatten lost a region.
 */
export function checkFlattenCoverage(
  regions: FlattenResult[],
  canvas: CanvasRect
): CoverageReport {
  const canvasArea = canvas.width * canvas.height;
  let coveredArea = 0;
  for (const r of regions) coveredArea += r.polygon.area();
  const holeArea = Math.max(0, canvasArea - coveredArea);
  const perimeter = 2 * (canvas.width + canvas.height);
  const tolerance = Math.max(canvasArea * 1e-4, 64 * PERTURB_EPS * perimeter);
  return {
    canvasArea,
    coveredArea,
    holeArea,
    holeRatio: canvasArea > 0 ? holeArea / canvasArea : 0,
    tolerance,
    hasHoles: holeArea > tolerance,
  };
}

/**
 * Determine the canvas rectangle for coverage checking: the viewBox if
 * present, else the width/height attributes, else the union bounding box of
 * all parsed shapes. Returns null when no canvas can be determined.
 */
function parseCanvasRect(svgContent: string, layers: FlattenLayer[] | null): CanvasRect | null {
  try {
    const doc = new DOMParser().parseFromString(svgContent, 'image/svg+xml');
    const root = doc.documentElement;
    if (root && root.localName.toLowerCase() === 'svg') {
      const vb = root.getAttribute('viewBox');
      if (vb) {
        const parts = vb.trim().split(/[\s,]+/).map(Number);
        if (parts.length === 4 && parts.every(isFinite) && parts[2] > 0 && parts[3] > 0) {
          return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
        }
      }
      const w = parseFloat(root.getAttribute('width') || '');
      const h = parseFloat(root.getAttribute('height') || '');
      if (isFinite(w) && isFinite(h) && w > 0 && h > 0) {
        return { x: 0, y: 0, width: w, height: h };
      }
    }
  } catch {
    // fall through to the shape-bbox fallback
  }
  if (layers) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const layer of layers) {
      for (const poly of layer.polygons) {
        const b = poly.box;
        if (b.xmin < minX) minX = b.xmin;
        if (b.ymin < minY) minY = b.ymin;
        if (b.xmax > maxX) maxX = b.xmax;
        if (b.ymax > maxY) maxY = b.ymax;
      }
    }
    if (isFinite(minX) && maxX > minX && maxY > minY) {
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
  }
  return null;
}

/**
 * Inset (SVG user units) of the canvas rectangle used for the coverage gap.
 * The gap is computed against a canvas inset by a hairline so the region union
 * CROSSES the inset rect transversally (regions extend to the canvas edge) —
 * the subtract is then exact (no collinear-edge throws, no perturbed retries
 * that would leave the fill overlapping the regions by sub-pixel strips). The
 * inset leaves a sub-pixel uncovered strip along the canvas edge, far below
 * the coverage tolerance and invisible at print resolution.
 */
const GAP_INSET = 1e-3;

/**
 * Compute the uncovered (hole) area within the canvas: the canvas rectangle
 * (inset by a hairline, see GAP_INSET) minus the UNION of all flattened
 * regions. The union is subtracted in a SINGLE boolean op — subtracting the
 * regions one by one would hit identical-edge contacts (each region's edge
 * coincides with the gap's notched boundary from its already-subtracted
 * neighbor), which the boolean engine rejects. The result is exact: it never
 * overlaps a region, and the regions + gap tile the inset canvas.
 * Returns null when there is no gap.
 */
function computeCoverageGap(canvas: CanvasRect, regions: FlattenResult[]): Polygon | null {
  // Union of all regions as one polygon. Faces of adjacent regions may share
  // edges; flatten-js treats them as touching islands of one multipolygon.
  const union = new Polygon();
  for (const r of regions) {
    for (const f of r.polygon.faces) union.addFace(f as any);
  }
  if (union.isEmpty()) return null;

  const inset = Math.max(GAP_INSET, Math.max(canvas.width, canvas.height) * 1e-6);
  const shrunk = new Polygon();
  try {
    shrunk.addFace([
      point(canvas.x + inset, canvas.y + inset),
      point(canvas.x + canvas.width - inset, canvas.y + inset),
      point(canvas.x + canvas.width - inset, canvas.y + canvas.height - inset),
      point(canvas.x + inset, canvas.y + canvas.height - inset),
    ]);
  } catch {
    return null;
  }

  let gap: Polygon;
  try {
    gap = subtract(shrunk, union);
  } catch {
    // Rare degenerate contact: fall back to a perturbed subtract (may leave
    // sub-pixel slivers, stripped below).
    gap = safeSubtract(shrunk, union);
  }
  gap = removeSliverFaces(gap);
  return gap.isEmpty() || gap.area() < MIN_FACE_AREA ? null : gap;
}

// ---------------------------------------------------------------------------
// Contour cleaning + Polygon construction from sampled points.
// ---------------------------------------------------------------------------

export interface XY {
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
 * by the boolean engine: same-meaning faces must share orientation).
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

// ---------------------------------------------------------------------------
// Adaptive curve flattening (flatness-based subdivision).
// ---------------------------------------------------------------------------

interface V2 { x: number; y: number; }

/** Perpendicular distance from point (px,py) to the line through (ax,ay)-(bx,by). */
function pointLineDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(px - ax, py - ay);
  return Math.abs(dx * (ay - py) - dy * (ax - px)) / len;
}

const mid2 = (a: V2, b: V2): V2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Subdivision depth cap: at most 32 segments per curve (old fixed sampling: 24). */
const CURVE_MAX_DEPTH = 5;

function subdivideCubic(p0: V2, p1: V2, p2: V2, p3: V2, depth: number, out: V2[]): void {
  const flat =
    pointLineDist(p1.x, p1.y, p0.x, p0.y, p3.x, p3.y) <= CURVE_TOLERANCE &&
    pointLineDist(p2.x, p2.y, p0.x, p0.y, p3.x, p3.y) <= CURVE_TOLERANCE;
  if (flat || depth >= CURVE_MAX_DEPTH) {
    out.push({ x: p3.x, y: p3.y });
    return;
  }
  // de Casteljau split at t = 0.5.
  const l1 = mid2(p0, p1), l2 = mid2(p1, p2), l3 = mid2(p2, p3);
  const m1 = mid2(l1, l2), m2 = mid2(l2, l3);
  const c = mid2(m1, m2);
  subdivideCubic(p0, l1, m1, c, depth + 1, out);
  subdivideCubic(c, m2, l3, p3, depth + 1, out);
}

function subdivideQuadratic(p0: V2, p1: V2, p2: V2, depth: number, out: V2[]): void {
  const flat = pointLineDist(p1.x, p1.y, p0.x, p0.y, p2.x, p2.y) <= CURVE_TOLERANCE;
  if (flat || depth >= CURVE_MAX_DEPTH) {
    out.push({ x: p2.x, y: p2.y });
    return;
  }
  const l1 = mid2(p0, p1), l2 = mid2(p1, p2), c = mid2(l1, l2);
  subdivideQuadratic(p0, l1, c, depth + 1, out);
  subdivideQuadratic(c, l2, p2, depth + 1, out);
}

/** Divisions for an elliptical arc so the chord deviation stays within tolerance. */
function ellipseAdaptiveDivisions(c: any): number {
  // The traced angular span is NOT |aEndAngle - aStartAngle|: EllipseCurve
  // .getPoint normalizes the delta into [0, 2π] and flips it for clockwise
  // arcs, so a near-full-circle arc (large-arc flag) has a raw angle
  // difference near 0 but traces ~2π. Mirror that computation exactly.
  const twoPi = Math.PI * 2;
  let deltaAngle = c.aEndAngle - c.aStartAngle;
  const samePoints = Math.abs(deltaAngle) < Number.EPSILON;
  while (deltaAngle < 0) deltaAngle += twoPi;
  while (deltaAngle > twoPi) deltaAngle -= twoPi;
  if (deltaAngle < Number.EPSILON) {
    deltaAngle = samePoints ? 0 : twoPi;
  }
  if (c.aClockwise === true && !samePoints) {
    deltaAngle = deltaAngle === twoPi ? -twoPi : deltaAngle - twoPi;
  }
  const span = Math.abs(deltaAngle);
  const r = Math.max(c.xRadius, c.yRadius);
  if (!(r > 0) || !(span > 0)) return 2;
  // Chord deviation for a segment subtending θ on radius r is ≈ r·θ²/8.
  const theta = Math.sqrt((8 * CURVE_TOLERANCE) / r);
  const n = Math.ceil(span / Math.max(theta, 1e-6));
  return Math.min(Math.max(n, 2), CURVE_DIVISIONS * 2);
}

/**
 * Sample a THREE subpath (CurvePath) to a polyline with per-curve adaptive
 * resolution. Mirrors CurvePath.getPoints semantics (no consecutive duplicate
 * points, autoClose appends the first point) but spends points only where the
 * curvature requires them.
 */
function subpathPointsAdaptive(sp: any): V2[] {
  const points: V2[] = [];
  let hasLast = false, lastX = 0, lastY = 0;
  // Snap to the emission grid (see EMISSION_GRID): adjacent shapes whose
  // boundaries are near-coincident in the source art then share exact
  // vertices, so the boolean ops and the emission rounding treat them as
  // one shared boundary instead of two hairline-apart ones.
  const snap = (p: V2): V2 => ({
    x: Math.round(p.x / EMISSION_GRID) * EMISSION_GRID,
    y: Math.round(p.y / EMISSION_GRID) * EMISSION_GRID,
  });
  const curves: any[] = sp?.curves ?? [];
  for (const curve of curves) {
    let pts: V2[];
    if (curve?.isLineCurve || curve?.isLineCurve3) {
      pts = curve.getPoints(1);
    } else if (curve?.isEllipseCurve) {
      pts = curve.getPoints(ellipseAdaptiveDivisions(curve));
    } else if (curve?.isCubicBezierCurve) {
      pts = [{ x: curve.v0.x, y: curve.v0.y }];
      subdivideCubic(curve.v0, curve.v1, curve.v2, curve.v3, 0, pts);
    } else if (curve?.isQuadraticBezierCurve) {
      pts = [{ x: curve.v0.x, y: curve.v0.y }];
      subdivideQuadratic(curve.v0, curve.v1, curve.v2, 0, pts);
    } else {
      pts = curve.getPoints(CURVE_DIVISIONS);
    }
    for (const p0 of pts) {
      const p = snap(p0);
      if (hasLast && p.x === lastX && p.y === lastY) continue; // no consecutive duplicates
      points.push(p);
      lastX = p.x; lastY = p.y; hasLast = true;
    }
  }
  if (sp?.autoClose && points.length > 1) {
    const f = points[0], l = points[points.length - 1];
    if (f.x !== l.x || f.y !== l.y) points.push({ x: f.x, y: f.y });
  }
  return points;
}

// ---------------------------------------------------------------------------
// Winding-based subpath -> polygon conversion (replaces SVGLoader.createShapes).
// ---------------------------------------------------------------------------

/**
 * Ray-casting point-in-polygon test. Uses the contour centroid as the probe
 * point (computed by the caller) so the test point is well inside the contour
 * and not on a shared vertex/edge with a neighbouring subpath.
 */
function pointInPolygon(p: XY, polygon: XY[]): boolean {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    if (((yi > p.y) !== (yj > p.y)) &&
        (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/** Centroid (average of vertices) of a contour — a safe interior probe point. */
function contourCentroid(pts: XY[]): XY {
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  return { x: cx / pts.length, y: cy / pts.length };
}

// ---------------------------------------------------------------------------
// Winding-based contour classification (shared by parsing, emission, re-parse).
// ---------------------------------------------------------------------------

/** A closed contour with the data needed for winding classification. */
export interface ClassifiedContour {
  pts: XY[];
  /** Shoelace signed area sum (2x signed area); sign encodes orientation. */
  shoelace: number;
  /** Average of vertices — a safe interior probe point. */
  centroid: XY;
}

/** One shape: an outer contour plus the hole contours carved out of it. */
export interface ContourIsland {
  outer: XY[];
  outerAbsArea: number;
  holes: XY[][];
}

/**
 * Group contours into islands (outer + holes) using the nonzero winding rule.
 *
 * A contour C is a HOLE iff the winding number inside C — including C's own
 * contribution — equals zero; otherwise it is a solid outer contour.
 * Contours are processed largest-area first, so containers are always
 * classified before the contours they contain and the winding number at each
 * centroid is exact. This handles arbitrary nesting depth:
 *
 *   outer → hole → solid-in-hole → hole → ...
 *
 * and is robust to ANY input winding — unlike sign-based classification,
 * which misclassifies a hole that happens to share its outer's winding (and
 * sign-based island extraction in flatten-js's splitToIslands groups by
 * orientation sign, which breaks the same way).
 */
export function contoursToIslands(contours: ClassifiedContour[]): ContourIsland[] {
  const sorted = [...contours].sort((a, b) => Math.abs(b.shoelace) - Math.abs(a.shoelace));
  // Winding contribution in the nonzero fill rule: opposite orientations
  // contribute opposite signs; only the zero test matters.
  const contrib = (c: ClassifiedContour): number => (c.shoelace < 0 ? 1 : -1);
  const islands: ContourIsland[] = [];
  // All classified contours (outers and holes) for winding-number computation.
  const assigned: ClassifiedContour[] = [];
  for (const c of sorted) {
    // Winding number at c's centroid from all previously classified contours.
    let w = 0;
    for (const a of assigned) {
      if (pointInPolygon(c.centroid, a.pts)) w += contrib(a);
    }
    if (w + contrib(c) === 0) {
      // C is a hole — attach to the innermost (smallest) containing outer.
      let parent: ContourIsland | null = null;
      for (const isl of islands) {
        if (!pointInPolygon(c.centroid, isl.outer)) continue;
        if (!parent || isl.outerAbsArea < parent.outerAbsArea) parent = isl;
      }
      if (parent) {
        parent.holes.push(c.pts);
      } else {
        // winding-inside == 0 but no containing outer found — shouldn't happen
        // for valid input, but guard against losing the contour.
        islands.push({ outer: c.pts, outerAbsArea: Math.abs(c.shoelace), holes: [] });
      }
    } else {
      // C is a solid shape — new outer contour.
      islands.push({ outer: c.pts, outerAbsArea: Math.abs(c.shoelace), holes: [] });
    }
    assigned.push(c);
  }
  return islands;
}

/** Face vertices as plain points, dropping a closing duplicate if present. */
function faceVertices(face: { vertices: any[] }): XY[] {
  const pts: XY[] = (face.vertices as any[]).map((v) => ({ x: v.x, y: v.y }));
  if (pts.length >= 2) {
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) pts.pop();
  }
  return pts;
}

/**
 * Build a ClassifiedContour from a flatten-js face, or null when the face is
 * degenerate (< 3 vertices or zero area).
 */
export function faceToContour(face: { vertices: any[] }): ClassifiedContour | null {
  const pts = faceVertices(face);
  if (pts.length < 3) return null;
  const shoelace = signedArea(pts);
  if (shoelace === 0) return null;
  return { pts, shoelace, centroid: contourCentroid(pts) };
}

/**
 * Convert a THREE.SVGLoader path into flatten-js Polygons using WINDING-BASED
 * hole detection, replacing SVGLoader.createShapes.
 *
 * createShapes uses a scanline algorithm: for each subpath it casts a
 * horizontal ray through the subpath's bounding-box centre and counts edge
 * crossings. When two subpaths are close together (e.g. adjacent letters in
 * a text path like "YOUR HEAD"), the scanline through one letter's centre can
 * also cross a neighbouring letter's edges, making the crossing count even.
 * The letter is then misclassified as a HOLE and subtracted away — it vanishes
 * from the flattened output.
 *
 * Winding-based detection is exact and matches the SVG nonzero fill rule:
 *
 *   In SVG (Y-down), the shoelace signed area sign encodes the winding
 *   direction: positive = CW on screen (contributes -1 to the winding number),
 *   negative = CCW on screen (contributes +1). A point is filled iff the
 *   winding number (sum of contributions from all containing subpaths) is
 *   non-zero.
 *
 *   A contour C is a HOLE iff the winding number inside C — including C's own
 *   contribution — equals zero. That is: W(centroid_C) + contribution_C == 0,
 *   where W is the winding number from all OTHER contours containing the
 *   centroid. This correctly handles arbitrary nesting depth:
 *
 *     outer(+1) → hole(-1) → solid(+1) inside the hole → hole(-1) → ...
 *
 *   A contour whose winding-inside is non-zero is a solid shape (new outer
 *   contour). Containment is tested with a ray-cast from the subpath's
 *   centroid, which is robustly interior for simple polygons.
 *
 * The classification itself lives in contoursToIslands (shared with the
 * emission and re-parse paths).
 */
function pathToPolygons(path: any): Polygon[] {
  const subpaths: any[] = path?.subPaths ?? [];
  if (!subpaths.length) return [];

  // Extract contours with their signed areas (winding).
  const contours: ClassifiedContour[] = [];
  for (const sp of subpaths) {
    const rawPts: XY[] = subpathPointsAdaptive(sp);
    if (rawPts.length < 3) continue;
    const shoelace = signedArea(rawPts);
    if (Math.abs(shoelace) < 1e-12) continue; // degenerate
    contours.push({ pts: rawPts, shoelace, centroid: contourCentroid(rawPts) });
  }
  if (!contours.length) return [];

  const islands = contoursToIslands(contours);

  // Build polygons: outer minus holes.
  const polygons: Polygon[] = [];
  for (const isl of islands) {
    let poly = contourToPolygon(isl.outer);
    if (!poly) continue;
    for (const hole of isl.holes) {
      const holePoly = contourToPolygon(hole);
      if (!holePoly) continue;
      const next = safeSubtract(poly, holePoly);
      if (next === poly) console.warn('Flatten: hole subtract failed, ignoring hole');
      poly = next;
    }
    if (!poly.isEmpty()) polygons.push(poly);
  }
  return polygons;
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
export async function svgToLayers(snappedSVG: string): Promise<FlattenLayer[] | null> {
  const t0 = performance.now();
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
    await maybeYield();
    const color = pathFillColor(p);
    if (!color) continue;
    // Winding-based subpath parsing (NOT SVGLoader.createShapes — its scanline
    // hole-detection misclassifies adjacent letter subpaths as holes, making
    // them vanish from the output).
    let polygons: Polygon[];
    try {
      polygons = pathToPolygons(p);
    } catch (e) {
      console.warn('Flatten: pathToPolygons failed for a path, skipping:', e);
      continue;
    }
    if (polygons.length) {
      layers.push({ color, polygons });
      for (const poly of polygons) {
        const e = polyEdges(poly);
        __FLAT_STATS.parsePoints += e;
        if (e > __FLAT_STATS.maxPathPoints) __FLAT_STATS.maxPathPoints = e;
      }
      __FLAT_STATS.parsePolys += polygons.length;
    }
  }
  __FLAT_STATS.parseTime += performance.now() - t0;
  return layers.length ? layers : null;
}

// ---------------------------------------------------------------------------
// Output assembly.
// ---------------------------------------------------------------------------

/**
 * Grid (SVG user units) that sampled polyline points are snapped to, and that
 * emitted path numbers are rounded to. Snapping the INPUT to this grid before
 * the boolean ops makes near-coincident boundaries of adjacent shapes exactly
 * coincident (their vertices land on the same grid points), so the emission
 * rounding is idempotent on them — it can no longer flip a sub-quantum gap
 * into a hairline overlap between two regions (which the 3D builder turns
 * into coincident bottom faces: non-manifold STL edges slicers reject).
 * 1e-3 units is ~0.00008 mm on a 100 mm print — invisible.
 */
const EMISSION_GRID = 1e-3;

/** Round numbers in a path `d` string to keep the output compact and stable. */
function roundPathNumbers(d: string): string {
  return d.replace(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi, (m) => {
    const n = parseFloat(m);
    if (!isFinite(n)) return m;
    const r = Math.round(n / EMISSION_GRID) * EMISSION_GRID;
    return String(r);
  });
}

/**
 * Build SVG path-data strings from a result polygon, one per island.
 *
 * Each result polygon may be a multipolygon (multiple disjoint outer contours
 * produced by mergeByColor's unify). If all faces were emitted as subpaths of
 * a single <path>, three.js's createShapes scanline hole-detection can
 * misclassify one outer contour as a hole of another (when their bounding
 * boxes overlap), dropping it from the 3D output. We therefore split the
 * polygon into islands (each an outer + its holes) and emit each island as a
 * separate <path> element.
 *
 * Faces are classified into islands by WINDING NUMBER (contoursToIslands),
 * not by flatten-js's splitToIslands: splitToIslands groups faces by
 * orientation sign, which mis-groups polygons whose faces do not follow
 * flatten-js's canonical orientation (outer CCW / hole CW), and it throws on
 * some degenerate inputs.
 *
 * Emission winding is ENFORCED, not inherited: the outer contour of each
 * island is emitted with positive shoelace area and every hole with negative
 * shoelace area (vertex order reversed when needed). This guarantees the
 * emission contract that parseFlattenedPaths relies on — and that the
 * browser's nonzero fill rule needs to render holes as holes — regardless of
 * the orientation the boolean ops happened to produce.
 *
 * Degenerate faces (near-zero area or < 3 vertices) are skipped — they carry
 * no visible region and can crash downstream shape parsing.
 *
 * Note: createShapes can still misclassify a HOLE as a solid shape when its
 * scanline is tangent to another subpath's edge (see svgToRegions); the
 * browser's own nonzero fill is unaffected. svgToRegions therefore parses
 * this output by winding rather than via createShapes.
 *
 * Returns null if the polygon has no valid faces.
 */
function polygonToIslandDpaths(poly: Polygon): string[] | null {
  const contours: ClassifiedContour[] = [];
  for (const face of poly.faces) {
    if (face.area() < MIN_FACE_AREA) continue;
    const c = faceToContour(face);
    if (c) contours.push(c);
  }
  if (!contours.length) return null;

  const islands = contoursToIslands(contours);
  const dpaths: string[] = [];
  for (const isl of islands) {
    const parts: string[] = [];
    // Emit one subpath per contour with the contract winding: outer positive
    // shoelace, holes negative.
    const emit = (pts: XY[], wantPositive: boolean): void => {
      const p = (signedArea(pts) > 0) === wantPositive ? pts : [...pts].reverse();
      const move = `M${p[0].x},${p[0].y}`;
      const lines = p.slice(1).map((v) => `L${v.x},${v.y}`).join('');
      parts.push(`${move}${lines} z`);
    };
    emit(isl.outer, true);
    for (const hole of isl.holes) emit(hole, false);
    dpaths.push(parts.join(''));
  }
  return dpaths.length ? dpaths : null;
}

/** Build the output SVG document string from flattened regions. */
async function buildOutputSVG(
  rootAttrs: Record<string, string>,
  results: FlattenResult[]
): Promise<string> {
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
    await maybeYield();
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
 * The flatten step emits one `<path>` per island with absolute M/L/z commands
 * and enforced winding: positive shoelace area = outer contour, negative =
 * hole. We parse those `d` strings directly instead of routing through
 * SVGLoader.createShapes: its scanline hole-detection misclassifies a hole as
 * a solid shape whenever the scanline (the horizontal line through the hole's
 * bounding-box center) is tangent to another subpath's edge — e.g. a dot
 * pattern where one circle's center line grazes a neighbor's extremum. A
 * misclassified hole comes back as a solid region that overlaps the shape
 * above it, breaking the non-overlapping guarantee the manifold builder
 * relies on. Winding-based parsing (contoursToIslands) is exact for our own
 * output and robust to any subpath winding.
 *
 * Documents that do not match the emission contract (any `<path>` with
 * commands other than absolute M/L and z — i.e. not produced by flattenSVG)
 * fall back to the SVGLoader-based parse.
 *
 * Cooperatively async: yields to the event loop between regions so large
 * documents do not block the caller's UI.
 *
 * @param svgContent - Flattened SVG string.
 * @returns Regions (color + polygon) or null if no fillable shapes were found.
 */
export async function svgToRegions(svgContent: string): Promise<Region[] | null> {
  const parsed = parseFlattenedPaths(svgContent);
  if (parsed) {
    const regions: Region[] = [];
    for (const { color, outers, holes } of parsed) {
      await maybeYield();
      const polygons: Polygon[] = [];
      for (const outer of outers) {
        // Clean before addFace: roundPathNumbers rounds emitted coordinates to
        // 3 decimals, which can collapse two nearby vertices into an exact
        // duplicate — flatten-js addFace throws on that and the region would
        // be silently dropped (leaving a hole in the 3D model).
        const cleaned = cleanContour(outer);
        if (!cleaned) continue;
        const poly = new Polygon();
        try {
          poly.addFace(cleaned.map((p) => point(p.x, p.y)));
        } catch {
          continue;
        }
        polygons.push(poly);
      }
      for (const hole of holes) {
        const cleaned = cleanContour(hole);
        if (!cleaned) continue;
        const holePoly = new Polygon();
        try {
          holePoly.addFace(cleaned.map((p) => point(p.x, p.y)));
        } catch {
          continue;
        }
        // Attach the hole to the outer that contains it (the emission contract
        // is one outer per path, but stay correct for multi-outer paths too).
        // Probe with the hole's centroid: a vertex of the hole can lie exactly
        // on the outer's boundary, where contains() is false and the hole
        // would be silently dropped.
        const probe = contourCentroid(cleaned);
        let target: Polygon | undefined;
        for (const poly of polygons) {
          if (!poly.box.not_intersect(holePoly.box) && poly.contains(point(probe.x, probe.y))) {
            target = poly;
            break;
          }
        }
        if (target) target.addFace(cleaned.map((p) => point(p.x, p.y)));
      }
      for (const poly of polygons) {
        if (!poly.isEmpty()) regions.push({ color, polygon: poly });
      }
    }
    return regions.length ? regions : null;
  }

  // Fallback: arbitrary SVG (not our flattened output).
  const layers = await svgToLayers(svgContent);
  if (!layers) return null;
  const regions: Region[] = [];
  for (const layer of layers) {
    for (const poly of layer.polygons) {
      if (!poly.isEmpty()) regions.push({ color: layer.color, polygon: poly });
    }
  }
  return regions.length ? regions : null;
}

/** One flattened `<path>`: its fill color plus outer/hole contours. */
interface FlattenedPath {
  color: string;
  outers: XY[][];
  holes: XY[][];
}

/**
 * Parse the `<path>` elements of a flattened SVG via the emission contract.
 * Returns null when the document does not match the contract (missing/foreign
 * commands, no fillable paths) so the caller can fall back.
 */
function parseFlattenedPaths(svgContent: string): FlattenedPath[] | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(svgContent, 'image/svg+xml');
  } catch {
    return null;
  }
  if (doc.querySelector('parsererror')) return null;
  const pathEls = Array.from(doc.querySelectorAll('path'));
  if (!pathEls.length) return null;

  const parsed: FlattenedPath[] = [];
  for (const el of pathEls) {
    const fill = el.getAttribute('fill');
    if (!isSnappableColor(fill)) return null; // not our output; use fallback
    const d = el.getAttribute('d');
    if (!d) return null;
    const subpaths = parseEmittedD(d);
    if (!subpaths) return null;
    // Classify subpaths by winding number (contoursToIslands) — the same rule
    // the browser's nonzero fill uses — rather than by shoelace sign alone, so
    // a hole is recognized even if it was emitted with its outer's winding.
    const contours: ClassifiedContour[] = [];
    for (const pts of subpaths) {
      const shoelace = signedArea(pts);
      if (shoelace === 0) continue;
      contours.push({ pts, shoelace, centroid: contourCentroid(pts) });
    }
    const islands = contoursToIslands(contours);
    const outers: XY[][] = islands.map((isl) => isl.outer);
    const holes: XY[][] = islands.flatMap((isl) => isl.holes);
    if (!outers.length) continue;
    parsed.push({ color: rgbToHex(colorToRGB(fill!)), outers, holes });
  }
  return parsed.length ? parsed : null;
}

/**
 * Parse a `d` string emitted by buildOutputSVG: absolute M/L commands and z
 * closes only. Returns the closed subpaths as point arrays, or null when the
 * string uses any other command (curves, relative moves, arcs, ...).
 */
function parseEmittedD(d: string): XY[][] | null {
  if (/[^\sMLZz\d,.+\-eE]/.test(d)) return null;
  const subpaths: XY[][] = [];
  let current: XY[] | null = null;
  for (const m of d.matchAll(/([MLZz])([^MLZz]*)/g)) {
    const cmd = m[1];
    if (cmd === 'z' || cmd === 'Z') {
      if (current && current.length >= 3) subpaths.push(current);
      current = null;
      continue;
    }
    const coords = m[2].match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g);
    if (!coords || coords.length % 2 !== 0) return null;
    if (cmd === 'M') {
      if (current && current.length >= 3) subpaths.push(current);
      current = [];
    }
    if (!current) return null;
    for (let i = 0; i < coords.length; i += 2) {
      current.push({ x: parseFloat(coords[i]), y: parseFloat(coords[i + 1]) });
    }
  }
  if (current && current.length >= 3) subpaths.push(current);
  return subpaths;
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/**
 * Flatten an SVG by snapping fills to the palette and then applying real
 * vector boolean subtraction so that exactly one shape covers any pixel.
 *
 * After the boolean pass, a COVERAGE CHECK verifies the flattened regions
 * tile the canvas with no holes (see checkFlattenCoverage). Any uncovered
 * area is filled with a background region, so the flattened image is always
 * complete — the 3D model gets a solid slab instead of gaps.
 *
 * Cooperatively async: the heavy phases yield to the event loop so the page
 * stays responsive (no "page unresponsive" dialog on large posters). Pass
 * `onProgress` to surface phase/per-shape progress in the UI.
 *
 * @param svgContent - SVG string
 * @param palette - Optional list of hex colors to snap fills to (Simplify output)
 * @param onProgress - Optional status callback (human-readable progress text)
 * @returns Flattened SVG string. On any boolean-op failure, degrades to the
 *          color-snapped SVG (still valid, just possibly overlapping).
 */
export async function flattenSVG(
  svgContent: string,
  palette?: string[],
  onProgress?: (status: string) => void
): Promise<string> {
  // Let the caller's busy indicator paint before the first heavy phase.
  await yieldToUI();

  // 1. Color snap (also the fallback output if the boolean step fails).
  onProgress?.('snapping colors');
  const tSnap = performance.now();
  const snapped = await snapColors(svgContent, palette);
  __FLAT_STATS.snapTime += performance.now() - tSnap;

  // 2. Boolean flatten.
  try {
    onProgress?.('parsing shapes');
    const layers = await svgToLayers(snapped);
    if (!layers) {
      console.log('Flatten: no fillable shapes found, returning snapped SVG.');
      return snapped;
    }

    onProgress?.('flattening regions');
    const results = await flattenPolygons(layers, (done, total) => {
      onProgress?.(`flattening regions (${done}/${total} shapes)`);
    });
    if (!results.length) {
      console.log('Flatten: boolean pass produced no regions, returning snapped SVG.');
      return snapped;
    }

    // Coverage check: the flattened regions must tile the canvas with NO
    // HOLES. If the source SVG does not cover the canvas (or the flatten lost
    // a region), the uncovered area is filled with a background region so the
    // flattened image is complete.
    onProgress?.('checking coverage');
    const tCov = performance.now();
    const canvas = parseCanvasRect(snapped, layers);
    if (canvas) {
      const report = checkFlattenCoverage(results, canvas);
      if (report.hasHoles) {
        const gap = computeCoverageGap(canvas, results);
        if (gap) {
          results.push({ color: HOLE_FILL_COLOR, polygon: gap });
          const pct = (report.holeRatio * 100).toFixed(2);
          console.warn(
            `Flatten: coverage check found holes — ${report.holeArea.toFixed(1)} units² ` +
            `uncovered (${pct}% of canvas); filled with background ${HOLE_FILL_COLOR}.`
          );
          onProgress?.(`filled ${pct}% uncovered area with background`);
        }
      } else {
        console.log(
          `Flatten: coverage OK — regions tile ${report.coveredArea.toFixed(1)} ` +
          `of ${report.canvasArea.toFixed(1)} units² of the canvas.`
        );
      }
      const after = checkFlattenCoverage(results, canvas);
      if (after.hasHoles) {
        console.warn(
          `Flatten: coverage check still reports ${after.holeArea.toFixed(1)} units² ` +
          `uncovered after the background fill.`
        );
      }
    }
    __FLAT_STATS.coverageTime += performance.now() - tCov;

    onProgress?.('building output');
    const tBuild = performance.now();
    const rootAttrs = readRootAttrs(snapped);
    const out = await buildOutputSVG(rootAttrs, results);
    __FLAT_STATS.buildTime += performance.now() - tBuild;
    console.log(
      `Flatten (boolean): ${layers.length} layers -> ${results.length} non-overlapping regions.`
    );
    return out;
  } catch (e) {
    console.error('Flatten: boolean pass failed, returning snapped SVG:', e);
    return snapped;
  }
}
