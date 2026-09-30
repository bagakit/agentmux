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
      const originalCode = code, mutation = process.env.AGENTMUX_PROJECT_ASSOCIATION_MUTATION
      const changes: Record<string, [string, string, string]> = {
        'ignore-conflict': ['lib/focus-history-timeline.ts', 'const identity = fact.conflict ? undefined : fact.observed.identity', 'const identity = fact.observed.identity'],
        'ignore-host': ['lib/focus-history-timeline.ts', 'const observed = observations.get(referenceKey(reference))', 'const observed = [...observations.values()].find(item => item.sessionId === reference.agentSessionId)'],
        'invent-project': ['lib/focus-history-timeline.ts', 'identity: undefined, key: trackKey(reference.agentSessionId, undefined)', "identity: { name: reference.agentSessionId, kind: 'agent' as const, providerId: null, hostId: reference.hostId, workspacePath: '', project: { id: 'current-project', name: 'Current Project' } }, key: trackKey(reference.agentSessionId, undefined)"],
        'metadata-tracks': ['components/RecentFocusTimeline.tsx', 'const visibleInputTracks = useMemo(() => readInputTracks.filter(source => source.messages.some(message => message.recordedAt !== undefined && Number.isFinite(message.recordedAt) && message.recordedAt >= range.start && message.recordedAt <= Math.min(now, range.end))), [readInputTracks, range, now])', 'const visibleInputTracks = useMemo(() => inputReference ? [resolveFocusInputTrack(observations, inputReference)] : [], [readInputTracks, range, now])']
      }
      if (mutation) {
        const change = changes[mutation]
        if (!change) throw new Error(`Unknown exact retired-history mutation ${mutation}`)
        if (file === `${root}/apps/desktop/src/renderer/src/${change[0]}`) {
          if (code.split(change[1]).length !== 2) throw new Error(`Missing unique loaded retired-history mutation ${mutation}`)
          code = code.replace(change[1], change[2])
        }
      }
      const destination = process.env.AGENTMUX_PROJECT_ASSOCIATION_LOADED_SOURCE
      if (destination) appendFileSync(destination, `${JSON.stringify({ path: relative(root, file), originalSHA256: createHash('sha256').update(originalCode).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'), bytes: Buffer.byteLength(code), ...(code !== originalCode ? { mutation } : {}) })}\n`)
      if (code !== originalCode) return { code, map: null }
    }
  }],
  cacheDir: resolve(import.meta.dirname, '../../../../../.tmp/focus-history-project-association-cache'),
  test: { ...original.test, include: ['apps/desktop/test/focus-history-project-association.test.tsx'], passWithNoTests: false, fileParallelism: false, testTimeout: 15_000 }
})
