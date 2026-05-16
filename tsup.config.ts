// @ts-ignore
import { cpSync, existsSync } from 'fs';

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src'],
  outDir: 'dist',
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: true,
  format: ['cjs'],
  onSuccess: async () => {
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
