import { readdir, rm } from 'node:fs/promises';
import esbuild from 'esbuild';

// 每个被测模块一个测试文件，各自打包成独立产物；先清空输出目录，避免改名或删除后的旧产物继续被执行。
await rm('dist/test', { recursive: true, force: true });
const entryPoints = (await readdir('test'))
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => `test/${name}`);

await esbuild.build({
  entryPoints,
  bundle: true,
  outdir: 'dist/test',
  outExtension: { '.js': '.cjs' },
  alias: { vscode: './test/vscode-stub.ts' },
  format: 'cjs',
  platform: 'node',
  mainFields: ['module', 'main'],
  target: 'node20',
  sourcemap: true,
  logLevel: 'info'
});
