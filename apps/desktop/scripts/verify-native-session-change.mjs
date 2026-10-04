import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFile, fork } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'
const root=path.resolve(import.meta.dirname,'../../..'),fixture=path.join(root,'apps/desktop/scripts/fixtures/native-session-change')
const evidence=path.resolve(process.argv[2]??path.join(root,'.tmp/native-session-change',String(globalThis.crypto.randomUUID())))
const privateRoot=await fs.mkdtemp(_hygiene_fixturePath("tmp/amux-native-source-")),run=promisify(execFile)
const desktopRequire=createRequire(path.join(root,'apps/desktop/package.json')),coreRequire=createRequire(path.join(root,'packages/core/package.json'))
const {build:buildRenderer}=await import(pathToFileURL(desktopRequire.resolve('vite')).href),{build:buildNode}=coreRequire('esbuild')
const sha=value=>createHash('sha256').update(value).digest('hex')
const owned=['src/shared/agent-native-source.ts','src/shared/contracts.ts','src/main/runtime-controller.ts','src/main/ipc.ts','src/preload/index.ts','src/renderer/src/lib/session-state.ts','src/renderer/src/lib/session-user-messages.ts','src/renderer/src/lib/api.ts','src/renderer/src/components/AgentNativeSourceControls.tsx','src/renderer/src/components/AgentRegionHeader.tsx','src/renderer/src/components/SessionPane.tsx','src/renderer/src/components/ActivityView.tsx','src/renderer/src/lib/session-conversation-window.ts','src/renderer/src/styles/agent-region-header.css','src/renderer/src/styles/activity.css'].map(p=>'apps/desktop/'+p)
const cssMutant=process.env.AGENTMUX_NATIVE_UI_CSS_MUTANT==='1'
const receipt={schema:'agentmux.native-session-change-ui.v1',passed:false,evidence,sourceBefore:{},sourceAfter:{},mutations:[],processes:[],visualReview:'pending-independent-review',isolation:[
 'Current source App/Store/SessionPane/Header/ActivityView/ConversationView/TerminalView/Core/Main RuntimeController and production Hosted connector are compiled privately. Source aliases and metafiles exclude shared dist.',
 'One real private semantic owner serves all Electron generations over public hosted RPC; actual ctxmux PTY/Run PID, Hook ingress, file descriptors, input ACK and File/Spatial stores are retained. Three independent Electron processes per Provider use one exact private profile.',
 'Codex uses actual process-FD discovery and private read-only JSON-RPC protocol. Claude uses actual declared main SessionStart plus real JSONL history; neither authenticates or requests upstream work.',
 'Only managed native config installation and the history watch subscription are isolated. Explicit historical reads use the actual ActivityView, ConversationView, navigation owner and real Provider code. The user App/profile/config/Session/Runtime are not accessed.',
 'The private IPC dispatcher invokes the actual production RuntimeController methods. Product IPC/preload call sites are audited separately; the full unrelated product IPC registrar is not booted.',
 'One real acknowledged raw input loses its return receipt at the private adapter boundary. Its original permission operation/range must remain unknown through source confirmation and independent process restoration.'
]}
await fs.mkdir(evidence,{recursive:true})
const command=async(label,args,env={})=>{let value;try{const r=await run(path.join(root,'node_modules/.bin/vitest'),args,{cwd:root,env:{...process.env,...env},timeout:60000,maxBuffer:8*1024*1024});value={code:0,output:r.stdout+r.stderr}}catch(e){value={code:e.code,output:(e.stdout??'')+(e.stderr??'')}}await fs.writeFile(path.join(evidence,label+'.log'),value.output);return value}
const files=async(directory)=>(await Promise.all((await fs.readdir(directory,{withFileTypes:true})).map(e=>e.isDirectory()?files(path.join(directory,e.name)):/\.tsx?$/.test(e.name)?[path.join(directory,e.name)]:[]))).flat()
let owner,ready
try {
 receipt.sourceBefore=Object.fromEntries(await Promise.all(owned.map(async p=>[p,sha(await fs.readFile(path.join(root,p)))])))
 const config=path.join(fixture,'vitest.config.mts'),loads=path.join(evidence,'baseline-loaded.jsonl')
 if(process.env.AGENTMUX_NATIVE_UI_REUSE_CONTROL_RECEIPT){const prior=JSON.parse(await fs.readFile(process.env.AGENTMUX_NATIVE_UI_REUSE_CONTROL_RECEIPT,'utf8'));assert.deepEqual(prior.sourceBefore,receipt.sourceBefore);assert.equal(prior.mutations.length,9);assert.ok(prior.mutations.every(m=>m.red>0&&m.green===0));receipt.controlReuse={receipt:process.env.AGENTMUX_NATIVE_UI_REUSE_CONTROL_RECEIPT,exactSourceHashes:true};receipt.mutations=prior.mutations;}else{
 const baseline=await command('baseline',['run','--config',config],{AGENTMUX_NATIVE_UI_LOADED_PATH:loads});assert.equal(baseline.code,0,baseline.output);assert.match(baseline.output,/Tests\s+[1-9]\d* passed/)
 const mutations=[
 ['drop-source-fact','src/shared/agent-native-source.ts','source.observedNativeHandle ?','false ?','mirrors exact'],
 ['keep-old-revision-fence','src/renderer/src/lib/session-state.ts','&& nativeBindingKey(session) === nativeBindingKey(incoming)','&& true','accepts same-Run'],
 ['duplicate-native-observation-banner','src/renderer/src/lib/session-state.ts',"(core.code === 'AGENT_NATIVE_SOURCE_UNCONFIRMED' || core.code === 'AGENT_NATIVE_IDENTITY_UNCONFIRMED')) return null","(false)) return null",'routes only exact persisted'],
 ['drop-true-refresh','src/main/runtime-controller.ts','options?.refreshNativeSource === undefined','true','Main forwards only'],
 ['disconnect-sdk-confirm','src/main/runtime-controller.ts','return await client.confirmAgentNativeSession(input)','throw new Error("Mutant disconnected Core confirmation")','Main confirms only'],
 ['disconnect-confirm-button','src/renderer/src/components/AgentNativeSourceControls.tsx','event.preventDefault(); void confirm()','event.preventDefault(); void Promise.resolve()','shows a corner label'],
 ['retarget-reviewed-candidate','src/renderer/src/components/AgentNativeSourceControls.tsx','run: review.expectedRun }, review)','run: review.expectedRun }, nativeConfirmationInput(session, review.operationId)!)','keeps a stale reviewed'],
 ['reuse-current-history','src/renderer/src/lib/session-conversation-window.ts',"...(nativeSource ? { nativeSource } : {})",'...({})','keeps the original reader'],
 ['reuse-same-run-cache','src/renderer/src/lib/session-user-messages.ts','`${makeSessionControlKey(control)}:${bindingKey}`','makeSessionControlKey(control)','isolates shared history cache']
 ].map(([label,file,before,after,test])=>({label,file:'apps/desktop/'+file,before,after,test}))
 for(const m of mutations){const mutationFile=path.join(evidence,'mutation.json'),loaded=path.join(evidence,m.label+'-loaded.jsonl');await fs.writeFile(mutationFile,JSON.stringify(m));const red=await command(m.label,['run','--config',config,'-t',m.test],{AGENTMUX_NATIVE_UI_MUTATION_PATH:mutationFile,AGENTMUX_NATIVE_UI_LOADED_PATH:loaded});assert.ok(Number.isInteger(red.code)&&red.code>0,red.output);assert.match(red.output,/AssertionError/);assert.match(red.output,/Tests\s+[1-9]\d* failed/);const actual=(await fs.readFile(loaded,'utf8')).trim().split('\n').map(JSON.parse).filter(l=>l.path===m.file&&l.mutated);assert.ok(actual.length);assert.equal(actual[0].sourceSHA256,receipt.sourceBefore[m.file]);const green=await command(m.label+'-control',['run','--config',config,'-t',m.test]);assert.equal(green.code,0,green.output);receipt.mutations.push({...m,red:red.code,green:green.code,loaded:actual[0]});console.log('native source mutant killed: '+m.label)}
 }
 await fs.writeFile(path.join(evidence,'source-controls.json'),JSON.stringify({sourceBefore:receipt.sourceBefore,mutations:receipt.mutations}))
 const manifest=JSON.parse(await fs.readFile(path.join(root,'packages/core/package.json'),'utf8'))
 const aliases=Object.entries(manifest.exports).map(([key,v])=>({find:new RegExp('^'+(key==='.'?'@agentmux/core':'@agentmux/core/'+key.slice(2)).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$'),replacement:path.join(root,'packages/core',v.import.replace('./dist/','./src/').replace(/\.js$/,'.ts'))}))
 const clientUi=JSON.parse(await fs.readFile(path.join(root,'packages/client-ui/package.json'),'utf8'))
 const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
 const clientUiAliases=Object.entries(clientUi.exports).flatMap(([key,value])=>{
  const target=typeof value==='string'?value:value.browser
  if(!target)return[]
  const name='@agentmux/client-ui'+(key==='.'?'':key.slice(1))
  return[{find:new RegExp('^'+name.split('*').map(escape).join('(.*)')+'$'),replacement:path.join(root,'packages/client-ui',target.replace('*','$1'))}]
 }).sort((a,b)=>b.find.source.length-a.find.source.length)
 aliases.unshift(...clientUiAliases)
 aliases.push({find:/^@agentmux\/layout$/,replacement:path.join(root,'packages/core/src/spatial-layout.ts')},{find:/^@xterm\/xterm$/,replacement:path.join(root,'apps/desktop/scripts/fixtures/terminal-wheel/xterm-instrumented.ts')})
 const consumed=new Map(),guard={name:'actual-native-source-inputs',enforce:'pre',transform(code,id){if(id.startsWith(root+'/apps/desktop/src/')||id.startsWith(root+'/packages/core/src/')||id.startsWith(root+'/packages/client-ui/src/'))consumed.set(path.relative(root,id.split('?')[0]),sha(code))}}
 const renderer=path.join(evidence,'renderer')
 const cssPath=path.join(root,'apps/desktop/src/renderer/src/styles/agent-region-header.css'),cssSource=await fs.readFile(cssPath,'utf8')
 const mutatedDeclarations=new WeakSet()
 const cssMutationPlugin={postcssPlugin:'actual-owning-native-menu-css-mutation',Declaration(declaration){
  if(!cssMutant||mutatedDeclarations.has(declaration)||declaration.prop!=='max-height'||declaration.parent.selector!=='.agent-region-menu')return
  assert.equal(path.resolve(declaration.source.input.file),cssPath,'Mutation must consume the owning imported source file')
  const before='max-height: min(calc(100vh - 2 * var(--sp-4)), var(--radix-dropdown-menu-content-available-height, 100vh));',after='max-height: none;'
  assert.equal(cssSource.split(before).length,2);assert.equal(declaration.value,before.slice('max-height: '.length,-1));assert.equal(receipt.visualMutation,undefined,'One actual CSS mutation')
  mutatedDeclarations.add(declaration);declaration.value='none';receipt.visualMutation={path:path.relative(root,cssPath),sourceSHA256:sha(cssSource),transformedSHA256:sha(cssSource.replace(before,after)),before,after,pipelineSource:declaration.source.input.file}
 }}
 await buildRenderer({configFile:false,root:fixture,base:'./',logLevel:'error',define:{__AGENTMUX_WEB_PREVIEW__:'true',__TERMINAL_WHEEL_UMD_URL__:'"unused"'},resolve:{alias:aliases},plugins:[guard],css:{postcss:{plugins:[cssMutationPlugin]}},build:{target:'esnext',outDir:renderer,emptyOutDir:true,minify:false}})
 if(cssMutant)assert.ok(receipt.visualMutation,'Nonempty actual owning CSS mutation consumed')
 receipt.compiledRenderer=Object.fromEntries(consumed)
 for(const p of ['src/renderer/src/App.tsx','src/renderer/src/store.ts','src/renderer/src/components/SessionPane.tsx','src/renderer/src/components/AgentRegionHeader.tsx','src/renderer/src/components/AgentNativeSourceControls.tsx','src/renderer/src/components/ActivityView.tsx','src/renderer/src/lib/session-conversation-window.ts','src/renderer/src/components/TerminalView.tsx','src/renderer/src/lib/session-user-messages.ts'])assert.ok(consumed.has('apps/desktop/'+p),'Current source compiled: '+p)
 assert.ok(consumed.has('packages/client-ui/src/components/ConversationView.tsx'),'Actual common ConversationView compiled')
 const nodeAliases=Object.fromEntries(aliases.filter(a=>a.find.source.includes('@agentmux')&&!a.find.source.includes('client-ui')).map(a=>[a.find.source.slice(1,-1).replaceAll('\\/','/').replaceAll('\\.','.'),a.replacement]))
 const sdkPath=path.join(root,'packages/core/node_modules/@ctxmux/sdk'),sdk=JSON.parse(await fs.readFile(path.join(sdkPath,'package.json'),'utf8'));nodeAliases['@ctxmux/sdk']=path.join(sdkPath,sdk.exports['.'].import)
 const nodeSourceHashes=new Map()
 const nodePlugin={name:'private-current-node-source',setup(build){build.onResolve({filter:/^@agentmux\/client-ui(?:\/|$)/},args=>{const alias=clientUiAliases.find(item=>item.find.test(args.path));assert.ok(alias,'Actual client-ui source export '+args.path);return{path:args.path.replace(alias.find,alias.replacement)}});build.onLoad({filter:/\.[cm]?[jt]sx?$/},async a=>{const code=await fs.readFile(a.path,'utf8');if(a.path.startsWith(root+'/packages/core/src/')||a.path.startsWith(root+'/apps/desktop/src/')||a.path.startsWith(root+'/packages/client-ui/src/'))nodeSourceHashes.set(path.relative(root,a.path),sha(code));return{contents:code.replaceAll('import.meta.url',JSON.stringify(pathToFileURL(a.path).href)).replaceAll('import.meta.dirname',JSON.stringify(path.dirname(a.path))),loader:a.path.endsWith('.tsx')?'tsx':a.path.endsWith('.ts')?'ts':'js'}})}}
 receipt.nodeBundles={}
 for(const [name,file]of[['owner','owner.ts'],['main','main.ts']]){nodeSourceHashes.clear();const out=path.join(evidence,name+'.mjs'),built=await buildNode({absWorkingDir:root,entryPoints:[path.join(fixture,file)],outfile:out,bundle:true,platform:'node',format:'esm',external:['electron'],conditions:['browser'],alias:nodeAliases,metafile:true,plugins:[nodePlugin],banner:{js:'import {createRequire as _privateRequire} from "node:module"; const require=_privateRequire(import.meta.url);'},logLevel:'error'});receipt.nodeBundles[name]={sha256:sha(await fs.readFile(out)),inputs:Object.keys(built.metafile.inputs),sourceSHA256:Object.fromEntries(nodeSourceHashes)};await fs.writeFile(path.join(evidence,name+'-metafile.json'),JSON.stringify(built.metafile))}
 assert.ok(receipt.nodeBundles.main.inputs.includes('packages/client-ui/src/lib/mote-face.ts'),'Actual current Node client-ui source compiled')
 for(const p of ['apps/desktop/src/main/runtime-controller.ts','apps/desktop/src/main/desktop-host.ts','packages/core/src/hosted-client.ts'])assert.ok(receipt.nodeBundles.main.inputs.includes(p),'Actual Main/Hosted source '+p)
 for(const p of ['packages/core/src/client.ts','packages/core/src/agent-native-session-confirmation.ts','packages/core/src/providers/app-server-native-session.ts','packages/core/src/providers/claude-native-session.ts'])assert.ok(receipt.nodeBundles.owner.inputs.includes(p),'Actual native Core source '+p)
 await fs.copyFile(path.join(fixture,'native-cli.mjs'),path.join(privateRoot,'native-cli.mjs'))
 for(const provider of ['codex','claude'])await fs.mkdir(path.join(privateRoot,'native-'+provider))
 const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('AGENTMUX_')&&!name.startsWith('CTXMUX_')&&name!=='ELECTRON_RUN_AS_NODE'))
 Object.assign(env,{AGENTMUX_RUNTIME_DIRECTORY:path.join(privateRoot,'runtime'),AGENTMUX_STATE_DIRECTORY:path.join(privateRoot,'state'),AGENTMUX_MESSAGE_QUEUE_PATH:path.join(privateRoot,'messages.ndjson')})
 const ownerLogs=[];owner=fork(path.join(evidence,'owner.mjs'),[privateRoot],{cwd:root,env,stdio:['ignore','pipe','pipe','ipc']});owner.stdout.on('data',b=>ownerLogs.push(String(b)));owner.stderr.on('data',b=>ownerLogs.push(String(b)))
 ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Private real semantic owner did not start: '+ownerLogs.join(''))),20000);owner.once('message',m=>{clearTimeout(timer);resolve(m)});owner.once('exit',code=>{clearTimeout(timer);reject(new Error('Private semantic owner exited '+code+': '+ownerLogs.join('')))})});assert.equal(ready.ready,true);receipt.owner=ready
 for(const provider of ['codex','claude'])for(const phase of ['seed','adopt','confirmed-restore']){const lines=[],phaseRoot=path.join(privateRoot,provider+'-'+phase);await fs.mkdir(phaseRoot);const exit=await runProbeProcess(desktopRequire('electron'),[path.join(evidence,'main.mjs'),path.join(renderer,'index.html'),privateRoot,provider,phase,path.join(fixture,'preload.cjs'),evidence,process.execPath],{temporaryRoot:phaseRoot,cwd:root,env,timeoutMs:90000,onLine:line=>{lines.push(line);process.stderr.write(provider+'/'+phase+': '+line.slice(0,900)+'\n')}});await fs.writeFile(path.join(evidence,provider+'-'+phase+'-stderr.log'),lines.join('\n'));const fact=JSON.parse(await fs.readFile(path.join(evidence,provider+'-'+phase+'.json'),'utf8'));receipt.processes.push({...exit,...fact});assert.equal(exit.exitCode,0,JSON.stringify(fact.failure));assert.equal(fact.passed,true);console.log('native source Electron '+provider+'/'+phase+' passed PID='+fact.pid)}
 assert.equal(new Set(receipt.processes.map(p=>p.pid)).size,6)
 if(!cssMutant){
  const negative=path.join(evidence,'menu-clamp-mutant');let exitCode=0
  try{await run(process.execPath,[import.meta.filename,negative],{cwd:root,env:{...process.env,AGENTMUX_NATIVE_UI_CSS_MUTANT:'1',AGENTMUX_NATIVE_UI_REUSE_CONTROL_RECEIPT:path.join(evidence,'source-controls.json')},timeout:90000,maxBuffer:4*1024*1024})}catch(error){exitCode=error.code;await fs.writeFile(path.join(evidence,'menu-clamp-mutant.log'),(error.stdout??'')+(error.stderr??''))}
  assert.ok(Number.isInteger(exitCode)&&exitCode>0,'Actual source CSS clamp mutant must fail')
  const red=JSON.parse(await fs.readFile(path.join(negative,'receipt.json'),'utf8'))
  assert.equal(red.visualMutation?.sourceSHA256,receipt.sourceBefore['apps/desktop/src/renderer/src/styles/agent-region-header.css'])
  assert.ok(red.processes.some(p=>p.failure?.message==='Native source menu stays inside the actual viewport'),'CSS mutant fails for actual menu geometry')
  assert.deepEqual(red.cleanup.errors,[]);assert.deepEqual(red.cleanup.remaining,[])
  receipt.visualMutationGate={label:'remove-real-menu-height-bound',red:exitCode,receipt:path.join(negative,'receipt.json'),green:0,controlPIDs:receipt.processes.map(p=>p.pid)}
 }

 const scanned=await files(path.join(root,'apps/desktop/src')),callers=[]
 for(const[symbol,definition]of[['projectNativeSourceFacts','apps/desktop/src/shared/agent-native-source.ts'],['nativeBindingKey','apps/desktop/src/shared/agent-native-source.ts'],['confirmNativeSession','apps/desktop/src/main/runtime-controller.ts'],['useAgentNativeSourceControls','apps/desktop/src/renderer/src/components/AgentNativeSourceControls.tsx'],['useSessionUserMessages','apps/desktop/src/renderer/src/lib/session-user-messages.ts']]){const found=[];for(const file of scanned.filter(p=>p!==path.join(root,definition)))if(new RegExp('(?:\\b'+symbol+'\\s*\\(|<'+symbol+'\\b)').test(await fs.readFile(file,'utf8')))found.push(path.relative(root,file));assert.ok(found.length,'Nonempty production callers '+symbol);callers.push({symbol,callers:found})}
 assert.ok(scanned.length);receipt.productionConsumers={scanned:scanned.length,callers}
 receipt.sourceAfter=Object.fromEntries(await Promise.all(owned.map(async p=>[p,sha(await fs.readFile(path.join(root,p)))])));assert.deepEqual(receipt.sourceAfter,receipt.sourceBefore);receipt.passed=true
}catch(error){receipt.failure={name:error.name,message:error.message,stack:error.stack};console.error(error)}
finally{
 if(Object.keys(receipt.sourceBefore).length)receipt.sourceAfter=Object.fromEntries(await Promise.all(owned.map(async p=>[p,sha(await fs.readFile(path.join(root,p)))])))
 const errors=[]
 if(owner){try{if(owner.exitCode===null){const stopped=new Promise(resolve=>owner.once('exit',resolve));owner.send({operation:'shutdown'});await Promise.race([stopped,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Owner cleanup timeout')),15000))])} }catch(e){errors.push(e.message);owner.kill('SIGTERM')}}
 try{await stopProbeProcesses(process.pid+1_000_000_000,privateRoot)}catch(e){errors.push(e.message)}
 const remaining=await listProbeProcesses(-1,privateRoot);receipt.cleanup={errors,remaining,privateRootRemoved:false};if(!remaining.length){await fs.rm(privateRoot,{recursive:true,force:true});receipt.cleanup.privateRootRemoved=true}await fs.writeFile(path.join(evidence,'receipt.json'),JSON.stringify(receipt,null,2))
}
assert.equal(receipt.passed,true,receipt.failure?.message);assert.deepEqual(receipt.cleanup.errors,[]);assert.deepEqual(receipt.cleanup.remaining,[])
console.log(JSON.stringify({passed:true,receipt:path.join(evidence,'receipt.json'),screenshots:receipt.processes.reduce((n,p)=>n+p.screenshots.length,0)}))
