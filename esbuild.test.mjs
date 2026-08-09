import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['test/unit.test.ts'],
  bundle: true,
  outfile: 'dist/test.cjs',
  alias: { vscode: './test/vscode-stub.ts' },
  format: 'cjs',
  platform: 'node',
  mainFields: ['module', 'main'],
  target: 'node20',
  sourcemap: true,
  logLevel: 'info'
});
