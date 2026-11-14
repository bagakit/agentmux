import {defineConfig} from 'vitest/config'
import {appendFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {resolve,relative} from 'node:path'
import base from './vitest.mote-context.config.mts'
const root=resolve(import.meta.dirname,'../../..'),mutant=process.env.MOTE_QUERY_CUSTODY_MUTANT
const variants:Record<string,{file:string;before:string;after:string}>={
  'old-input-blocks-ready':{file:'components/MoteMainActions.tsx',before:'!pendingCreations.length',after:'!pending.length'},
  'old-input-labels-creation':{file:'components/MoteMainActions.tsx',before:'onPendingCreation?.(pendingCreations)',after:'onPendingCreation?.(pending)'},
  'old-inspection-hidden':{file:'components/MoteMainActions.tsx',before:'[...(reading?.pendingStarts ?? []), ...pendingCreations]',after:'[...pendingCreations]'},
  'unknown-creation-admitted':{file:'components/MoteMainActions.tsx',before:'ready: Boolean(reading && !reading.issue && !pendingCreations.length)',after:'ready: Boolean(reading && !reading.issue)'},
  'old-preparation-blocks-ready':{file:'components/MoteMainActions.tsx',before:'!pendingCreations.length',after:"!pendingCreations.length && result?.creation === 'confirmed'"},
  'workface-creation-disconnected':{file:'components/MoteWorkface.tsx',before:'onPendingCreation={reportPendingCreation}',after:'onPendingCreation={undefined}'}
}
if(mutant&&!variants[mutant])throw Error('Unknown original query custody mutation')
export default defineConfig({...base,cacheDir:base.cacheDir+'-query-custody',plugins:[...base.plugins??[],{
  name:'loaded-original-query-custody',enforce:'pre',transform(code,id){
    const file=relative(root,id.split('?')[0]!),choice=mutant&&variants[mutant]
    if(!choice||file!=='apps/desktop/src/renderer/src/'+choice.file)return
    if(code.split(choice.before).length!==2)throw Error('One exact production anchor required: '+mutant)
    const changed=code.replace(choice.before,choice.after),sha=(s:string)=>createHash('sha256').update(s).digest('hex')
    if(!process.env.MOTE_QUERY_CUSTODY_TRACE)throw Error('Original evaluated production trace required')
    appendFileSync(process.env.MOTE_QUERY_CUSTODY_TRACE,JSON.stringify({mutant,file,original:sha(code),changed:sha(changed)})+'\n')
    return{code:changed,map:null}
  }
}],test:{...base.test,
  setupFiles:[...base.test?.setupFiles??[],'apps/host/test/fixtures/mote-continuity-rollover-runtime.ts'],
  include:process.env.MOTE_QUERY_CUSTODY_COMPAT?['apps/desktop/test/mote-policy-service.test.tsx']:['apps/desktop/test/mote-main-query-custody.test.tsx'],
  testNamePattern:process.env.MOTE_QUERY_CUSTODY_COMPAT?'an unknown original creation opens its existing progress':undefined,
  passWithNoTests:false,maxWorkers:1,testTimeout:45000}})
