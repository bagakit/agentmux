import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative,resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.focus-project-actions.config.mts'
const root=resolve(import.meta.dirname,'../../..')
const mutations={
 'expanded-default':['renderer/src/components/FocusProjectPreferences.tsx','setAppearanceOpen(false); baseline.current','setAppearanceOpen(true); baseline.current'],
 'lost-collapsed-draft':['renderer/src/components/FocusProjectPreferences.tsx','onClick={() => setAppearanceOpen(value => !value)}','onClick={() => { setDraft(saved); setAppearanceOpen(value => !value) }}'],
 'verbose-actions':['renderer/src/components/MoteTaskAction.tsx',"orientation !== 'vertical' && action.description ?",'action.description ?']
} as const
const selected=process.env.AGENTMUX_COMPACT_MENU_MUTANT as keyof typeof mutations|undefined
if(selected&&!mutations[selected])throw Error('Unknown compact menu inverse')
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');let applied=false
export default defineConfig({...source,cacheDir:'.tmp/focus-menu-compact-cache',plugins:[...source.plugins??[],{name:'actual-compact-menu-source',enforce:'pre',transform(original,id){
 const path=relative(root,id.split('?')[0]!),local=path.replace(/^apps\/desktop\/src\//,'');let code=original
 if(selected&&local===mutations[selected][0]){const[,before,after]=mutations[selected];if(code.split(before).length!==2)throw Error('One exact compact menu inverse anchor required');code=code.replace(before,after);applied=true;process.stderr.write(`MUTATION_APPLIED=${selected}\n`)}
 if(process.env.AGENTMUX_COMPACT_MENU_LOADED&&path.startsWith('apps/desktop/src/')&&/\.[jt]sx?$/.test(path))appendFileSync(process.env.AGENTMUX_COMPACT_MENU_LOADED,JSON.stringify({path,original_sha256:sha(original),loaded_sha256:sha(code),mutant:code===original?null:selected})+'\n')
 return code===original?undefined:{code,map:null}
},buildEnd(){if(selected&&!applied)throw Error('Actual compact menu inverse owner not loaded')}}],test:{...source.test,include:['apps/desktop/test/focus-project-actions.test.tsx','apps/desktop/test/focus-project-preferences-races.test.tsx','apps/desktop/test/focus-project-appearance.test.tsx','apps/desktop/test/focus-zone-layout-toggle.test.tsx'],maxWorkers:1,fileParallelism:false,passWithNoTests:false}})
