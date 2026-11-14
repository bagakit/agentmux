import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
const output=resolve(process.env.MOTE_QUERY_CUSTODY_OUTPUT??'.tmp/mote-main-query-custody-mutations')
await mkdir(output,{recursive:true})
const cases=[['old-input-blocks-ready','actual App admits'],['old-input-labels-creation','shared creation projection'],['old-inspection-hidden','shared creation projection'],
  ['unknown-creation-admitted','pending Core creation|local creation'],['old-preparation-blocks-ready','actual App admits'],['workface-creation-disconnected','an unknown original creation opens',true]]
const selected=process.env.MOTE_QUERY_CUSTODY_ONLY?.split(',')
if(selected?.some(name=>!cases.some(item=>item[0]===name)))throw Error('Unknown selected custody mutation')
const proof={passed:false,mutations:[]}
for(const [name,pattern,compat]of cases.filter(item=>!selected||selected.includes(item[0]))){
  const json=join(output,name+'.json'),trace=join(output,name+'.ndjson')
  const execution=await new Promise((done,reject)=>{
    let stdout='',stderr=''
    const child=spawn(process.execPath,['node_modules/vitest/vitest.mjs','run','--config','apps/desktop/test/mote-main-query-custody.config.mts','--reporter=json','--outputFile='+json,'-t',pattern],
      {env:{...process.env,MOTE_QUERY_CUSTODY_MUTANT:name,MOTE_QUERY_CUSTODY_TRACE:trace,...(compat?{MOTE_QUERY_CUSTODY_COMPAT:'1'}:{})},stdio:['ignore','pipe','pipe']})
    child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk)
    child.on('error',reject);child.on('exit',(code,signal)=>done({code,signal,stdout,stderr}))
  })
  await writeFile(join(output,name+'.log'),execution.stdout+execution.stderr)
  const report=JSON.parse(await readFile(json,'utf8')),loaded=(await readFile(trace,'utf8')).trim().split('\n').map(line=>JSON.parse(line))
  const failed=report.testResults.flatMap(x=>x.assertionResults).filter(x=>x.status==='failed')
  const qualified=execution.code===1&&execution.signal===null&&failed.length>0&&failed.length===report.numFailedTests&&loaded.length>0&&
    failed.every(x=>x.failureMessages.some(message=>message.includes('AssertionError')))&&loaded.every(x=>x.original!==x.changed)
  proof.mutations.push({name,pattern,compat:Boolean(compat),selected:report.numPassedTests+report.numFailedTests,failed:failed.length,loaded,qualified})
  await writeFile(join(output,'proof.json'),JSON.stringify(proof,null,2))
  assert.equal(qualified,true,'A nonempty actual consumer semantic RED is required: '+name)
}
proof.passed=true
await writeFile(join(output,'proof.json'),JSON.stringify(proof,null,2))
console.log(JSON.stringify({passed:true,mutations:proof.mutations.length,output}))
