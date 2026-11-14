import {defineConfig} from 'vitest/config'
import {appendFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {relative,resolve} from 'node:path'
import base from './vitest.mote-context.config.mts'
const root=resolve(import.meta.dirname,'../../..'),mutant=process.env.MOTE_POLICY_MUTANT
const variants:Record<string,{file:string;edits:Array<[string,string]>}>={
  'borrow-settings':{file:'lib/mote-main-service.ts',edits:[["if (scope.issue || saved?.status !== 'saved' || !current || saved.version !== main.documentRevision ||","if (saved?.status !== 'saved' || !current || false && (scope.issue || saved.version !== main.documentRevision ||"],["moteMainRoleRevision(saved.defaults, saved.version ?? null) !== main.roleRevision) return", "moteMainRoleRevision(saved.defaults, saved.version ?? null) !== main.roleRevision)) return"]]},
  'missing-is-automatic':{file:'lib/mote-main-service.ts',edits:[["!policy ? 'unconfigured'", "!policy ? 'automatic'"]]},
  'enabled-is-executing':{file:'lib/mote-main-service.ts',edits:[["已开启自动接续。新问题由保存的策略决定是否切换。", "正在切换到新的主 Agent。"]]},
  'duplicate-original-faults':{file:'components/SessionPane.tsx',edits:[["moteMainService: Boolean(moteWorkface?.mainService", "moteMainService: Boolean(false && moteWorkface?.mainService"]]},
  'hide-original-actions':{file:'components/ActivityView.tsx',edits:[["!moteConversation || moteMainService ? readingAction", "!moteConversation ? readingAction"]]},
  'forget-creation-progress':{file:'components/MoteMainActions.tsx',edits:[["onPending?.(pending)","onPending?.([])"]]},
  'unknown-is-unavailable':{file:'lib/mote-main-service.ts',edits:[["if (status === 'unconfirmed')", "if (false && status === 'unconfirmed')"]]},
  'mislabel-cause':{file:'components/MoteConversationStart.tsx',edits:[["automatic.decision.policy.kind === 'continuity-unavailable'", "false && automatic.decision.policy.kind === 'continuity-unavailable'"]]}
}
if(mutant&&!variants[mutant])throw Error('Unknown Main service mutation')
export default defineConfig({...base,cacheDir:base.cacheDir+'-policy-service',plugins:[...base.plugins??[],{
  name:'loaded-mote-policy-service',enforce:'pre',transform(original,id){
    const target=mutant&&variants[mutant],file=relative(root,id.split('?')[0]!)
    if(!target||file!=='apps/desktop/src/renderer/src/'+target.file)return
    let changed=original
    for(const [before,after]of target.edits){if(changed.split(before).length!==2)throw Error('One production mutation anchor required: '+mutant);changed=changed.replace(before,after)}
    if(!process.env.MOTE_POLICY_TRACE)throw Error('Loaded production trace required')
    const sha=(s:string)=>createHash('sha256').update(s).digest('hex')
    appendFileSync(process.env.MOTE_POLICY_TRACE,JSON.stringify({mutant,file,original:sha(original),changed:sha(changed)})+'\n')
    return{code:changed,map:null}
  }
}],test:{...base.test,include:['apps/desktop/test/mote-policy-service.test.tsx'],passWithNoTests:false,maxWorkers:1,testTimeout:30000}})
