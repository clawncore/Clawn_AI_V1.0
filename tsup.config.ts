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
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
`,
  },
  noExternal: [
    (id) => {
      const externals = [
        '@ffmpeg-installer/ffmpeg',
        'fluent-ffmpeg',
        '@ffmpeg-installer/linux-x64',
        '@ffmpeg-installer/darwin-x64',
        '@ffmpeg-installer/win32-x64',
        '@prisma/client',
        'sharp',
      ];
      return !externals.some((ext) => id === ext || id.startsWith(`${ext}/`));
    },
  ],
  external: [
    '@prisma/client',
    '@ffmpeg-installer/ffmpeg',
    'fluent-ffmpeg',
    '@ffmpeg-installer/linux-x64',
    '@ffmpeg-installer/darwin-x64',
    '@ffmpeg-installer/win32-x64',
    'sharp',
  ],
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
});
