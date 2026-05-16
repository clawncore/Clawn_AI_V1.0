// @ts-ignore
import { cpSync, existsSync, writeFileSync } from 'fs';

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  outDir: 'dist',
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: true,
  format: ['esm'],
  outExtension() {
    return {
      js: '.mjs',
    };
  },
  banner: {
    js: `
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
`,
  },
  noExternal: ['@figuro/chatwoot-sdk'],
  onSuccess: async () => {
    // Create a redirector file for Render dashboard compatibility
    writeFileSync('dist/main.js', 'import("./main.mjs");');

    if (existsSync('src/utils/translations')) {
      cpSync('src/utils/translations', 'dist/translations', { recursive: true });
    }
    if (existsSync('views')) {
      cpSync('views', 'dist/views', { recursive: true });
    }
    if (existsSync('public')) {
      cpSync('public', 'dist/public', { recursive: true });
    }
  },
  loader: {
    '.json': 'file',
    '.yml': 'file',
  },
});
