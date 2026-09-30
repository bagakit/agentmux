import { readFileSync } from 'node:fs'
import { exactReplace, verifyWorkfaceMutations } from './lib/workface-mutation-proof.mjs'
const open = 'apps/desktop/src/renderer/src/lib/workface-file-open.ts'
const mapper = 'apps/desktop/src/renderer/src/lib/zone-file-resource.ts'
const reducer = 'apps/desktop/src/renderer/src/lib/file-workbench-state.ts'
const store = 'apps/desktop/src/renderer/src/store.ts'
const read = path => readFileSync(path, 'utf8')
const background = read(reducer).replaceAll('placement.focus === false', 'false').replaceAll('placement?.focus === false', 'false')
if (background === read(reducer)) throw new Error('Nonempty background placement consumption is required.')
verifyWorkfaceMutations({ operation: 'file-open', testPath: 'apps/desktop/test/workface-file-open-control.test.tsx',
  sourcePaths: [open, mapper, reducer, store, 'apps/desktop/src/renderer/src/lib/note-creation.ts',
    'apps/desktop/src/renderer/src/components/GitDiffCanvas.tsx', 'apps/desktop/test/helpers/workface-monaco-fixture.ts',
    'apps/desktop/src/renderer/src/components/FileSurfaceView.tsx', 'apps/desktop/src/renderer/src/components/EditorPane.tsx',
    'apps/desktop/src/renderer/src/lib/file-region-presentation.ts', 'apps/desktop/src/renderer/src/lib/desktop-presentation.ts',
    'apps/desktop/test/helpers/workface-file-fixture.ts', 'packages/core/bin/agentmux', 'packages/core/dist/agentmux.js', 'packages/core/dist/control-host.js'],
  callers: [{ symbol: 'executeWorkfaceFileOpen', definition: open }, { symbol: 'zoneFileResource', definition: mapper },
    { symbol: 'openFile', definition: store }, { symbol: 'FileSurfaceView', definition: 'apps/desktop/src/renderer/src/components/FileSurfaceView.tsx' }],
  variants: [
    { name: 'zone-root-mapping-withdrawn', changes: { [mapper]: exactReplace(read(mapper),
      "path: relativeDirectory && relativePath\n    ? `${relativeDirectory}/${relativePath}` : relativeDirectory || relativePath || (requestedPath ? '.' : '')",
      'path: relativePath') } },
    { name: 'background-placement-authority-withdrawn', changes: { [reducer]: background } },
    { name: 'late-original-owner-guard-withdrawn', changes: { [store]: exactReplace(read(store),
      " &&\n        (!placement?.onResult || !expectedSurface || exactRegionId && currentTab?.regions[exactRegionId] === expectedSurface)", '') } }
  ] })
