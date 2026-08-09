/**
 * STL Export utilities for 3D printing
 * 
 * STL (StereoLithography) is the standard format for 3D printing.
 * This module provides functionality to export Three.js meshes as STL files.
 */

import * as THREE from 'three';

/**
 * Options for STL export
 */
export interface STLExportOptions {
  /** Whether to export as ASCII or binary STL (binary is smaller and more common) */
  format: 'ascii' | 'binary';
  /** Name for the exported file (without extension) */
  fileName?: string;
  /** Target width in mm for scaling */
  targetWidthMM?: number;
  /** Target height in mm for scaling */
  targetHeightMM?: number;
}

/**
 * Default STL export options
 */
const DEFAULT_OPTIONS: STLExportOptions = {
  format: 'binary',
  fileName: '3d-poster',
};

/**
 * Vertex data for STL face
 */
interface STLVertex {
  x: number;
  y: number;
  z: number;
}

/**
 * Face data for STL export
 */
interface STLFace {
  normal: STLVertex;
  vertices: [STLVertex, STLVertex, STLVertex];
}

/**
 * Convert a Three.js mesh to STL faces
 * @param mesh - The Three.js mesh to convert
 * @returns Array of STL faces
 */
function meshToSTLFaces(mesh: THREE.Mesh): STLFace[] {
  const faces: STLFace[] = [];
  const geometry = mesh.geometry;

  // Ensure we have BufferGeometry
  if (!(geometry instanceof THREE.BufferGeometry)) {
    console.warn('Unsupported geometry type for STL export');
    return faces;
  }

  // Get position attribute
  const positionAttribute = geometry.getAttribute('position');
  if (!positionAttribute) {
    return faces;
  }

  const position = positionAttribute.array as Float32Array;
  const index = geometry.index ? geometry.index.array : null;

  // Compute normals if not available
  if (!geometry.getAttribute('normal')) {
    geometry.computeVertexNormals();
  }

  const normalAttribute = geometry.getAttribute('normal');
  if (!normalAttribute) {
    return faces;
  }

  const normal = normalAttribute.array as Float32Array;

  // For indexed geometry
  if (index) {
    for (let i = 0; i < index.length; i += 3) {
      const a = index[i] * 3;
      const b = index[i + 1] * 3;
      const c = index[i + 2] * 3;

      // Get normal for this face
      const nx = normal[a];
      const ny = normal[a + 1];
      const nz = normal[a + 2];

      const face: STLFace = {
        normal: { x: nx, y: ny, z: nz },
        vertices: [
          { x: position[a], y: position[a + 1], z: position[a + 2] },
          { x: position[b], y: position[b + 1], z: position[b + 2] },
          { x: position[c], y: position[c + 1], z: position[c + 2] },
        ],
      };

      // Calculate face normal from vertices (more reliable)
      const v1 = face.vertices[1];
      const v2 = face.vertices[2];
      const v0 = face.vertices[0];

      const ux = v1.x - v0.x;
      const uy = v1.y - v0.y;
      const uz = v1.z - v0.z;

      const vx = v2.x - v0.x;
      const vy = v2.y - v0.y;
      const vz = v2.z - v0.z;

      const nx2 = uy * vz - uz * vy;
      const ny2 = uz * vx - ux * vz;
      const nz2 = ux * vy - uy * vx;

      // Normalize
      const len = Math.sqrt(nx2 * nx2 + ny2 * ny2 + nz2 * nz2);
      if (len > 0) {
        face.normal = {
          x: nx2 / len,
          y: ny2 / len,
          z: nz2 / len,
        };
      }

      faces.push(face);
    }
  } else {
    // For non-indexed geometry
    for (let i = 0; i < position.length; i += 9) {
      // Each face has 3 vertices, each vertex has 3 coordinates
      const v0x = position[i];
      const v0y = position[i + 1];
      const v0z = position[i + 2];

      const v1x = position[i + 3];
      const v1y = position[i + 4];
      const v1z = position[i + 5];

      const v2x = position[i + 6];
      const v2y = position[i + 7];
      const v2z = position[i + 8];

      // Calculate face normal using cross product
      const ux = v1x - v0x;
      const uy = v1y - v0y;
      const uz = v1z - v0z;

      const vx = v2x - v0x;
      const vy = v2y - v0y;
      const vz = v2z - v0z;

      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;

      // Normalize
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const normal = len > 0 ? { x: nx / len, y: ny / len, z: nz / len } : { x: 0, y: 0, z: 0 };

      faces.push({
        normal,
        vertices: [
          { x: v0x, y: v0y, z: v0z },
          { x: v1x, y: v1y, z: v1z },
          { x: v2x, y: v2y, z: v2z },
        ],
      });
    }
  }

  return faces;
}

