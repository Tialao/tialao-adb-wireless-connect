// Bundle de l'extension.
//
// Point critique : `tialao-adb-wireless` (le coeur) N'EST PAS declare en `external`.
// esbuild le suit donc jusqu'a packages/core/dist/index.js et l'inline, avec `qrcode`.
// Le .vsix ne contient au final qu'un seul fichier JS et ne depend d'aucun node_modules
// — c'est ce qui evite les deboires de vsce avec les dependances liees d'un monorepo.
import esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  // L'hote d'extension fait un require() sur `main` : la sortie doit etre du CommonJS.
  format: 'cjs',
  platform: 'node',
  // VS Code 1.85 embarque Node 18 : ne pas viser plus haut.
  target: 'node18',
  // `vscode` est fourni par l'hote et n'existe pas sur le disque.
  external: ['vscode'],
  minify: production,
  sourcemap: production ? false : 'linked',
  sourcesContent: false,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[esbuild] surveillance active');
} else {
  const result = await esbuild.build({ ...options, metafile: true });
  const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
  console.log(`[esbuild] dist/extension.js — ${(bytes / 1024).toFixed(1)} Ko`);
}
