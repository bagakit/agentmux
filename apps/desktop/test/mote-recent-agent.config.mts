import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import owning from '../scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts'

// A readonly old-Source oracle lets concurrent production fixes continue while
// the new assertions prove their original RED, without rewriting product files.
const repository = resolve(import.meta.dirname, '../../..')
const baseline = process.env.AGENTMUX_MOTE_RECENT_BASELINE_REF
const sourcePaths = ['apps/desktop/src/renderer/src/components/PmoTeamsTopicEntry.tsx','apps/desktop/src/renderer/src/App.tsx',
  'apps/desktop/src/renderer/src/lib/mote-quick-preferences.ts',
  'apps/desktop/src/renderer/src/lib/mote-workbench-projection.ts',
  'apps/desktop/src/renderer/src/lib/pmo-teams-topic-target.ts','apps/desktop/src/renderer/src/store.ts',
  'apps/desktop/src/renderer/src/lib/workbench-tab-removal.ts',
  'apps/desktop/src/renderer/src/lib/pmo-teams-topic-floating.ts',
  'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx',
  'apps/desktop/src/renderer/src/components/PmoTeamsTopicFloatingPanel.tsx',
  'apps/desktop/src/renderer/src/components/WorkbenchEmptyState.tsx',
  'apps/desktop/src/renderer/src/components/WorkbenchTabStrip.tsx',
  'apps/desktop/src/renderer/src/styles/workbench.css']
const original = new Map(baseline ? sourcePaths.map(path => [resolve(repository, path),
  execFileSync('git', ['show', `${baseline}:${path}`], { cwd: repository, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })]) : [])
const overrideFile = process.env.AGENTMUX_MOTE_RECENT_OVERRIDE_SOURCE
if (overrideFile) {
  const overrides = JSON.parse(readFileSync(overrideFile, 'utf8')) as Record<string, string>
  for (const [path, source] of Object.entries(overrides)) {
    if (!sourcePaths.includes(path) || typeof source !== 'string' || !source) throw new Error(`Invalid test-only Source override: ${path}`)
    original.set(resolve(repository, path), source)
  }
}

export default defineConfig({
  ...owning,
  plugins: [...owning.plugins ?? [], ...(original.size ? [{
    name: 'mote-continuity-readonly-baseline',
    enforce: 'pre' as const,
    transform(_code: string, id: string) {
      const source = original.get(id.split('?')[0]!)
      const trace = process.env.AGENTMUX_MOTE_RECENT_TRANSFORM_TRACE ?? process.env.AGENTMUX_MOTE_RECENT_BASELINE_TRACE
      if (source !== undefined && trace)
        appendFileSync(trace, JSON.stringify({ baseline: baseline ?? null, overrideFile: overrideFile ?? null, path: id.split('?')[0] }) + '\n')
      return source === undefined ? undefined : { code: source, map: null }
    }
  }] : [])],
  test: { ...owning.test,
    include: ['test/mote-recent-agent.test.tsx','test/mote-closed-tab-target.test.tsx', 'test/pmo-teams-topic-floating.test.tsx',
      'test/mote-hover-surface.test.tsx', 'test/workbench-projection-ownership.test.tsx',
      'test/workbench-tab-strip.test.ts'],
    passWithNoTests: false,
    maxWorkers: 1
  }
})
