import { appendFileSync, readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import assert from 'node:assert/strict'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config'
const root = resolve(import.meta.dirname, '../../..')
// This focused harness loads current public source exports. Shipping dist is verified separately.
const coreManifest = JSON.parse(readFileSync(resolve(root,'packages/core/package.json'),'utf8'))
const alias: Record<string,string> = {'@agentmux/identity':resolve(root,'packages/identity/src/index.ts')}
for (const [name,value] of Object.entries(coreManifest.exports) as [string,{import?:string}][]) {
  if (!value.import) continue
  const source=resolve(root,'packages/core',value.import.replace('./dist/','./src/').replace(/\.js$/,'.ts'))
  if(existsSync(source)) alias[name==='.'?'@agentmux/core':'@agentmux/core/'+name.slice(2)] = source
}
assert.ok(Object.keys(alias).length>20 && alias['@agentmux/core/object-id'],'Nonempty real public export source set')
const rules: Record<string, [string,string,string]> = {
  'file-facts': ['apps/desktop/src/renderer/src/lib/file-workbench-state.ts', 'if (original) return { tabId: original.tab.id, regionId: original.surface.regionId }', 'if (false && original) return { tabId: original.tab.id, regionId: original.surface.regionId }'],
  'rename-identity': ['apps/desktop/src/renderer/src/lib/file-workbench-state.ts', 'tabs[tab.id] = {', 'delete tabs[tab.id]; tabs[fileTabId(workspaceId, nextPath)] = {'],
  'topic-directory': ['apps/desktop/src/shared/scratch-topic-identity.mjs', 'if (isObjectId(id)) return id', 'if (isObjectId(id)) return null'],
  'file-domain': ['apps/desktop/src/renderer/src/lib/workbench-tabs.ts', "deriveObjectId('workbench.file-tab', JSON.stringify([workspaceId, path, incarnation]))", "'file:' + workspaceId + ':' + path + ':' + incarnation"],
  'region-occupancy': ['apps/desktop/src/renderer/src/lib/workbench-tabs.ts', 'tabs[tabId] || occupiedRegions.has(regionId)', 'tabs[tabId]'],
  'session-owner': ['apps/desktop/src/renderer/src/store.ts', 'const { tabId, regionId } = availableWorkbenchTabIdentity(current.tabs, incarnation => sessionTabId(id, incarnation))', 'const tabId = sessionTabId(id), regionId = initialWorkbenchRegionId(tabId)'],
  'prompt-id': ['apps/desktop/src/renderer/src/lib/goals-common-actions.ts', 'id = mintObjectId()', "id = 'prompt-' + crypto.randomUUID()"]
}
export default defineConfig({ ...original, root, resolve:{alias:Object.entries(alias).map(([name,replacement])=>({find:new RegExp('^'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$'),replacement})),conditions:['browser','import','default']}, ssr:{noExternal:['@agentmux/client-ui'],resolve:{conditions:['browser','import','default']}}, plugins: [{ name:'unified-object-id-source-evidence', enforce:'pre', transform(source,id) {
  const path=id.split('?')[0]!, name=relative(root,path)
  if (!name.startsWith('apps/') && !name.startsWith('packages/')) return
  let code=source
  const mutation=process.env.AMUX_RENDERER_ID_MUTATION
  if(mutation) { assert.ok(rules[mutation]); const [target,anchor,replacement]=rules[mutation]!; if(name===target) { assert.ok(source.includes(anchor)); code=source.replace(anchor,replacement) } }
  if(process.env.AMUX_RENDERER_ID_LOADED) appendFileSync(process.env.AMUX_RENDERER_ID_LOADED, JSON.stringify({path:name,sourceSHA256:createHash('sha256').update(source).digest('hex'),loadedSHA256:createHash('sha256').update(code).digest('hex'),mutated:source!==code})+'\n')
  if(code!==source)return {code,map:null}
} }], test:{...original.test, globalSetup:[], include:['apps/desktop/test/unified-object-id.test.ts','apps/desktop/test/unified-object-id-store.test.ts','apps/desktop/test/unified-object-id-process-restore.test.ts','apps/desktop/test/browser-task-batch-editor.test.tsx','apps/desktop/test/goals-common-actions.test.tsx',...(process.env.AMUX_RENDERER_ID_EXECUTOR_ONLY ? ['apps/desktop/test/settings-executor-creation.test.tsx'] : [])], fileParallelism:false,maxWorkers:1,passWithNoTests:false,testTimeout:30000, ...(process.env.AMUX_RENDERER_ID_EXECUTOR_ONLY ? {testNamePattern:/identity:|rerolls a forced short code collision/} : {})} })
