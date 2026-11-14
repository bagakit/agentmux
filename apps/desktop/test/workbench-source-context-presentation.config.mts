import source from './vitest.mote-context.config.mts'
import { defineConfig } from 'vitest/config'
import { relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
const owner = 'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx'
const mutations: Record<string, [string, string]> = {
 'source-object-layout': ['const objectLayout = sourceWorkspace ?', 'const objectLayout = source ?'],
 'source-layout': ['if (zoneLayout) return zoneLayout.layout\n      if (sourceWorkspace) return ordinaryLayout ?? null', 'if (source) return ordinaryLayout ?? null\n      if (zoneLayout) return zoneLayout.layout'],
 'source-owner-bypass': ['const zoneLayout = useMemo(() => projection ? projectWorkbenchProjection(', "const zoneLayout = useMemo(() => projection && (!source || viewOwnership === 'projection') ? projectWorkbenchProjection("],
 'source-first-group': ['const confirmedDisplayGroup = confirmedReferenceGroup(projection)', 'const confirmedDisplayGroup = source ? bodyLayout?.groups.find(group => group.tabOrder.includes(tab.id))?.id : confirmedReferenceGroup(projection)']
}
const mutation = process.env.RETAINED_MUTATION
if (mutation) assert.ok(mutations[mutation], 'Known retained presentation mutation')
export default defineConfig({ ...source, plugins: [{ name: 'loaded-retained-owner', enforce: 'pre', transform(original, id) {
 const path = relative(source.root!, id.split('?')[0]!)
 if (path !== owner) return
 let code = original
 if (mutation) { const [from, to] = mutations[mutation]!; assert.equal(code.split(from).length - 1, 1, 'Unique loaded production anchor'); code = code.replace(from, to) }
 if (process.env.RETAINED_LOADED) appendFileSync(process.env.RETAINED_LOADED, JSON.stringify({ path, originalSHA256: createHash('sha256').update(original).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex'), mutation: code !== original ? mutation : null }) + '\n')
 if (code !== original) return { code, map: null }
} }], test: { ...source.test,
 include: process.env.RETAINED_ADJACENT ? ['apps/desktop/test/main-region-app.test.tsx', 'apps/desktop/test/workbench-projection-ownership.test.tsx', 'apps/desktop/test/workbench-parked-presentation.test.tsx', 'apps/desktop/test/space-new-tab-reachability.test.tsx'] : ['apps/desktop/test/workbench-source-context-presentation.test.tsx'], setupFiles: [], globalSetup: [],
 maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 30000 } })
