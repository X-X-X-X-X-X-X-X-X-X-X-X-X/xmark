import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

try {
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'src/index.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    outfile: path.join(__dirname, 'dist/index.js'),
    banner: {
      js: '#!/usr/bin/env node\n'
    },
    sourcemap: true,
    logLevel: 'info'
  });
  console.log('[xmark-mcp] Build succeeded -> packages/xmark-mcp/dist/index.js');
} catch (err) {
  console.error('[xmark-mcp] Build failed:', err);
  process.exit(1);
}
