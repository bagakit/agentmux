import { readFileSync } from 'node:fs'
import { exactReplace, verifyWorkfaceMutations } from './lib/workface-mutation-proof.mjs'

const swap = 'apps/desktop/src/renderer/src/lib/workface-region-swap.ts'
const read = path => readFileSync(path, 'utf8')
const call = 'ports.swapRegions(tab.workspaceId, tab.id, request.regionId, request.withRegionId)'
verifyWorkfaceMutations({ operation: 'region-swap', testPath: 'apps/desktop/test/workface-region-swap-control.test.tsx',
  sourcePaths: [swap, 'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/workbench-tabs.ts',
    'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx', 'apps/desktop/src/renderer/src/lib/desktop-presentation.ts'],
  callers: [ { symbol: 'executeWorkfaceRegionSwap', definition: swap },
    { symbol: 'swapRegions', definition: 'apps/desktop/src/renderer/src/store.ts' },
    { symbol: 'swapWorkbenchTabRegions', definition: 'apps/desktop/src/renderer/src/lib/workbench-tabs.ts' } ],
  variants: [
    { name: 'original-layout-owner-withdrawn', changes: { [swap]: exactReplace(read(swap), call, 'void request.regionId') } },
    { name: 'resource-owner-replaced-with-display', changes: { [swap]: exactReplace(read(swap), call,
      'ports.swapRegions(locations.at(-1)?.displayWorkspaceId ?? tab.workspaceId, tab.id, request.regionId, request.withRegionId)') } },
    { name: 'input-owner-identity-withdrawn', changes: { ['apps/desktop/src/renderer/src/lib/desktop-presentation.ts']:
      exactReplace(read('apps/desktop/src/renderer/src/lib/desktop-presentation.ts'),
        ' &&\n    before.fact.tabId === after.fact.tabId && before.fact.regionId === after.fact.regionId && before.fact.sessionId === after.fact.sessionId', '') } }
  ] })
