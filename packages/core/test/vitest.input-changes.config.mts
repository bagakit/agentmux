import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve, relative, dirname } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const mutants: Record<string, [string, string, string]> = {
  'ignore-control-changes': ['agent-global-message-queue.ts',
    'WHERE i.recipient_id=? AND i.control_sequence>? AND i.control_sequence<=?',
    'WHERE i.recipient_id=? AND i.intent_sequence>? AND i.intent_sequence<=?']
}
export default defineConfig({ root, cacheDir: resolve(root, '.cache/input-changes', process.env.AGENTMUX_TEST_INPUT_CHANGES_MUTATION ?? 'positive'),
  plugins: [{ name: 'actual-input-changes-source', enforce: 'pre',
    resolveId(source, importer) {
      if (process.env.AGENTMUX_TEST_INPUT_CHANGES_COMPILED === '1') return
      if (source === '@agentmux/core') return resolve(root, 'packages/core/src/index.ts')
      if (source.startsWith('@agentmux/core/')) {
        const exports = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports
        const entry = exports['./' + source.slice('@agentmux/core/'.length)]?.import as string | undefined
        if (entry?.startsWith('./dist/')) return resolve(root, 'packages/core/src', entry.slice('./dist/'.length).replace(/\.js$/u, '.ts'))
      }
      if (!importer || !source.startsWith('.')) return
      const path = resolve(dirname(importer), source)
      const match = path.match(/\/packages\/(core|connectors)\/dist\/(.+)\.js$/u)
      if (match) return resolve(root, 'packages', match[1]!, 'src', match[2]! + '.ts')
    },
    transform(code, id) {
      const path = relative(root, id.split('?')[0]!)
      if (!path.startsWith('packages/core/src/') || !path.endsWith('.ts')) return
      const original = code, mutation = process.env.AGENTMUX_TEST_INPUT_CHANGES_MUTATION
      const change = mutation ? mutants[mutation] : undefined
      if (mutation && !change) throw new Error('Unknown input changes mutation')
      if (change && path === 'packages/core/src/' + change[0]) {
        if (code.split(change[1]).length !== 2) throw new Error('Input changes mutation anchor is not unique: ' + mutation)
        code = code.replace(change[1], change[2])
      }
      const sha = (text: string) => createHash('sha256').update(text).digest('hex')
      if (process.env.AGENTMUX_TEST_INPUT_CHANGES_LOADED) appendFileSync(process.env.AGENTMUX_TEST_INPUT_CHANGES_LOADED, JSON.stringify({ path, originalSHA256: sha(original), sha256: sha(code), ...(original !== code ? { mutation } : {}) }) + '\n')
      if (code !== original) return { code, map: null }
    }
  }], test: { environment: 'node', globalSetup: [], passWithNoTests: false, fileParallelism: false,
    include: ['packages/core/test/agent-input-changes.test.ts'], maxWorkers: 1, testTimeout: 100_000 } })
