import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, writeFile, copyFile, rm, truncate } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runProbeProcess, listProbeProcesses, signalOwnedProbeProcess } from './probe-process.mjs'
const require = createRequire(import.meta.url), { build } = await import('vite'), viteRequire = createRequire(require.resolve('vite')), esbuild = viteRequire('esbuild'), ts = require('typescript'), run = promisify(execFile)
const desktop = resolve(import.meta.dirname,'..'), repository = resolve(desktop,'../..'), sourceRoot = join(desktop,'src/renderer/src'), fixture = join(desktop,'scripts/fixtures/local-file-preview')
const arg = name => process.argv.find(value=>value.startsWith(name+'='))?.slice(name.length+1), sha = bytes => createHash('sha256').update(bytes).digest('hex')
const receiptPath = arg('--receipt') ? resolve(repository,arg('--receipt')) : null
const evidence = arg('--output') ? resolve(repository,arg('--output')) : receiptPath ? dirname(receiptPath) : join(repository,'.tmp/local-file-preview-capture')
const designRoot = arg('--design-root') ? resolve(arg('--design-root')) : repository
const rendererModules = ['components/FileSurfaceView.tsx','components/FilePreviewPane.tsx','components/EditorPane.tsx','components/SessionPane.tsx','components/AgentMarkdown.tsx','components/WorkspaceWorkbench.tsx','lib/file-workbench-state.ts','lib/editor-save-shortcut.ts','lib/markdown-file-reference.ts','lib/workbench-persistence.ts','styles/file-preview.css']
async function bindings() {
 const sources={}
 for(const name of rendererModules)sources['renderer:'+name]=sha(await readFile(join(sourceRoot,name)))
 for(const name of ['main/workspace-files.ts','preload/index.ts','shared/contracts.ts','shared/workspace-file-preview.ts','shared/workspace-file-bytes.ts'])sources[name]=sha(await readFile(join(desktop,'src',name)))
 const store=await readFile(join(sourceRoot,'store.ts'),'utf8')
 for(const anchor of ['async function loadPersistedFileDocument(','  async openFile(','  async reloadDocument(','  async createBrowser(']) {
  const start=store.indexOf(anchor),end=anchor.startsWith('async function')?store.indexOf('\nasync function enqueueFileSave(',start):store.indexOf('\n  },',start)
  assert.ok(start>=0&&end>start,'Nonempty exact Store production binding: '+anchor);sources['store:'+anchor]=sha(store.slice(start,end))
 }
 sources['style-entry']=sha((await readFile(join(sourceRoot,'styles/index.css'),'utf8')).split('\n').filter(line=>line.includes('file-preview.css')).join('\n'));assert.ok((await readFile(join(sourceRoot,'styles/index.css'),'utf8')).includes("@import './file-preview.css';"))
 sources['production-csp']=sha(await readFile(join(desktop,'src/renderer/index.html')))
 for(const name of ['entry.tsx','main.cjs','preload.ts','native-file-owner.ts','index.html'])sources['fixture:'+name]=sha(await readFile(join(fixture,name)))
 for(const name of ['agentmux-desktop-interaction.md','agentmux-surface-density.md']) {
  const bytes=await readFile(join(designRoot,'docs/design',name),'utf8'),anchor=name.includes('interaction')?'#### 本地链接的真实格式预览与二进制保全':'## 本地文件查看与编辑表面',start=bytes.indexOf(anchor),end=bytes.indexOf('\n'+(name.includes('interaction')?'#### ':'## '),start+anchor.length)
  assert.ok(start>=0,'Current preview SSOT is registered');sources['SSOT:'+name]=sha(bytes.slice(start,end<0?bytes.length:end))
 }
 sources.oracle=sha(await readFile(import.meta.filename));return {sources,digest:sha(JSON.stringify(sources))}
}
async function callers() {
 const facts=[]
 for(const [symbol,definition,caller] of [['FileSurfaceView','components/FileSurfaceView.tsx','components/WorkspaceWorkbench.tsx'],['FilePreviewPane','components/FilePreviewPane.tsx','components/FileSurfaceView.tsx'],['ImageContent','components/FilePreviewPane.tsx','components/FileSurfaceView.tsx'],['workspaceFilePreviewFormat','../../shared/workspace-file-preview.ts','components/FileSurfaceView.tsx'],['classifyMarkdownLinkHref','lib/markdown-file-reference.ts','components/AgentMarkdown.tsx'],['reduceFileSurfaceOpened','lib/file-workbench-state.ts','store.ts'],['openFile','store.ts','components/SessionPane.tsx'],['openFile','store.ts','components/TerminalView.tsx'],['openFile','store.ts','components/FileExplorer.tsx']]) {
  assert.notEqual(definition,caller);const bytes=await readFile(join(sourceRoot,caller),'utf8'),source=ts.createSourceFile(caller,bytes,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),hits=[]
  function visit(node){if((ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node))&&node.tagName.getText(source)===symbol)hits.push(node.getText(source));if(ts.isCallExpression(node)&&node.expression.getText(source)===symbol)hits.push(node.getText(source));ts.forEachChild(node,visit)}visit(source)
  assert.ok(hits.length>0,'Actual caller outside definition/import/test: '+symbol+' in '+caller);facts.push({symbol,definition,caller,hits})
 }return facts
}
async function consumeSourceProofs() {
 const proofRoot=join(repository,'docs/reviews/evidence/local-file-preview-2026-10-04')
 const rendererPath=arg('--source-proof')?resolve(repository,arg('--source-proof')):join(proofRoot,'source-renderer-final/mutation-receipt.json')
 const renderer=JSON.parse(await readFile(rendererPath,'utf8'));assert.equal(renderer.passed,true);assert.ok(renderer.mutations.length>0);assert.equal(renderer.restoredGreen.exitCode,0)
 for(const mutation of renderer.mutations) {
  const current=await readFile(join(repository,mutation.file),'utf8'),block=mutation.productionBlock
  assert.ok(block?.text&&block.text.includes(mutation.mutation.old),'Actual mutated production block is bound');assert.equal(sha(block.text),block.sha256);assert.equal(current.split(block.text).length,2,'Exact current production block: '+mutation.name)
  const red=await readFile(join(dirname(rendererPath),mutation.red.log));assert.equal(sha(red),mutation.red.sha256);assert.notEqual(mutation.red.exitCode,0);assert.equal(mutation.red.assertionError,true);assert.ok(red.includes('AssertionError'))
 }
 const restored=await readFile(join(dirname(rendererPath),renderer.restoredGreen.log));assert.equal(sha(restored),renderer.restoredGreen.sha256);assert.ok(restored.includes('passed'))
 const mainPath=arg('--main-proof')?resolve(repository,arg('--main-proof')):join(proofRoot,'source-main/mutation-receipt.json'),main=JSON.parse(await readFile(mainPath,'utf8'))
 assert.ok(main.mutations.length>0);for(const [file,expected]of Object.entries(main.originals))assert.equal(sha(await readFile(join(repository,file))),expected,'Current Main owner matches restored source: '+file)
 for(const mutation of main.mutations){assert.notEqual(mutation.exitCode,0);assert.equal(mutation.assertionRed,true);assert.ok((await readFile(join(dirname(mainPath),mutation.log),'utf8')).includes('AssertionError'))}assert.equal(main.restored.exitCode,0)
 assert.ok((await readFile(join(dirname(mainPath),main.restored.log),'utf8')).includes('passed'))
 const htmlPath=arg('--html-proof')?resolve(repository,arg('--html-proof')):join(proofRoot,'html-native-receipt.json'),html=JSON.parse(await readFile(htmlPath,'utf8'))
 assert.equal(html.passed,true);assert.equal(html.result.passed,true);assert.equal(html.outcome.exitCode,0)
 for(const [file,expected]of Object.entries(html.identity))assert.equal(sha(await readFile(join(desktop,file))),expected,'Actual Browser proof source remains current: '+file)
 const facts=html.result.facts,prefs=html.result.preferences;assert.equal(facts.imageLoaded,true);assert.equal(facts.node,'undefined');assert.equal(facts.appBridge,'undefined');assert.equal(facts.electron,'undefined');assert.equal(prefs.contextIsolation,true);assert.equal(prefs.sandbox,true);assert.equal(prefs.nodeIntegration,false);assert.equal(prefs.preload,null)
 assert.equal(sha(await readFile(join(dirname(htmlPath),'html-native-browser.png'))),html.pngSha256)
 return {renderer:{path:rendererPath,sha256:sha(await readFile(rendererPath)),proof:renderer},main:{path:mainPath,sha256:sha(await readFile(mainPath)),proof:main},html:{path:htmlPath,sha256:sha(await readFile(htmlPath)),proof:html}}
}
await mkdir(evidence,{recursive:true});const identity=await bindings(),realCallers=await callers()
if(receiptPath) {
 const capture=JSON.parse(await readFile(join(evidence,'capture-receipt.json'),'utf8'));assert.equal(capture.passed,true);assert.equal(capture.sourceDigest,identity.digest)
 const review=JSON.parse(await readFile(arg('--review')?resolve(repository,arg('--review')):join(evidence,'independent-visual-review.json'),'utf8'));assert.equal(review.passed,true);assert.equal(review.sourceDigest,identity.digest);assert.ok(review.reviewer&&review.reviewer!=='launcher_surface')
 for(const frame of capture.frames){assert.equal(sha(await readFile(join(evidence,frame.file))),frame.sha256);assert.equal(review.frames.find(item=>item.file===frame.file)?.sha256,frame.sha256,'Independent review inspected exact image '+frame.file)}
 const sourceProofs=await consumeSourceProofs()
 const receipt={schema:'agentmux.local-file-preview-acceptance.v1',passed:true,identity,callers:realCallers,sourceProofs,capture,independentVisualReview:review,boundary:capture.boundary}
 await writeFile(receiptPath,JSON.stringify(receipt,null,2));console.log(JSON.stringify({passed:true,receipt:receiptPath,sourceDigest:identity.digest}));process.exit(0)
}
const privateRoot=await mkdtemp('/tmp/amx-file-preview-'),profile=join(privateRoot,'profile'),workspace=join(privateRoot,'workspace'),outDir=join(privateRoot,'out')
const result={schema:'agentmux.local-file-preview-capture.v1',passed:false,sourceDigest:identity.digest,identity,callers:realCallers,frames:[],processes:[],userRunTouched:false,
 boundary:'Actual production Workbench/Region/FileExplorer, CSS, Monaco and native image/media/PDF engine. Production preload files IPC enters the real Main WorkspaceFiles byte/revision owner in a private workspace; other Core/config/Browser facts are controlled preview adapters. Two ordinary Electron processes share one private profile and read durable File identity/layout/focus/dirty buffers before fixture setup. No installed-user-App, external system application or healthy native Run claim. Independent aesthetics review is separate.'}
