import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const root=resolve(import.meta.dirname,'../../..'), desktop=join(root,'apps/desktop')
assert.ok(process.argv.length===2||(process.argv.length===4&&process.argv[2]==='--evidence'&&process.argv[3]),'Use optional --evidence <private evidence directory>')
// Official gates may consume one explicitly chosen, immutable capture. Changed input rejects reuse.
if(process.env.AGENTMUX_FOCUS_FAILED_CLOSE_RECEIPT){
  const record=resolve(process.env.AGENTMUX_FOCUS_FAILED_CLOSE_RECEIPT),saved=JSON.parse(await readFile(record,'utf8')),savedRoot=resolve(record,'..')
  const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
  assert.equal(saved.schema,'agentmux.focus-failed-session-close-scene.v1');assert.equal(saved.capturedPass,true);assert.equal(saved.captureOnly,true)
  assert.ok(Object.keys(saved.inputs).length>10);assert.deepEqual(saved.sourceAfter,saved.inputs)
  for(const [file,sha] of Object.entries(saved.inputs))assert.equal(digest(await readFile(join(root,file))),sha,'Exact capture input '+file)
  for(const [kind,file] of Object.entries(saved.compiledArtifacts))assert.equal(digest(await readFile(join(savedRoot,file))),saved.compiled[kind],'Actual frozen compiled '+kind)
  assert.equal(saved.frames.length,9)
  for(const frame of saved.frames)assert.equal(digest(await readFile(join(savedRoot,frame.file))),frame.sha256,'Exact full screenshot '+frame.file)
  for(const [file,sha] of Object.entries(saved.artifacts))assert.equal(digest(await readFile(join(savedRoot,file))),sha,'Exact process/actual log '+file)
  assert.equal(saved.processes.length,2);assert.ok(saved.processes.every(item=>item.exitCode===0&&item.actual.passed))
  const first=saved.processes[0].actual,second=saved.processes[1].actual
  assert.notEqual(first.pid,second.pid);assert.equal(first.initial.seedCount,1);assert.equal(second.initial.seedCount,0)
  assert.equal(first.initial.originalInitialize,true);assert.equal(second.initial.originalInitialize,true)
  for(const key of ['tabs','layouts','drafts','documents','dirty','sessions'])assert.deepEqual(first.persisted[key],second.initial[key])
  assert.equal(saved.restart.passed,true);assert.deepEqual(saved.cleanup.remaining,[]);assert.equal(saved.cleanup.removed,true)
  const freshness=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',`const {assertWorkspaceDistBuiltFromCurrentSource}=await import(${JSON.stringify(pathToFileURL(join(root,'vitest.dist-freshness.ts')).href)});await assertWorkspaceDistBuiltFromCurrentSource(${JSON.stringify(root)});`],{cwd:root,encoding:'utf8'})
  assert.equal(freshness.status,0,freshness.stdout+freshness.stderr)
  console.log(JSON.stringify({capturedPass:true,exactEvidenceReused:true,record,frames:saved.frames.length,restart:saved.restart,pendingIndependentVisualReview:true}));process.exit(0)
}
const evidence=process.argv[3]?resolve(process.argv[3]):join(root,'.bagakit/feature-tracker/focus-identity-consistency-artifacts/failed-close','scene-'+globalThis.crypto.randomUUID());await mkdir(evidence,{recursive:true})
const privateRoot=await mkdtemp(join(tmpdir(),'amux-focus-failed-close-')), fixture=join(desktop,'scripts/fixtures/focus-failed-session-close')
const require=createRequire(join(desktop,'package.json')), {build}=createRequire(require.resolve('vite/package.json'))('esbuild')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),inputs=new Map(),transformations=[],logs=[]
const receipt={schema:'agentmux.focus-failed-session-close-scene.v1',capturedPass:false,aestheticReview:'not-performed',userAppRunRuntimeControlled:false,
  boundary:'Original compiled Global/Attention/Store/Core lifecycle reducer and source CSS. Isolated typed API transport; real first Electron PID exit then second PID original Store initialize with no second seed. PTY and Monaco paint leaves isolated; unsaved file state remains original. Typed Session/Run references do not certify physical Runtime/PTY, OS input or user installation.'}
