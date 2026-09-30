import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve, dirname } from 'node:path'
import { runProbeProcess, listProbeProcesses, signalOwnedProbeProcess } from './probe-process.mjs'
const require=createRequire(import.meta.url),{build}=await import('vite'),ts=require('typescript')
const desktop=resolve(import.meta.dirname,'..'), repository=resolve(desktop,'../..'), sourceRoot=join(desktop,'src/renderer/src'),fixture=join(desktop,'scripts/fixtures/launcher-launchpad')
const arg=name=>process.argv.find(value=>value.startsWith(name+'='))?.slice(name.length+1)
const receiptPath=arg('--receipt')?resolve(repository,arg('--receipt')):null
const evidence=arg('--output')?resolve(repository,arg('--output')):receiptPath?dirname(receiptPath):join(repository,'.tmp/launcher-launchpad-capture')
const designRoot=arg('--design-root')?resolve(arg('--design-root')):repository
const scenes=arg('--scenes')??'full'
const sha=value=>createHash('sha256').update(value).digest('hex')
const modules=['components/NewTabSurface.tsx','components/LauncherEnvironment.tsx','components/LaunchOptionControls.tsx','components/LauncherSecondarySurfaces.tsx','components/LauncherMoteAction.tsx','components/LauncherResumePicker.tsx','lib/launcher-state.ts','lib/launcher-resume.ts','lib/workbench-persistence.ts','lib/copy-path-display.ts','styles/launcher.css','styles/resume.css']
const section=(bytes,start,end)=>{const a=bytes.indexOf(start),b=end?bytes.indexOf(end,a+start.length):bytes.length;assert.ok(a>=0&&b>a,'Source binding has a nonempty exact scope: '+start);return bytes.slice(a,b)}
async function bindings(){
 const facts={}
 for(const file of modules)facts[file]=sha(await readFile(join(sourceRoot,file)))
 const store=await readFile(join(sourceRoot,'store.ts'),'utf8')
 for(const [name,start,end] of [['note-content','  async createNote(','  async openHttpLink('],['resume-owner','  async recoverSession(','  async deleteSession(']]){
  const a=store.indexOf(start);assert.ok(a>=0);let b=store.indexOf('\n  },',a);assert.ok(b>a);facts['store:'+name]=sha(store.slice(a,b+5))
 }
 const index=await readFile(join(sourceRoot,'styles/index.css'),'utf8');facts['style-entry']=sha(index.split('\n').filter(line=>/launcher\.css|resume\.css/.test(line)).join('\n'));assert.ok(index.includes("@import './launcher.css';")&&index.includes("@import './resume.css';"))
 for(const name of ['entry.tsx','main.cjs','preload.cjs','index.html'])facts['fixture:'+name]=sha(await readFile(join(fixture,name)))
 facts['oracle']=sha(await readFile(import.meta.filename))
 for(const [name,anchor] of [['agentmux-desktop-interaction.md','初始 Launcher'],['agentmux-surface-density.md','初始 Launcher']]){
  const bytes=await readFile(join(designRoot,'docs/design',name),'utf8'),start=bytes.lastIndexOf(anchor);assert.ok(start>=0,'Reviewed Launcher SSOT section must be registered');let heading=bytes.lastIndexOf('\n#',start),end=bytes.indexOf('\n## ',start+anchor.length);if(end<0)end=bytes.length;facts['SSOT:'+name]=sha(bytes.slice(heading>=0?heading:start,end))
 }
 return {sources:facts,digest:sha(JSON.stringify(facts))}
}
async function callers(){
 const result=[]
 for(const [symbol,definition,caller] of [['NewTabSurface','components/NewTabSurface.tsx','components/WorkspaceWorkbench.tsx'],['LauncherEnvironment','components/LauncherEnvironment.tsx','components/NewTabSurface.tsx'],['LaunchRefine','components/LaunchOptionControls.tsx','components/NewTabSurface.tsx'],['LauncherResumePicker','components/LauncherResumePicker.tsx','components/NewTabSurface.tsx'],['LauncherSecondarySurfaces','components/LauncherSecondarySurfaces.tsx','components/NewTabSurface.tsx'],['LauncherMoteAction','components/LauncherMoteAction.tsx','components/NewTabSurface.tsx']]){
  assert.notEqual(definition,caller);const file=join(sourceRoot,caller),bytes=await readFile(file,'utf8'),source=ts.createSourceFile(file,bytes,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),hits=[]
  function visit(node){if((ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node))&&node.tagName.getText(source)===symbol)hits.push(node.getText(source));ts.forEachChild(node,visit)}visit(source)
  assert.ok(hits.length>0,'Actual non-definition/non-test caller: '+symbol);result.push({symbol,definition,caller,hits,sha256:sha(hits.join('\n'))})
 }return result
}
async function consume(path,kind,identity,capture){
 const bytes=await readFile(path),proof=JSON.parse(bytes)
 assert.equal(proof.passed,true,kind+' must explicitly pass')
 if(kind==='Independent visual review'){
  assert.equal(proof.sourceDigest,identity.digest,'Independent review binds this Launcher candidate')
  assert.ok(proof.reviewer&&proof.reviewer!== 'launcher_surface','Independent review names its reviewer')
  for(const frame of capture.frames)assert.equal(proof.frames?.find(item=>item.file===frame.file)?.sha256,frame.sha256,'Independent review inspected exact PNG: '+frame.file)
 } else {
  assert.equal(proof.records?.length,2,'Native proof has two ordinary process records')
  const [before,after]=proof.records
  for(const key of ['id','run','childPid','daemon'])assert.deepEqual(after[key],before[key],'Native restart preserves original '+key)
  assert.notEqual(before.clientPid,after.clientPid);assert.ok(after.accepted>before.accepted&&after.output>before.output,'Original healthy Run accepts actual input and grows output after restart')
  assert.deepEqual(after.tabs,before.tabs);assert.deepEqual(after.layouts,before.layouts);assert.deepEqual(proof.inputsAfter,proof.inputsBefore);assert.equal(proof.cleanup?.remaining?.length,0)
  assert.match(proof.scope,/Core.*native PTY/u,'Native proof declares its actual runtime boundary')
 }
 return {path,sha256:sha(bytes),proof}
}
await mkdir(evidence,{recursive:true});const identity=await bindings(),realCallers=await callers()
if(receiptPath){
 const capture=JSON.parse(await readFile(join(evidence,'capture-receipt.json'),'utf8'))
 assert.equal(capture.passed,true);assert.equal(capture.sourceDigest,identity.digest,'Capture must match the current Launcher source/SSOT')
 for(const frame of capture.frames)assert.equal(sha(await readFile(join(evidence,frame.file))),frame.sha256,'PNG bytes have not changed')
 const review=await consume(arg('--review')?resolve(repository,arg('--review')):join(evidence,'independent-visual-review.json'),'Independent visual review',identity,capture)
 const runtime=await consume(arg('--runtime-proof')?resolve(repository,arg('--runtime-proof')):join(evidence,'runtime-restart.json'),'Native restart proof',identity,capture)
 const receipt={schema:'agentmux.launcher-launchpad-acceptance.v1',passed:true,sourceDigest:identity.digest,identity,callers:realCallers,capture,independentVisualReview:review,nativeRuntimeRestart:runtime,
  boundary:'Actual production Workbench/Region Renderer behavior and two-process private-profile restore; independent aesthetics review of these exact PNGs; separate native Core/ctxmux original healthy Run proof. No installed user App or Renderer update claim.'}
 await writeFile(receiptPath,JSON.stringify(receipt,null,2));console.log(JSON.stringify({passed:true,receipt:receiptPath,sourceDigest:identity.digest}));process.exit(0)
}
const privateRoot=await mkdtemp('/tmp/amx-launchpad-'),profile=join(privateRoot,'profile'),outDir=join(privateRoot,'out')
const result={schema:'agentmux.launcher-launchpad-capture.v1',passed:false,scenes,sourceDigest:identity.digest,identity,callers:realCallers,frames:[],processes:[],
 aestheticReview:'Not performed by capture. Independent review is required by the final receipt gate.',userRunTouched:false,
 boundary:'Actual isolated production Workbench/Region, CSS, rich editors and xterm. Controlled preview API facts. Two separate Electron processes reuse one private profile; no native daemon or vendor CLI continuity claim.'}