try {
 await mkdir(workspace);await mkdir(profile)
 const image=arg('--image')?resolve(arg('--image')):join(repository,'docs/reviews/evidence/launcher-launchpad-2026-10-04/wide-dark-default.png')
 await copyFile(image,join(workspace,'original.png'))
 for(const [name,extra] of [['photo.jpg',[]],['animation.gif',[]],['small.png',['-vf','scale=80:60']]])await run('ffmpeg',['-loglevel','error','-y','-i',join(workspace,'original.png'),'-frames:v','1',...extra,join(workspace,name)],{timeout:10000})
 await run('ffmpeg',['-loglevel','error','-y','-f','lavfi','-i','sine=frequency=440:duration=2',join(workspace,'tone.wav')],{timeout:10000})
 await run('ffmpeg',['-loglevel','error','-y','-f','lavfi','-i','testsrc=size=640x360:rate=12','-t','2','-c:v','libvpx','-pix_fmt','yuv420p',join(workspace,'motion.webm')],{timeout:10000})
 await writeFile(join(workspace,'drawing.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#8de3ae"/></svg>')
 await writeFile(join(workspace,'notes.md'),'# Saved Markdown\n\nA shared source document.\n\n[View the workspace PNG](original.png)')
 await writeFile(join(workspace,'opaque.unknown'),Buffer.from([0,255,128,0,44,88]));await writeFile(join(workspace,'broken.png'),'This is not image data.');await writeFile(join(workspace,'large.png'),'budget sample');await truncate(join(workspace,'large.png'),16777217)
 // A generated valid, one-page PDF fixture; actual support still requires the native production image review.
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];const stream='BT /F1 22 Tf 64 710 Td (Native workspace PDF preview) Tj 0 -40 Td /F1 13 Tf (Original File identity - Chromium PDF controls) Tj ET';objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);let pdf='%PDF-1.4\n',offsets=[0];for(let index=0;index<objects.length;index++){offsets.push(Buffer.byteLength(pdf));pdf+=`${index+1} 0 obj\n${objects[index]}\nendobj\n`}const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;await writeFile(join(workspace,'sample.pdf'),pdf)
 const before={};for(const name of await readdir(workspace))before[name]=sha(await readFile(join(workspace,name)));result.originalFiles=before
 const loaded={},styles={}
 await build({configFile:false,root:fixture,base:'./',logLevel:'error',plugins:[{name:'file-preview-source-identity',enforce:'pre',transform(bytes,id){if(id.startsWith(sourceRoot+'/')&&!id.includes('?'))loaded[id.slice(sourceRoot.length+1)]=sha(bytes)},async generateBundle(){for(const file of this.getWatchFiles())if(file.startsWith(sourceRoot+'/')&&file.endsWith('.css'))styles[file.slice(sourceRoot.length+1)]=sha(await readFile(file))}}],define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},esbuild:{jsx:'automatic'},build:{outDir,emptyOutDir:true}})
 for(const file of rendererModules.filter(file=>!file.endsWith('.css')))assert.equal(loaded[file],identity.sources['renderer:'+file],'Actual module compiled: '+file)
 for(const file of rendererModules.filter(file=>file.endsWith('.css')))assert.equal(styles[file],identity.sources['renderer:'+file],'Actual stylesheet imported: '+file)
 const nativeModule=join(privateRoot,'workspace-files.mjs');await esbuild.build({entryPoints:[join(fixture,'native-file-owner.ts')],outfile:nativeModule,bundle:true,platform:'node',format:'esm',logLevel:'error'})
 await esbuild.build({entryPoints:[join(fixture,'preload.ts')],outfile:join(privateRoot,'preload.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron'],logLevel:'error'})
 const compiled={};for(const entry of await readdir(outDir,{recursive:true,withFileTypes:true}))if(entry.isFile())compiled[join(entry.parentPath,entry.name).slice(outDir.length+1)]=sha(await readFile(join(entry.parentPath,entry.name)));assert.ok(Object.keys(compiled).length>0);result.compiled={files:compiled,loadedSources:loaded,styles,mainSha256:sha(await readFile(nativeModule)),preloadSha256:sha(await readFile(join(privateRoot,'preload.cjs')))}
 const main=join(privateRoot,'main.cjs');await copyFile(join(fixture,'main.cjs'),main);const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
 for(const phase of ['capture','restart']) {
  const lines=[],outcome=await runProbeProcess(require('electron'),[main,join(outDir,'index.html'),profile,evidence,phase,nativeModule,workspace],{temporaryRoot:privateRoot,cwd:repository,env,timeoutMs:120000,onLine:line=>lines.push(line)})
  await writeFile(join(evidence,phase+'-process.log'),lines.join('\n'));const render=JSON.parse(await readFile(join(evidence,phase+'-render.json'),'utf8'));result.processes.push({phase,outcome,render});assert.equal(outcome.exitCode,0,render.failure?.message);assert.equal(render.passed,true)
  for(const frame of render.frames)result.frames.push({...frame,sha256:sha(await readFile(join(evidence,frame.file)))})
 }
 assert.notEqual(result.processes[0].render.pid,result.processes[1].render.pid);assert.equal(result.processes[1].render.durable.passed,true)
 const after={};for(const name of await readdir(workspace))after[name]=sha(await readFile(join(workspace,name)));assert.deepEqual(after,before,'Viewing, source-mode changes, drafts and restart preserve every original byte');result.originalFilesAfter=after
 assert.deepEqual(await bindings(),identity,'Relevant source did not change during capture');result.passed=true
}catch(error){result.failure={name:error.name,message:error.message,stack:error.stack}}
finally {
 const remaining=await listProbeProcesses(-1,privateRoot);for(const pid of remaining)await signalOwnedProbeProcess(pid,privateRoot,'SIGKILL');result.cleanup={remaining:await listProbeProcesses(-1,privateRoot)};assert.equal(result.cleanup.remaining.length,0)
 await rm(privateRoot,{recursive:true,force:true});await writeFile(join(evidence,'capture-receipt.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,evidence,sourceDigest:identity.digest,failure:result.failure??null}));process.exitCode=result.passed?0:1
}
