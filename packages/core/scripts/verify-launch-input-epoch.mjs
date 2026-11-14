import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir, mkdtemp, rm, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
process.umask(0o077)
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),core=join(repo,'packages/core'),common=resolve(repo,execFileSync('git',['rev-parse','--git-common-dir'],{cwd:repo,encoding:'utf8'}).trim()),main=dirname(common)
const evidence=process.env.AGENTMUX_RELIABILITY_EVIDENCE_DIRECTORY??join(repo,'.local/reliability-fixes/runtime'),temporary=await mkdtemp(join(tmpdir(),'amux-lc-'))
const fixture=join(core,'test/fixtures/launch-input-epoch-proof.mjs'),loader=join(core,'scripts/helpers/core-source-loader.mjs'),vendor=join(core,'vendor')
const daemon=join(vendor,'ctxmux',`${process.platform}-${process.arch}`,'bin/ctxmuxd'),manifest=join(vendor,'ctxmux',`${process.platform}-${process.arch}`,'manifest.json')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),ts=createRequire(join(core,'package.json'))('typescript'),workerSource=join(core,'src/control-endpoint-listener-worker.ts'),worker=join(evidence,'launch-epoch-listener-worker.mjs')
let ownVendor=false,cleanupUnknown=false
const guards="assertAgentInputEpoch(optionalInputEpoch(await this.store.readInputEpoch()), input)"
const tests=['empty','post-launch','post-launch-cut','late-create-cut','resume','resume-no-input','resume-final-unknown'].map(mode=>({name:mode,mode}))
const mutants=[
 {name:'remove-create-cuts',mode:'empty',changes:[{path:'/src/client.ts',from:guards,to:'void input'},{path:'/src/client.ts',from:guards,to:'void input'}],assertion:'old empty create is refused'},
 {name:'remove-final-create-cut',mode:'late-create-cut',changes:[{path:'/src/client.ts',from:'// Recheck after preparation/authority IO, before the first possibly executing Start.\n      if (input.inputRuntimeId',to:'// Recheck after preparation/authority IO, before the first possibly executing Start.\n      if (input.inputRuntimeId'}],assertion:'final create authority refuses intervening real cut'},
 {name:'remove-resume-start-cut',mode:'resume-final-unknown',changes:[{path:'/src/agent-session-recovery/lifecycle.ts',from:'await this.assertLaunchInputEpoch(current.agentSessionId, continuity)',to:'void continuity'}],assertion:'final resume namespace unknown is refused'}
]
// The late create mutant removes only the final read, leaving preflight intact.
mutants[1].changes=[{path:'/src/client.ts',from:'// Recheck after preparation/authority IO, before the first possibly executing Start.\n      if (input.inputRuntimeId !== undefined && input.inputRuntimeId !== (await this.agentCreationAuthority()).runtimeId) throw new AgentMuxError(\'The original input belongs to another semantic Runtime.\', \'RUNTIME_OWNER_MISMATCH\')\n    '+guards,to:'// Mutation: remove only the final namespace read.'}]
const variants=[...tests,...mutants.flatMap(item=>[item,{name:'restored-'+item.name,mode:item.mode}])]
try{
 await mkdir(evidence,{recursive:true});if(!existsSync(vendor)){await symlink(join(main,'packages/core/vendor'),vendor,'dir');ownVendor=true}
 assert.ok(existsSync(daemon),'the exact vendored private Native is required')
 await writeFile(worker,ts.transpileModule(await readFile(workerSource,'utf8'),{fileName:workerSource,compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext,verbatimModuleSyntax:true}}).outputText,{mode:0o600})
 const results=[]
 for(const test of variants){
  const root=join(temporary,test.name.slice(0,24));await mkdir(root)
  const log=join(root,'loaded.ndjson')
  const result=spawnSync(process.execPath,['--import',loader,fixture,test.mode],{cwd:repo,encoding:'utf8',timeout:70000,maxBuffer:2*1024*1024,env:{...process.env,AGENTMUX_LAUNCH_EPOCH_ROOT:root,AGENTMUX_LAUNCH_EPOCH_DAEMON:daemon,AGENTMUX_SOURCE_LISTENER_ASSET:worker,AGENTMUX_SOURCE_LOAD_LOG:log,AGENTMUX_SOURCE_MUTATION_JSON:JSON.stringify(test.changes??[])}})
  if(!existsSync(join(root,'cleanup.json'))){cleanupUnknown=true;await writeFile(join(evidence,'launch-input-epoch-harness-failure.private.json'),JSON.stringify({test,root,status:result.status,stdout:result.stdout,stderr:result.stderr},null,2),{mode:0o600});assert.fail('owned cleanup unknown; exact root retained '+root)}
  const cleanup=JSON.parse(await readFile(join(root,'cleanup.json'),'utf8'));assert.deepEqual(cleanup.cleanupErrors,[])
  const sources=[...new Map((await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(line=>{const item=JSON.parse(line);return[item.path,item]})).values()]
  assert.ok(sources.some(item=>/@ctxmux[\/+]+sdk/u.test(item.path)),'actual vendored Native SDK consumer required')
  let proof
  if(test.changes){assert.notEqual(result.status,0,test.name);assert.ok((result.stdout+result.stderr).includes(test.assertion),test.name+' must fail at its business assertion');assert.ok(sources.some(item=>item.sourceSHA256!==item.loadedSHA256),'actual mutation required')}
  else{assert.equal(result.status,0,result.stderr);proof=JSON.parse(result.stdout.split('\n').find(line=>line.startsWith('LAUNCH_EPOCH_JSON:')).slice('LAUNCH_EPOCH_JSON:'.length));assert.equal(proof.pass,true);assert.ok(proof.rows.length>0)}
  const entry={test:test.name,mode:test.mode,verdict:'pass',mutationKilled:Boolean(test.changes),proof:proof??null,cleanup,sources:sources.map(({path,sourceSHA256,loadedSHA256})=>({path,sourceSHA256,loadedSHA256})),stdout:result.stdout,stderr:result.stderr}
  await writeFile(join(evidence,'launch-epoch-'+test.name+'.private.json'),JSON.stringify(entry,null,2)+'\n',{mode:0o600});results.push({test:test.name,mutationKilled:Boolean(test.changes),evidence:join(evidence,'launch-epoch-'+test.name+'.private.json')})
  await rm(root,{recursive:true,force:true});console.log(JSON.stringify({case:test.name,pass:true}))
 }
 await writeFile(join(evidence,'launch-input-epoch.private.json'),JSON.stringify({schema:'agentmux.launch-input-epoch-proof.v1',verdict:'pass',runnerSHA256:hash(await readFile(fileURLToPath(import.meta.url))),fixtureSHA256:hash(await readFile(fixture)),loaderSHA256:hash(await readFile(loader)),native:{binarySHA256:hash(await readFile(daemon)),manifestSHA256:hash(await readFile(manifest))},results,productionWrites:0,privateRootsRemoved:true},null,2)+'\n',{mode:0o600})
 console.log(JSON.stringify({verdict:'pass',nativeCases:tests.length,mutants:mutants.length,restored:mutants.length}))
}finally{if(!cleanupUnknown)await rm(temporary,{recursive:true,force:true});if(ownVendor)await unlink(vendor)}
