import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({
  ...original,
  root,
  plugins: [...(original.plugins ?? []), {
    name: 'session-history-entry-loaded-source',
    enforce: 'pre',
    transform(code, id) {
      const destination = process.env.AGENTMUX_ENTRY_LOADED_SOURCE
      const file = id.split('?')[0]!
      if (!file.startsWith(`${root}/apps/desktop/src/renderer/src/`) || !/\.[cm]?[jt]sx?$/u.test(file)) return
      const originalCode = code
      const mutation = process.env.AGENTMUX_ENTRY_MUTATION
      if (mutation && file === `${root}/apps/desktop/src/renderer/src/components/SessionPane.tsx`) {
        const changes: Record<string, [string, string]> = {
          'activity-hidden': ['visible={visible && (historyOpen || inlineHistory)}', 'visible={visible && (historyOpen || inlineHistory) && (viewMode === \'terminal\' || inlineHistory)}'],
          'wrong-return': ['setHistoryOpen(false)\n    if (linkOrigin.tabId', "setHistoryOpen(false)\n    useAppStore.getState().setViewMode(sessionId, 'terminal')\n    if (linkOrigin.tabId"],
          'skip-return-focus': ['target.focus()', 'void target'],
          'covered-activity-focus': ['inert={historyOpen}', 'inert={false}']
        }
        const change = changes[mutation]
        if (!change || originalCode.split(change[0]).length !== 2) throw new Error(`Invalid or missing exact entry mutation ${mutation}`)
        code = code.replace(change[0], change[1])
      }
      if (destination) appendFileSync(destination, `${JSON.stringify({ path: relative(root, file), originalSHA256: createHash('sha256').update(originalCode).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'), bytes: Buffer.byteLength(code), ...(mutation && code !== originalCode ? { mutation } : {}) })}\n`)
      if (code !== originalCode) return { code, map: null }
    }
  }],
  cacheDir: resolve(import.meta.dirname, '../../../../../.tmp/session-history-entry-views-cache/owning'),
  test: { ...original.test, include: ['apps/desktop/test/session-history-entry-views.test.tsx'], passWithNoTests: false, fileParallelism: false }
})
