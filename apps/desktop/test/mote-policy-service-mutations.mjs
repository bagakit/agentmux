import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {resolve,join} from 'node:path'
const output=resolve(process.env.MOTE_POLICY_MUTATIONS_OUTPUT??'.local/state/mote-main-recovery-escape/presentation/mutations')
await mkdir(output,{recursive:true})
const cases=[['borrow-settings','different'],['missing-is-automatic','the current Main'],['enabled-is-executing','saved automatic'],
  ['duplicate-original-faults','the current Main'],['hide-original-actions','the current Main'],['forget-creation-progress','unknown original creation'],
  ['unknown-is-unavailable','unknown original recovery'],['mislabel-cause','original typed unavailable decision']]
const result={passed:false,mutations:[]}
for(const [name,pattern]of cases){
  const trace=join(output,name+'.ndjson'),json=join(output,name+'.json')
  const execution=await new Promise((done,reject)=>{
    let stdout='',stderr=''
    const child=spawn(process.execPath,['node_modules/vitest/vitest.mjs','run','--config','apps/desktop/test/mote-policy-service.config.mts','--reporter=json','--outputFile='+json,'-t',pattern],
      {env:{...process.env,MOTE_POLICY_MUTANT:name,MOTE_POLICY_TRACE:trace},stdio:['ignore','pipe','pipe']})
    child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data)
    child.on('error',reject);child.on('exit',(code,signal)=>done({code,signal,stdout,stderr}))
  })
  await writeFile(join(output,name+'.log'),execution.stdout+execution.stderr)
  const report=JSON.parse(await readFile(json,'utf8')),loaded=(await readFile(trace,'utf8')).trim().split('\n').map(line=>JSON.parse(line))
  const failed=report.testResults.flatMap(s=>s.assertionResults).filter(a=>a.status==='failed')
  const qualified=execution.code===1&&execution.signal===null&&report.numFailedTests>0&&loaded.length>0&&loaded.every(item=>item.original!==item.changed)&&
    failed.every(item=>item.failureMessages.some(message=>message.includes('AssertionError')))
  result.mutations.push({name,pattern,exit:execution.code,selected:report.numPassedTests+report.numFailedTests,failed:report.numFailedTests,loaded,qualified})
  await writeFile(join(output,'proof.json'),JSON.stringify(result,null,2))
  assert.equal(qualified,true,'Expected a nonempty actual consumer semantic RED: '+name)
}
result.passed=true
await writeFile(join(output,'proof.json'),JSON.stringify(result,null,2))
console.log(JSON.stringify({passed:true,mutations:result.mutations.length,output}))
