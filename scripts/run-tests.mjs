import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

// node --test 对目录参数与通配符的处理在 Node 20 与 22 之间不一致，显式列出文件才能保证两边跑的是同一批测试。
const files = readdirSync('dist/test')
  .filter((name) => name.endsWith('.test.cjs'))
  .map((name) => `dist/test/${name}`);
if (!files.length) {
  console.error('dist/test 下没有测试产物，请先执行 node esbuild.test.mjs。');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
