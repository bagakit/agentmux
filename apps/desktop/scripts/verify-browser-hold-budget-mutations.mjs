import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const root=resolve(import.meta.dirname,'../../..'), output=join(root,'.local/browser-standalone/hold-mutations')
await mkdir(output,{recursive:true})
const tests=['apps/desktop/test/browser-program-budget.test.ts','apps/desktop/test/browser-page-touch.test.ts']
const variants=[{label:'source'},
 {label:'original-budget-port-removed',file:'packages/browser/src/browser-program-owner.ts',from:'remainingMillis: () => runBudget?.remainingMillis() ?? 0,',to:'',expected:'The real ProgramOwner must pass the original script budget'},
 {label:'overflow-timer-restored',file:'packages/browser/src/browser-page-dispatch.ts',from:'timer = setTimeout(next, Math.min(left, MAX_NODE_TIMER_MS))',to:'timer = setTimeout(() => { cleanup(); resolve() }, left)',expected:'An overflowing native hold must not become a 1ms success'},
 {label:'restored-source'}]
const hash=value=>createHash('sha256').update(value).digest('hex')
const receipt={schema:'agentmux.browser-hold-budget.proof.v1',head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sources:{},runs:[],passed:false}
for(const file of ['packages/browser/src/browser-script-runner.ts',...variants.filter(row=>row.file).map(row=>row.file),...tests])receipt.sources[file]=hash(await readFile(join(root,file)))
try{
 for(const row of variants){
  const loaded=join(output,row.label+'-loaded.json'),config=join(output,row.label+'.mjs')
  let plugin=''
  if(row.file){const file=join(root,row.file),source=await readFile(file,'utf8');assert.equal(source.split(row.from).length-1,1,'Mutant changes one actual production block');const changed=source.replace(row.from,row.to);row.mutatedSha256=hash(changed)
   plugin=`,plugins:[{name:'original-hold-source-mutant',enforce:'pre',load(id){if(id.split('?')[0]!==${JSON.stringify(file)})return;writeFileSync(${JSON.stringify(loaded)},${JSON.stringify(JSON.stringify({file:row.file,original:hash(source),mutated:hash(changed)}))});return ${JSON.stringify(changed)}}}]`
  }
  await writeFile(config,`import base from ${JSON.stringify(join(root,'vitest.config.ts'))};import{writeFileSync}from'node:fs';export default {...base${plugin},test:{...base.test,include:${JSON.stringify(tests)}}}\n`)
  const result=spawnSync(process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run',...tests,'-t','original runner budget|spans Node timer sections','--root',root,'--config',config,'--maxWorkers=1'],{cwd:root,encoding:'utf8',timeout:60_000})
  const log=(result.stdout??'')+(result.stderr??'');await writeFile(join(output,row.label+'.log'),log)
  const evidence={label:row.label,code:result.status,signal:result.signal,passed:false};receipt.runs.push(evidence)
  if(row.file){assert.notEqual(result.status,null,'A timeout or killed process is not a RED witness');assert.notEqual(result.status,0,'Mutation must fail');assert.ok(log.includes(row.expected),'RED must come from the exact behavior witness');assert.equal(JSON.parse(await readFile(loaded,'utf8')).mutated,row.mutatedSha256);evidence.mutationRejected=true}
  else{assert.equal(result.status,0,log);assert.match(log,/2 passed/);evidence.passed=true}
 }
 receipt.passed=true
}finally{await writeFile(join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')}
console.log(JSON.stringify({passed:receipt.passed,receipt:join(output,'receipt.json')}))
