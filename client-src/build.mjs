/**
 * 打包客户端 bundle 到 `lib/client.js`。
 *
 * 产物形态必须与 DSH 的客户端模块加载器契约一致：
 *
 * ```js
 * window.__ModuleLoader__.load({ id, factory: (require) => { ...; return module.exports } })
 * ```
 *
 * `id` 必须是**包名**（`dsh-session-archive`）—— 加载器按包名索引，
 * 用条目 id 或文件路径会让模块永远解析不到。
 *
 * `react` / `react-dom` 保持 external：它们由宿主 shell 提供单例，
 * 打进来会产生第二个 React 实例，hooks 直接报错（真实缺陷，非理论风险）。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'

const sourceDirectory = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(sourceDirectory, '..')
const outputPath = resolve(packageRoot, 'lib/client.js')
const pkg = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'))

const result = await build({
  entryPoints: [resolve(sourceDirectory, 'index.js')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome100'],
  // 默认 charset 'ascii' 会把中文转义成 \uXXXX：产物可读性差，
  // 且让「用 includes 校验产物文案」的测试天然失效。
  charset: 'utf8',
  external: ['react', 'react-dom'],
  write: false,
  minify: process.env.NODE_ENV === 'production',
  legalComments: 'none',
})

const bundled = result.outputFiles?.[0]?.text
if (!bundled) throw new Error('esbuild did not produce a client bundle')

const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${bundled}
    return module.exports;
  }
});
`
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, wrapped, 'utf8')
console.log(`Wrote ${outputPath}`)
