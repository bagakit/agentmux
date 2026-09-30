import { createHash } from 'node:crypto'
import { appendFileSync, realpathSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
export default defineConfig({
  ...original,
  define: { ...original.define, __AGENTMUX_WEB_PREVIEW__: 'false' },
  // Public workspace package links can target a bounded, read-only producer outside
  // this proof root. Permit only those exact package roots; resolution is unchanged.
  server: { fs: { allow: [resolve(import.meta.dirname, '../../../../..'), ...['core', 'demand', 'layout'].map(name => realpathSync(resolve(import.meta.dirname, '../../../../..', 'packages', name)))] } },
  root: resolve(import.meta.dirname, '../../../../..'),
  plugins: [...(original.plugins ?? []), {
    name: 'focus-retired-history-loaded-source', enforce: 'pre',
    transform(code, id) {
      const root = resolve(import.meta.dirname, '../../../../..'), file = id.split('?')[0]!
      if (!file.startsWith(`${root}/apps/desktop/src/renderer/src/`) || !/\.[cm]?[jt]sx?$/u.test(file)) return
      const originalCode = code, mutation = process.env.AGENTMUX_RETIRED_FOCUS_MUTATION
      const changes: Record<string, [string, string, string]> = {
        'clear-retained-selection': ['components/RecentFocusTimeline.tsx', 'onRefresh: () => { if (historical)', 'onRefresh: () => { setPreview(current => current ? { ...current, message: undefined } : current); if (historical)'],
        'readonly-disconnected': ['components/RecentFocusTimeline.tsx', 'const inputReference = inputSource?.reference', 'const inputReference = inputContext ? inputSource?.reference : undefined'],
        'current-members-only': ['lib/focus-history-timeline.ts', 'for (const readonlyInputTrack of readonlyInputTracks) {', 'for (const readonlyInputTrack of readonlyInputTracks) { if (!contexts.some(context => context.id === readonlyInputTrack.sessionId)) continue;'],
        'equal-body-merge': ['components/RecentFocusTimeline.tsx', 'projected.filter(item => item.agentSessionId === inputReference?.agentSessionId)', 'projected.filter((item, index) => item.agentSessionId === inputReference?.agentSessionId && projected.findIndex(other => other.content === item.content) === index)']
      }
      if (mutation) {
        const change = changes[mutation]
        if (!change) throw new Error(`Unknown exact retired-history mutation ${mutation}`)
        if (file === `${root}/apps/desktop/src/renderer/src/${change[0]}`) {
          if (code.split(change[1]).length !== 2) throw new Error(`Missing unique loaded retired-history mutation ${mutation}`)
          code = code.replace(change[1], change[2])
        }
      }
      const destination = process.env.AGENTMUX_RETIRED_FOCUS_LOADED_SOURCE
      if (destination) appendFileSync(destination, `${JSON.stringify({ path: relative(root, file), originalSHA256: createHash('sha256').update(originalCode).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'), bytes: Buffer.byteLength(code), ...(code !== originalCode ? { mutation } : {}) })}\n`)
      if (code !== originalCode) return { code, map: null }
    }
  }],
  cacheDir: resolve(import.meta.dirname, '../../../../../.tmp/focus-retired-history-renderer-cache'),
  test: { ...original.test, include: ['apps/desktop/test/focus-retired-history-renderer.test.tsx'], passWithNoTests: false, fileParallelism: false, testTimeout: 15_000 }
})
