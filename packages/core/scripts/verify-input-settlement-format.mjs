import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
process.umask(0o077)
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..')
const fixture=join(repo,'packages/core/test/fixtures/input-settlement-format-proof.mjs'),loader=join(repo,'packages/core/scripts/helpers/core-source-loader.mjs')
const evidence=process.env.AGENTMUX_RELIABILITY_EVIDENCE_DIRECTORY??join(repo,'.local/reliability-fixes/runtime')
// This is a real installed ABI consumer, never a substituted source alias or a production database.
const installed=process.env.AGENTMUX_INSTALLED_CORE_URL??pathToFileURL(join(homedir(), 'Applications/AgentMux.app/Contents/Resources/app/node_modules/@agentmux/core/dist/index.js')).href
assert.ok(installed.startsWith('file:'),'the installed reader must be a local exact artifact')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),temporary=await mkdtemp(join(tmpdir(),'amux-settle-format-'))
const mutations=[
 {name:'settlement-upgrades-creation',mutation:{path:'/src/agent-session-store.ts',from:'}, signal, expected.agentSessionId, undefined, false)',to:'}, signal, expected.agentSessionId)'},assertion:'settlement must not change the unrelated creation schema generation'},
 {name:'all-writes-skip-creation',mutation:{path:'/src/agent-session-store.ts',from:'settlement?: MetadataTimelineSettlement, initializeCreationSchema = true)',to:'settlement?: MetadataTimelineSettlement, initializeCreationSchema = false)'},assertion:'ordinary write retains creation owner schema upgrade'}
]
const cases=[{name:'baseline'},...mutations.flatMap(test=>[test,{name:'restored-'+test.name}])]
const results=[]
try{
 await mkdir(evidence,{recursive:true})
 for(const test of cases){
  const root=join(temporary,test.name);await mkdir(root)
  const loaded=join(root,'loaded.ndjson')
  const result=spawnSync(process.execPath,['--import',loader,fixture],{cwd:repo,encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024,env:{...process.env,AGENTMUX_INSTALLED_CORE_URL:installed,AGENTMUX_SETTLEMENT_ROOT:root,AGENTMUX_SOURCE_LOAD_LOG:loaded,AGENTMUX_SOURCE_MUTATION_JSON:JSON.stringify(test.mutation?[test.mutation]:[])}})
  const sources=[...new Map((await readFile(loaded,'utf8')).trim().split('\n').filter(Boolean).map(line=>{const item=JSON.parse(line);return[item.path,item]})).values()]
  assert.ok(sources.some(item=>item.path===fileURLToPath(installed)),'actual installed dist must be loaded')
  assert.ok(sources.some(item=>item.path.endsWith('/src/agent-session-store.ts')),'actual original Store must be loaded')
  let proof=null
  if(test.mutation){assert.notEqual(result.status,0,test.name);assert.ok((result.stdout+result.stderr).includes(test.assertion),test.name+' must fail at the business assertion');assert.ok(sources.some(item=>item.sourceSHA256!==item.loadedSHA256),'actual loaded mutation required')}
  else{assert.equal(result.status,0,result.stderr);const line=result.stdout.split('\n').find(line=>line.startsWith('INPUT_SETTLEMENT_FORMAT_PASS:'));assert.ok(line,'nonempty complete fixture proof');proof=JSON.parse(line.slice('INPUT_SETTLEMENT_FORMAT_PASS:'.length));assert.equal(proof.rows.length,3);assert.equal(proof.retiredPtyOriginalOnly,true);assert.equal(proof.installedIndependentProcess,true)}
  results.push({name:test.name,verdict:'pass',mutationKilled:Boolean(test.mutation),status:result.status,proof,sources:sources.map(({path,sourceSHA256,loadedSHA256})=>({path,sourceSHA256,loadedSHA256})),stdout:result.stdout,stderr:result.stderr})
  await rm(root,{recursive:true,force:true});console.log(test.name+': pass')
 }
 const receipt={schema:'agentmux.input-settlement-format-proof.v1',verdict:'pass',scope:'existing original ACK settlement under real FileStore locks, actual installed v1 seed and independent installed process; schema generation is not a dependency of settlement; no Client or Native',runnerSHA256:hash(await readFile(fileURLToPath(import.meta.url))),fixtureSHA256:hash(await readFile(fixture)),loaderSHA256:hash(await readFile(loader)),installed:{url:installed,indexSHA256:hash(await readFile(fileURLToPath(installed)))},results,productionWrites:0,nativeCalls:0,temporaryCleanup:true}
 await writeFile(join(evidence,'input-settlement-format.private.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600})
 console.log(JSON.stringify({verdict:'pass',cases:cases.length,mutants:mutations.length,nativeCalls:0}))
}finally{await rm(temporary,{recursive:true,force:true})}
