import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {mkdtemp,mkdir,readFile,writeFile,rm,copyFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve,relative} from 'node:path'
import {pathToFileURL} from 'node:url'
import {spawnSync} from 'node:child_process'
import {runProbeProcess,listProbeProcesses} from '../../probe-process.mjs'
const repository=resolve(import.meta.dirname,'../../../../..'),desktop=join(repository,'apps/desktop'),fixture=import.meta.dirname,mature=join(desktop,'scripts/fixtures/mote-shortcut')
const require=createRequire(join(desktop,'package.json')),{build}=createRequire(require.resolve('vite/package.json'))('esbuild')
const digest=b=>createHash('sha256').update(b).digest('hex')
const evidence=join(repository,'.tmp','shared-native-browser-pane-canonical-'+Date.now());await mkdir(evidence,{recursive:true})
const receipt={schema:'agentmux.shared-native-browser-pane-capability-wrapper.v1',evidence,passed:false,productImplemented:false,T004Qualified:false,userAppRunRuntimeControls:0,inputs:{},transformations:[],limitations:['Research BrowserPane slot/native-bounds arbitration and mature private mote-native bridge do not constitute registered product IPC caller or multi-surface product delivery.','Same fixed viewport, original single page/profile/WebContents/native view, one stream/two videos. No any-size/cross-requester scalability claim.','Trusted CDP is not physical OS/IME/clipboard qualification; user clipboard is never read/written.','Requester/source Renderer and Native page PNGs are separate WebContents captures, not OS composition; diagnostic pixel sample is not transport.']}
let privateRoot;const logs=[],inputs=new Map()
const plugin={name:'original-product-plus-explicit-private-research-seams',setup(b){
 b.onLoad({filter:/\.[cm]?[jt]sx?$/},async({path})=>{
  if(!path.startsWith(repository+'/')||path.includes('/node_modules/'))return
  const raw=await readFile(path,'utf8');inputs.set(path,digest(raw));let code=raw
  const exact=(from,to)=>{assert.equal(code.split(from).length-1,1,'Unique private transform '+from);code=code.replace(from,to)}
  if(path===join(desktop,'src/renderer/src/lib/api.ts')){
   exact('export const api = __AGENTMUX_WEB_PREVIEW__ ? mockApi : requireDesktopApi()','export const api = mockApi')
   receipt.transformations.push({path:relative(repository,path),reason:'Maintained typed factory only for non-Browser data; actual native branch and mature private Browser/UI bridge retained',originalSHA:digest(raw),consumedSHA:digest(code)})
  }
  if(path===join(desktop,'src/renderer/src/components/BrowserPane.tsx')){
   exact('  onControlConfirmation\n}: {','  onControlConfirmation,\n  researchPresentation\n}: {')
   exact('  tab: BrowserWorkbenchSurface','  researchPresentation?: { native: boolean; body: import(\'react\').ReactNode }\n  tab: BrowserWorkbenchSurface')
   exact('    if (!stage) return\n    let frame = 0','    if (!stage || !researchPresentation?.native) return\n    let frame = 0')
   exact('tab.error, tab.url, visible])','tab.error, tab.url, visible, researchPresentation?.native])')
   exact('data-native-browser-stage={tab.browserId} ref={stageRef}>','data-native-browser-stage={tab.browserId} ref={stageRef}>\n        {researchPresentation?.body}')
   receipt.transformations.push({path:relative(repository,path),reason:'Private optional video slot and one-native-input-host gate only; no product lifecycle/registered ABI change',originalSHA:digest(raw),consumedSHA:digest(code)})
   await writeFile(join(evidence,'BrowserPane.private-candidate.tsx'),code)
  }
  return{contents:code,loader:path.endsWith('tsx')?'tsx':path.endsWith('ts')?'ts':'js'}
 })
 b.onLoad({filter:/\.css$/},async({path})=>{if(!path.startsWith(repository+'/')||path.includes('/node_modules/'))return;const bytes=await readFile(path);inputs.set(path,digest(bytes));return{contents:bytes.toString(),loader:'css'}})
}}
try{
 receipt.planMetadata={feature:'f-2gn8f5azk',task:'T-003',path:'docs/plans/shared-workbench-entity-binding-task-plan-2026-10-04.json',qualification:'Research only. Approved plan is metadata, not a private ignored-file Runtime gate.'}
 const fresh=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',`const {assertWorkspaceDistBuiltFromCurrentSource}=await import(${JSON.stringify(pathToFileURL(join(repository,'vitest.dist-freshness.ts')).href)});await assertWorkspaceDistBuiltFromCurrentSource(${JSON.stringify(repository)});`],{cwd:repository,encoding:'utf8'})
 await writeFile(join(evidence,'freshness.log'),fresh.stdout+fresh.stderr);receipt.freshness={exitCode:fresh.status,rebuilt:false};assert.equal(fresh.status,0,'Canonical original Core/Demand freshness; no bypass or implicit build')
 receipt.main=spawnSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).stdout.trim()
 privateRoot=await mkdtemp(join(tmpdir(),'amux-native-pane-research-'));const out=join(privateRoot,'out');await mkdir(out)
 for(const file of ['browser-pane-main.cjs','browser-pane-entry.mjs','browser-pane.css','browser-pane-proof.mjs'])inputs.set(join(fixture,file),digest(await readFile(join(fixture,file))))
 for(const file of ['browser.html','preload.cjs'])inputs.set(join(mature,file),digest(await readFile(join(mature,file))))
 inputs.set(join(desktop,'scripts/verify-shared-native-presentation.mjs'),digest(await readFile(join(desktop,'scripts/verify-shared-native-presentation.mjs'))))
 const nativeBundle=join(out,'native.mjs'),rendererBundle=join(out,'app.js')
 const nativeBuild=await build({entryPoints:[join(mature,'native-browser.ts')],outfile:nativeBundle,bundle:true,platform:'node',format:'esm',packages:'bundle',target:'node22',external:['electron'],metafile:true,plugins:[plugin],logLevel:'silent',banner:{js:"import {createRequire as createNativeRequire} from 'node:module';const require=createNativeRequire(import.meta.url);"}})
 const rendererBuild=await build({entryPoints:[join(fixture,'browser-pane-entry.mjs')],outfile:rendererBundle,bundle:true,platform:'browser',format:'esm',target:'es2022',jsx:'automatic',nodePaths:[join(desktop,'node_modules')],metafile:true,plugins:[plugin],logLevel:'silent',define:{__AGENTMUX_WEB_PREVIEW__:'false','process.env.NODE_ENV':'"production"'},loader:{'.png':'file','.svg':'file','.woff2':'file','.woff':'file','.ttf':'file'}})
 receipt.inputCount=inputs.size;receipt.inputs=Object.fromEntries([...inputs].map(([file,sha])=>[relative(repository,file),sha]))
 for(const suffix of ['BrowserPane.tsx','browser-bounds-sync.ts','browser-view-manager.ts','browser-profile-manager.ts','browser-profile-store.ts'])assert.ok([...inputs.keys()].some(p=>p.endsWith('/'+suffix)),'Nonempty actual production consumer '+suffix)
 await writeFile(join(evidence,'metafiles.json'),JSON.stringify({native:nativeBuild.metafile,renderer:rendererBuild.metafile},null,2)+'\n')
 await writeFile(join(out,'index.html'),'<!doctype html><html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; media-src blob:"><div id="root"></div><link rel="stylesheet" href="app.css"><script type="module" src="app.js"></script></html>')
 await mkdir(join(evidence,'compiled'))
 receipt.compiled={};for(const file of ['native.mjs','app.js','app.css','index.html']){const bytes=await readFile(join(out,file));receipt.compiled[file]={sha256:digest(bytes),bytes:bytes.length};await copyFile(join(out,file),join(evidence,'compiled',file))}
 const env={...process.env,AGENTMUX_DESKTOP_USER_DATA:join(privateRoot,'user-data'),AGENTMUX_RUNTIME_DIRECTORY:join(privateRoot,'runtime'),AGENTMUX_STATE_DIRECTORY:join(privateRoot,'state')};delete env.ELECTRON_RUN_AS_NODE
 const run=await runProbeProcess(require('electron'),[join(fixture,'browser-pane-main.cjs'),privateRoot,evidence,nativeBundle,join(mature,'preload.cjs'),join(mature,'browser.html'),out],{temporaryRoot:privateRoot,cwd:repository,env,timeoutMs:65000,onLine:line=>logs.push(line)})
 receipt.process=run;receipt.native=JSON.parse(await readFile(join(evidence,'native-receipt.json'),'utf8'));receipt.capturedFacts=receipt.native.cases.length>0
 receipt.frames=[];for(const frame of receipt.native.frames){const bytes=await readFile(join(evidence,frame.file));receipt.frames.push({...frame,sha256:digest(bytes),bytes:bytes.length})}
 receipt.sourceAfter=Object.fromEntries(await Promise.all([...inputs.keys()].map(async file=>[relative(repository,file),digest(await readFile(file))])))
 receipt.sourceUnchanged=JSON.stringify(receipt.sourceAfter)===JSON.stringify(receipt.inputs)
 assert.deepEqual(receipt.sourceAfter,receipt.inputs,'Exact consumed Source before/after')
 assert.equal(run.exitCode,0,'Sole private probe actual exit');assert.equal(receipt.native.passed,true)
 assert.equal(receipt.native.cases.length,5,'Original five positive stages, no historical matrix replay')
 assert.equal(receipt.native.invalidGrant?.passed,true,'Actual invalid-document request rejection')
 assert.equal(receipt.native.captureRequests.length,2)
 assert.equal(receipt.native.captureRequests.filter(request=>request.allowed).length,1)
 assert.equal(receipt.native.invalidGrant.renderer.failure?.name,'AbortError')
 assert.equal(receipt.native.invalidGrant.renderer.failure?.message,'Invalid capture constraints')
 assert.equal(receipt.frames.length,8,'Four requester/original-native diagnostic pairs remain nonempty')
 receipt.passed=true;receipt.streamRevocationOnNavigation='not-qualified; rejecting new request does not establish revocation of an authorized stream';receipt.aestheticReview='pending independent review; actual facts only'
}catch(e){receipt.failure={name:e.name,message:e.message,stack:e.stack}}
finally{
 await writeFile(join(evidence,'process.log'),logs.join('\n')+'\n')
 if(privateRoot){const remaining=await listProbeProcesses(-1,privateRoot);receipt.cleanup={privateRoot,remaining,removed:false,borrowedLinksChanged:false};if(!remaining.length){await rm(privateRoot,{recursive:true});receipt.cleanup.removed=true}}
 await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')
 console.log(JSON.stringify({evidence:relative(repository,evidence),researchPassed:receipt.passed,cases:receipt.native?.cases.length,inputQualifiedCDP:receipt.native?.input?.qualified,invalidGrantRejected:receipt.native?.invalidGrant?.passed,sourceUnchanged:receipt.sourceUnchanged,failure:receipt.failure?.message,cleanup:receipt.cleanup}))
 if(!receipt.passed)process.exitCode=1
}
