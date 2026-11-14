import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import source from './vitest.mote-context.config.mts'

const menu = 'apps/desktop/src/renderer/src/components/FocusContextMenu.tsx'
const reader = 'apps/desktop/src/renderer/src/components/AgentInformationReader.tsx'
const sources = 'apps/desktop/src/renderer/src/lib/use-focus-sources.tsx'
const mutations: Record<string, [string, string, string]> = {
  'refresh-only-remounts': [sources, 'previous.current = revision\n    refresh()', 'previous.current = revision'],
  'runtime-as-host': [menu, 'executionHostProjection(access.executionHostId, context.workspacePath)', 'executionHostProjection(access.identity.runtimeId, context.workspacePath)'],
  'diagnostic-as-heading': [menu, '<InformationIcon size={14} /><span>{focusSourceObservationLabel(access.observation)}</span>', '<InformationIcon size={14} /><span>{focusSourceObservationLabel(access.observation)}</span><span>{access.issue}</span>'],
  'unknown-as-lost-run': [reader, "'The current Run has not been confirmed.'", "'The original Run is no longer confirmed.'"],
  'replace-protected-reading': [reader, 'if (request.bookmark && !protectedNow && changedReading && visible && session)', 'if (request.bookmark && changedReading && visible && session)']
}
const mutation = process.env.AGENTMUX_SOURCE_RECOVERY_MUTATION
if (mutation) assert.ok(mutations[mutation], 'Known source recovery mutation')
const bound = new Set([menu, reader, sources, 'apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx',
  'apps/desktop/src/main/space-mount-ipc.ts', 'apps/desktop/src/main/space-member-surface.ts', 'packages/core/src/space-session-sources.ts'])
export default defineConfig({ ...source,
  cacheDir: resolve(source.root!, '.tmp/focus-source-recovery-cache'),
  plugins: [{ name: 'actual-source-recovery-consumer', enforce: 'pre', transform(original, id) {
    const path = relative(source.root!, id.split('?')[0]!)
    if (!bound.has(path)) return
    let code = original
    if (mutation && path === mutations[mutation]![0]) {
      const [, from, to] = mutations[mutation]!
      assert.equal(code.split(from).length - 1, 1, 'Unique loaded production mutation anchor')
      code = code.replace(from, to)
    }
    if (process.env.AGENTMUX_SOURCE_RECOVERY_LOADED) appendFileSync(process.env.AGENTMUX_SOURCE_RECOVERY_LOADED,
      JSON.stringify({ path, originalSHA256: createHash('sha256').update(original).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex'), mutation: original === code ? null : mutation }) + '\n')
    if (code !== original) return { code, map: null }
  } }],
  test: { ...source.test, environment: 'happy-dom', include: process.env.AGENTMUX_SOURCE_RECOVERY_DOCUMENT
      ? ['apps/desktop/test/workbench-widget-document.test.tsx'] : ['apps/desktop/test/focus-source-recovery.test.tsx'], setupFiles: [], globalSetup: [],
    passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 15000 }
})
