import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'

const root = source.root!
const treePath = 'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx'
const narrow = `  const labels = useWorkbenchRegionLabels(tab)
  const swapTargets = useMemo(() => regionIds(tab.layout.root).flatMap(regionId =>
    tab.regions[regionId] ? [{ regionId, label: labels[regionId]! }] : []), [labels, tab.regions, tab.layout.root])`
const broad = `  const sessions = useWorkbenchTabSessions(tab)
  const sessionNameMetadata = useWorkbenchTabNameMetadata(tab)
  const agentNames = useWorkbenchTabRecord('agentNames', tab)
  const timelines = useWorkbenchTabRecord('timelines', tab)
  const swapTargets = useMemo(() => {
    const agentFactsFor = workbenchAgentFactsFor(sessions, agentNames, timelines, sessionNameMetadata)
    return regionIds(tab.layout.root).flatMap(regionId => {
      const region = tab.regions[regionId]
      if (!region) return []
      const facts = region.kind === 'agent' ? agentFactsFor(region.sessionId) : null
      return [{ regionId, label: facts ? agentDisplayName(facts) : regionSurfaceLabel(region, sessions, sessionNameMetadata) }]
    })
  }, [sessions, agentNames, timelines, sessionNameMetadata, tab.regions, tab.layout.root])`
const restoredImports = `import { regionSurfaceLabel } from '../lib/region-display-name'
import { workbenchAgentFactsFor } from '../lib/workbench-tab-presentation'
import { agentDisplayName } from '../lib/workbench-tabs'
`
const counts = 'globalThis.__regionLabelCounts ??= { tree: 0, pane: {}, composer: {}, menus: {} };'
const instrument = [
  [treePath, '  const { tab } = props', `${counts}globalThis.__regionLabelCounts.tree++;`],
  ['apps/desktop/src/renderer/src/components/SessionPane.tsx', '  const observationVisible = visible || presentations.some(target => target.visible !== false)', `${counts}globalThis.__regionLabelCounts.pane[sessionId] = (globalThis.__regionLabelCounts.pane[sessionId] ?? 0) + 1;`],
  ['apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', "  useObservedConsumerCommit('composer', visible)", `${counts}globalThis.__regionLabelCounts.composer[sessionId] = (globalThis.__regionLabelCounts.composer[sessionId] ?? 0) + 1;`],
  ['apps/desktop/src/renderer/src/components/RegionContextMenu.tsx', '  const base = createRegionCopyModel({', `${counts}globalThis.__regionLabelCounts.menus[regionId] = swapMenu;`]
] as const
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

export default defineConfig({ ...source, cacheDir: resolve(root, '.tmp/region-label-cost-vitest-cache'),
  plugins: [{ name: 'actual-region-label-source', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    let code = original, mutated = false
    if (process.env.AGENTMUX_REGION_LABEL_MUTANT && path === treePath) {
      assert.equal(code.split(narrow).length - 1, 1, 'Unique actual RegionTree reversal')
      code = restoredImports + code.replace(narrow, broad); mutated = true
    }
    const effective = code
    for (const [file, anchor, counter] of instrument) if (path === file) {
      assert.equal(code.split(anchor).length - 1, 1, 'Unique actual consumer counter')
      code = code.replace(anchor, counter + '\n' + anchor)
    }
    if (process.env.AGENTMUX_REGION_LABEL_LOADED && (path.startsWith('apps/desktop/src/') || path.startsWith('packages/'))) {
      appendFileSync(process.env.AGENTMUX_REGION_LABEL_LOADED, JSON.stringify({ path, originalSHA256: hash(original),
        effectiveSHA256: hash(effective), instrumentedSHA256: hash(code), mutated }) + '\n')
    }
    if (code !== original) return { code, map: null }
  } }],
  test: { ...source.test, include: process.env.AGENTMUX_REGION_LABEL_ADJACENT ? [
    'apps/desktop/test/session-name-metadata.test.ts', 'apps/desktop/test/workbench-tab-actions.test.ts',
    'apps/desktop/test/region-display-name.test.ts', 'apps/desktop/test/workbench-tab-name-public.test.ts'
  ] : ['apps/desktop/test/workbench-region-label-cost.test.tsx'], passWithNoTests: false, testTimeout: 30000 }
})
