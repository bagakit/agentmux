import {defineConfig} from 'vitest/config'
import {appendFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {resolve,relative} from 'node:path'
import base from './vitest.mote-context.config.mts'
const root=resolve(import.meta.dirname,'../../..'),mutant=process.env.AGENTMUX_FOCUS_MUTANT
const variants:Record<string,[string,string]>={
  'wait-for-global-discovery':['const topics = scratchTopicsForConfig(currentFacts.config, currentFacts.scratchTopicSnapshots) ?? []',"const topics = await api.scratch.listTopics(SCRATCH_WORKSPACE_ID)"],
  'ignore-snapshot-source':['const topics = scratchTopicsForConfig(currentFacts.config, currentFacts.scratchTopicSnapshots) ?? []','const topics = currentFacts.scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]?.topics ?? []'],
  'ignore-agent-host':['(request.expectedAgentHostId === undefined || original.execution?.hostId === request.expectedAgentHostId)','true'],
  'ignore-agent-session':['original?.kind === \'agent\' && original.agentSessionId === request.expectedAgentSessionId','original?.kind === \'agent\''],
  'ignore-later-navigation':['if (navigationChanged || fileNavigationSelection(get()) !== originalNavigation','if (false || fileNavigationSelection(get()) !== originalNavigation'],
  'ignore-cancellation':['        requireActive()','        void 0'],
  'steal-preserved-input':['const before = captureDesktopInput(get().tabs)',"request = { ...request, inputPolicy:'target' }; const before = captureDesktopInput(get().tabs)"]
}
if(mutant&&!variants[mutant])throw Error('Unknown focus readiness mutation')
const sha=(text:string)=>createHash('sha256').update(text).digest('hex')
export default defineConfig({...base,cacheDir:base.cacheDir+'-focus-readiness',plugins:[...base.plugins??[],{
  name:'loaded-exact-focus-source',enforce:'pre',transform(original,id){
    if(relative(root,id.split('?')[0]!)!=='apps/desktop/src/renderer/src/store.ts')return
    const start=original.indexOf("    if (request.operation === 'focus') {");if(start<0)throw Error('Original focus owner missing')
    const end=original.indexOf('\n    if (',start+12),block=original.slice(start,end),choice=mutant&&variants[mutant]
    let changed=block
    if(choice){const[before,after]=choice;if(block.split(before).length!==2)throw Error('One exact focus mutation anchor required: '+mutant);changed=block.replace(before,after)}
    if(process.env.AGENTMUX_FOCUS_TRACE)appendFileSync(process.env.AGENTMUX_FOCUS_TRACE,JSON.stringify({kind:'focus-source',mutant:mutant??null,file:'apps/desktop/src/renderer/src/store.ts',sourceSha256:sha(original),focusSha256:sha(block),changedFocusSha256:sha(changed)})+'\n')
    return choice?{code:original.slice(0,start)+changed+original.slice(end),map:null}:null
  }
}],test:{...base.test,setupFiles:[...base.test?.setupFiles??[],'apps/host/test/fixtures/mote-continuity-rollover-runtime.ts'],include:process.env.AGENTMUX_FOCUS_REGRESSION?['apps/desktop/test/spatial-link-navigation.test.ts']:['apps/desktop/test/focus-discovery-readiness.test.tsx'],testNamePattern:process.env.AGENTMUX_FOCUS_TEST_PATTERN,passWithNoTests:false,maxWorkers:1,testTimeout:30000}})
