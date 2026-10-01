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
const heightScene=process.argv[4]==='--height'
assert.ok(process.argv[2]==='--evidence'&&process.argv[3]&&(process.argv.length===4||(heightScene&&process.argv.length===5)),'Use --evidence <private evidence directory> [--height]')
const evidence=resolve(process.argv[3]);await mkdir(evidence,{recursive:true})
const privateRoot=await mkdtemp(join(tmpdir(),'amux-focus-lane-')),fixture=join(desktop,'scripts/fixtures/focus-lane-adaptive-density'),mainFixture=join(fixture,'main.cjs')
const require=createRequire(join(desktop,'package.json')), {build}=createRequire(require.resolve('vite/package.json'))('esbuild')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),inputs=new Map(),transformations=[],logs=[]
const receipt={schema:'agentmux.focus-lane-adaptive-scene.v1',capturedPass:false,captureOnly:true,aestheticReview:'not-performed',userAppRunRuntimeControlled:false,
  boundary:'Light Renderer-only actual App/Focus/Workbench/Stable/Store and installed Panel browser primary. Maintained typed preview API; only SessionPane PTY/Agent paint and unused Monaco painting leaves isolated. No Runtime/native simultaneous presentation, Writer, ordinary restart or user installation.'}
if(heightScene){receipt.heightScene=true;receipt.boundary='Same light actual App/Focus/Workbench/Stable/Store plus one ordinary two-Electron-process private restore. Original Store initialization/persistence, one first workface seed and no second seed. Typed Session/Run references do not prove physical PTY/Run continuity. No Core/Desktop build, dependency copy, package or user installation.'}
try{
  const freshness=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',`const {assertWorkspaceDistBuiltFromCurrentSource}=await import(${JSON.stringify(pathToFileURL(join(root,'vitest.dist-freshness.ts')).href)});await assertWorkspaceDistBuiltFromCurrentSource(${JSON.stringify(root)});`],{cwd:root,encoding:'utf8'})
  await writeFile(join(evidence,'freshness.log'),freshness.stdout+freshness.stderr);assert.equal(freshness.status,0,'Original public freshness guard')
  const observe={name:'actual-app-focus-source-and-paint-leaf',setup(builder){builder.onResolve({filter:/\?raw$/},args=>({path:resolve(args.resolveDir,args.path.slice(0,-4)),namespace:'fixture-raw-text'}));builder.onLoad({filter:/.*/,namespace:'fixture-raw-text'},async({path})=>{const source=await readFile(path,'utf8');inputs.set(path,hash(source));return{contents:'export default '+JSON.stringify(source),loader:'js'}});builder.onLoad({filter:/\.[cm]?[jt]sx?$/},async({path})=>{
    if(!path.startsWith(root+'/')||path.includes('/node_modules/'))return
    const source=await readFile(path,'utf8');inputs.set(path,hash(source));const component=path.slice(path.lastIndexOf('/')+1)
    if(component==='monaco.ts'){const code='export {}';transformations.push({path:relative(root,path),isolated:'Unused Monaco setup and worker painting; no file Region in this scene',sourceSHA256:hash(source),loadedSHA256:hash(code)});return{contents:code,loader:'js'}}
    if(component==='SessionPane.tsx'){
      const code=`import {createElement as h,useEffect} from 'react';import{useAppStore}from ${JSON.stringify(join(desktop,'src/renderer/src/store.ts'))};export function SessionPane({sessionId,linkOrigin}){const key=linkOrigin.tabId+'/'+linkOrigin.regionId;useEffect(()=>{window.presentationLeaves.mounts.push(key);return()=>window.presentationLeaves.unmounts.push(key)},[key]);const draft=useAppStore(s=>s.agentComposerDrafts[sessionId]??'');return h('section',{'data-fixture-session':sessionId,'data-owner-tab':linkOrigin.tabId,'data-owner-region':linkOrigin.regionId,style:{display:'flex',flexDirection:'column',height:'100%',minHeight:0,padding:'16px',gap:'12px'}},h('small',{style:{color:'var(--text-muted)'}},'Isolated PTY painting · '+linkOrigin.regionId),h('strong',null,'Original Agent work surface'),h('textarea',{'aria-label':'Original draft '+key,value:draft,readOnly:true,style:{width:'100%',flex:1,minHeight:'80px',resize:'none'}}))}`
      transformations.push({path:relative(root,path),isolated:'PTY/Agent painting only',sourceSHA256:hash(source),loadedSHA256:hash(code)})
      return{contents:code,loader:'js'}
    }
    if(['EditorPane.tsx','GitBranchDiffPane.tsx','NewTabSurface.tsx','FileExplorer.tsx','ProjectRail.tsx','SurfaceToolDock.tsx'].includes(component)){
      const code=`export function ${component.slice(0,-4)}(){return null}`
      transformations.push({path:relative(root,path),isolated:['NewTabSurface.tsx','FileExplorer.tsx','ProjectRail.tsx','SurfaceToolDock.tsx'].includes(component)?'Unrelated Launcher/Explorer/Project rail/tool dock paint; hidden on Focus and not part of the retained Agent Region':'Unused Monaco painting; no file Region in this scene',sourceSHA256:hash(source),loadedSHA256:hash(code)})
      return{contents:code,loader:'js'}
    }
    return{contents:source,loader:path.endsWith('tsx')?'tsx':path.endsWith('ts')?'ts':'js'}
  });builder.onLoad({filter:/\.css$/},async({path})=>{if(!path.startsWith(root+'/')||path.includes('/node_modules/'))return;const source=await readFile(path,'utf8');inputs.set(path,hash(source));if(path.endsWith('/styles/focus.css')&&process.env.AGENTMUX_FOCUS_LANE_ADAPTIVE_CSS_MUTATION==='old-800-columns'){const loaded=source+'\n@container (max-width:800px) { .focus-project-lanes__groups { flex-direction: column; } .focus-context-group { width:100%; } }\n';transformations.push({path:relative(root,path),mutation:'old-800-columns',sourceSHA256:hash(source),loadedSHA256:hash(loaded)});return{contents:loaded,loader:'css'}}return{contents:source,loader:'css'}})}}
  for(const file of ['main.cjs','entry.mjs'])inputs.set(join(fixture,file),hash(await readFile(join(fixture,file))))
  if(heightScene)inputs.set(join(fixture,'height-scene.cjs'),hash(await readFile(join(fixture,'height-scene.cjs'))))
  inputs.set(mainFixture,hash(await readFile(mainFixture)))
  inputs.set(new URL(import.meta.url).pathname,hash(await readFile(new URL(import.meta.url))))
  const out=join(privateRoot,'out');await mkdir(out)
  const renderer=join(out,'app.js')
  const buildResult=await build({entryPoints:[join(fixture,'entry.mjs')],outfile:renderer,bundle:true,platform:'browser',format:'esm',target:'es2022',jsx:'automatic',metafile:true,plugins:[observe],logLevel:'silent',
    define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},loader:{'.png':'file','.svg':'file','.woff2':'file','.woff':'file','.ttf':'file'}})
  receipt.metafile=buildResult.metafile;receipt.inputs=Object.fromEntries([...inputs].map(([path,sha])=>[relative(root,path),sha]));receipt.transformations=transformations
  for(const suffix of ['App.tsx','GlobalFocusSurface.tsx','WorkspaceWorkbench.tsx','StableWorkbenchView.tsx','store.ts','focus-tab-projection.ts','agent-focus.ts'])assert.ok([...inputs.keys()].some(path=>path.endsWith('/'+suffix)),'Actual loaded '+suffix)
  const html=join(out,'index.html');await writeFile(html,'<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="./app.css"><div id="root"></div><script type="module" src="./app.js"></script></html>')
  receipt.compiled={renderer:hash(await readFile(renderer)),css:hash(await readFile(join(out,'app.css')))}
  receipt.cssMutation=process.env.AGENTMUX_FOCUS_LANE_ADAPTIVE_CSS_MUTATION??null;const env={...process.env,AGENTMUX_DESKTOP_USER_DATA:join(privateRoot,'user-data'),AGENTMUX_RUNTIME_DIRECTORY:join(privateRoot,'runtime'),AGENTMUX_STATE_DIRECTORY:join(privateRoot,'state')};delete env.ELECTRON_RUN_AS_NODE
  if(heightScene){
    receipt.processes=[]
    for(const phase of ['height-first','height-second']){
      const process=await runProbeProcess(require('electron'),[mainFixture,html,privateRoot,evidence,phase],{temporaryRoot:privateRoot,cwd:root,env,timeoutMs:60000,onLine:line=>logs.push(line)})
      const actual=JSON.parse(await readFile(join(evidence,'actual-'+phase+'.json'),'utf8'));receipt.processes.push({phase,...process,actual})
      assert.equal(process.exitCode,0,actual.failure?.message);assert.equal(actual.passed,true)
    }
    const first=receipt.processes[0].actual,second=receipt.processes[1].actual
    assert.notEqual(first.pid,second.pid);assert.equal(second.restored.seedCount,0);assert.deepEqual(second.restored.tabs,first.persisted.tabs);assert.deepEqual(second.restored.layouts,first.persisted.layouts);assert.equal(second.restored.draft,first.persisted.draft);assert.deepEqual(second.restored.original,first.persisted.original)
    receipt.actual={passed:true,geometryPass:first.geometryPass,loadedCSSRed:first.loadedCSSRed,improvement:first.improvement,scenes:first.scenes,frames:[...first.frames,...second.frames],restart:{passed:true,firstPID:first.pid,secondPID:second.pid,secondSeedCount:second.restored.seedCount,originalStoreRestore:second.restored.originalInitialize,typedReferencesOnly:true}}
  }else{
    receipt.process=await runProbeProcess(require('electron'),[mainFixture,html,privateRoot,evidence],{temporaryRoot:privateRoot,cwd:root,env,timeoutMs:60000,onLine:line=>logs.push(line)})
    receipt.actual=JSON.parse(await readFile(join(evidence,'actual.json'),'utf8'))
    assert.equal(receipt.process.exitCode,0,receipt.actual.failure?.message);assert.equal(receipt.actual.passed,true)
  }
  receipt.frames=await Promise.all(receipt.actual.frames.map(async frame=>({...frame,sha256:hash(await readFile(join(evidence,frame.file)))})))
  assert.ok(receipt.frames.length>=9,heightScene?'Nonempty skewed/single/double/mixed and ordinary private restore frames':'Actual 320/640/799/801/wide single-state, compact offline and exact Topic views')
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
