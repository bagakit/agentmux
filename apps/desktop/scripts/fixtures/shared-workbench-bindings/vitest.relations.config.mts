import { defineConfig } from 'vitest/config'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '../../../../..')
const core = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8'))
const alias = Object.entries(core.exports).map(([key, value]) => ({
  find: key === '.' ? '@agentmux/core' : `@agentmux/core/${key.slice(2)}`,
  replacement: resolve(root, 'packages/core', (value as { import: string }).import.replace('./dist/', './src/').replace(/\.js$/, '.ts'))
})).sort((a, b) => b.find.length - a.find.length)
alias.push({ find: '@agentmux/layout', replacement: resolve(root, 'packages/layout/src/index.ts') })
const mutation = process.env.AGENTMUX_BINDING_MUTATION_PATH
  ? JSON.parse(readFileSync(process.env.AGENTMUX_BINDING_MUTATION_PATH, 'utf8')) : null
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias },
  plugins: mutation ? [{ name: 'loaded-owning-binding-mutation', enforce: 'pre', transform(source, id) {
    if (id.split('?')[0] !== resolve(root, mutation.file)) return
    if (source.split(mutation.before).length !== 2) throw new Error(`Mutation anchor is not unique: ${mutation.label}`)
    const code = source.replace(mutation.before, mutation.after)
    writeFileSync(mutation.loaded, JSON.stringify({ file: mutation.file, source: createHash('sha256').update(source).digest('hex'),
      loaded: createHash('sha256').update(code).digest('hex') }))
    return { code, map: null }
  } }] : [],
  test: { include: ['apps/desktop/test/shared-workbench-bindings.test.ts', 'apps/desktop/test/space-agent-control.test.ts'],
    exclude: [], environment: 'happy-dom', maxWorkers: 1 }
})
