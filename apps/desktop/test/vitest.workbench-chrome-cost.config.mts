import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'

const chromeGate = 'surfaceVisible && !conversationChrome && <TopRowLeadingChrome />'
const surfaceEntries = { Focus: 'GlobalFocusSurface', Recall: 'GlobalRecallSurface', Survey: 'GlobalSurveySurface', Goals: 'GlobalBoardSurface' } as const
const goalsLoader = "const loadGoals = () => import('./components/GlobalBoardSurface').then(module => module.GlobalBoardSurface)"
const mutations = {
  parked: ['/components/WorkspaceWorkbench.tsx', chromeGate, '!conversationChrome && <TopRowLeadingChrome />'],
  conversation: ['/components/WorkspaceWorkbench.tsx', chromeGate, 'surfaceVisible && <TopRowLeadingChrome />'],
  'wide-layout-inputs': ['/hooks/useWorkbenchObjectLayout.ts', 'scratchTopicSnapshots: state.scratchTopicSnapshots,',
    'scratchTopicSnapshots: state.scratchTopicSnapshots, selectedDemandId: state.selectedDemandId, spatialRequests: state.spatialRequests, mainSurface: state.mainSurface, activeWorkspaceId: state.activeWorkspaceId,'],
  'global-layout-choice': ['/hooks/useWorkbenchObjectLayout.ts', 'choice?.workspaceId === workspaceId ? choice : null', 'choice'],
  'eager-goals': ['/App.tsx', goalsLoader, "import { GlobalBoardSurface } from './components/GlobalBoardSurface'\nconst loadGoals = () => Promise.resolve(GlobalBoardSurface)"],
  'confirm-shell': ['/lib/desktop-presentation.ts', "surface !== 'space' ? mountedSurface : regionId", "surface !== 'space' ? main : regionId"]
} as const
const mutation = process.env.AGENTMUX_WORKBENCH_CHROME_MUTANT as keyof typeof mutations | undefined
if (mutation) assert(Object.hasOwn(mutations, mutation), 'Known Workbench chrome mutation')

export default defineConfig({
  ...base, cacheDir: resolve(base.root!, '.tmp/workbench-chrome-cost-vitest'),
  plugins: [...(base.plugins ?? []), {
    name: 'observe-original-workbench-chrome', enforce: 'pre',
    transform(original, id) {
      if (!id.includes('/apps/desktop/src/renderer/src/')) return
      if (mutation && id.endsWith(mutations[mutation][0])) {
        const [, from, to] = mutations[mutation]
        assert.equal(original.split(from).length, 2, 'Unique original Workbench mutation anchor')
        process.stderr.write(`MUTATION_APPLIED=${mutation}\n`)
        return { code: original.replace(from, to), map: null }
      }
      if (id.endsWith('/lib/desktop-focus-navigation.ts')) {
        const projector = 'export function workbenchObjectLayout(state: WorkbenchObjectLayoutFacts, workspaceId: string, layout = state.layouts[workspaceId]) {'
        assert.equal(original.split(projector).length, 2, 'Observe the actual Workbench layout projector')
        return { code: original.replace(projector, projector + '\n  globalThis.__agentmuxCountWorkbenchLayout?.(workspaceId)\n'), map: null }
      }
      for (const [surface, module] of Object.entries(surfaceEntries)) {
        if (id.endsWith(`/components/${module}.tsx`)) {
          return { code: original + `\n;(globalThis as any).__agentmuxSurfaceLoad?.evaluated.push('${surface}')\n`, map: null }
        }
      }
      if (id.endsWith('/App.tsx')) {
        const code = Object.entries(surfaceEntries).reduce((current, [surface, module]) => {
          const before = `import('./components/${module}')`
          assert.equal(current.split(before).length, 2, `Unique original ${surface} loader`)
          return current.replace(before, `(globalThis as any).__agentmuxSurfaceLoad.load('${surface}', () => ${before})`)
        }, original)
        return { code, map: null }
      }
      if (!id.endsWith('/TopRowChrome.tsx')) return
      const selector = 'export function TopRowLeadingChrome() {\n  const preferredProjects = useAppStore((state) => state.projectRailOpen)'
      assert.equal(original.split(selector).length, 2, 'Observe the actual window chrome subscriber')
      return { code: original.replace(selector, `export function TopRowLeadingChrome() {
  const preferredProjects = useAppStore((state) => {
    globalThis.__agentmuxCountWorkbenchChromeRead?.()
    return state.projectRailOpen
  })`), map: null }
    }
  }],
  test: { ...base.test, include: ['apps/desktop/test/workbench-chrome-cost.test.tsx', 'apps/desktop/test/renderer-startup-graph.test.ts'], setupFiles: [],
    globalSetup: [], passWithNoTests: false, testTimeout: 30000 }
})
