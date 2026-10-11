import base from './vitest.conversation-unified-consumers.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const hook = 'packages/client-ui/src/lib/use-conversation-view.ts'
const window = 'apps/desktop/src/renderer/src/lib/session-conversation-window.ts'
const edits: Record<string, [string, string, string]> = {
  'hide-source-failure': [hook, 'const sourceError = sourceReadError(complete)', 'const sourceError = null'],
  'replace-retry-window': [window, 'retry: () => { void view.retry() }', 'retry: () => { void view.refresh() }'],
  'clear-pending-failure': [hook, "setState(value => ({ ...value, loading: true, error: null }))", "setState(value => ({ ...value, loading: true, error: null, sourceError: null }))"],
  'retry-unsupported-capability': [hook, "source.current === 'unavailable'", "source.current === 'unavailable' || source.current === 'unsupported'"]
}
export default defineConfig({ ...base, cacheDir: '.cache/conversation-source-retry',
  plugins: [...base.plugins ?? [], { name: 'source-read-retry-loaded-proof', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (![hook, window].includes(path)) return
    const mutation = process.env.AGENTMUX_SOURCE_RETRY_MUTATION
    let code = source
    if (mutation) {
      const edit = edits[mutation]
      if (!edit) throw Error('Unknown source retry mutation')
      if (path === edit[0]) {
        if (source.split(edit[1]).length !== 2) throw Error('Missing unique source retry mutation target')
        code = source.replace(edit[1], edit[2])
      }
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_SOURCE_RETRY_LOADED) appendFileSync(process.env.AGENTMUX_SOURCE_RETRY_LOADED,
      JSON.stringify({ path, originalSHA256: hash(source), sha256: hash(code), bytes: Buffer.byteLength(code), ...(code !== source ? { mutation } : {}) }) + '\n')
    return source === code ? undefined : { code, map: null }
  } }], test: { ...base.test, include: ['apps/desktop/test/conversation-source-retry.test.tsx'], passWithNoTests: false, fileParallelism: false, testTimeout: 15000 }
})
