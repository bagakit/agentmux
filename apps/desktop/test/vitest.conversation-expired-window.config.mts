import base from './vitest.conversation-unified-consumers.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..'), hook = 'packages/client-ui/src/lib/use-conversation-view.ts'
const edits: Record<string, [string, string]> = {
  'disable-current-reopen': ["if (reopenExpired) void read('reopen')", "if (false && reopenExpired) void read('reopen')"],
  'forget-original-scope': ['complete.scope.sources.some(source => !prior.scope.sources.some(original => conversationSourceKey(source) === conversationSourceKey(original)))', 'false'],
  'discard-readable-source': ["if (kind === 'reopen') {\n            const failure = sourceReadError(complete)\n            if (failure) throw failure\n          }", '']
}
export default defineConfig({ ...base, cacheDir: '.cache/conversation-expired-window',
  plugins: [...base.plugins ?? [], { name: 'expired-window-source-proof', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (![hook, 'packages/core/src/conversation-reader.ts'].includes(path)) return
    const mutation = process.env.AGENTMUX_EXPIRED_WINDOW_MUTATION
    let code = source
    if (mutation && path === hook) {
      const edit = edits[mutation]
      if (!edit || source.split(edit[0]).length !== 2) throw Error('Missing unique expired-window mutation target: ' + mutation)
      code = source.replace(...edit)
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_EXPIRED_WINDOW_LOADED) appendFileSync(process.env.AGENTMUX_EXPIRED_WINDOW_LOADED,
      JSON.stringify({ path, originalSHA256: hash(source), sha256: hash(code), bytes: Buffer.byteLength(code), ...(source === code ? {} : { mutation }) }) + '\n')
    return source === code ? undefined : { code, map: null }
  } }], test: { ...base.test, include: ['apps/desktop/test/conversation-expired-window.test.tsx'], passWithNoTests: false, fileParallelism: false, testTimeout: 15000 }
})
