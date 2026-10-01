import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, writeFile, copyFile, rm, truncate } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { runProbeProcess, listProbeProcesses, signalOwnedProbeProcess } from './probe-process.mjs'
import { sourceAliases } from './fixtures/bookmark-local-link/vitest.owning.config.mts'
const require=createRequire(import.meta.url),{build}=await import('vite'),esbuild=createRequire(require.resolve('vite'))('esbuild')
const root=resolve(import.meta.dirname,'../../..'),desktop=join(root,'apps/desktop'),fixture=join(desktop,'scripts/fixtures/bookmark-local-link')
let consume=false,output='docs/reviews/evidence/bookmark-local-link-2026-10-05/native'
for(let index=2;index<process.argv.length;index++) {
 const [flag,inline]=process.argv[index].split('=')
 if(flag==='--receipt'){assert.equal(inline,undefined);consume=true;continue}
 assert.equal(flag,'--output','Unknown argument: '+flag);output=inline??process.argv[++index];assert.ok(output&&!output.startsWith('--'))
}
const evidence=resolve(root,output),sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const sources=['src/shared/bookmark-file.ts','src/main/bookmark-file.ts','src/main/workspace-files.ts','src/main/browser-view-manager.ts','src/main/native-overlay-surfaces.ts','src/shared/native-overlay.ts','src/renderer/src/hooks/useNativeOverlayChrome.ts','src/renderer/src/lib/native-overlay-regions.ts','src/main/browser-profile-manager.ts','src/main/browser-profile-store.ts','src/main/browser-ref-ledger-store.ts','src/preload/index.ts','src/renderer/src/store.ts','src/renderer/src/lib/workbench-persistence.ts','src/renderer/src/lib/workbench-tabs.ts','src/renderer/src/components/BrowserPane.tsx','src/renderer/src/components/FileExplorer.tsx','src/renderer/src/components/WorkspaceWorkbench.tsx','src/renderer/src/styles/browser.css','src/renderer/src/styles/index.css',...['entry.tsx','main.cjs','preload.ts','native-owner.ts','index.html','vitest.owning.config.mts'].map(name=>'scripts/fixtures/bookmark-local-link/'+name)]
async function bindings(){const result={};for(const file of sources)result['apps/desktop/'+file]=sha(await readFile(join(desktop,file)));result['apps/desktop/scripts/verify-bookmark-local-link-native.mjs']=sha(await readFile(import.meta.filename));return result}
const identity=await bindings()
function assertFrames(frames){
 assert.ok(frames.length>0)
 const layers=frames.flatMap(frame=>frame.layers).filter(layer=>layer.kind==='browser');assert.ok(layers.length>0)
 assert.ok(layers.some(layer=>new URL(layer.url).protocol==='http:'));assert.ok(layers.some(layer=>new URL(layer.url).protocol==='file:'))
 for(const frame of frames){assert.ok(frame.root.pixelSize.width>0&&frame.root.pixelSize.height>0);assert.ok(frame.method.includes('composed workface'));for(const layer of frame.layers){assert.equal(layer.visible,true);assert.ok(layer.bounds.width>0&&layer.bounds.height>0);assert.ok(layer.pixelSize.width>0&&layer.pixelSize.height>0)}}
}
if(consume) {
 const receipt=JSON.parse(await readFile(join(evidence,'capture-receipt.json'),'utf8'))
 assert.equal(receipt.schema,'agentmux.bookmark-local-link-native.v1');assert.equal(receipt.passed,true);assert.deepEqual(receipt.identity,identity);assert.equal(receipt.sourceDigest,sha(JSON.stringify(identity)))
 assert.equal(receipt.processes.length,2);assert.notEqual(receipt.processes[0].render.pid,receipt.processes[1].render.pid);assert.equal(receipt.processes[1].render.durable.passed,true)
 for(const item of receipt.processes){assert.equal(item.outcome.exitCode,0);assert.equal(item.outcome.timedOut,false);assert.equal(item.outcome.interruption,null);assert.equal(item.render.passed,true);assert.ok(item.render.pid>0);for(const key of ['nativeOwnerSha256','preloadSha256','mainSha256'])assert.equal(item.render.loaded[key],receipt.compiled[key]);assert.equal(item.render.loaded.rendererHtmlSha256,receipt.compiled.archive['renderer/index.html']);assert.ok(item.render.frames.length>0);assert.equal(sha(await readFile(join(evidence,item.log))),item.logSha256);const raw=await readFile(join(evidence,item.report),'utf8');assert.equal(sha(raw),item.reportSha256);assert.deepEqual(JSON.parse(raw),item.render)}
 assertFrames(receipt.frames)
 assert.deepEqual(receipt.frames.map(({sha256,root,layers,...frame})=>({...frame,root:Object.fromEntries(Object.entries(root).filter(([key])=>key!=='sha256')),layers:layers.map(layer=>Object.fromEntries(Object.entries(layer).filter(([key])=>key!=='sha256')))})),receipt.processes.flatMap(item=>item.render.frames))
 assert.ok(receipt.frames.length>0);for(const item of receipt.frames){assert.equal(sha(await readFile(join(evidence,item.file))),item.sha256);assert.equal(sha(await readFile(join(evidence,item.root.file))),item.root.sha256);for(const layer of item.layers){assert.equal(layer.visible,true);assert.ok(layer.bounds.width>0&&layer.bounds.height>0);assert.equal(sha(await readFile(join(evidence,layer.file))),layer.sha256)}}
 const compiled=receipt.compiled.archive;assert.ok(Object.keys(compiled).length>0);for(const[file,hash]of Object.entries(compiled))assert.equal(sha(await readFile(join(evidence,'compiled',file))),hash)
 for(const[file,hash]of Object.entries(receipt.compiled.loaded))if(identity[file])assert.equal(identity[file],hash)
 assert.deepEqual(receipt.cleanup.remaining,[]);assert.equal(receipt.cleanup.rootRemoved,true);assert.equal(receipt.userRunTouched,false)
 console.log(JSON.stringify({passed:true,mode:'read-only-current-proof',receipt:output+'/capture-receipt.json',sourceDigest:receipt.sourceDigest,frames:receipt.frames.length}));process.exit(0)
}
await mkdir(evidence,{recursive:true});const privateRoot=await mkdtemp('/tmp/amx-bookmark-proof-'),profile=join(privateRoot,'profile'),workspace=join(privateRoot,'workspace'),outDir=join(privateRoot,'out')
const server=createServer((_request,response)=>{response.setHeader('Content-Type','text/html; charset=utf-8');response.end('<!doctype html><title>Research &amp; Notes</title><style>body{background:#17231e;color:#eaf1ed;font:20px system-ui;padding:48px}p{color:#a8bbb0}</style><h1>A saved local link</h1><p>HTTP target opened by the original AgentMux Browser.</p>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const httpUrl=`http://127.0.0.1:${server.address().port}/`
const report={schema:'agentmux.bookmark-local-link-native.v1',passed:false,identity,sourceDigest:sha(JSON.stringify(identity)),processes:[],frames:[],userRunTouched:false,boundary:'Two ordinary Electron processes share a private profile with explicitly software Chromium painting. Production Workbench/FileExplorer/BrowserPane/Monaco and preload call real WorkspaceFiles/raw-byte/plutil/BrowserViewManager/profile/presentation/native-Chrome owners through a narrow private IPC adapter; registered production Main IPC is proven by bookmark-owner-ipc.test.ts. Native file: and HTTP pages are real sandboxed Chromium owners. Original Renderer controls receive Chromium CDP mouse/keyboard input. Config/Core/provider discovery facts are explicitly controlled; no GPU, healthy native Run or installed user App claim.'}
try {
 await mkdir(profile);await mkdir(workspace)
 const localFile=join(workspace,'target.html'),localUrl=pathToFileURL(localFile).href
 await writeFile(localFile,'<!doctype html><title>Local saved target</title><style>body{background:#f0f5f1;color:#24352b;font:20px system-ui;padding:48px}</style><h1>A local file URL</h1><p>Original sandboxed Browser owner.</p>')
 await writeFile(join(workspace,'notes.md'),'# Original neighbor\n\nThis File Region remains in its original split across restart.\n')
 await writeFile(join(workspace,'Local.url'),`[InternetShortcut]\nURL=${localUrl}\n`)
 const xml=url=>`<?xml version="1.0"?><plist version="1.0"><dict><key>URL</key><string>${url}</string></dict></plist>`
 await writeFile(join(workspace,'Numeric.webloc'),xml(httpUrl+'?a=1&#38;b=2'))
 await writeFile(join(workspace,'Binary.webloc'),execFileSync('/usr/bin/plutil',['-convert','binary1','-o','-','-'],{input:xml(localUrl)}))
 await writeFile(join(workspace,'Large.webloc'),xml(httpUrl));await truncate(join(workspace,'Large.webloc'),4*1024*1024+1)
 const original={};for(const file of await readdir(workspace))original[file]=sha(await readFile(join(workspace,file)))
 const loaded={},styles={},alias=sourceAliases
 await build({configFile:false,root:fixture,base:'./',logLevel:'error',resolve:{alias},plugins:[{name:'bookmark-production-identity',enforce:'pre',transform(bytes,id){if(id.startsWith(desktop+'/src/')&&!id.includes('?'))loaded[id.slice(root.length+1)]=sha(bytes)},async generateBundle(){for(const file of this.getWatchFiles())if(file.startsWith(desktop+'/src/')&&file.endsWith('.css'))styles[file.slice(root.length+1)]=sha(await readFile(file))}}],define:{__AGENTMUX_WEB_PREVIEW__:'false','process.env.NODE_ENV':'"production"'},esbuild:{jsx:'automatic'},build:{outDir,emptyOutDir:true}})
 for(const file of sources.filter(file=>file.startsWith('src/renderer/')&&!file.endsWith('.css')))assert.equal(loaded['apps/desktop/'+file],identity['apps/desktop/'+file],'Actual compiled production module: '+file)
 for(const file of sources.filter(file=>file.endsWith('.css')))assert.equal(styles['apps/desktop/'+file],identity['apps/desktop/'+file],'Actual imported CSS: '+file)
 const nativeModule=join(privateRoot,'native-owner.mjs')
 await esbuild.build({entryPoints:[join(fixture,'native-owner.ts')],outfile:nativeModule,bundle:true,platform:'node',format:'esm',banner:{js:"import { createRequire as bookmarkProofCreateRequire } from 'node:module'; const require = bookmarkProofCreateRequire(import.meta.url);"},external:['electron'],alias:Object.fromEntries(alias.map(item=>[item.find,item.replacement])),logLevel:'error'})
 await esbuild.build({entryPoints:[join(fixture,'preload.ts')],outfile:join(privateRoot,'preload.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron'],logLevel:'error'})
 const main=join(privateRoot,'main.cjs');await copyFile(join(fixture,'main.cjs'),main)
 report.compiled={loaded,styles,nativeOwnerSha256:sha(await readFile(nativeModule)),preloadSha256:sha(await readFile(join(privateRoot,'preload.cjs'))),mainSha256:sha(await readFile(main)),archive:{}}
 await mkdir(join(evidence,'compiled'),{recursive:true})
 for(const [name,file]of [['native-owner.mjs',nativeModule],['preload.cjs',join(privateRoot,'preload.cjs')],['main.cjs',main]]){await copyFile(file,join(evidence,'compiled',name));report.compiled.archive[name]=sha(await readFile(file))}
 for(const entry of await readdir(outDir,{recursive:true,withFileTypes:true}))if(entry.isFile()){const file=join(entry.parentPath,entry.name),name='renderer/'+file.slice(outDir.length+1);await mkdir(resolve(evidence,'compiled',name,'..'),{recursive:true});await copyFile(file,join(evidence,'compiled',name));report.compiled.archive[name]=sha(await readFile(file))}
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
 for(const phase of ['capture','restart']) {
  const lines=[],outcome=await runProbeProcess(require('electron'),[main,join(outDir,'index.html'),profile,evidence,phase,nativeModule,workspace,httpUrl,localUrl],{temporaryRoot:privateRoot,cwd:root,env,timeoutMs:120000,onLine:line=>lines.push(line)})
  await writeFile(join(evidence,phase+'-process.log'),lines.join('\n'))
  const item={phase,outcome,log:phase+'-process.log',logSha256:sha(await readFile(join(evidence,phase+'-process.log')))};report.processes.push(item)
  const rawReport=await readFile(join(evidence,phase+'-render.json'),'utf8').catch(()=>null)
  assert.ok(rawReport?.trim(),'Private Electron '+phase+' ended without a complete Renderer report: '+JSON.stringify(outcome))
  const render=JSON.parse(rawReport);Object.assign(item,{render,report:phase+'-render.json',reportSha256:sha(rawReport)})
  assert.equal(outcome.exitCode,0,render.failure?.message);assert.equal(render.passed,true);for(const key of ['nativeOwnerSha256','preloadSha256','mainSha256'])assert.equal(render.loaded[key],report.compiled[key]);assert.equal(render.loaded.rendererHtmlSha256,report.compiled.archive['renderer/index.html'])
  for(const frame of render.frames)report.frames.push({...frame,sha256:sha(await readFile(join(evidence,frame.file))),root:{...frame.root,sha256:sha(await readFile(join(evidence,frame.root.file)))},layers:await Promise.all(frame.layers.map(async layer=>({...layer,sha256:sha(await readFile(join(evidence,layer.file)))})))})
 }
 assert.notEqual(report.processes[0].render.pid,report.processes[1].render.pid);assert.equal(report.processes[1].render.durable.passed,true)
 for(const [file,hash]of Object.entries(original))assert.equal(sha(await readFile(join(workspace,file))),hash,'Original bytes preserved: '+file)
 report.originalFiles=original;assert.deepEqual(await bindings(),identity,'Source is unchanged during the proof');assertFrames(report.frames);report.passed=true
}catch(error){report.failure={name:error.name,message:error.message,stack:error.stack}}
finally {
 for(const pid of await listProbeProcesses(-1,privateRoot))await signalOwnedProbeProcess(pid,privateRoot,'SIGKILL')
 report.cleanup={remaining:await listProbeProcesses(-1,privateRoot)};await rm(privateRoot,{recursive:true,force:true});report.cleanup.rootRemoved=true;await new Promise(resolve=>server.close(resolve));await writeFile(join(evidence,'capture-receipt.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,evidence,sourceDigest:report.sourceDigest,failure:report.failure??null}));process.exitCode=report.passed?0:1
}
