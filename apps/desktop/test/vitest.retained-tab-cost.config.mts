import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'

const root = source.root!
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const snapshots: Record<string, string> = process.env.AGENTMUX_RETAINED_TAB_SOURCES
  ? JSON.parse(readFileSync(process.env.AGENTMUX_RETAINED_TAB_SOURCES, 'utf8')) : {}
const instrument = [
  ['apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx', '  const primaryHostId = targetId ?? homeId',
    '  globalThis.__retainedTabCounts.hosts[tab.id] = (globalThis.__retainedTabCounts.hosts[tab.id] ?? 0) + 1;'],
  ['apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx', '  const { tab } = props',
    '  globalThis.__retainedTabCounts.trees[tab.id] = (globalThis.__retainedTabCounts.trees[tab.id] ?? 0) + 1;'],
  ['apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx', '  const moteContext = useContext(MoteWorkfaceContext)',
    '  globalThis.__retainedTabCounts.workspace++;'],
  ['apps/desktop/src/renderer/src/components/SessionPane.tsx', "  useObservedConsumerCommit('sessionPane', observationVisible)",
    `  globalThis.__retainedTabCounts.paneRender[sessionId] = (globalThis.__retainedTabCounts.paneRender[sessionId] ?? 0) + 1;
  globalThis.__retainedTabCounts.paneProps[sessionId] = { visible, interactiveResize };
  useEffect(() => { const counts = globalThis.__retainedTabCounts; counts.paneCommit[sessionId] = (counts.paneCommit[sessionId] ?? 0) + 1 })`],
  ['apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', "  useObservedConsumerCommit('composer', visible)",
    `  globalThis.__retainedTabCounts.composerRender[sessionId] = (globalThis.__retainedTabCounts.composerRender[sessionId] ?? 0) + 1;
  useEffect(() => { const counts = globalThis.__retainedTabCounts; counts.composerCommit[sessionId] = (counts.composerCommit[sessionId] ?? 0) + 1 })`],
  ['apps/desktop/src/renderer/src/components/BrowserPane.tsx', 'export function BrowserPane(props: BrowserPaneProps) {',
    '  globalThis.__retainedTabCounts.browser[props.tab.browserId] = (globalThis.__retainedTabCounts.browser[props.tab.browserId] ?? 0) + 1;'],
  ['apps/desktop/src/renderer/src/components/RegionContextMenu.tsx', '  const base = createRegionCopyModel({',
    '  globalThis.__retainedTabCounts.menus[regionId] = swapMenu;']
] as const

export default defineConfig({
  ...source, cacheDir: resolve(root, '.tmp/retained-tab-cost-vitest-cache'),
  plugins: [{ name: 'actual-retained-tab-consumers', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    let code = snapshots[path] ?? original
    const effective = code
    const mutant = process.env.AGENTMUX_RETAINED_TAB_MUTANT
    const anchor = mutant === 'tab-memo' && path.endsWith('/WorkspaceWorkbench.tsx')
      ? 'const WorkbenchContentHost = memo(function WorkbenchContentHost('
      : mutant === 'targets-unstable' && path.endsWith('/App.tsx')
        ? 'function useStableWorkbenchViewTargets(current: WorkbenchViewTargets): WorkbenchViewTargets {' : null
    if (anchor) {
      assert.equal(code.split(anchor).length - 1, 1, 'Unique loaded surface-switch mutation')
      code = code.replace(anchor, mutant === 'tab-memo'
        ? 'const WorkbenchContentHost = ((component) => component)(function WorkbenchContentHost('
        : `${anchor}\n  return current`)
      process.stderr.write(`MUTATION_APPLIED=${mutant}\n`)
    }
    for (const [file, anchor, probe] of instrument) if (path === file) {
      assert.equal(code.split(anchor).length - 1, 1, 'Unique actual retained Tab consumer')
      code = code.replace(anchor, path.endsWith('/RegionContextMenu.tsx') ? `${probe}\n${anchor}` : `${anchor}\n${probe}`)
    }
    if (process.env.AGENTMUX_RETAINED_TAB_LOADED && (path.startsWith('apps/desktop/src/') || path.startsWith('packages/'))) {
      appendFileSync(process.env.AGENTMUX_RETAINED_TAB_LOADED, JSON.stringify({ path,
        originalSHA256: hash(original), effectiveSHA256: hash(effective), instrumentedSHA256: hash(code), mutant: anchor ? mutant : null }) + '\n')
    }
    if (code !== original) return { code, map: null }
  } }],
  test: { ...source.test, include: ['apps/desktop/test/workbench-retained-tab-cost.fixture.tsx'],
    globalSetup: [], setupFiles: [], maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 15000 }
})
