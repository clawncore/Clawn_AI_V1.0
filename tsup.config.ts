// @ts-ignore
import { cpSync } from 'fs';

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
    cpSync('src/utils/translations', 'dist/translations', { recursive: true });
    cpSync('views', 'dist/views', { recursive: true });
    cpSync('public', 'dist/public', { recursive: true });
  },
  loader: {
    '.json': 'file',
    '.yml': 'file',
  },
});
