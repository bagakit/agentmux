import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import { defineConfig } from 'vitest/config'
import owning from './workbench-window-presentations.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const workspace = 'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx'
const stage = 'apps/desktop/src/renderer/src/components/BrowserPresentationStage.tsx'
const mutations: Record<string, {file: string; changes: readonly [string,string][]}> = {
  'drop-primary-stage': { file: workspace, changes: [['primaryStage={primaryStage}', 'primaryStage={undefined}']] },
  'drop-window-document': { file: stage, changes: [["api.browser.registerPresentation({ ...(windowDocument ? { window: windowDocument } : {}), browserId", 'api.browser.registerPresentation({ browserId']] },
  'eager-cold-stage': { file: stage, changes: [
    ['if (cancelled || registering || lease.current || !geometry().visible) return', 'if (cancelled || registering || lease.current) return'],
    ['const mountTask = setTimeout(() => { if (!cancelled) observe() }, 0)', 'const mountTask = setTimeout(() => { if (!cancelled) void mount().catch(failure) }, 0)']
  ] }
}
export default defineConfig({...owning, plugins:[...(owning.plugins??[]),{
 name:'actual-browser-window-stage-proof',enforce:'pre',transform(source,id){
  const file=relative(root,id.split('?')[0]!)
  if(![workspace,stage,'apps/desktop/src/renderer/src/components/BrowserPane.tsx'].includes(file))return
  const mutation=process.env.BROWSER_WINDOW_COMPONENT_MUTATION
  const selected=mutation?mutations[mutation]:undefined
  if(mutation)assert.ok(selected,'Declared actual Browser stage mutation')
  let code=source
  if(selected?.file===file)for(const [before,after] of selected.changes){
   assert.equal(code.split(before).length,2,'One exact current owner anchor: '+mutation)
   code=code.replace(before,after)
  }
  if(process.env.BROWSER_WINDOW_COMPONENT_LOADED)appendFileSync(process.env.BROWSER_WINDOW_COMPONENT_LOADED,
   JSON.stringify({file,mutated:code!==source,source:createHash('sha256').update(source).digest('hex'),loaded:createHash('sha256').update(code).digest('hex')})+'\n')
  return code===source?undefined:{code,map:null}
 }
}],test:{...owning.test,include:['test/workbench-window-return.test.tsx','test/workbench-browser-primary-stage.test.tsx','test/workbench-window-presentations.test.tsx'],passWithNoTests:false}})
