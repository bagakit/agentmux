import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative, isAbsolute, dirname } from 'node:path'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { defineConfig } from 'vitest/config'
import { candidateAlias, candidateModule } from '../../candidate-package-resolve.mjs'
import { radixOverlayAliases } from '../../radix-overlay-aliases.ts'
import { noteParsingAliases } from '../../../../../packages/client-ui/scripts/note-parsing-aliases.ts'
const root = resolve(import.meta.dirname, '../../../../..')
const desktop = createRequire(resolve(root, 'apps/desktop/package.json'))
const aliases = [...['react', 'react-dom'].map(find => ({ find, replacement: dirname(desktop.resolve(find + '/package.json')) })),
  ...Object.entries({ ...radixOverlayAliases, ...noteParsingAliases }).map(([find, replacement]) => ({ find, replacement })), candidateAlias(root, { browser: true, source: true })]
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases, conditions: ['browser'], dedupe: ['react', 'react-dom'] },
  plugins: [{ name: 'native-session-owning-source', enforce: 'pre',
    transform(source, id) {
      const file = id.split('?')[0]!
      if (!isAbsolute(file)) return
      const path = candidateModule(root, file), name = relative(root, path)
      if (!/^(?:apps|packages)\//.test(name) || name.includes('/node_modules/')) return
      let code = source
      if (process.env.AGENTMUX_NATIVE_UI_MUTATION_PATH) {
        const item = JSON.parse(readFileSync(process.env.AGENTMUX_NATIVE_UI_MUTATION_PATH, 'utf8'))
        if (path === resolve(root, item.file)) { assert.equal(source.split(item.before).length - 1, 1, 'Unique loaded mutation'); code = source.replace(item.before, item.after) }
      }
      if (process.env.AGENTMUX_NATIVE_UI_LOADED_PATH) appendFileSync(process.env.AGENTMUX_NATIVE_UI_LOADED_PATH,
        JSON.stringify({ path: relative(root, path), sourceSHA256: digest(source), loadedSHA256: digest(code), mutated: code !== source }) + '\n')
      if (code !== source) return { code, map: null }
    }
  }],
  test: { include: ['apps/desktop/test/native-session-change.test.tsx', 'apps/desktop/test/native-source-themed-action.test.tsx'], setupFiles: [resolve(root, 'vitest.setup.ts')],
    passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 10000 }
})
