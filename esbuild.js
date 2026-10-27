const esbuild = require('esbuild');

const isWatch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const buildConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  minify: false
};

async function main() {
  if (isWatch) {
    const ctx = await esbuild.context(buildConfig);
    await ctx.watch();
    console.log(`[watch] Watching ${buildConfig.entryPoints[0]}...`);
  } else {
    await esbuild.build(buildConfig);
    console.log(`[build] Finished ${buildConfig.entryPoints[0]} -> ${buildConfig.outfile}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
