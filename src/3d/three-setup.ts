/**
 * Three.js scene setup and management
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader';
import { BoundingBox } from '../types';

// Export SVGLoader for use in other modules
export { SVGLoader };

/**
 * Application Three.js state
 */
export interface ThreeState {
  scene: THREE.Scene | null;
  camera: THREE.Camera | null;
  renderer: THREE.WebGLRenderer | null;
  controls: OrbitControls | null;
}

/**
 * Initialize Three.js scene
 * @param container - DOM container element for the renderer
 * @returns Three.js state object
 */
export function initThreeJS(container: HTMLElement): ThreeState {
  // Create scene
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf0f0f0);

  // Show the container and force layout update before getting dimensions
  container.style.display = 'block';
  // Force reflow to ensure dimensions are calculated
  container.offsetHeight;
  const containerWidth = container.clientWidth;
  const containerHeight = container.clientHeight - 40; // Subtract header height

  // Create orthographic camera for precise viewport alignment
  // Will be updated in positionCameraForScene with actual scene dimensions
  const camera = new THREE.OrthographicCamera(
    -containerWidth / 2,
    containerWidth / 2,
    containerHeight / 2,
    -containerHeight / 2,
    0.1,
    1000
  );
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);

  // Create renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(containerWidth, containerHeight);
  renderer.setClearColor(0xf0f0f0);
  container.appendChild(renderer.domElement);

  // Add lights
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambientLight);
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
  directionalLight.position.set(1, 1, 1);
  scene.add(directionalLight);

  // Add orbit controls for better viewing
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;

  // Handle window resize
  window.addEventListener('resize', () => {
    const width = container.clientWidth;
    const height = container.clientHeight - 40;
    camera.left = -width / 2;
    camera.right = width / 2;
    camera.top = height / 2;
    camera.bottom = -height / 2;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  });

  // Start animation loop
  function animate(): void {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  return { scene, camera, renderer, controls };
}

/**
 * Clear the Three.js scene
 * @param state - Three.js state object
 */
export function clearThreeJSScene(state: ThreeState): void {
  if (state.scene) {
    while (state.scene.children.length > 0) {
      state.scene.remove(state.scene.children[0]);
    }
  }
}

/**
 * Add default lights to the scene
 * @param scene - Three.js scene
 */
export function addDefaultLights(scene: THREE.Scene): void {
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambientLight);
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
  directionalLight.position.set(1, 1, 1);
  scene.add(directionalLight);
}

/**
 * Calculate bounding box from SVG paths
 * @param paths - Array of SVG paths from THREE.SVGLoader
 * @returns Bounding box object
 */
export function calculateBoundingBox(paths: any[]): BoundingBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const path of paths) {
    for (const subPath of path.subPaths) {
      for (const point of subPath.getPoints()) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      }
    }
  }

  const width = maxX - minX;
  const height = maxY - minY;

  return {
    minX,
    minY,
    maxX,
    maxY,
    width,
    height,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  };
}

/**
 * Position camera to fit the scene
 * @param camera - Three.js camera (should be OrthographicCamera)
 * @param boundingBox - Scene bounding box
 * @param scaleFactor - Scale factor applied to the scene
 */
export function positionCameraForScene(
  camera: THREE.Camera,
  boundingBox: BoundingBox,
  scaleFactor: number
): void {
  const sceneWidth = boundingBox.width * scaleFactor;
  const sceneHeight = boundingBox.height * scaleFactor;

  // The group is positioned so that SVG (minX, minY) is at world (0, 0)
  // With group.scale.y = -1:
  //   - SVG (minX, minY) -> world (0, 0)
  //   - SVG (maxX, maxY) -> world (sceneWidth, -sceneHeight)
  // The scene extends from (0, -sceneHeight) to (sceneWidth, 0) in world space
  
  if (camera instanceof THREE.OrthographicCamera) {
    // For orthographic camera, set frustum to match scene dimensions
    // We want world (0, 0) at top-left of viewport and (sceneWidth, -sceneHeight) at bottom-right
    // In orthographic camera, left/right/top/bottom define the frustum planes
    // To have (0, 0) at top-left and (sceneWidth, -sceneHeight) at bottom-right:
    //   left = 0, right = sceneWidth
    //   top = 0, bottom = -sceneHeight
    camera.left = 0;
    camera.right = sceneWidth;
    camera.top = 0;
    camera.bottom = -sceneHeight;
    camera.updateProjectionMatrix();

    // Position camera along Z-axis to look at the scene
    // With orthographic camera, we need some distance for depth testing
    const cameraZ = Math.max(sceneWidth, sceneHeight) * 2;
    camera.position.set(
      sceneWidth / 2,
      -sceneHeight / 2,
      cameraZ
    );
    camera.lookAt(
      sceneWidth / 2,
      -sceneHeight / 2,
      0
    );
  } else {
    // Fallback for perspective camera
    const halfDiagonal = Math.sqrt(sceneWidth * sceneWidth + sceneHeight * sceneHeight) / 2;
    const cameraDistance = Math.max(10, halfDiagonal / Math.tan(THREE.MathUtils.degToRad(75) / 2));

    const centerX = sceneWidth / 2;
    const centerY = -sceneHeight / 2;

    (camera as THREE.PerspectiveCamera).position.set(
      centerX,
      centerY,
      cameraDistance
    );
    (camera as THREE.PerspectiveCamera).lookAt(
      centerX,
      centerY,
      0
    );
  }
}