/**
 * Convert all meshes in a group/object to STL faces
 * @param object - Three.js object3D (Group, Mesh, etc.)
 * @returns Array of STL faces
 */
function objectToSTLFaces(object: THREE.Object3D): STLFace[] {
  const faces: STLFace[] = [];

  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      const meshFaces = meshToSTLFaces(child);
      faces.push(...meshFaces);
    }
  });

  return faces;
}

/**
 * Generate ASCII STL content from faces
 * @param faces - Array of STL faces
 * @param solidName - Name for the solid object
 * @returns ASCII STL string
 */
function generateASCIISTL(faces: STLFace[], solidName: string = '3d-poster'): string {
  let content = `solid ${solidName}\n`;

  for (const face of faces) {
    // Normal vector
    content += `  facet normal ${face.normal.x} ${face.normal.y} ${face.normal.z}\n`;
    content += '    outer loop\n';
    
    // Vertices
    for (const vertex of face.vertices) {
      content += `      vertex ${vertex.x} ${vertex.y} ${vertex.z}\n`;
    }
    
    content += '    endloop\n';
    content += '  endfacet\n';
  }

  content += `endsolid ${solidName}\n`;
  return content;
}

/**
 * Generate binary STL content from faces
 * @param faces - Array of STL faces
 * @returns Uint8Array containing binary STL data
 */
function generateBinarySTL(faces: STLFace[]): Uint8Array {
  // Binary STL header: 80 bytes
  const header = new TextEncoder().encode('3D Poster Export'.padEnd(80, '\0'));

  // Number of triangles: 4 bytes (uint32 little-endian)
  const triangleCount = faces.length;
  const triangleCountBuffer = new Uint8Array(4);
  const triangleCountView = new DataView(triangleCountBuffer.buffer);
  triangleCountView.setUint32(0, triangleCount, true);

  // Calculate total size: 80 + 4 + (50 * triangleCount)
  const totalSize = 84 + triangleCount * 50;
  const result = new Uint8Array(totalSize);

  // Copy header
  result.set(header, 0);
  result.set(triangleCountBuffer, 80);

  // Write each triangle
  let offset = 84;
  for (const face of faces) {
    // Normal (3 floats x 4 bytes each = 12 bytes)
    writeFloat32(result, offset, face.normal.x);
    writeFloat32(result, offset + 4, face.normal.y);
    writeFloat32(result, offset + 8, face.normal.z);

    // Vertex 1 (12 bytes)
    writeFloat32(result, offset + 12, face.vertices[0].x);
    writeFloat32(result, offset + 16, face.vertices[0].y);
    writeFloat32(result, offset + 20, face.vertices[0].z);

    // Vertex 2 (12 bytes)
    writeFloat32(result, offset + 24, face.vertices[1].x);
    writeFloat32(result, offset + 28, face.vertices[1].y);
    writeFloat32(result, offset + 32, face.vertices[1].z);

    // Vertex 3 (12 bytes)
    writeFloat32(result, offset + 36, face.vertices[2].x);
    writeFloat32(result, offset + 40, face.vertices[2].y);
    writeFloat32(result, offset + 44, face.vertices[2].z);

    // Attribute byte count (2 bytes) - we don't use attributes, so 0
    writeUint16(result, offset + 48, 0);

    offset += 50;
  }

  return result;
}

/**
 * Write a 32-bit float to a Uint8Array at the specified offset
 * @param array - The Uint8Array to write to
 * @param offset - The byte offset to write at
 * @param value - The float value to write
 */
function writeFloat32(array: Uint8Array, offset: number, value: number): void {
  const view = new DataView(array.buffer, offset, 4);
  view.setFloat32(0, value, true);
}

/**
 * Write a 16-bit unsigned integer to a Uint8Array at the specified offset
 * @param array - The Uint8Array to write to
 * @param offset - The byte offset to write at
 * @param value - The uint16 value to write
 */
function writeUint16(array: Uint8Array, offset: number, value: number): void {
  const view = new DataView(array.buffer, offset, 2);
  view.setUint16(0, value, true);
}

/**
 * Export a Three.js object as STL file
 * @param object - Three.js object3D to export
 * @param options - Export options
 * @returns Blob containing STL file data
 */
