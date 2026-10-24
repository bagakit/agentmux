import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, symlink, readdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(join(root, 'packages/core/package.json'))
const { build } = require('esbuild')
const sha = value => createHash('sha256').update(value).digest('hex')
await mkdir(join(root, '.tmp'), { recursive: true })
const output = await mkdtemp(join(root, '.tmp/capsule-recovery-'))
const owner = 'packages/core/src/capsule-run-manager.ts', codec = 'packages/core/src/capsule-runtime.ts'
const ui = 'apps/desktop/src/renderer/src/components/settings/CapsuleRuntimeSettings.tsx'
const files = [owner, codec, ui, 'packages/core/scripts/verify-capsule-recovery.mjs', 'packages/core/src/capsule-cli.ts', 'packages/core/src/agentmux.ts',
  'packages/core/test/capsule-recovery.test.ts', 'packages/core/test/helpers/capsule-recovery-fixture.ts',
  'apps/desktop/test/capsule-runtime-recovery.test.tsx']
const sources = Object.fromEntries(await Promise.all(files.map(async path => [path, await readFile(join(root,path),'utf8')])))
try {
await symlink(join(root,'packages/core/node_modules'),join(output,'node_modules'),'dir')
const cli = join(output,'amux.mjs')
await build({ entryPoints:[join(root,'packages/core/src/agentmux.ts')],outfile:cli,bundle:true,platform:'node',format:'esm',target:'node22',packages:'external',metafile:true,
  banner:{js:"import {createRequire as __createRequire} from 'node:module';const require=__createRequire(import.meta.url);"} })
const failures={
 'old-latest-overwrites-current':'A late old generation must preserve the latest reserved Native receipt',
 'durable-native-not-consumed':'Durable original Start refusal must restore reachable recovery',
 'frozen-native-identity-ignored':'Foreign Native identity cannot authorize recovery',
 'creation-wrong-key':'Wrong or absent Native receipt must stay unknown',
 'late-result-dropped':'Late refusal must be durable without another management mutation',
 'history-overwritten':'Confirmed original management result must stay immutable',
 'native-premature-ready':'Native creation does not prove service readiness',
 'domain-predispatch-unknown':'Unsent domain request has exact nonapplication',
 'domain-postdispatch-refused':'An invoked domain call cannot inherit manager predispatch nonapplication',
 'uncalled-fact-lost':'Live owner retains exact uncalled Native fact',
 'settings-explicit-recovery-removed':'Typed original rejection must expose a new explicit recovery action',
}
const mutants = [
  { id:'old-latest-overwrites-current',file:owner,from:'reserve || !record.latestNative || record.latestNative.key === native.key',to:'true',test:'keeps a reserved latest generation separate' },
  { id:'durable-native-not-consumed',file:owner,from:'if (!id) return undefined\n    const record',to:'if (true) return undefined\n    const record',test:'recovers a refused Start from durable settlement' },
  { id:'frozen-native-identity-ignored',file:owner,from:'receipt.launchKey === launchKey(b.launch!) &&',to:'true &&',test:'refuses missing or foreign durable Native identity' },
  { id:'creation-wrong-key', file:owner, from:'error.creationFailure?.operationId === effect.operationId && error.creationFailure.disposition',to:'error.creationFailure?.disposition',test:'does not convert wrong-key' },
  { id:'late-result-dropped', file:owner,from:'if (!this.closed) void this.serial(() => this.settle(original))',to:'if (false) void this.serial(() => this.settle(original))',test:'settles a late original refusal' },
  { id:'history-overwritten',file:owner,from:'if (!terminal) record.receipt =',to:'record.receipt =',test:'keeps confirmed management history' },
  { id:'native-premature-ready',file:owner,from:"outcome.disposition === 'applied' ? 'pending' : outcome.disposition",to:"outcome.disposition === 'applied' ? 'confirmed' : outcome.disposition",test:'keeps Native creation separate' },
  { id:'domain-predispatch-unknown',file:owner,from:"{ disposition: 'not_applied', confirmedInputBytes: 0 }, original.logId",to:"{ disposition: 'unknown', confirmedInputBytes: 0 }, original.logId",test:'exposes the same retained original result' },
  { id:'domain-postdispatch-refused',file:owner,from:'dispatched = true; return await connected.connection.call',to:'dispatched = false; return await connected.connection.call',test:'preserves a postdispatch domain failure' },
  { id:'uncalled-fact-lost',file:owner,from:'const notApplied = !effect.invoked || error instanceof AgentMuxError',to:'const notApplied = error instanceof AgentMuxError',test:'retains a live uncalled fact' },
  { id:'settings-explicit-recovery-removed',file:ui,from:"value?.issue?.retry === 'start' && !value.run",to:'false',test:'allows a new explicit Settings Start' },
]
for(const m of mutants)assert.equal(sources[m.file].split(m.from).length-1,1,'One original source mutation anchor: '+m.id)
const sdkRoot=dirname(fileURLToPath(import.meta.resolve('@ctxmux/sdk')))
const sdkFiles=['client.js','control.js','generated/CreationFailure.d.ts','generated/CreationObservation.d.ts','generated/constants.js']
const sdkInputs=Object.fromEntries(await Promise.all(sdkFiles.map(async file=>[file,sha(await readFile(join(sdkRoot,file)))])))
const worker=join(root,'packages/core/dist/control-endpoint-listener-worker.js'),workerSha256=sha(await readFile(worker))
const receipt={schema:'agentmux.capsule-recovery-proof.v1',passed:false,boundary:'Current source manager/codec, original Unix public RPC and source-compiled CLI, actual ReactDOM Runtime Settings; controlled Native creation/Stop receipts, actual independent Capsule Unix/HTTP owner. No user/live Native or visual proof.',
  inputs:Object.fromEntries(Object.entries(sources).map(([file,text])=>[file,sha(text)])),cliSha256:sha(await readFile(cli)),sdkInputs,listenerWorkerSha256:workerSha256,runs:[]}
async function run(mutant) {
 const name=mutant?.id??'baseline',config=join(output,name+'.config.mts'),report=join(output,name+'.json'),capture=join(output,name+'.capture.json')
 await writeFile(config,`import base from ${JSON.stringify(join(root,'apps/desktop/test/capsule-settings.config.mts'))};
import {readFileSync,writeFileSync} from 'node:fs';import{relative}from'node:path';import{createHash}from'node:crypto';
const mutation=${JSON.stringify(mutant?{...mutant,source:sources[mutant.file].replace(mutant.from,mutant.to)}:null)};
const sources=${JSON.stringify([owner,codec,ui])},loaded={},compiled={};let consumed=0;
const hash=v=>createHash('sha256').update(v).digest('hex');const save=()=>writeFileSync(${JSON.stringify(capture)},JSON.stringify({loaded,compiled,consumed}));
export default {...base,cacheDir:${JSON.stringify(join(output,'cache-'+name))},test:{...base.test,server:{deps:{external:[/packages\\/capsule\\/dist\\//]}},include:['packages/core/test/capsule-runtime.test.ts','packages/core/test/capsule-recovery.test.ts','apps/desktop/test/capsule-runtime-recovery.test.tsx'],testTimeout:15000},plugins:[...base.plugins,
{name:'actual-capsule-recovery-source',enforce:'pre',transform(input,id){const file=relative(${JSON.stringify(root)},id.split('?')[0]);if(!sources.includes(file))return;const text=mutation?.file===file?mutation.source:input;if(mutation?.file===file)consumed++;loaded[file]=hash(text);save();return {code:text,map:null}}},
{name:'actual-capsule-recovery-compiled',enforce:'post',transform(code,id){const file=relative(${JSON.stringify(root)},id.split('?')[0]);if(sources.includes(file)){compiled[file]=hash(code);save()}}}]};`)
 const log=[]
 const args=[join(root,'node_modules/vitest/vitest.mjs'),'run','--config',config,'--reporter=json','--outputFile.json='+report]
 if(mutant)args.push('-t',mutant.test)
 const code=await new Promise((yes,no)=>{const child=spawn(process.execPath,args,{cwd:root,env:{...process.env,CAPSULE_RECOVERY_CLI:cli},stdio:['ignore','pipe','pipe']});child.stdout.on('data',x=>log.push(x));child.stderr.on('data',x=>log.push(x));child.on('error',no);child.on('close',yes)})
 await writeFile(join(output,name+'.log'),Buffer.concat(log))
 const result=JSON.parse(await readFile(report,'utf8')),facts=JSON.parse(await readFile(capture,'utf8'))
 const assertions=result.testResults.flatMap(x=>x.assertionResults).filter(x=>x.status!=='skipped'&&x.status!=='pending')
 assert.ok(assertions.length>0,'Actual nonempty collection: '+name)
 assert.equal(result.numRuntimeErrorTestSuites ?? 0,0,'Setup/runtime suites cannot qualify: '+name)
 for (const suite of result.testResults) {
   assert.equal(suite.message ?? '', '', 'Suite setup errors cannot qualify: ' + name)
   if (suite.status === 'failed') assert.ok(suite.assertionResults.some(x => x.status === 'failed'), 'A failing suite must contain an actual failed assertion: ' + name)
 }
 assert.doesNotMatch(Buffer.concat(log).toString(),/Unhandled Rejection|Unhandled Errors|Uncaught Exception/u,'Unhandled execution errors cannot qualify: '+name)
 if (!mutant) {
   assert.equal(result.numTotalTests, 41, 'The complete approved collection must run')
   assert.equal(result.numPassedTests, 41, 'Every approved baseline assertion must pass')
   assert.equal(assertions.length, 41, 'No baseline assertion may be skipped or pending')
   assert.ok(assertions.every(x => x.status === 'passed'), 'The complete baseline must pass')
   assert.equal(result.testResults.length, 3)
   for (const suite of result.testResults) {
     assert.ok(suite.assertionResults.some(x => x.status === 'passed'), 'Each actual production consumer suite must pass assertions')
     assert.ok(['packages/core/test/capsule-runtime.test.ts', 'packages/core/test/capsule-recovery.test.ts', 'apps/desktop/test/capsule-runtime-recovery.test.tsx']
       .some(path => resolve(suite.name) === resolve(root, path)), 'Exact expected production suite')
   }
   assert.equal(code, 0, Buffer.concat(log).toString())
   assert.equal(result.numFailedTests, 0)
   for (const file of [owner, codec, ui]) { assert.equal(facts.loaded[file], sha(sources[file])); assert.ok(facts.compiled[file]) }
 }
 else{assert.equal(code,1,'Actual mutation must fail a business assertion: '+name);assert.ok(facts.consumed>0&&facts.compiled[mutant.file]);assert.equal(facts.loaded[mutant.file],sha(sources[mutant.file].replace(mutant.from,mutant.to)));assert.ok(assertions.some(x=>x.fullName.includes(mutant.test)&&x.status==='failed'&&x.failureMessages.some(y=>/AssertionError/u.test(y)&&y.includes(failures[mutant.id]))),'Declared semantic assertion must fail: '+name)}
 receipt.runs.push({name,code,passed:result.numPassedTests,failed:result.numFailedTests,capture:facts});process.stdout.write(JSON.stringify({name,code,passed:result.numPassedTests,failed:result.numFailedTests})+'\n')
}
try {
  await run()
  if(process.argv.includes('--mutations'))for(const mutant of mutants)await run(mutant)
  for(const[file,text]of Object.entries(sources))assert.equal(sha(await readFile(join(root,file))),sha(text),'Shared source stays unchanged: '+file)
  for(const[file,hash]of Object.entries(sdkInputs))assert.equal(sha(await readFile(join(sdkRoot,file))),hash,'Actual SDK stays unchanged: '+file)
  assert.equal(sha(await readFile(worker)),workerSha256,'The actual listener worker stays unchanged')
  receipt.passed=true
  process.stdout.write(JSON.stringify({passed:true,output,mutations:receipt.runs.length-1})+'\n')
} catch(error) {
  receipt.error={message:error.message}
  throw error
} finally {
  await writeFile(join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')
}
} finally {
  for(const name of await readdir(output)) if(name==='amux.mjs'||name==='node_modules'||name.endsWith('.config.mts')||name.startsWith('cache-'))
    await rm(join(output,name),{recursive:true,force:true})
}
