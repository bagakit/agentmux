import { fixturePath } from './lib/fixture-values.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFile, fork } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'
import { candidateAlias, candidateModule, candidateResolve } from './candidate-package-resolve.mjs'
import { radixOverlayAliases } from './radix-overlay-aliases.ts'
import { noteParsingAliases } from '../../../packages/client-ui/scripts/note-parsing-aliases.ts'

const root=path.resolve(import.meta.dirname,'../../..')
const fixture=path.join(root,'apps/desktop/scripts/fixtures/native-session-change')
const controlsOnly=process.argv.includes('--controls-only')
const evidence=path.resolve(process.argv.slice(2).find(value=>!value.startsWith('--'))??path.join(root,'.local/native-target-ui',randomUUID()))
const desktopRequire=createRequire(path.join(root,'apps/desktop/package.json'))
const coreRequire=createRequire(path.join(root,'packages/core/package.json'))
const run=promisify(execFile),sha=value=>createHash('sha256').update(value).digest('hex')
const owned=['src/shared/agent-native-source.ts','src/shared/contracts.ts','src/main/runtime-controller.ts','src/main/ipc.ts','src/preload/index.ts','src/renderer/src/lib/session-state.ts','src/renderer/src/lib/session-user-messages.ts','src/renderer/src/lib/api.ts','src/renderer/src/components/AgentNativeSourceControls.tsx','src/renderer/src/components/AgentRegionHeader.tsx','src/renderer/src/components/SessionPane.tsx','src/renderer/src/styles/agent-region-header.css'].map(file=>'apps/desktop/'+file)
const testFiles=['apps/desktop/test/native-session-change.test.tsx','apps/desktop/test/native-source-themed-action.test.tsx','apps/desktop/scripts/fixtures/native-session-change/vitest.config.mts']
const probeFiles=['apps/desktop/scripts/verify-native-session-change.mjs','apps/desktop/scripts/candidate-package-resolve.mjs','apps/desktop/scripts/radix-overlay-aliases.ts','packages/client-ui/scripts/note-parsing-aliases.ts',...['main.ts','owner.ts','entry.mjs','native-cli.mjs','preload.cjs','index.html'].map(file=>'apps/desktop/scripts/fixtures/native-session-change/'+file)]
const hashes=files=>Promise.all(files.map(async file=>[file,sha(await fs.readFile(path.join(root,file)))])).then(Object.fromEntries)
await fs.mkdir(evidence,{recursive:true})
const receipt={schema:'agentmux.native-target-ui.v1',passed:false,sourceBefore:await hashes(owned),sourceAfter:{},probeSources:await hashes(probeFiles),processes:[],captureOnly:true,aestheticReview:'not-performed',isolation:[
 'Current source App, Store, SessionPane, Region menu, TerminalView, Core and Main RuntimeController are privately compiled; source hashes and bundle inputs are retained.',
 'One private semantic owner and actual ctxmux Run serve two independent Electron processes through the production Hosted connector and public RPC. File and Spatial stores, terminal PID and raw-input ACK are real.',
 'The native CLI is an explicit protocol fixture with real writable OS descriptors; it is not stock Codex and does not prove upstream TUI selection. Stock-native provenance is qualified separately by the T002 evidence.',
 'The private IPC bridge calls real RuntimeController methods. The unrelated production IPC registrar is not booted; mounted forwarding tests cover that API boundary.',
 'Only native configuration installation and history-watch subscription are isolated. No user App, profile, native credentials or user Session is used. Captured drafts are never submitted.',
 'This bounded scene covers current target menus, exact confirmation and workface restoration. It does not rerun the former full historical-reader or lost-ACK lifecycle matrix.'
]}
const controlsPath=path.join(evidence,'controls.json')
async function controls(){
 const sources=await hashes([...owned,...testFiles])
 const prior=await fs.readFile(controlsPath,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error})
 if(prior){assert.deepEqual(prior.sources,sources,'Existing controls bind exact current source');assert.equal(prior.passed,true);return prior}
 const config=path.join(fixture,'vitest.config.mts')
 async function execute(name,mutation){
  const loaded=path.join(evidence,name+'-loaded.jsonl'),report=path.join(evidence,name+'.json')
  await fs.writeFile(loaded,'')
  const env={...process.env,AGENTMUX_NATIVE_UI_LOADED_PATH:loaded}
  delete env.AGENTMUX_NATIVE_UI_MUTATION_PATH
  if(mutation){const file=path.join(evidence,name+'-mutation.json');await fs.writeFile(file,JSON.stringify(mutation));env.AGENTMUX_NATIVE_UI_MUTATION_PATH=file}
  const args=['run','--config',config,'--reporter=json','--outputFile='+report,...(mutation?['-t',mutation.test]:[])]
  let exitCode=0,output=''
  try{const result=await run(process.execPath,[path.join(root,'node_modules/vitest/vitest.mjs'),...args],{cwd:root,env,timeout:60000,maxBuffer:8*1024*1024});output=result.stdout+result.stderr}
  catch(error){exitCode=error.code;output=(error.stdout??'')+(error.stderr??'')}
  await fs.writeFile(path.join(evidence,name+'.log'),output)
  const data=JSON.parse(await fs.readFile(report,'utf8'))
  const assertions=data.testResults.flatMap(file=>file.assertionResults),failed=assertions.filter(test=>test.status==='failed')
  const reads=(await fs.readFile(loaded,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  assert.ok(reads.length&&assertions.length,'Actual nonempty tests and implementation loads')
  assert.equal(data.numRuntimeErrorTestSuites??0,0)
  if(mutation){
   assert.ok(Number.isInteger(exitCode)&&exitCode>0)
   assert.ok(failed.length&&failed.every(test=>test.fullName.includes(mutation.test)&&test.failureMessages.some(value=>value.includes('AssertionError'))),'Only the expected business oracle kills the mutation')
   const owner=reads.find(value=>value.path===mutation.file&&value.mutated)
   assert.ok(owner);assert.equal(owner.sourceSHA256,sources[mutation.file]);assert.notEqual(owner.sourceSHA256,owner.loadedSHA256)
  }else{
   assert.equal(exitCode,0);assert.equal(data.success,true);assert.equal(failed.length,0);assert.ok(data.numPassedTests>=19)
   for(const owner of ['apps/desktop/src/renderer/src/components/AgentNativeSourceControls.tsx','apps/desktop/src/shared/agent-native-source.ts'])assert.ok(reads.some(value=>value.path===owner&&value.sourceSHA256===sources[owner]&&!value.mutated),'Current product owner loaded: '+owner)
  }
  return{name,exitCode,passed:data.numPassedTests,failed:data.numFailedTests,report:path.basename(report),reportSHA256:sha(await fs.readFile(report)),loaded:path.basename(loaded),loadedSHA256:sha(await fs.readFile(loaded))}
 }
 const positive=await execute('positive')
 const file='apps/desktop/src/renderer/src/components/AgentNativeSourceControls.tsx'
 const mutations=[]
 for(const mutation of [
  {name:'wrong-candidate',file,before:'candidateNativeHandle: structuredClone(candidate)',after:'candidateNativeHandle: structuredClone(old)',test:'keeps the chosen Run member'},
  {name:'removed-confirm',file,before:'event.preventDefault(); void confirm()',after:'event.preventDefault(); void Promise.resolve()',test:'offers each verified Run member'},
  {name:'removed-menu-focus',file,before:'?.querySelector<HTMLElement>(\'[data-native-source-check]\')?.focus()',after:'?.querySelector<HTMLElement>(\'[data-native-source-check]\')',test:'keeps keyboard focus'}
 ])mutations.push(await execute(mutation.name,mutation))
 assert.deepEqual(await hashes([...owned,...testFiles]),sources,'Controls source did not change during the run')
 const result={passed:true,sources,positive,mutations}
 await fs.writeFile(controlsPath,JSON.stringify(result,null,2)+'\n');return result
}
receipt.controls=await controls()
if(controlsOnly){console.log(JSON.stringify({passed:true,controls:controlsPath}));process.exit(0)}

const privateRoot=await fs.mkdtemp(fixturePath('tmp/amux-native-target-'))
let owner
try{
 const {build:buildRenderer}=await import(pathToFileURL(desktopRequire.resolve('vite')).href)
 const {build:buildNode}=coreRequire('esbuild')
 const manifests=new Map(),onManifest=(file,bytes)=>manifests.set(path.relative(root,file),sha(bytes))
 const aliases=[...Object.entries({...radixOverlayAliases,...noteParsingAliases}).map(([find,replacement])=>({find,replacement})),candidateAlias(root,{browser:true,source:true,onManifest}),{find:/^@xterm\/xterm$/,replacement:path.join(root,'apps/desktop/scripts/fixtures/terminal-wheel/xterm-instrumented.ts')}]
 const consumed=new Map()
 const sourcePlugin={name:'current-native-target-product',enforce:'pre',async transform(_code,id){
  const file=id.split('?')[0]
  if(!path.isAbsolute(file))return
  const actual=candidateModule(root,file),relative=path.relative(root,actual)
  if(/^(?:apps|packages)\//.test(relative)&&!relative.includes('/node_modules/'))consumed.set(relative,sha(await fs.readFile(actual)))
 }}
 const renderer=path.join(evidence,'renderer')
 await buildRenderer({configFile:false,root:fixture,base:'./',logLevel:'error',define:{__AGENTMUX_WEB_PREVIEW__:'true',__TERMINAL_WHEEL_UMD_URL__:'"unused"'},esbuild:{jsx:'automatic'},resolve:{alias:aliases,dedupe:['react','react-dom']},plugins:[sourcePlugin],worker:{format:'es',plugins:()=>[sourcePlugin]},build:{target:'esnext',outDir:renderer,emptyOutDir:true,minify:false}})
 receipt.compiledRenderer=Object.fromEntries(consumed)
 for(const file of ['App.tsx','store.ts','components/SessionPane.tsx','components/AgentRegionHeader.tsx','components/AgentNativeSourceControls.tsx','components/TerminalView.tsx'])assert.ok(consumed.has('apps/desktop/src/renderer/src/'+file),'Current Renderer consumer compiled: '+file)
 for(const file of ['theme/icons.tsx','theme/runtime.ts','components/ConversationView.tsx'])assert.ok(consumed.has('packages/client-ui/src/'+file),'Current shared UI consumer compiled: '+file)
 const sdkPath=path.join(root,'packages/core/node_modules/@ctxmux/sdk'),sdk=JSON.parse(await fs.readFile(path.join(sdkPath,'package.json'),'utf8'))
 const nodeAliases={'@ctxmux/sdk':path.join(sdkPath,sdk.exports['.'].import)}
 const sourceHashes=new Map()
 const nodePlugin={name:'current-native-target-node',setup(build){
 build.onResolve({filter:/^@agentmux\//},input=>({path:candidateResolve(root,input.path,{source:true,onManifest})}))
 build.onLoad({filter:/\.[cm]?[jt]sx?$/},async input=>{
  const actual=candidateModule(root,input.path),relative=path.relative(root,actual)
  const code=await fs.readFile(input.path,'utf8')
  if(/^(?:apps|packages)\//.test(relative)&&!relative.includes('/node_modules/'))sourceHashes.set(relative,sha(code))
  return{contents:code.replaceAll('import.meta.url',JSON.stringify(pathToFileURL(input.path).href)).replaceAll('import.meta.dirname',JSON.stringify(path.dirname(input.path))),loader:input.path.endsWith('.tsx')?'tsx':input.path.endsWith('.ts')?'ts':'js'}
 })}}
 receipt.nodeBundles={}
 for(const name of ['owner','main']){
  sourceHashes.clear();const output=path.join(evidence,name+'.mjs')
  const built=await buildNode({absWorkingDir:root,entryPoints:[path.join(fixture,name+'.ts')],outfile:output,bundle:true,platform:'node',format:'esm',external:['electron'],conditions:['browser'],alias:nodeAliases,metafile:true,plugins:[nodePlugin],banner:{js:'import {createRequire as _privateRequire} from "node:module"; const require=_privateRequire(import.meta.url);'},logLevel:'error'})
  receipt.nodeBundles[name]={sha256:sha(await fs.readFile(output)),inputs:Object.keys(built.metafile.inputs),sourceSHA256:Object.fromEntries(sourceHashes)}
  await fs.writeFile(path.join(evidence,name+'-metafile.json'),JSON.stringify(built.metafile))
 }
 for(const file of ['apps/desktop/src/main/runtime-controller.ts','apps/desktop/src/main/desktop-host.ts','packages/core/src/hosted-client.ts'])assert.ok(receipt.nodeBundles.main.inputs.includes(file),'Actual Main/Hosted consumer '+file)
 for(const file of ['packages/core/src/client.ts','packages/core/src/agent-native-session-confirmation.ts','packages/core/src/providers/app-server-native-session.ts','packages/core/src/providers/codex-native-record-role.ts'])assert.ok(receipt.nodeBundles.owner.inputs.includes(file),'Actual Core/Provider owner '+file)
 receipt.packageManifests=Object.fromEntries(manifests)
 await fs.copyFile(path.join(fixture,'native-cli.mjs'),path.join(privateRoot,'native-cli.mjs'))
 await fs.mkdir(path.join(privateRoot,'native-codex'))
 await fs.mkdir(path.join(privateRoot,'home'))
 const env=Object.fromEntries(['PATH','TMPDIR','LANG','LC_ALL','SHELL','USER'].filter(name=>process.env[name]!==undefined).map(name=>[name,process.env[name]]))
 Object.assign(env,{HOME:path.join(privateRoot,'home'),AGENTMUX_RUNTIME_DIRECTORY:path.join(privateRoot,'runtime'),AGENTMUX_STATE_DIRECTORY:path.join(privateRoot,'state'),AGENTMUX_MESSAGE_QUEUE_PATH:path.join(privateRoot,'messages.ndjson')})
 const ownerLogs=[]
 owner=fork(path.join(evidence,'owner.mjs'),[privateRoot],{cwd:root,env,stdio:['ignore','pipe','pipe','ipc']})
 owner.stdout.on('data',value=>ownerLogs.push(String(value)));owner.stderr.on('data',value=>ownerLogs.push(String(value)))
 receipt.owner=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('Private semantic owner did not start: '+ownerLogs.join(''))),20000)
  owner.once('message',value=>{clearTimeout(timer);resolve(value)})
  owner.once('exit',code=>{clearTimeout(timer);reject(new Error('Private semantic owner exited '+code+': '+ownerLogs.join('')))})
 })
 assert.equal(receipt.owner.ready,true)
 for(const phase of ['select','restore']){
  const lines=[],phaseRoot=path.join(privateRoot,phase);await fs.mkdir(phaseRoot)
  const exit=await runProbeProcess(desktopRequire('electron'),[path.join(evidence,'main.mjs'),path.join(renderer,'index.html'),privateRoot,'codex',phase,path.join(fixture,'preload.cjs'),evidence,process.execPath],{temporaryRoot:phaseRoot,cwd:root,env,timeoutMs:90000,onLine:line=>{lines.push(line);process.stderr.write(phase+': '+line.slice(0,900)+'\n')}})
  await fs.writeFile(path.join(evidence,phase+'-stderr.log'),lines.join('\n'))
  const fact=JSON.parse(await fs.readFile(path.join(evidence,'codex-'+phase+'.json'),'utf8'))
  receipt.processes.push({...exit,...fact});assert.equal(exit.exitCode,0,JSON.stringify(fact.failure));assert.equal(fact.passed,true)
 }
 assert.equal(new Set(receipt.processes.map(value=>value.pid)).size,2)
 receipt.sourceAfter=await hashes(owned);assert.deepEqual(receipt.sourceAfter,receipt.sourceBefore)
 assert.deepEqual(await hashes(probeFiles),receipt.probeSources,'Probe source remains the executed candidate')
 assert.deepEqual(await hashes([...manifests.keys()]),receipt.packageManifests,'Workspace resolution remains the compiled candidate')
 for(const [file,digest] of Object.entries(receipt.compiledRenderer))assert.equal(sha(await fs.readFile(path.join(root,file))),digest,'Renderer source remains the compiled candidate: '+file)
 for(const bundle of Object.values(receipt.nodeBundles))for(const [file,digest] of Object.entries(bundle.sourceSHA256))assert.equal(sha(await fs.readFile(path.join(root,file))),digest,'Node source remains the compiled candidate: '+file)
 receipt.passed=true
}catch(error){receipt.failure={name:error.name,message:error.message,stack:error.stack};console.error(error)}
finally{
 receipt.sourceAfter=await hashes(owned)
 const errors=[]
 if(owner?.exitCode===null){
  try{const stopped=new Promise(resolve=>owner.once('exit',resolve));owner.send({operation:'shutdown'});await Promise.race([stopped,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Owner cleanup timeout')),15000))])}
  catch(error){errors.push(error.message);owner.kill('SIGTERM')}
 }
 try{await stopProbeProcesses(process.pid+1_000_000_000,privateRoot)}catch(error){errors.push(error.message)}
 const remaining=await listProbeProcesses(-1,privateRoot)
 receipt.cleanup={errors,remaining,privateRootRemoved:false}
 if(!remaining.length){await fs.rm(privateRoot,{recursive:true,force:true});receipt.cleanup.privateRootRemoved=true}
 await fs.writeFile(path.join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')
 const pictures=receipt.processes.flatMap(value=>value.screenshots.map(shot=>`- [${shot.file}](./${shot.file})`))
 await fs.writeFile(path.join(evidence,'review.md'),['# Native target menu capture','', 'Capture only. Independent visual review has not been performed.','',...receipt.isolation.map(value=>'- '+value),'',...pictures,''].join('\n'))
}
assert.equal(receipt.passed,true,receipt.failure?.message)
assert.deepEqual(receipt.cleanup.errors,[]);assert.deepEqual(receipt.cleanup.remaining,[])
console.log(JSON.stringify({passed:true,receipt:path.join(evidence,'receipt.json'),review:path.join(evidence,'review.md'),screenshots:receipt.processes.reduce((count,value)=>count+value.screenshots.length,0)}))
