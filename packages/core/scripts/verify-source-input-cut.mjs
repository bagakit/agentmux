import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
process.umask(0o077)
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), loader = join(repo,'packages/core/scripts/helpers/core-source-loader.mjs')
const fixture = join(repo,'packages/core/test/fixtures/source-input-cut-proof.mjs')
const evidence = process.env.AGENTMUX_RELIABILITY_EVIDENCE_DIRECTORY ?? join(repo,'.local/reliability-fixes/runtime')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const temporary = await mkdtemp(join(tmpdir(),'amux-source-cut-')), cases = [
  { name:'baseline' },
  { name:'drop-runtime-pin', mutation:{path:'/src/agent-open-contract.ts',from:'original.runtimeId !== (target?.runtimeId ?? input.expectedRuntimeId) || ',to:''}, assertion:'wrong exact execution Runtime must refuse' },
  { name:'managed-reader', mutation:{path:'/apps/host/src/spatial-agent-control.ts',from:"if (context.caller || !context.principal || !['user','device'].includes(context.principal.kind))",to:'if (false)'}, assertion:'Missing expected rejection' },
  { name:'execution-only-consumes-optional-description', mutation:{path:'/src/public-rpc-service.ts',from:'if (!input.executionOnly) try { contracts =',to:'if (true) try { contracts ='}, assertion:'Expected values to be strictly equal' }
]
try {
  const results=[]
  for(const test of cases){
    const loaded=join(temporary,'loads.ndjson')
    await writeFile(loaded,'',{mode:0o600})
    const result=spawnSync(process.execPath,['--import',loader,fixture],{cwd:repo,encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024,
      env:{...process.env,AGENTMUX_SOURCE_LOAD_LOG:loaded,AGENTMUX_SOURCE_MUTATION_JSON:JSON.stringify(test.mutation?[test.mutation]:[])}})
    const sources=(await readFile(loaded,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))
    assert.ok(sources.length>0,'the actual consumer must load original source')
    if(test.mutation){assert.notEqual(result.status,0,test.name);assert.ok((result.stdout+result.stderr).includes(test.assertion),test.name+' must fail at its business counterexample');assert.ok(sources.some(item=>item.mutations.length===1),'mutation must be actually loaded')}
    else {assert.equal(result.status,0,result.stderr);assert.ok(result.stdout.includes('SOURCE_INPUT_CUT_PASS:'))}
    const unique=[...new Map(sources.map(item=>[item.path,item])).values()]
    results.push({name:test.name,status:result.status,mutantKilled:Boolean(test.mutation),assertion:test.assertion??null,sources:unique.map(({path,sourceSHA256,loadedSHA256})=>({path,sourceSHA256,loadedSHA256}))})
  }
  await mkdir(evidence,{recursive:true})
  const receipt={schema:'agentmux.source-input-cut-proof.v1',verdict:'pass',scope:'actual Source/Host/RPC-service pure consumers with controlled authority/namespace leaves; no real Native/Run or route transport',runnerSHA256:hash(await readFile(fileURLToPath(import.meta.url))),fixtureSHA256:hash(await readFile(fixture)),loaderSHA256:hash(await readFile(loader)),results,productionWrites:0,nativeCalls:0,temporaryCleanup:true}
  await writeFile(join(evidence,'source-input-cut.private.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600})
  console.log(JSON.stringify({verdict:'pass',cases:results.length,mutants:results.filter(item=>item.mutantKilled).length,nativeCalls:0}))
}finally{await rm(temporary,{recursive:true,force:true})}
