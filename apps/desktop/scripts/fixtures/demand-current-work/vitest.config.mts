import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import original from '../demand-supervisor/vitest.config.mts'
const repository = resolve(import.meta.dirname, '../../../../..')
export default { ...original, plugins: [...(original.plugins ?? []), { name: 'current-demand-private-listener-asset', enforce: 'pre', transform(code: string, id: string) {
  if (id.split('?')[0] !== resolve(repository, 'packages/core/src/control-endpoint-publication.ts')) return
  const anchor = "const worker = join(dirname(packagePath), 'dist/control-endpoint-listener-worker.js')"
  if (code.split(anchor).length !== 2) throw new Error('The original Core listener asset owner must be loaded exactly once')
  const changed = code.replace(anchor, "const worker = process.env.AGENTMUX_PRIVATE_LISTENER_ASSET ?? join(dirname(packagePath), 'dist/control-endpoint-listener-worker.js')")
  if (process.env.AGENTMUX_DAILY_GOAL_PROOF) appendFileSync(process.env.AGENTMUX_DAILY_GOAL_PROOF, JSON.stringify({ file: 'packages/core/src/control-endpoint-publication.ts', consumer: 'actual-fixture-listener-asset', boundary: 'Only locate the private exact Source worker; original Core publication and semantic owner unchanged.', beforeSha256: createHash('sha256').update(code).digest('hex'), afterSha256: createHash('sha256').update(changed).digest('hex') }) + '\n')
  return changed
} }], resolve: { ...original.resolve, alias: [
  { find: /^@viz-js\/viz$/, replacement: resolve(repository, 'node_modules/.pnpm/@viz-js+viz@3.31.0/node_modules/@viz-js/viz/dist/viz.js') },
  { find: /^highlight\.js\/(.*)$/, replacement: resolve(repository, 'node_modules/.pnpm/highlight.js@11.12.0/node_modules/highlight.js') + '/$1' },
  { find: /^katex\/(.*)$/, replacement: resolve(repository, 'node_modules/.pnpm/katex@0.19.0/node_modules/katex') + '/$1' },
  { find: /^katex$/, replacement: resolve(repository, 'node_modules/.pnpm/katex@0.19.0/node_modules/katex/dist/katex.mjs') },
  { find: /^remark-math$/, replacement: resolve(repository, 'node_modules/.pnpm/remark-math@6.0.0/node_modules/remark-math/index.js') },
  ...(original.resolve?.alias as Array<{ find: RegExp; replacement: string }> ?? [])
] }, test: { ...original.test, include: ['test/demand-current-work.test.tsx', 'test/demand-current-work-product.test.tsx'], maxWorkers: 1, passWithNoTests: false } }
