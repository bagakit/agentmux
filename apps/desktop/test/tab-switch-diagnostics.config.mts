import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'

const root = source.root!
const snapshots: Record<string, string> = process.env.AGENTMUX_TAB_SWITCH_SOURCES
  ? JSON.parse(readFileSync(process.env.AGENTMUX_TAB_SWITCH_SOURCES, 'utf8')) : {}
const sha = (value: string) => createHash('sha256').update(value).digest('hex')

export default defineConfig({ ...source, cacheDir: resolve(root, '.tmp/tab-switch-vitest-cache'),
  plugins: [{ name: 'actual-tab-switch-source', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    let code = snapshots[path] ?? original, mutated = false
    if (path === 'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx') {
      const variant = process.env.AGENTMUX_TAB_SWITCH_MUTANT
      const anchor = variant === 'action-tail' ? 'tabSwitchObservation.actionEnded(observationId, actionResult)'
        : variant === 'selected-source' ? "tabSwitchObservation.selected(switchTarget, 'layout-effect')" : null
      if (anchor) {
        assert.equal(code.split(anchor).length - 1, 1, 'Unique original Tab observation call')
        code = code.replace(anchor, variant === 'action-tail' ? 'void observationId'
          : "tabSwitchObservation.selected(switchTarget, 'already-selected-handler')")
        mutated = true
      }
    }
    if (process.env.AGENTMUX_TAB_SWITCH_LOADED && (path.startsWith('apps/desktop/') || path.startsWith('packages/'))) {
      appendFileSync(process.env.AGENTMUX_TAB_SWITCH_LOADED, JSON.stringify({ path,
        originalSHA256: sha(original), effectiveSHA256: sha(code), emittedSHA256: sha(code), mutated,
        returnedReplacement: code !== original }) + '\n')
    }
    if (code !== original) return { code, map: null }
  } }], test: { ...source.test, maxWorkers: 1, fileParallelism: false, passWithNoTests: false,
    include: ['apps/desktop/test/tab-switch-observation.test.ts', 'apps/desktop/test/tab-switch-mounted.test.tsx',
      'apps/desktop/test/tab-switch-mote-presentation.test.tsx', 'apps/desktop/test/tab-switch-placement-lifetime.test.tsx',
      'apps/desktop/test/tab-switch-projection-target.test.ts', 'apps/desktop/test/terminal-webgl-visibility.test.tsx', 'packages/core/test/renderer-tab-switch-codec.test.ts',
      'packages/core/test/metrics-control-host.test.ts'],
    testNamePattern: /^(?!.*public metrics Control owner)|preserves actual Tab action tails/,
    testTimeout: 15000 }
})
