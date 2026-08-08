import { defineConfig } from 'vite';
import path from 'path';
import { readFileSync, writeFileSync } from 'fs';

export default defineConfig({
  root: '.',
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: './index.html',
      },
      output: {
        // Output as IIFE (Immediately Invoked Function Expression) 
        // This makes it work without requiring ES module support
        format: 'iife',
        // Bundle all dependencies into a single file
        manualChunks: undefined,
        // Don't split into chunks
        inlineDynamicImports: true,
      },
    },
  },
  plugins: [
    {
      name: 'fix-file-protocol',
      closeBundle() {
        // After build, modify the index.html to use regular script instead of module
        // This allows the app to work with file:// protocol
        const indexPath = path.join(__dirname, 'dist', 'index.html');
        let html = readFileSync(indexPath, 'utf-8');
        
        // Replace type="module" with regular script
        html = html.replace(
          '<script type="module" crossorigin src="./assets/main',
          '<script src="./assets/main'
        );
        
        // Also replace any other module script tags
        html = html.replace(
          '<script type="module" crossorigin src="assets/main',
          '<script src="assets/main'
        );
        
        // Remove any remaining crossorigin attributes
        html = html.replace(/ crossorigin/g, '');
        
        writeFileSync(indexPath, html);
      }
    }
  ]
});
