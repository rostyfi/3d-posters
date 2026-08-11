// Type shim for @flatten-js/boolean-op, which ships no .d.ts.
// The boolean ops accept and return @flatten-js/core Polygons.
declare module '@flatten-js/boolean-op' {
  import type { Polygon } from '@flatten-js/core';
  export function unify(polygon1: Polygon, polygon2: Polygon): Polygon;
  export function subtract(polygon1: Polygon, polygon2: Polygon): Polygon;
  export function intersect(polygon1: Polygon, polygon2: Polygon): Polygon;
  export const BOOLEAN_UNION: number;
  export const BOOLEAN_INTERSECT: number;
  export const BOOLEAN_SUBTRACT: number;
}