try{
  const freshness=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',`const {assertWorkspaceDistBuiltFromCurrentSource}=await import(${JSON.stringify(pathToFileURL(join(root,'vitest.dist-freshness.ts')).href)});await assertWorkspaceDistBuiltFromCurrentSource(${JSON.stringify(root)});`],{cwd:root,encoding:'utf8'})
  await writeFile(join(evidence,'freshness.log'),freshness.stdout+freshness.stderr);assert.equal(freshness.status,0,'Original source/dist freshness guard')
  const observe={name:'original-focus-card-interaction-source-binding',setup(builder){builder.onResolve({filter:/\?raw$/},args=>({path:resolve(args.resolveDir,args.path.slice(0,-4)),namespace:'fixture-raw-text'}));builder.onLoad({filter:/.*/,namespace:'fixture-raw-text'},async({path})=>{const source=await readFile(path,'utf8');inputs.set(path,hash(source));return{contents:'export default '+JSON.stringify(source),loader:'js'}});builder.onLoad({filter:/\.[cm]?[jt]sx?$/},async({path})=>{
    if(!path.startsWith(root+'/')||path.includes('/node_modules/'))return
    const source=await readFile(path,'utf8');inputs.set(path,hash(source));const component=path.slice(path.lastIndexOf('/')+1)
    if(['SessionPane.tsx','EditorPane.tsx','GitBranchDiffPane.tsx','NewTabSurface.tsx'].includes(component)){
      const code=component==='SessionPane.tsx' ? `import {createElement as h} from 'react';import{useAppStore}from ${JSON.stringify(join(desktop,'src/renderer/src/store.ts'))};export function SessionPane({sessionId}){const draft=useAppStore(s=>s.agentComposerDrafts[sessionId]??'');return h('section',{style:{padding:'16px',height:'100%',display:'flex',flexDirection:'column',gap:'12px'}},h('small',null,'Isolated PTY paint · '+sessionId),h('textarea',{'aria-label':'Original draft '+sessionId,value:draft,readOnly:true,style:{flex:1,minHeight:'100px'}}))}` : `export function ${component.slice(0,-4)}(){return null}`
      transformations.push({path:relative(root,path),isolated:component==='SessionPane.tsx'?'PTY paint leaf only; original workface, Store control and draft owner remain':component==='NewTabSurface.tsx'?'Unmounted Launcher paint, no Launcher Region in this scene':'Monaco/Git paint leaf isolated; actual unsaved file Tab and Store document are preserved',sourceSHA256:hash(source),loadedSHA256:hash(code)})
      return{contents:code,loader:'js'}
    }
    return{contents:source,loader:path.endsWith('tsx')?'tsx':path.endsWith('ts')?'ts':'js'}
  });builder.onLoad({filter:/\.css$/},async({path})=>{if(!path.startsWith(root+'/')||path.includes('/node_modules/'))return;const source=await readFile(path,'utf8');inputs.set(path,hash(source));return{contents:source,loader:'css'}})}}
  for(const path of [join(fixture,'entry.mjs'),join(fixture,'main.cjs'),join(fixture,'preload.cjs'),new URL(import.meta.url).pathname])inputs.set(path,hash(await readFile(path)))
  const out=join(privateRoot,'out');await mkdir(out)
  const buildResult=await build({entryPoints:[join(fixture,'entry.mjs')],outfile:join(out,'app.js'),bundle:true,platform:'browser',format:'esm',target:'es2022',jsx:'automatic',metafile:true,plugins:[observe],logLevel:'silent',
    define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},loader:{'.png':'file','.svg':'file','.woff2':'file','.woff':'file','.ttf':'file'}})
  receipt.metafile=buildResult.metafile;receipt.inputs=Object.fromEntries([...inputs].map(([path,sha])=>[relative(root,path),sha]));receipt.transformations=transformations
  for(const suffix of ['GlobalFocusSurface.tsx','WorkspaceWorkbench.tsx','StableWorkbenchView.tsx','workbench-projection.ts','AttentionRequestPanel.tsx','focus-context.ts','session-state.ts','session-events.ts','TransientErrorNotice.tsx','store.ts'])assert.ok([...inputs.keys()].some(path=>path.endsWith('/'+suffix)),'Nonempty actual module '+suffix)
  const html=join(out,'index.html');await writeFile(html,'<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="./app.css"><div id="root"></div><script type="module" src="./app.js"></script></html>')
  receipt.compiled={renderer:hash(await readFile(join(out,'app.js'))),css:hash(await readFile(join(out,'app.css')))}
  await cp(out,join(evidence,'compiled'),{recursive:true});receipt.compiledArtifacts={renderer:'compiled/app.js',css:'compiled/app.css'}
  const env={...process.env,AGENTMUX_DESKTOP_USER_DATA:join(privateRoot,'user-data'),AGENTMUX_RUNTIME_DIRECTORY:join(privateRoot,'runtime'),AGENTMUX_STATE_DIRECTORY:join(privateRoot,'state')};delete env.ELECTRON_RUN_AS_NODE
  receipt.processes=[]
  for(const phase of ['first','second']){
    const process=await runProbeProcess(require('electron'),[join(fixture,'main.cjs'),html,privateRoot,evidence,phase],{temporaryRoot:privateRoot,cwd:root,env,timeoutMs:60000,onLine:line=>logs.push(line)})
    const actual=JSON.parse(await readFile(join(evidence,'actual-'+phase+'.json'),'utf8'));receipt.processes.push({phase,...process,actual})
    assert.equal(process.exitCode,0,actual.failure?.message);assert.equal(actual.passed,true)
  }
  const first=receipt.processes[0].actual,second=receipt.processes[1].actual
  assert.notEqual(first.pid,second.pid);assert.equal(first.initial.seedCount,1);assert.equal(second.initial.seedCount,0)
  for(const key of ['tabs','layouts','drafts','documents','dirty','sessions'])assert.deepEqual(second.initial[key],first.persisted[key],'Original Store restores '+key+' without a second seed')
  receipt.restart={passed:true,firstPID:first.pid,secondPID:second.pid,secondSeedCount:0,originalStoreInitialize:true,typedRunReferences:true}
  receipt.frames=await Promise.all([...first.frames,...second.frames].map(async frame=>({...frame,sha256:hash(await readFile(join(evidence,frame.file)))})))
  assert.equal(receipt.frames.length,9,'Eight current full failure/control views plus second PID restoration')
  receipt.sourceAfter=Object.fromEntries(await Promise.all([...inputs.keys()].map(async path=>[relative(root,path),hash(await readFile(path))])));assert.deepEqual(receipt.sourceAfter,receipt.inputs,'Exact nonempty Source stable before/after')
  receipt.owningSourceScope=['GlobalFocusSurface.tsx','WorkspaceWorkbench.tsx','StableWorkbenchView.tsx','workbench-projection.ts','AttentionRequestPanel.tsx','focus-context.ts','session-state.ts','session-events.ts','store.ts','styles/agent.css','styles/focus.css'];receipt.captureOnly=true;receipt.capturedPass=true
}catch(error){receipt.failure={name:error.name,message:error.message,stack:error.stack};process.exitCode=1}
finally{
  await writeFile(join(evidence,'process.log'),logs.join('\n'))
  receipt.artifacts=Object.fromEntries(await Promise.all(['freshness.log','process.log',...['first','second'].filter(phase=>receipt.processes?.some(item=>item.phase===phase)).map(phase=>'actual-'+phase+'.json')].map(async file=>[file,hash(await readFile(join(evidence,file)))])))
  const remaining=await listProbeProcesses(-1,privateRoot);receipt.cleanup={privateRoot,remaining,removed:false,evidencePreserved:true,compiledBytesPreserved:Boolean(receipt.compiledArtifacts)}
  if(!remaining.length){await rm(privateRoot,{recursive:true});receipt.cleanup.removed=true}
  await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({capturedPass:receipt.capturedPass,evidence,failure:receipt.failure?.message,pendingIndependentVisualReview:true}))
}
