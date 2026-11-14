import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
process.umask(0o077)
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), loader = join(repo,'packages/core/scripts/helpers/core-source-loader.mjs')
const fixture = join(repo,'packages/core/test/fixtures/goal-input-cut-proof.mjs')
const evidence = process.env.AGENTMUX_RELIABILITY_EVIDENCE_DIRECTORY ?? join(repo,'.local/reliability-fixes/runtime')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const temporary = await mkdtemp(join(tmpdir(),'amux-goal-cut-')), cases = [
  { name:'baseline' },
  { name:'refresh-old-discussion-condition', mutation:{path:'/apps/host/src/goal-discussions.ts',from:'{ expectedRun: key.expectedRun, afterSubmissionId: frozen.afterSubmissionId, ...optionalInputEpoch(frozen.inputEpoch) }',to:'agentPromptCondition(observed.session)'}, assertion:'old discussion request must reach its old input authority without renewal' },
  { name:'drop-finite-epoch', mutation:{path:'/apps/host/src/goal-finite-runtime.ts',from:'...optionalInputEpoch(value.inputEpoch),',to:''}, assertion:'fresh qualified source input remains usable' },
  { name:'drop-stored-discussion-epoch', mutation:{path:'/packages/demand/src/discussion.ts',from:'...structuredClone(p) as DemandDiscussionInput, ...optionalDemandInputEpoch(p.inputEpoch)',to:'...structuredClone(p) as DemandDiscussionInput, inputEpoch: undefined'}, assertion:'fresh discussion first request remains usable' },
  { name:'drop-legacy-reference-cut', mutation:{path:'/apps/host/src/goal-dispatch-input.ts',from:'reference.inputEpoch !== original.inputEpoch || ',to:''}, assertion:'different original Goal input cut must refuse before submission' }
]
try {
  const results=[]
  for(const test of cases){
    const loaded=join(temporary,'loads.ndjson'), root=join(temporary,test.name)
    await mkdir(root)
    await writeFile(loaded,'',{mode:0o600})
    const result=spawnSync(process.execPath,['--import',loader,fixture],{cwd:repo,encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024,
      env:{...process.env,AGENTMUX_GOAL_CUT_ROOT:root,AGENTMUX_SOURCE_LOAD_LOG:loaded,AGENTMUX_SOURCE_MUTATION_JSON:JSON.stringify(test.mutation?[test.mutation]:[])}})
    const sources=(await readFile(loaded,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))
    assert.ok(sources.length>0,'the actual consumer must load original source')
    if(test.mutation){assert.notEqual(result.status,0,test.name);assert.ok((result.stdout+result.stderr).includes(test.assertion),test.name+' must fail at its business counterexample');assert.ok(sources.some(item=>item.mutations.length===1),'mutation must be actually loaded')}
    else {assert.equal(result.status,0,result.stderr);assert.ok(result.stdout.includes('GOAL_INPUT_CUT_PASS:'))}
    await rm(root,{recursive:true,force:true})
    const unique=[...new Map(sources.map(item=>[item.path,item])).values()]
    results.push({name:test.name,status:result.status,mutantKilled:Boolean(test.mutation),assertion:test.assertion??null,sources:unique.map(({path,sourceSHA256,loadedSHA256})=>({path,sourceSHA256,loadedSHA256}))})
  }
  await mkdir(evidence,{recursive:true})
  const receipt={schema:'agentmux.goal-input-cut-proof.v1',verdict:'pass',scope:'actual durable Demand/Spatial owners and original Host discussion/finite consumers with a controlled Core input leaf; no real Native',runnerSHA256:hash(await readFile(fileURLToPath(import.meta.url))),fixtureSHA256:hash(await readFile(fixture)),loaderSHA256:hash(await readFile(loader)),results,productionWrites:0,nativeCalls:0,temporaryCleanup:true}
  await writeFile(join(evidence,'goal-input-cut.private.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600})
  console.log(JSON.stringify({verdict:'pass',cases:results.length,mutants:results.filter(item=>item.mutantKilled).length,nativeCalls:0}))
}finally{await rm(temporary,{recursive:true,force:true})}
