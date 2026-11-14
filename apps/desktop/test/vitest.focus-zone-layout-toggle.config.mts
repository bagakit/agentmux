import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.focus-zone-organization.config.mts'
const root=resolve(import.meta.dirname,'../../..')
const mutations={
 'wrong-container':['renderer/src/components/FocusZoneLayoutToggle.tsx','key: intent.key, presentation: intent.presentation','key: intent.key + ":wrong", presentation: intent.presentation'],
 'late-scope':['renderer/src/components/FocusZoneLayoutToggle.tsx','if (live.current && scope.current === intent.key && generation.current === token) setAttempt({ intent, token, pending: false','if (live.current) setAttempt({ intent, token, pending: false'],
 'lost-slot':['renderer/src/components/FocusProjectPreferences.tsx','discussionVisited ? discussion?.','open ? discussion?.'],
 'overwrite-later-config':['renderer/src/components/settings/save-config-slice.ts','if (useAppStore.getState().config === current)','if (true)']
} as const
const selected=process.env.AGENTMUX_ZONE_TOGGLE_MUTANT as keyof typeof mutations|undefined
if(selected&&!mutations[selected])throw Error('Unknown Zone toggle mutation')
let applied=false
const sha=(code:string)=>createHash('sha256').update(code).digest('hex')
export default defineConfig({...source,cacheDir:'.tmp/focus-zone-layout-toggle-cache',
 plugins:[...source.plugins??[],{name:'actual-zone-toggle-source',enforce:'pre',transform(original,id){
  const path=relative(root,id.split('?')[0]!),local=path.replace(/^apps\/desktop\/src\//,'');let code=original
  if(selected&&local===mutations[selected][0]){const[,before,after]=mutations[selected];if(code.split(before).length!==2)throw Error('One exact toggle mutation anchor required');code=code.replace(before,after);applied=true;process.stderr.write(`MUTATION_APPLIED=${selected}\n`)}
  if(process.env.AGENTMUX_ZONE_TOGGLE_LOADED&&path.startsWith('apps/desktop/src/')&&/\.[jt]sx?$/.test(path))appendFileSync(process.env.AGENTMUX_ZONE_TOGGLE_LOADED,JSON.stringify({path,original_sha256:sha(original),loaded_sha256:sha(code),mutant:code===original?null:selected})+'\n')
  return code===original?undefined:{code,map:null}
 },buildEnd(){if(selected&&!applied)throw Error('Actual Zone toggle inverse owner was not loaded')}}],
 test:{...source.test,include:['apps/desktop/test/focus-zone-layout-toggle.test.tsx','apps/desktop/test/focus-zone-organization.test.tsx','apps/desktop/test/focus-project-preferences-races.test.tsx','apps/desktop/test/focus-project-appearance.test.tsx'],maxWorkers:1,fileParallelism:false,passWithNoTests:false}
})
