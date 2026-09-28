import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'

const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({
  ...original,
  root,
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  cacheDir: resolve(root, '.bagakit/feature-tracker/conversation-quality-artifacts/T002/cache'),
  plugins: [...(original.plugins ?? []), {
    name: 'conversation-window-loaded-source',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]!
      if (!file.startsWith(`${root}/apps/desktop/src/`) || !/\.[cm]?[jt]sx?$/u.test(file)) return
      const before = code
      const mutation = process.env.AGENTMUX_CONVERSATION_WINDOW_MUTATION
      const target = mutation === 'detach-history' ? 'SessionPane.tsx' : 'ActivityView.tsx'
      if (mutation && file === `${root}/apps/desktop/src/renderer/src/components/${target}`) {
        const changes: Record<string, [string, string]> = {
          'detach-history': ['onReadEarlier: openHistory', 'onReadEarlier: () => {}'],
          'hide-read-state': ['const readNotice = <UserMessageReadNotice read={userMessageRead} />', 'const readNotice = null']
        }
        const change = changes[mutation]
        if (!change || before.split(change[0]).length !== 2) throw new Error(`Missing unique read-state mutation ${mutation}`)
        code = before.replace(change[0], change[1])
      }
      const log = process.env.AGENTMUX_CONVERSATION_WINDOW_LOADED_SOURCE
      if (log) appendFileSync(log, `${JSON.stringify({ path: relative(root, file), originalSHA256: createHash('sha256').update(before).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'), bytes: Buffer.byteLength(code), ...(before !== code ? { mutation } : {}) })}\n`)
      if (code !== before) return { code, map: null }
    }
  }],
  test: { ...original.test, include: ['apps/desktop/test/conversation-native-input-window.integration.test.tsx'], passWithNoTests: false, fileParallelism: false }
})
