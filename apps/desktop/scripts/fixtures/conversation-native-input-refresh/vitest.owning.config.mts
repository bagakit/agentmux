import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
const root = resolve(import.meta.dirname, '../../../../..')
const hook = 'apps/desktop/src/renderer/src/lib/session-user-messages.ts'
const changes: Record<string, [string, string]> = {
  'filter-native-users': ['historyPage: entry?.historyPage ?? undefined,', 'historyPage: entry?.historyPage ? { ...entry.historyPage, items: entry.historyPage.items.filter(item => item.kind !== "user-message") } : undefined,'],
  'freeze-auto-page': ['entry.historyPage = { ...page, items, nextCursor }', 'if (mode !== "revalidate") entry.historyPage = { ...page, items, nextCursor }'],
  'dedupe-by-body': ['...incoming.slice(index + 1).filter(item => !existing.has(item.id))', '...incoming.slice(index + 1).filter(item => !existing.has(item.id) && !entry.items.some(old => JSON.stringify(old.contentParts) === JSON.stringify(item.contentParts)))'],
  'swallow-unknown-time': ['historyPage: entry?.historyPage ?? undefined,', 'historyPage: entry?.historyPage ? { ...entry.historyPage, items: entry.historyPage.items.filter(item => item.startedAt !== undefined) } : undefined,']
}
export default defineConfig({ ...original, root,
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  plugins: [...(original.plugins ?? []), {
    name: 'native-refresh-actual-loaded', enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]!
      if (!file.startsWith(root + '/apps/desktop/src/') || !/\.[cm]?[jt]sx?$/u.test(file)) return
      const originalCode = code, mutation = process.env.AGENTMUX_NATIVE_REFRESH_MUTATION
      if (mutation && relative(root, file) === hook) {
        const change = changes[mutation]
        if (!change || code.split(change[0]).length !== 2) throw new Error('Missing unique native refresh mutation ' + mutation)
        code = code.replace(change[0], change[1])
      }
      const log = process.env.AGENTMUX_NATIVE_REFRESH_LOADED
      const hash = (text: string) => createHash('sha256').update(text).digest('hex')
      if (log) appendFileSync(log, JSON.stringify({ path: relative(root, file), originalSHA256: hash(originalCode), sha256: hash(code), bytes: Buffer.byteLength(code), ...(code !== originalCode ? { mutation } : {}) }) + '\n')
      if (code !== originalCode) return { code, map: null }
    }
  }],
  test: { ...original.test, include: ['apps/desktop/test/conversation-native-input-refresh.integration.test.tsx', 'apps/desktop/test/session-history-observation-owners.test.ts'], passWithNoTests: false, fileParallelism: false }
})
