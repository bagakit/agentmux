import { resolve, relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config'
const root = resolve(import.meta.dirname, '../../..')
const mutations = {
 'drop-region-level': ['components/WorkspaceWorkbench.tsx', "if (viewOwnership === 'projection' && projection?.entity.kind === 'region') {", 'if (false) {'],
 'wrong-region-slot': ['lib/workbench-projection.ts', '[reference.displayWorkspaceId, reference.groupId, reference.tabId, reference.regionId]', "[reference.displayWorkspaceId, reference.groupId, reference.tabId, 'wrong-region']"],
 'drop-region-budget': ['App.tsx', 'target.reference.regionId] : [])), [viewTargets])', 'target.reference.regionId].filter(() => false) : [])), [viewTargets])']
} as const
export default defineConfig({ ...original, root, cacheDir: resolve(root,'.tmp/region-level-cache'),
 plugins: [...(original.plugins ?? []), { name:'actual-region-owner-proof', enforce:'pre', transform(source,id) {
  const path=id.split('?')[0]!
  if (!path.startsWith(root+'/apps/desktop/src/')) return
  let code=source
  const mutation=process.env.AGENTMUX_REGION_MUTATION as keyof typeof mutations | undefined
  if (mutation) { const change=mutations[mutation]; assert.ok(change,'Known Region semantic mutation')
   if (path===resolve(root,'apps/desktop/src/renderer/src',change[0])) { assert.equal(code.split(change[1]).length-1,1,'Unique actual loaded Region mutation');code=code.replace(change[1],change[2]) }
  }
  if (path===resolve(root,'apps/desktop/src/renderer/src/lib/terminal-cold-parking-coordinator.tsx')) {
   assert.equal(code.split('  return candidates').length-1,1,'Actual nonempty budget observation anchor')
   code=code.replace('  return candidates','  ;(globalThis as unknown as { __regionBudgetFacts?: unknown[] }).__regionBudgetFacts?.push(candidates.map(item => ({ id: item.id, visible: item.visible })))\n  return candidates')
  }
  if (process.env.AGENTMUX_REGION_LOADED) appendFileSync(process.env.AGENTMUX_REGION_LOADED,JSON.stringify({ path:relative(root,path),sourceSHA:createHash('sha256').update(source).digest('hex'),loadedSHA:createHash('sha256').update(code).digest('hex'),transformed:code!==source,mutation })+'\n')
  if (code!==source)return {code,map:null}
 }}],
 test: { ...original.test, include:process.env.AGENTMUX_REGION_ADJACENT ? ['apps/desktop/test/shared-workbench-presentation.test.tsx','apps/desktop/test/focus-local-workbench-selection.test.tsx','apps/desktop/test/focus-preview-header.test.tsx'] : ['apps/desktop/test/shared-region-presentation.test.tsx'], passWithNoTests:false, maxWorkers:1,fileParallelism:false,testTimeout:15000 } })