try{
 const loaded={},styles={}
 const wrapper=join(privateRoot,'xterm.mjs');await writeFile(wrapper,`import xterm from ${JSON.stringify(require.resolve('@xterm/xterm'))};export class Terminal extends xterm.Terminal {constructor(...args){super(...args);(globalThis.launchpadTerminals??=[]).push(this)}dispose(){this.disposed=true;return super.dispose()}}`);
 await build({configFile:false,root:fixture,base:'./',logLevel:'error',resolve:{alias:[{find:/^@xterm\/xterm$/,replacement:wrapper}]},plugins:[{name:'launcher-owned-source-identity',enforce:'pre',transform(bytes,id){if(id.startsWith(sourceRoot+'/')&&!id.includes('?'))loaded[id.slice(sourceRoot.length+1)]=sha(bytes)},async generateBundle(){for(const file of this.getWatchFiles())if(file.startsWith(sourceRoot+'/')&&file.endsWith('.css'))styles[file.slice(sourceRoot.length+1)]=sha(await readFile(file))}}],
  define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},esbuild:{jsx:'automatic'},build:{outDir,emptyOutDir:true}})
 for(const file of modules.filter(name=>!name.endsWith('.css')))assert.equal(loaded[file],identity.sources[file],'Actual production module compiled: '+file)
 for(const file of modules.filter(name=>name.endsWith('.css')))assert.equal(styles[file],identity.sources[file],'Actual stylesheet imported: '+file)
 const compiled={};for(const entry of await readdir(outDir,{recursive:true,withFileTypes:true}))if(entry.isFile())compiled[join(entry.parentPath,entry.name).slice(outDir.length+1)]=sha(await readFile(join(entry.parentPath,entry.name)))
 assert.ok(Object.keys(compiled).length>0);result.compiled={files:compiled,loadedSources:loaded,importedStyles:styles}
 const main=join(privateRoot,'main.cjs');await writeFile(main,await readFile(join(fixture,'main.cjs')));await writeFile(join(privateRoot,'preload.cjs'),await readFile(join(fixture,'preload.cjs')))
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
 for(const phase of ['capture','restart']){
  const lines=[],outcome=await runProbeProcess(require('electron'),[main,join(outDir,'index.html'),profile,evidence,phase,scenes],{temporaryRoot:privateRoot,cwd:repository,env,timeoutMs:120000,onLine:line=>lines.push(line)})
  await writeFile(join(evidence,phase+'-process.log'),lines.join('\n'));const render=JSON.parse(await readFile(join(evidence,phase+'-render.json'),'utf8'));result.processes.push({phase,outcome,render});assert.equal(outcome.exitCode,0,render.failure?.message);assert.equal(render.passed,true)
  for(const frame of render.frames)result.frames.push({...frame,sha256:sha(await readFile(join(evidence,frame.file)))})
 }
 assert.notEqual(result.processes[0].render.pid,result.processes[1].render.pid,'Durable read uses a separate actual Electron process')
 assert.equal(result.processes[1].render.durable.passed,true);assert.deepEqual(await bindings(),identity,'Relevant production source did not change during capture');result.passed=true
}catch(error){result.failure={name:error.name,message:error.message,stack:error.stack}}
finally{
 const remaining=await listProbeProcesses(-1,privateRoot);for(const pid of remaining)await signalOwnedProbeProcess(pid,privateRoot,'SIGKILL');result.cleanup={remaining:await listProbeProcesses(-1,privateRoot)}
 assert.equal(result.cleanup.remaining.length,0);await rm(privateRoot,{recursive:true,force:true});await writeFile(join(evidence,'capture-receipt.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,evidence,sourceDigest:identity.digest,failure:result.failure??null}));process.exitCode=result.passed?0:1
}
