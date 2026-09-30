import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {spawnSync} from 'node:child_process'
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve,relative} from 'node:path'
import {pathToFileURL} from 'node:url'
import {runProbeProcess,listProbeProcesses} from './probe-process.mjs'

const root=resolve(import.meta.dirname,'../../..'),desktop=join(root,'apps/desktop')
const recoveryScene=process.argv[4]==='--region-restart',regionScene=process.argv[4]==='--region'||recoveryScene
assert.ok(process.argv[2]==='--evidence'&&process.argv[3]&&(process.argv.length===4||(process.argv.length===5&&regionScene)),'Use --evidence <private evidence directory> [--region|--region-restart]')
const scene=recoveryScene?'region-recovery':regionScene?'region':'presentation'
const evidence=resolve(process.argv[3]);await mkdir(evidence,{recursive:true})
const privateRoot=await mkdtemp(join(tmpdir(),'amux-focus-caller-')),fixture=join(desktop,'scripts/fixtures/shared-workbench-bindings')
const require=createRequire(join(desktop,'package.json')), {build}=createRequire(require.resolve('vite/package.json'))('esbuild')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),inputs=new Map(),transformations=[],logs=[]
const receipt={schema:'agentmux.shared-focus-presentation-scene.v1',capturedPass:false,captureOnly:true,aestheticReview:'not-performed',userAppRunRuntimeControlled:false,
  boundary:'Light Renderer-only actual App/Focus/Workbench/Stable/Store and installed Panel browser primary. Maintained typed preview API; only SessionPane PTY/Agent paint and unused Monaco painting leaves isolated. No Runtime/native simultaneous presentation, Writer, ordinary restart or user installation.'}
