import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
process.umask(0o077)
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), loader = join(repo,'packages/core/scripts/helpers/core-source-loader.mjs')
const fixture = join(repo,'packages/core/test/fixtures/goal-input-epoch-reader-proof.mjs')
const evidence = process.env.AGENTMUX_RELIABILITY_EVIDENCE_DIRECTORY ?? join(repo,'.local/reliability-fixes/runtime')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const ts=(await import('node:module')).createRequire(join(repo,'packages/core/package.json'))('typescript')
const worker=join(evidence,'goal-input-epoch-reader-listener.mjs'),workerSource=join(repo,'packages/core/src/control-endpoint-listener-worker.ts')
await mkdir(evidence,{recursive:true});await writeFile(worker,ts.transpileModule(await readFile(workerSource,'utf8'),{fileName:workerSource,compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext}}).outputText,{mode:0o600})
const temporary = await mkdtemp(join(tmpdir(),'amux-goal-reader-')), cases = [
  { name:'baseline' },
  { name:'remove-no-run-reader', mutation:{path:'/src/space-member-codec.ts',from:"  if (invocation.method === 'readAgentInputEpoch') { if (invocation.args.length !== 0) mismatch(); return }",to:''}, assertion:'exact conversation-only namespace reader remains usable' },
  { name:'allow-full-session-without-run', mutation:{path:'/src/space-member-codec.ts',from:"if (!('expectedRun' in target)) throw",to:'if (false) throw'}, assertion:'namespace reader cannot open full Session metadata' },
  { name:'drop-goal-runtime-pin', mutation:{path:'/src/goal-input-epoch.ts',from:'runtimeId !== input.agentReference.execution.runtimeId || ',to:''}, assertion:'Goal reader refuses a different Runtime pin' }
]
try {
  const results=[]
  for(const test of cases){
    const loaded=join(temporary,'loads.ndjson')
    await writeFile(loaded,'',{mode:0o600})
    const result=spawnSync(process.execPath,['--import',loader,fixture],{cwd:repo,encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024,
      env:{...process.env,AGENTMUX_SOURCE_LISTENER_ASSET:worker,AGENTMUX_SOURCE_LOAD_LOG:loaded,AGENTMUX_SOURCE_MUTATION_JSON:JSON.stringify(test.mutation?[test.mutation]:[])}})
    const sources=(await readFile(loaded,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))
    assert.ok(sources.length>0,'the actual consumer must load original source')
    if(test.mutation){assert.notEqual(result.status,0,test.name);assert.ok((result.stdout+result.stderr).includes(test.assertion),test.name+' must fail at its business counterexample');assert.ok(sources.some(item=>item.mutations.length===1),'mutation must be actually loaded')}
    else {assert.equal(result.status,0,result.stderr);assert.ok(result.stdout.includes('GOAL_INPUT_EPOCH_READER_PASS:'))}
    const unique=[...new Map(sources.map(item=>[item.path,item])).values()]
    results.push({name:test.name,status:result.status,mutantKilled:Boolean(test.mutation),assertion:test.assertion??null,sources:unique.map(({path,sourceSHA256,loadedSHA256})=>({path,sourceSHA256,loadedSHA256}))})
  }
  await mkdir(evidence,{recursive:true})
  const receipt={schema:'agentmux.goal-input-epoch-reader-proof.v1',verdict:'pass',scope:'actual public Host/Hosted SDK/Unix RPC/source CLI pure Goal namespace reader with controlled Source authority/namespace leaves; zero Native/Run/input/subscription',listener:{sourceSHA256:hash(await readFile(workerSource)),compiledSHA256:hash(await readFile(worker))},runnerSHA256:hash(await readFile(fileURLToPath(import.meta.url))),fixtureSHA256:hash(await readFile(fixture)),loaderSHA256:hash(await readFile(loader)),results,productionWrites:0,nativeCalls:0,temporaryCleanup:true}
  await writeFile(join(evidence,'goal-input-epoch-reader.private.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600})
  console.log(JSON.stringify({verdict:'pass',cases:results.length,mutants:results.filter(item=>item.mutantKilled).length,nativeCalls:0}))
}finally{await rm(temporary,{recursive:true,force:true})}
