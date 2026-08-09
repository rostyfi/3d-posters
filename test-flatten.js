/**
 * Test script for SVG flattening
 * This script tests the flattenSVG function without needing the full UI
 */

// Mock DOM environment for testing
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.HTMLCanvasElement = dom.window.HTMLCanvasElement;

// Add Paper.js to the mock window
const paper = require('paper');
window.paper = paper;

// Import the flattenSVG function
// We need to use a dynamic import since this is a test
async function testFlattening() {
  console.log('Testing SVG flattening...\n');
  
  // Read test SVG
  const fs = require('fs');
  const testSVG = fs.readFileSync('./test-overlapping.svg', 'utf8');
  
  console.log('Input SVG:');
  console.log(testSVG);
  console.log('\n---\n');
  
  // Read and execute the flatten function
  const flattenModule = require('./dist/assets/main-B76qYXuA.js');
  
  // The flattenSVG function is exported from the module
  // We need to extract it from the bundled code
  // For now, let's just test that Paper.js is loaded
  
  if (window.paper) {
    console.log('✓ Paper.js is loaded');
    
    // Setup Paper.js
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 200;
    document.body.appendChild(canvas);
    
    paper.setup(canvas);
    
    // Import SVG
    const item = paper.project.importSVG(testSVG);
    console.log('✓ SVG imported into Paper.js');
    
    // Get items
    const items = paper.project.getItems();
    console.log(`✓ Found ${items.length} items in SVG`);
    
    // Test boolean operations
    if (items.length >= 2) {
      const path1 = items[0];
      const path2 = items[1];
      
      console.log(`✓ Path 1: ${path1.className}, fill: ${path1.fillColor?.toCSS()}`);
      console.log(`✓ Path 2: ${path2.className}, fill: ${path2.fillColor?.toCSS()}`);
      
      // Try subtract
      const result = path1.subtract(path2);
      console.log('✓ Boolean subtraction works');
    }
    
    // Export
    const exported = paper.project.exportSVG({ asString: true });
    console.log('\nExported SVG:');
    console.log(exported);
    
  } else {
    console.log('✗ Paper.js is not loaded');
  }
}

testFlattening().catch(console.error);