export function exportToSTLBlob(object: THREE.Object3D, options: Partial<STLExportOptions> = {}): Blob {
  const mergedOptions: STLExportOptions = { ...DEFAULT_OPTIONS, ...options };
  const faces = objectToSTLFaces(object);

  if (faces.length === 0) {
    throw new Error('No faces found in the 3D object for STL export');
  }

  console.log(`Exporting ${faces.length} faces as STL`);

  if (mergedOptions.format === 'ascii') {
    const content = generateASCIISTL(faces, mergedOptions.fileName || '3d-poster');
    return new Blob([content], { type: 'application/vnd.ms-pki.stl' });
  } else {
    // Binary STL
    const binaryData = generateBinarySTL(faces);
    return new Blob([binaryData.buffer as ArrayBuffer], { type: 'application/vnd.ms-pki.stl' });
  }
}

/**
 * Download STL file to user's browser
 * @param object - Three.js object3D to export
 * @param options - Export options including fileName
 */
export function downloadSTL(object: THREE.Object3D, options: Partial<STLExportOptions> = {}): void {
  const mergedOptions: STLExportOptions = { ...DEFAULT_OPTIONS, ...options };
  const fileName = mergedOptions.fileName || '3d-poster';

  try {
    const blob = exportToSTLBlob(object, mergedOptions);
    
    // Create download link
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${fileName}.stl`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    // Cleanup URL object
    setTimeout(() => URL.revokeObjectURL(url), 100);
    
    console.log(`STL export successful: ${fileName}.stl (${(blob.size / 1024).toFixed(2)} KB)`);
  } catch (error) {
    console.error('Error exporting STL:', error);
    alert(`Error exporting STL: ${(error as Error).message}`);
  }
}

/**
 * Get STL export statistics
 * @param object - Three.js object3D to analyze
 * @returns Object with face count and mesh count
 */
export function getSTLStats(object: THREE.Object3D): { faceCount: number; meshCount: number } {
  let faceCount = 0;
  let meshCount = 0;

  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      meshCount++;
      const geometry = child.geometry;
      if (geometry instanceof THREE.BufferGeometry) {
        const index = geometry.index ? geometry.index.array : null;
        if (index) {
          faceCount += index.length / 3;
        } else {
          const position = geometry.getAttribute('position');
          if (position) {
            faceCount += position.count / 3;
          }
        }
      }
    }
  });

  return { faceCount, meshCount };
}

/**
 * Create a scaled clone of an object for export
 * Uses the stored SVG bounding box and scale factor to calculate proper scaling
 * @param object - Source object to clone
 * @param svgBoundingBox - Original SVG bounding box
 * @param svgScaleFactor - Scale factor used to convert SVG to 3D
 * @param targetWidthMM - Target width in millimeters
 * @param targetHeightMM - Target height in millimeters
 * @returns A new group with scaled geometry
 */
export function createScaledClone(
  object: THREE.Object3D,
  svgBoundingBox: { width: number; height: number },
  svgScaleFactor: number,
  targetWidthMM: number,
  targetHeightMM: number
): THREE.Group {
  // Calculate current dimensions in Three.js units
  // The 3D group has already been scaled by svgScaleFactor
  const currentWidth = svgBoundingBox.width * svgScaleFactor;
  const currentHeight = svgBoundingBox.height * svgScaleFactor;

  // Avoid division by zero
  if (currentWidth === 0 || currentHeight === 0) {
    console.warn('Cannot scale object with zero dimensions');
    return object.clone() as THREE.Group;
  }

  // Calculate scale factors to reach target dimensions
  // In the 3D scene, 1mm of height = 0.5 units, but for export we want 1mm = 1 unit
  // So we need to convert from Three.js units to mm
  const mmToThreeJsRatio = 0.5; // 1mm = 0.5 units in the current setup
  const threeJsToMM = 1 / mmToThreeJsRatio; // 2 units = 1mm
  
  // Current size in mm
  const currentWidthMM = currentWidth * threeJsToMM;
  const currentHeightMM = currentHeight * threeJsToMM;

  // Calculate scale factors
  const scaleX = targetWidthMM / currentWidthMM;
  const scaleY = targetHeightMM / currentHeightMM;
  const scaleZ = 1; // Keep Z scale at 1 (heights are relative)

  console.log(`Current 3D size: ${currentWidthMM.toFixed(2)}x${currentHeightMM.toFixed(2)}mm`);
  console.log(`Target size: ${targetWidthMM}x${targetHeightMM}mm`);
  console.log(`Scale factors: X=${scaleX.toFixed(4)}, Y=${scaleY.toFixed(4)}, Z=${scaleZ}`);

  // Clone the object and apply scaling
  const clone = object.clone();
  clone.scale.set(scaleX, scaleY, scaleZ);

  return clone as THREE.Group;
}
