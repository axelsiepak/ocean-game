import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true, // expose on the LAN so you can test from a phone/tablet
    port: 5173,
    open: false,
  },
  // Relative asset paths, so a build works from any subdirectory — a project
  // page on GitHub Pages, a preview URL, or opened straight off disk.
  base: './',
  build: {
    target: 'es2020',
    outDir: 'dist',
    sourcemap: true,
    // One chunk keeps deployment to two files, and makes the single-file
    // inlining step below trivial.
    rolldownOptions: { output: { codeSplitting: false } },
  },
});
