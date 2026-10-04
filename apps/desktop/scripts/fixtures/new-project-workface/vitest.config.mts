import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import assert from 'node:assert/strict'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../../../..')
const manifest = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8'))
const aliases = Object.entries(manifest.exports).map(([key, value]: [string, any]) => ({
  find: new RegExp('^' + (key === '.' ? '@agentmux/core' : '@agentmux/core/' + key.slice(2)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
  replacement: resolve(root, 'packages/core', value.import.replace('./dist/', './src/').replace(/\.js$/, '.ts'))
}))
aliases.push({ find: /^@agentmux\/layout$/, replacement: resolve(root, 'packages/core/src/spatial-layout.ts') })
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases },
  plugins: [{ name: 'new-project-owning-source', enforce: 'pre',
    resolveId(id) { if (/^(\.\.\/)+shared\/zone-file-resource(?:\.js)?$/.test(id)) return '\0unused-zone-file-resource' },
    load(id) { if (id === '\0unused-zone-file-resource') return 'export function zoneFileResource() { throw new Error("Unrelated missing file-resource leaf was invoked in the projection proof") }' },
    transform(source, id) {
      const path = id.split('?')[0]!
      if (!path.startsWith(root + '/apps/desktop/src/')) return
      let code = source
      if (process.env.AGENTMUX_WORKFACE_MUTATION_PATH) {
        const item = JSON.parse(readFileSync(process.env.AGENTMUX_WORKFACE_MUTATION_PATH, 'utf8'))
        if (path === resolve(root, item.file)) { assert.equal(source.split(item.before).length - 1, 1, 'Unique loaded mutation'); code = source.replace(item.before, item.after) }
      }
      if (process.env.AGENTMUX_WORKFACE_LOADED_PATH) appendFileSync(process.env.AGENTMUX_WORKFACE_LOADED_PATH,
        JSON.stringify({ path: relative(root, path), sourceSHA256: digest(source), loadedSHA256: digest(code), mutated: code !== source }) + '\n')
      if (code !== source) return { code, map: null }
    }
  }],
  test: { include: ['apps/desktop/test/new-project-workface.test.tsx'], setupFiles: [resolve(root, 'vitest.setup.ts')],
    passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 10000 }
})
