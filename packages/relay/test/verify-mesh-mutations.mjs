import { spawn } from 'node:child_process'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const directory=resolve('.local/state/mesh-network-access/relay-mutants')
await mkdir(directory,{recursive:true})
const runDirectory=resolve(directory,randomUUID());await mkdir(runDirectory)
await writeFile(resolve(directory,'receipt.json'),JSON.stringify({passed:false,status:'running',runDirectory})+'\n')
const cases=[
  ['origin-signature','rejects a forged origin'],['reciprocal-edge','rejects a forged origin'],['stale-revision','rejects a forged origin'],
  ['circuit-origin','rejects replayed peer'],['peer-proof','rejects replayed peer'],
  ['duplicate-opening','atomically claims pending'],['adjacency-budget','charges a frozen path'],['guard-bypass','a held explicit recovery'],
  ['revoked-circuit','revokes a remote member'],['frozen-path','freezes existing circuits'],
]
const hash=value=>createHash('sha256').update(value).digest('hex')
const results=[]
for(const [mode,name]of cases){
  const loaded=resolve(runDirectory,mode+'.loaded.jsonl'),report=resolve(runDirectory,mode+'.report.json'),log=resolve(runDirectory,mode+'.log')
  await writeFile(loaded,'')
  const child=spawn(process.execPath,[resolve('node_modules/vitest/vitest.mjs'),'run','--config','packages/relay/test/mesh-mutant.config.mts','-t',name,'--reporter=json','--outputFile',report],
    {env:{...process.env,RELAY_MESH_MUTANT:mode,RELAY_MESH_LOADED:loaded},stdio:['ignore','pipe','pipe']})
  let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{output+=String(data)})
  const exitCode=await new Promise((yes,no)=>{child.once('error',no);child.once('close',yes)})
  await writeFile(log,output)
  const records=(await readFile(loaded,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))
  const tests=JSON.parse(await readFile(report,'utf8'))
  const implementationPath=mode==='guard-bypass'?'packages/relay/src/mesh-state-guard.ts':'packages/relay/src/mesh-network.ts'
  const consumerPath=mode==='guard-bypass'?'packages/relay/test/mesh-state.test.ts':'packages/relay/test/mesh-network.test.ts'
  const implementation=records.find(r=>r.path===implementationPath),consumer=records.find(r=>r.path===consumerPath)
  const candidateSHA256=hash(await readFile(implementationPath))
  if(!implementation||implementation.originalSHA256!==candidateSHA256)throw Error('Loaded original is not current candidate: '+mode)
  const failures=tests.testResults.flatMap(r=>r.assertionResults).filter(r=>r.status==='failed')
  const result={mode,exitCode,loadedImplementation:implementation?.servedSHA256!==implementation?.originalSHA256&&implementation?.mode===mode,
    implementationPath,consumerPath,candidateSHA256,loadedOriginalMatchesCandidate:implementation.originalSHA256===candidateSHA256,
    loadedConsumer:consumer?.servedSHA256===hash(await readFile(consumerPath)),
    semanticRed:tests.numFailedTestSuites===1&&tests.numFailedTests===1&&failures.length===1&&failures[0].failureMessages.some(m=>m.includes('AssertionError')),
    failedTests:failures.map(r=>r.fullName),loaded,report,log}
  result.passed=exitCode!==0&&result.loadedImplementation&&result.loadedOriginalMatchesCandidate&&result.loadedConsumer&&result.semanticRed
  results.push(result)
  process.stdout.write(JSON.stringify({mode,passed:result.passed})+'\n')
  if(!result.passed){await writeFile(resolve(directory,'receipt.json'),JSON.stringify({passed:false,status:'failed',runDirectory,results},null,2)+'\n');throw Error('Mesh mutation was not a loaded semantic RED: '+mode)}
}
await writeFile(resolve(directory,'receipt.json'),JSON.stringify({passed:true,status:'passed',runDirectory,sourceHashes:Object.fromEntries(await Promise.all(['packages/relay/src/mesh-network.ts','packages/relay/src/mesh-state-guard.ts','packages/relay/test/mesh-network.test.ts','packages/relay/test/mesh-state.test.ts','packages/relay/test/mesh-mutant.config.mts','packages/relay/test/verify-mesh-mutations.mjs'].map(async p=>[p,hash(await readFile(p))]))),results},null,2)+'\n')