try{
  const freshness=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',`const {assertWorkspaceDistBuiltFromCurrentSource}=await import(${JSON.stringify(pathToFileURL(join(root,'vitest.dist-freshness.ts')).href)});await assertWorkspaceDistBuiltFromCurrentSource(${JSON.stringify(root)});`],{cwd:root,encoding:'utf8'})
  await writeFile(join(evidence,'freshness.log'),freshness.stdout+freshness.stderr);assert.equal(freshness.status,0,'Original public freshness guard')
  const observe={name:'actual-app-focus-source-and-paint-leaf',setup(builder){builder.onLoad({filter:/\.[cm]?[jt]sx?$/},async({path})=>{
    if(!path.startsWith(root+'/')||path.includes('/node_modules/'))return
    const source=await readFile(path,'utf8');inputs.set(path,hash(source));const component=path.slice(path.lastIndexOf('/')+1)
    if(component==='SessionPane.tsx'){
      const code=`import {createElement as h,useEffect,useLayoutEffect,useRef} from 'react';import{useAppStore}from ${JSON.stringify(join(desktop,'src/renderer/src/store.ts'))};export function SessionPane({sessionId,linkOrigin,visible}){const key=linkOrigin.tabId+'/'+linkOrigin.regionId,reading=useRef(null);useLayoutEffect(()=>{if(window.regionShrink&&linkOrigin.regionId==='exact-r2'){window.regionTrace?.push({phase:'shorten',text:reading.current.firstChild.data,current:document.getSelection()?.anchorNode?.nodeName,currentOffset:document.getSelection()?.anchorOffset});reading.current.firstChild.data='Short';window.regionShrink=false}});useEffect(()=>{window.presentationLeaves.mounts.push(key);return()=>window.presentationLeaves.unmounts.push(key)},[key]);const draft=useAppStore(s=>s.agentComposerDrafts[sessionId]??'');return h('section',{'data-fixture-session':sessionId,'data-owner-tab':linkOrigin.tabId,'data-owner-region':linkOrigin.regionId,'data-presented':visible,style:{display:'flex',flexDirection:'column',height:'100%',minHeight:0,padding:'16px',gap:'12px'}},h('small',{style:{color:'var(--text-muted)'}},'Isolated PTY painting · '+linkOrigin.regionId),h('strong',null,'Original Agent work surface'),h('p',{ref:reading,'data-original-reading':key},'Original selected reading passage'),h('textarea',{'aria-label':'Original draft '+key,value:draft,readOnly:true,style:{width:'100%',flex:1,minHeight:'80px',resize:'none'}}))}`
      transformations.push({path:relative(root,path),isolated:'PTY/Agent painting only',sourceSHA256:hash(source),loadedSHA256:hash(code)})
      return{contents:code,loader:'js'}
    }
    if(component==='EditorPane.tsx'||component==='GitBranchDiffPane.tsx'){
      const code=`export function ${component.slice(0,-4)}(){return null}`
      transformations.push({path:relative(root,path),isolated:'Unused Monaco painting; no file Region in this scene',sourceSHA256:hash(source),loadedSHA256:hash(code)})
      return{contents:code,loader:'js'}
    }
    if(component==='StableWorkbenchView.tsx' && regionScene){
      let code=source
      const seam='queueMicrotask(() => restoreReadingRanges(host, snapshot.ranges, snapshot.activeElement))'
      assert.equal(code.split(seam).length-1,1,'Actual commit snapshot restore seam')
      code=code.replace(seam,"queueMicrotask(() => { (window as unknown as { regionLateSelection?: () => void }).regionLateSelection?.(); restoreReadingRanges(host, snapshot.ranges, snapshot.activeElement) })")
      if(process.env.AGENTMUX_REGION_SCENE_TRACE==='1'){
        code=code.replace('  const selection = document.getSelection()\n  if (!selection || ranges.length',"  ;(window as unknown as { regionTrace?: unknown[] }).regionTrace?.push({phase:'restore',host:host.parentElement?.id,ranges:ranges.map(r=>({start:r.startOffset,end:r.endOffset,text:r.end.textContent})),current:document.getSelection()?.anchorNode?.nodeName,currentOffset:document.getSelection()?.anchorOffset})\n  const selection = document.getSelection()\n  if (!selection || ranges.length")
        code=code.replace('getSnapshotBeforeUpdate(): ReadingSnapshot { return { ranges: captureReadingRanges(this.props.host), activeElement: document.activeElement } }',"getSnapshotBeforeUpdate(): ReadingSnapshot { const ranges=captureReadingRanges(this.props.host);(window as unknown as { regionTrace?: unknown[] }).regionTrace?.push({phase:'snapshot',host:this.props.host.parentElement?.id,ranges:ranges.map(r=>({start:r.startOffset,end:r.endOffset,text:r.end.textContent}))});return {ranges,activeElement:document.activeElement} }")
      }
      const mutation=process.env.AGENTMUX_REGION_SCENE_MUTATION
      if(mutation==='drop-reading-snapshot'){
        assert.equal(code.split('getSnapshotBeforeUpdate(): ReadingSnapshot { return { ranges: captureReadingRanges(this.props.host), activeElement: document.activeElement } }').length-1,1)
        assert.equal(code.split('const ranges = captureReadingRanges(host), activeElement = document.activeElement').length-1,1)
        code=code.replace('getSnapshotBeforeUpdate(): ReadingSnapshot { return { ranges: captureReadingRanges(this.props.host), activeElement: document.activeElement } }','getSnapshotBeforeUpdate(): ReadingSnapshot { return { ranges: [], activeElement: null } }').replace('const ranges = captureReadingRanges(host), activeElement = document.activeElement','const ranges: ReadingRange[] = [], activeElement = document.activeElement')
      }else if(mutation==='overwrite-later-selection'){
        const start=code.indexOf('  const currentInput = document.activeElement'),end=code.indexOf('  selection.removeAllRanges()',start)
        assert.ok(start>=0&&end>start,'Actual selection priority guards nonempty')
        code=code.slice(0,start)+code.slice(end)
      }else assert.equal(mutation,undefined,'Known actual Chromium semantic mutation')
      transformations.push({path:relative(root,path),instrumentation:'one-shot later selection in actual commit; inactive for all normal phases',mutation:mutation??null,sourceSHA256:hash(source),loadedSHA256:hash(code)})
      return{contents:code,loader:'tsx'}
    }
    return{contents:source,loader:path.endsWith('tsx')?'tsx':path.endsWith('ts')?'ts':'js'}
  });builder.onLoad({filter:/\.css$/},async({path})=>{if(!path.startsWith(root+'/')||path.includes('/node_modules/'))return;const source=await readFile(path,'utf8');inputs.set(path,hash(source));return{contents:source,loader:'css'}})}}
  for(const file of [scene+'-main.cjs',scene+'-entry.mjs'])inputs.set(join(fixture,file),hash(await readFile(join(fixture,file))))
  inputs.set(new URL(import.meta.url).pathname,hash(await readFile(new URL(import.meta.url))))
  const out=join(privateRoot,'out');await mkdir(out)
  const renderer=join(out,'app.js')
  const buildResult=await build({entryPoints:[join(fixture,scene+'-entry.mjs')],outfile:renderer,bundle:true,platform:'browser',format:'esm',target:'es2022',jsx:'automatic',metafile:true,plugins:[observe],logLevel:'silent',
    define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},loader:{'.png':'file','.svg':'file','.woff2':'file','.woff':'file','.ttf':'file'}})
  receipt.metafile=buildResult.metafile;receipt.inputs=Object.fromEntries([...inputs].map(([path,sha])=>[relative(root,path),sha]));receipt.transformations=transformations
  for(const suffix of ['App.tsx','GlobalFocusSurface.tsx','WorkspaceWorkbench.tsx','StableWorkbenchView.tsx','store.ts','focus-tab-projection.ts','agent-focus.ts'])assert.ok([...inputs.keys()].some(path=>path.endsWith('/'+suffix)),'Actual loaded '+suffix)
  const html=join(out,'index.html');await writeFile(html,'<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="./app.css"><div id="root"></div><script type="module" src="./app.js"></script></html>')
  receipt.compiled={renderer:hash(await readFile(renderer)),css:hash(await readFile(join(out,'app.css')))}
  const env={...process.env,AGENTMUX_DESKTOP_USER_DATA:join(privateRoot,'user-data'),AGENTMUX_RUNTIME_DIRECTORY:join(privateRoot,'runtime'),AGENTMUX_STATE_DIRECTORY:join(privateRoot,'state')};delete env.ELECTRON_RUN_AS_NODE
  if(recoveryScene){
    receipt.processes=[];receipt.actuals=[]
    for(const mode of ['first','second']){
      const process=await runProbeProcess(require('electron'),[join(fixture,scene+'-main.cjs'),html,privateRoot,evidence,mode],{temporaryRoot:privateRoot,cwd:root,env,timeoutMs:60000,onLine:line=>logs.push(line)})
      const actual=JSON.parse(await readFile(join(evidence,'actual-'+mode+'.json'),'utf8'));receipt.processes.push(process);receipt.actuals.push(actual)
      assert.equal(process.exitCode,0,actual.failure?.message);assert.equal(actual.passed,true)
    }
    assert.notEqual(receipt.actuals[0].pid,receipt.actuals[1].pid,'Two independent ordinary GUI processes')
    assert.equal(receipt.actuals[1].recovery.seedWrites,0)
    assert.deepEqual(receipt.actuals[1].recovery.recordAtBoot,receipt.actuals[0].durable,'Same durable record from first normal quit; no second seed')
    assert.deepEqual(receipt.actuals[1].durable.state.restoredWorkbench,receipt.actuals[0].durable.state.restoredWorkbench,'Original complete layout and Regions restored')
    assert.deepEqual(receipt.actuals[1].bootRestored.workbench,receipt.actuals[0].durable.state.restoredWorkbench,'Actual Store restore before any second-process UI action')
    assert.deepEqual(receipt.actuals[1].bootRestored.focus,receipt.actuals[0].durable.state.agentFocus,'Original focus from actual hydration, before new visits')
    receipt.frames=await Promise.all(receipt.actuals.flatMap(actual=>actual.frames).map(async frame=>({...frame,sha256:hash(await readFile(join(evidence,frame.file)))})))
    assert.equal(receipt.frames.length,8);receipt.ordinaryGuiRecovery=true
    receipt.boundary='Two ordinary private BrowserWindow processes, actual original Store hydrate/project/persist and same durable record; first 1 seed, second 0 seed. Main shell and PTY/Agent paint isolated, typed Session/Run is not a healthy Run/PID proof or T005 full recovery. No Core/full Desktop build, package/install, Native or user App/Runtime.'
  }else{
    receipt.process=await runProbeProcess(require('electron'),[join(fixture,scene+'-main.cjs'),html,privateRoot,evidence],{temporaryRoot:privateRoot,cwd:root,env,timeoutMs:60000,onLine:line=>logs.push(line)})
    receipt.actual=JSON.parse(await readFile(join(evidence,'actual.json'),'utf8'))
    assert.equal(receipt.process.exitCode,0,receipt.actual.failure?.message);assert.equal(receipt.actual.passed,true)
    receipt.frames=await Promise.all(receipt.actual.frames.map(async frame=>({...frame,sha256:hash(await readFile(join(evidence,frame.file)))})))
    assert.equal(receipt.frames.length,4)
  }
  receipt.sourceAfter=Object.fromEntries(await Promise.all([...inputs.keys()].map(async path=>[relative(root,path),hash(await readFile(path))])))
  assert.deepEqual(receipt.sourceAfter,receipt.inputs,'Nonempty current Source stable before/after')
  receipt.capturedPass=true
}catch(error){receipt.failure={name:error.name,message:error.message,stack:error.stack};process.exitCode=1}
finally{
  await writeFile(join(evidence,'process.log'),logs.join('\n'))
  const remaining=await listProbeProcesses(-1,privateRoot);receipt.cleanup={privateRoot,remaining,removed:false,evidencePreserved:true}
  if(!remaining.length){await rm(privateRoot,{recursive:true});receipt.cleanup.removed=true}
  await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')
  console.log(JSON.stringify({capturedPass:receipt.capturedPass,evidence,failure:receipt.failure?.message,pendingIndependentVisualReview:true}))
}
