import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const contexts = await Promise.all([
  esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    mainFields: ['module', 'main'],
    target: 'node20',
    sourcemap: true,
    logLevel: 'info'
  }),
  // 侧边栏 Webview 的脚本运行在浏览器环境，单独打包；消息类型只以 import type 引入，不会把扩展侧代码带进来。
  esbuild.context({
    entryPoints: ['src/webview/sidebar.ts'],
    bundle: true,
    outfile: 'dist/webview/sidebar.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    logLevel: 'info'
  }),
]);

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
