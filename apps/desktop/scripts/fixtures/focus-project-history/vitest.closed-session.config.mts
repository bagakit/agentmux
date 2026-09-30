import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
export default defineConfig({
  ...original,
  define: { ...original.define, __AGENTMUX_WEB_PREVIEW__: 'false' },
  root: resolve(import.meta.dirname, '../../../../..'),
  cacheDir: resolve(import.meta.dirname, '../../../../../.tmp/focus-closed-session-cache'),
  plugins: [...(original.plugins ?? []), {
    name: 'focus-closed-session-loaded-source', enforce: 'pre',
    transform(code, id) {
      const root = resolve(import.meta.dirname, '../../../../..'), file = id.split('?')[0]!
      if (!file.startsWith(`${root}/apps/desktop/src/renderer/src/`) || !/\.[cm]?[jt]sx?$/u.test(file)) return
      const originalCode = code, mutation = process.env.AGENTMUX_FOCUS_CLOSED_MUTATION
      const changes: Record<string, [string, string, string]> = {
        'readonly-disconnected': ['components/RecentFocusTimeline.tsx', 'const inputReference = inputSource?.reference', 'const inputReference = inputContext ? inputSource?.reference : undefined'],
        'current-members-only': ['lib/focus-history-timeline.ts', 'for (const readonlyInputTrack of readonlyInputTracks) {', 'for (const readonlyInputTrack of readonlyInputTracks) { if (!contexts.some(context => context.id === readonlyInputTrack.sessionId)) continue;'],
        'equal-body-merge': ['components/RecentFocusTimeline.tsx', 'projected.filter(item => item.agentSessionId === inputReference?.agentSessionId)', 'projected.filter((item, index) => item.agentSessionId === inputReference?.agentSessionId && projected.findIndex(other => other.content === item.content) === index)']
      }
      if (mutation) {
        const change = changes[mutation]
        if (!change) throw new Error(`Unknown closed-session mutation ${mutation}`)
        if (file === `${root}/apps/desktop/src/renderer/src/${change[0]}`) {
          if (code.split(change[1]).length !== 2) throw new Error(`Missing unique closed-session mutation ${mutation}`)
          code = code.replace(change[1], change[2])
        }
      }
      const output = process.env.AGENTMUX_FOCUS_CLOSED_LOADED_SOURCE
      if (output) appendFileSync(output, JSON.stringify({ path: relative(root, file), originalSHA256: createHash('sha256').update(originalCode).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'), bytes: Buffer.byteLength(code), ...(code !== originalCode ? { mutation } : {}) }) + '\n')
      if (code !== originalCode) return { code, map: null }
    }
  }],
  test: { ...original.test, include: ['apps/desktop/test/focus-closed-session-history.test.tsx'], passWithNoTests: false, fileParallelism: false, hookTimeout: 45_000, testTimeout: 20_000,
    // The Node Runtime package must retain its actual import.meta.url and artifact resolver.
    // Vite asset rewriting a platform-specific new URL is not the published Node consumer.
    server: { deps: { external: [/\/packages\/core\/dist\/(?!session-user-messages\.js$)/u] } } }
})
