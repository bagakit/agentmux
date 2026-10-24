import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../..')
const changes: Record<string, [string, string, string]> = {
  'reader-double-hash': ['conversation-reader.ts', 'conversationValuesEqual as same,', ''],
  'double-hash': ['conversation-changes.ts', 'return conversationValuesEqual(a, b)', 'return conversationRevision(a) === conversationRevision(b)'],
  'trust-equality': ['conversation-stream.ts', 'return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))', 'return true']
}
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/conversation-value-comparison', process.env.AGENTMUX_COMPARISON_MUTATION ?? 'candidate'),
  plugins: [{ name: 'conversation-comparison-loaded-source', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/core/src/') || !/\.ts$/u.test(path)) return
    const before = code, mutation = process.env.AGENTMUX_COMPARISON_MUTATION
    if (mutation) {
      const change = changes[mutation]
      if (!change) throw Error('Unknown conversation comparison mutation')
      if (path === 'packages/core/src/' + change[0]) {
        if (code.split(change[1]).length !== 2) throw Error('Missing unique conversation comparison mutation anchor')
        code = code.replace(change[1], change[2])
        if (mutation === 'reader-double-hash') code += '\nconst same = (a: unknown, b: unknown) => conversationRevision(a) === conversationRevision(b)\n'
      }
    }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_COMPARISON_LOADED) appendFileSync(process.env.AGENTMUX_COMPARISON_LOADED,
      JSON.stringify({ path, originalSHA256: sha(before), sha256: sha(code), ...(code === before ? {} : { mutation }) }) + '\n')
    if (code !== before) return { code, map: null }
  } }],
  test: { ...original.test, globalSetup: [], setupFiles: [], include: ['packages/core/test/conversation-value-comparison.test.ts'],
    passWithNoTests: false, fileParallelism: false, testTimeout: 15000 }
})
