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
    name: 'session-pane-native-caller-loaded-source',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]!
      if (!file.startsWith(`${root}/apps/desktop/src/renderer/src/`) || !/\.[cm]?[jt]sx?$/u.test(file)) return
      const before = code
      const mutation = process.env.AGENTMUX_PANE_NATIVE_MUTATION
      if (mutation && file === `${root}/apps/desktop/src/renderer/src/components/SessionPane.tsx`) {
        const changes: Record<string, [string, string]> = {
          'always-enabled': ["enabled: visible && viewMode !== 'terminal' && !historyOpen && !pendingAgentRestore", 'enabled: true'],
          'wrong-control': ["session?.kind === 'agent' ? session.control : undefined", "session?.kind === 'agent' ? { ...session.control, agentSessionId: 'wrong-target' } : undefined"],
          'empty-records': ['userMessages={userMessages}', 'userMessages={[]}'],
          'wrong-sender': ['.find((agent) => agent.id === id)', '.find((agent) => agent.id === sessionId)']
        }
        const change = changes[mutation]
        if (!change || before.split(change[0]).length !== 2) throw new Error(`Missing unique caller mutation ${mutation}`)
        code = before.replace(change[0], change[1])
      }
      const destination = process.env.AGENTMUX_PANE_NATIVE_LOADED_SOURCE
      if (destination) appendFileSync(destination, `${JSON.stringify({ path: relative(root, file), originalSHA256: createHash('sha256').update(before).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'), bytes: Buffer.byteLength(code), ...(before !== code ? { mutation } : {}) })}\n`)
      if (before !== code) return { code, map: null }
    }
  }],
  cacheDir: resolve(root, '.tmp/session-pane-native-caller-cache'),
  test: {
    ...original.test,
    include: ['apps/desktop/test/session-pane-native-user-messages.test.tsx', 'apps/desktop/test/session-pane-native-covered-content-resume.test.tsx'],
    passWithNoTests: false,
    fileParallelism: false
  }
})
