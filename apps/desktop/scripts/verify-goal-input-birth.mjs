import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
const root=resolve(import.meta.dirname,'../../..'),evidence=process.env.AGENTMUX_GOAL_INPUT_EVIDENCE
assert.ok(evidence,'An exact private evidence directory is required')
mkdirSync(evidence,{recursive:true,mode:0o700})
const phases=[]
for(const [label,selected] of [['baseline'],['drop-qualified-cut','two association connection choices'],['mint-on-partial-selection','two association connection choices'],['renew-original-cut','editing an old operation'],['drop-submission-cut','two association connection choices'],['accept-wrong-goal-runtime','a wrong Runtime namespace reply'],['drop-main-goal-reader','two association connection choices'],['upgrade-old-store-cut','editing an old operation'],['drop-main-dispatch-cut','Main forwards'],['restored']]){
 const mutation=selected?label:'',output=join(evidence,label+'.json'),sources=join(evidence,label+'.sources.ndjson')
 writeFileSync(sources,'',{mode:0o600})
 const result=spawnSync(process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run','--config','apps/desktop/test/vitest.goal-input-birth.config.mts','--reporter=json','--outputFile='+output,...(selected?['-t',selected]:[])],{cwd:root,encoding:'utf8',timeout:120_000,env:{...process.env,AGENTMUX_GOAL_INPUT_MUTATION:mutation,AGENTMUX_GOAL_INPUT_SOURCE_PROOF:sources}})
 writeFileSync(join(evidence,label+'.log'),result.stdout+result.stderr,{mode:0o600});assert.equal(result.error,undefined)
 const report=JSON.parse(readFileSync(output,'utf8')),assertions=report.testResults.flatMap(test=>test.assertionResults).filter(test=>['passed','failed'].includes(test.status)),failed=assertions.filter(test=>test.status==='failed')
 assert.equal(assertions.length,mutation?1:12,'Exact nonempty real consumer selection')
 if(mutation){assert.equal(result.status,1);assert.ok(failed.some(test=>test.fullName.includes(selected)&&test.failureMessages.some(message=>/AssertionError|promise resolved .*instead of rejecting|promise rejected .*instead of resolving/u.test(message))),label+': behavior kills mutation')}
 else{assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(failed.length,0)}
 const loaded=readFileSync(sources,'utf8').trim().split('\n').filter(Boolean).map(value=>JSON.parse(value))
 for(const file of ['apps/desktop/src/main/ipc.ts','apps/desktop/src/renderer/src/components/GoalFiniteStartControl.tsx','apps/desktop/src/renderer/src/lib/goal-finite-start.ts'])assert.ok(loaded.some(source=>source.path===join(root,file)),file+': actual consumer loaded')
 if(!mutation)for(const file of ['apps/host/src/goals.ts','packages/core/src/goal-input-epoch.ts'])assert.ok(loaded.some(source=>source.path===join(root,file)),file+': exact current owner')
 if(mutation)assert.ok(loaded.some(source=>source.mutation===mutation&&source.sha256!==source.compiledSHA256))
 phases.push({label,passed:assertions.length-failed.length,failed:failed.length,exitCode:result.status});console.log(label+': '+(mutation?'target mutation killed':'passed'))
}
writeFileSync(join(evidence,'verification.json'),JSON.stringify({schema:'agentmux.desktop-goal-input-birth.v1',passed:true,root,phases,boundary:'Original Goal component/Store/form CAS and trusted registered Main/preload through real local Unix namespace RPC. Real Host Source/Execution Core qualified creation input with official private namespace cut: fresh task admitted once, same operation confirmed; old request remains unknown with zero Native input. Association UI namespace authority leaf controlled separately; physical Provider/Native leaves controlled. No production/user Runtime effects.'},null,2)+'\n',{mode:0o600})
