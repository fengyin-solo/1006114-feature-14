// 用 esbuild 把自测 bundle 成一个 ESM 文件再用 node 跑：
// 复用 vite 的 @ 路径别名，不引入 jest/vitest 之类的框架。
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))
const outfile = path.join(root, '.ledger.test.bundle.mjs')

await build({
  entryPoints: [path.join(root, 'ledger.test.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  logLevel: 'warning',
  alias: {
    '@': path.join(root, '..', 'src'),
  },
})

process.on('exit', () => {
  // bundle 是临时产物，跑完即弃
})

await import(outfile)
