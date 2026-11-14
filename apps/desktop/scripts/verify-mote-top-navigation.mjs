import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
const root=path.resolve(import.meta.dirname,'../../..'), evidence=path.join(root,'.local/mote-thread-navigation')
await fs.mkdir(evidence,{recursive:true})
const receipt={passed:false,baseline:null,mutations:[]}
const run=(env,pattern)=>spawnSync('pnpm',['exec','vitest','run','--config','apps/desktop/test/mote-top-navigation.config.mts',...(pattern?['-t',pattern]:[])],{cwd:root,env:{...process.env,...env},encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024})
try{
 const baseline=run({}); await fs.writeFile(path.join(evidence,'product-tests.log'),baseline.stdout+baseline.stderr)
 assert.equal(baseline.status,0,'Actual product baseline must pass');receipt.baseline={passed:true}
 for(const [name,pattern] of [['duplicate-count','top navigation counts'],['unknown-zero','unconfirmed work metadata'],['wrong-host','quick jump follows'],['waiting-is-active','quick jump follows'],['drop-main-dom','real compact entry']]){
  const trace=path.join(evidence,name+'.jsonl');await fs.rm(trace,{force:true})
  const result=run({AGENTMUX_MOTE_TOP_MUTATION:name,AGENTMUX_MOTE_TOP_TRACE:trace},pattern)
  await fs.writeFile(path.join(evidence,name+'.log'),result.stdout+result.stderr)
  const loaded=(await fs.readFile(trace,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))
  assert.ok(loaded.length>0&&loaded.every(row=>row.original!==row.changed),'Nonempty mutated original product input required')
  assert.equal(result.status,1,'Mutation must fail an actual assertion: '+name)
  assert.match(result.stdout+result.stderr,/AssertionError|expected .* to|TypeError/,'Mutation must reach product assertion: '+name)
  receipt.mutations.push({name,loaded,killed:true});console.log('Killed '+name)
 }
 assert.equal(receipt.mutations.length,5);receipt.passed=true
}catch(error){receipt.error=String(error);process.exitCode=1}
await fs.writeFile(path.join(evidence,'verification.json'),JSON.stringify(receipt,null,2)+'\n')
console.log(JSON.stringify({passed:receipt.passed,mutations:receipt.mutations.length,error:receipt.error}))
