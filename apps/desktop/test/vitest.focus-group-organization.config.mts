import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'

const inverses = {
  'collection-identity': ['apps/desktop/src/shared/focus-project-preferences.ts', "JSON.stringify(['collection', hostId, [...new Set(categorySpaceIds)].sort()])", "JSON.stringify(['collection', hostId, [categorySpaceIds[0]]])"],
  'skip-pin-order': ['apps/desktop/src/renderer/src/lib/use-focus-project-order.ts', 'preferences.filter(item => item.pinned)', 'preferences.filter(() => false)'],
  'drop-pin-draft': ['apps/desktop/src/renderer/src/components/FocusProjectPreferences.tsx', 'if (generation.current === token) setError(presentError(cause))', 'if (generation.current === token) { setDraft(saved); setError(presentError(cause)) }'],
  'omit-task-icons': ['apps/desktop/src/renderer/src/components/MoteTaskAction.tsx', "orientation === 'vertical' && action.icon ?", 'false && action.icon ?'],
  'freeze-hidden-route': ['apps/desktop/src/renderer/src/lib/use-focus-project-order.ts', 'const pins = new Map(', 'if (!visible) { route.current.projects = [...projectRanks.keys()]; route.current.lanes = [...laneRanks.keys()]; route.current.visible = true }\n  const pins = new Map('],
  'suppress-reentry': ['apps/desktop/src/renderer/src/lib/use-focus-project-order.ts', 'const entering = visible && !route.current.visible', 'const entering = visible && !route.current.visible && route.current.projects.length === 0'],
  'first-topic-activity': ['apps/desktop/src/renderer/src/lib/focus-project-lanes.ts',
    'return compareFocusWork({ priority: a.orderPriority ?? Infinity, lastActivityAt: a.lastActivityAt },\n    { priority: b.orderPriority ?? Infinity, lastActivityAt: b.lastActivityAt })',
    "return compareFocusWork({ priority: a.orderPriority ?? Infinity, lastActivityAt: Reflect.get(a, 'collection')?.topics[0]?.lastActivityAt ?? a.lastActivityAt },\n    { priority: b.orderPriority ?? Infinity, lastActivityAt: Reflect.get(b, 'collection')?.topics[0]?.lastActivityAt ?? b.lastActivityAt })"]
} as const
const legacyHidden = [
  ['apps/desktop/src/renderer/src/lib/use-focus-project-order.ts', 'const entering = visible && !route.current.visible',
    'const entering = visible && !route.current.visible && route.current.projects.length === 0'],
  ['apps/desktop/src/renderer/src/lib/use-focus-project-order.ts',
    'if (!projectRanks.has(project)) { projectRanks.set(project, projectRanks.size); if (visible) route.current.projects.push(project) }\n    if (!laneRanks.has(lane.id)) { laneRanks.set(lane.id, laneRanks.size); if (visible) route.current.lanes.push(lane.id) }',
    'if (!projectRanks.has(project)) { projectRanks.set(project, projectRanks.size); route.current.projects.push(project) }\n    if (!laneRanks.has(lane.id)) { laneRanks.set(lane.id, laneRanks.size); route.current.lanes.push(lane.id) }']
] as const
const selected = process.env.AGENTMUX_FOCUS_ORGANIZATION_INVERSE as keyof typeof inverses | 'legacy-hidden-route' | undefined
if (selected && selected !== 'legacy-hidden-route' && !inverses[selected]) throw Error('Unknown Focus organization inverse')
const replacements = selected === 'legacy-hidden-route' ? legacyHidden : selected ? [inverses[selected]] : []
let applied = false
const sha = (code: string) => createHash('sha256').update(code).digest('hex')
const guideReaders = new Set(['packages/core/src/agentmux-cli-module-skills.ts', 'packages/core/src/generated/agentmux-guides.ts',
  'packages/core/src/generated/agentmux-guides-index.ts', 'packages/core/src/guide-text.ts'])
export default defineConfig({ ...base, cacheDir: '.tmp/focus-group-organization-cache',
  resolve: { ...base.resolve, conditions: ['node', 'import', 'default'] },
  ssr: { ...base.ssr, resolve: { conditions: ['node', 'import', 'default'] } },
  plugins: [...base.plugins ?? [], { name: 'actual-focus-organization-consumers', enforce: 'pre', transform(original, id) {
    const path = relative(process.cwd(), id.split('?')[0]!)
    if (!path.startsWith('apps/desktop/src/') && !guideReaders.has(path)) return
    let code = original
    for (const [file, before, after] of replacements) {
      if (path !== file) continue
      if (code.split(before).length !== 2) throw Error('Unique loaded organization inverse anchor required')
      code = code.replace(before, after); applied = true; process.stderr.write(`MUTATION_APPLIED=${selected}\n`)
    }
    if (process.env.AGENTMUX_FOCUS_ORGANIZATION_LOADED) appendFileSync(process.env.AGENTMUX_FOCUS_ORGANIZATION_LOADED,
      JSON.stringify({ path, original_sha256: sha(original), loaded_sha256: sha(code), inverse: code === original ? null : selected }) + '\n')
    return code === original ? undefined : { code, map: null }
  }, buildEnd() { if (selected && !applied) throw Error('The actual selected organization inverse was not consumed') } }],
  test: { ...base.test, include: ['apps/desktop/test/focus-collection-layout.test.tsx', 'apps/desktop/test/focus-group-discussion.test.tsx', 'apps/desktop/test/focus-group-preferences-control.test.ts'],
    setupFiles: [], globalSetup: [], maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 20000 }
})
