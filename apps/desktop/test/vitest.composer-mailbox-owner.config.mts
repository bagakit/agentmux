import base from './vitest.conversation-unified-consumers.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../..')
const changes = {
  'second-native-owner': ['apps/desktop/src/renderer/src/components/SessionMailbox.tsx', '!inputHistory && open && visible', 'open && visible'],
  'foreign-notice-owner': ['apps/desktop/src/renderer/src/components/SessionMailbox.tsx', 'inputHistory?.nativeReading ?? {', 'undefined ?? {'],
  'hide-owner-freeze': ['apps/desktop/src/renderer/src/lib/use-composer-input-history.tsx', 'windowFrozen: native.windowFrozen', 'windowFrozen: false'],
  'hide-owner-read-error': ['apps/desktop/src/renderer/src/lib/use-composer-input-history.tsx', 'error: native.error', 'error: null'],
  'skip-native-refresh': ['apps/desktop/src/renderer/src/lib/use-composer-input-history.tsx', 'return native.refresh()', 'return Promise.resolve()'],
  'skip-query-refresh': ['apps/desktop/src/renderer/src/lib/use-composer-input-history.tsx', '    history.refresh()', '    void 0']
} as const
export default defineConfig({ ...base, cacheDir: '.cache/composer-mailbox-owner', plugins: [...base.plugins ?? [], {
  name: 'composer-mailbox-owner-proof', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!Object.values(changes).some(change => change[0] === path)) return
    const mutation = process.env.AGENTMUX_MAILBOX_OWNER_MUTATION as keyof typeof changes | undefined
    let code = source
    if (mutation) {
      const change = changes[mutation]
      if (!change) throw Error('Unknown Mailbox reader owner mutation')
      if (path === change[0]) {
        if (source.split(change[1]).length !== 2) throw Error('Mailbox owner mutation anchor must be unique')
        code = source.replace(change[1], change[2])
      }
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_MAILBOX_OWNER_LOADED) appendFileSync(process.env.AGENTMUX_MAILBOX_OWNER_LOADED,
      JSON.stringify({ path, originalSHA256: hash(source), sha256: hash(code), bytes: Buffer.byteLength(code), ...(code === source ? {} : { mutation }) }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/composer-mailbox-reading-owner.test.tsx'], exclude: [], passWithNoTests: false, maxWorkers: 1, fileParallelism: false } })
