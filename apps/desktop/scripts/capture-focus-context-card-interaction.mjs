import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const root=resolve(import.meta.dirname,'../../..'), desktop=join(root,'apps/desktop')
assert.ok(process.argv.length===2||(process.argv.length===4&&process.argv[2]==='--evidence'&&process.argv[3]),'Use optional --evidence <private evidence directory>')
const evidence=process.argv[3]?resolve(process.argv[3]):join(root,'.bagakit/feature-tracker/focus-identity-consistency-artifacts/cards','scene-'+globalThis.crypto.randomUUID());await mkdir(evidence,{recursive:true})
const privateRoot=await mkdtemp(join(tmpdir(),'amux-focus-card-interaction-')), fixture=join(desktop,'scripts/fixtures/focus-context-card-interaction')
const require=createRequire(join(desktop,'package.json')), {build}=createRequire(require.resolve('vite/package.json'))('esbuild')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),inputs=new Map(),transformations=[],logs=[]
const receipt={schema:'agentmux.focus-context-card-interaction-scene.v1',capturedPass:false,aestheticReview:'not-performed',userAppRunRuntimeControlled:false,
  boundary:'Original compiled Global/Store/projection/Row/menu/Hover/clipboard/reportError and CSS. Maintained typed preview API; only PTY, unused editor and unmounted Launcher paint isolated. No Launcher or file Region in this scene. No true Core/PTY/Run/PID, Writer, OS input, restart or user installation.'}
try{
  const freshness=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',`const {assertWorkspaceDistBuiltFromCurrentSource}=await import(${JSON.stringify(pathToFileURL(join(root,'vitest.dist-freshness.ts')).href)});await assertWorkspaceDistBuiltFromCurrentSource(${JSON.stringify(root)});`],{cwd:root,encoding:'utf8'})
  await writeFile(join(evidence,'freshness.log'),freshness.stdout+freshness.stderr);assert.equal(freshness.status,0,'Original source/dist freshness guard')
  const observe={name:'original-focus-card-interaction-source-binding',setup(builder){builder.onResolve({filter:/\?raw$/},args=>({path:resolve(args.resolveDir,args.path.slice(0,-4)),namespace:'fixture-raw-text'}));builder.onLoad({filter:/.*/,namespace:'fixture-raw-text'},async({path})=>{const source=await readFile(path,'utf8');inputs.set(path,hash(source));return{contents:'export default '+JSON.stringify(source),loader:'js'}});builder.onLoad({filter:/\.[cm]?[jt]sx?$/},async({path})=>{
    if(!path.startsWith(root+'/')||path.includes('/node_modules/'))return
    const source=await readFile(path,'utf8');inputs.set(path,hash(source));const component=path.slice(path.lastIndexOf('/')+1)
    if(['SessionPane.tsx','EditorPane.tsx','GitBranchDiffPane.tsx','NewTabSurface.tsx'].includes(component)){
      const code=`export function ${component.slice(0,-4)}(){return null}`
      transformations.push({path:relative(root,path),isolated:component==='SessionPane.tsx'?'Unselected PTY paint, no lifecycle or input replacement':component==='NewTabSurface.tsx'?'Unmounted Launcher paint, no Launcher Region in this scene':'Unused Monaco paint, no file Region in this scene',sourceSHA256:hash(source),loadedSHA256:hash(code)})
      return{contents:code,loader:'js'}
    }
    return{contents:source,loader:path.endsWith('tsx')?'tsx':path.endsWith('ts')?'ts':'js'}
  });builder.onLoad({filter:/\.css$/},async({path})=>{if(!path.startsWith(root+'/')||path.includes('/node_modules/'))return;const source=await readFile(path,'utf8');inputs.set(path,hash(source));return{contents:source,loader:'css'}})}}
  for(const path of [join(fixture,'entry.mjs'),join(fixture,'main.cjs'),new URL(import.meta.url).pathname])inputs.set(path,hash(await readFile(path)))
  const out=join(privateRoot,'out');await mkdir(out)
  const buildResult=await build({entryPoints:[join(fixture,'entry.mjs')],outfile:join(out,'app.js'),bundle:true,platform:'browser',format:'esm',target:'es2022',jsx:'automatic',metafile:true,plugins:[observe],logLevel:'silent',
    define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},loader:{'.png':'file','.svg':'file','.woff2':'file','.woff':'file','.ttf':'file'}})
  receipt.metafile=buildResult.metafile;receipt.inputs=Object.fromEntries([...inputs].map(([path,sha])=>[relative(root,path),sha]));receipt.transformations=transformations
  for(const suffix of ['GlobalFocusSurface.tsx','FocusContextRow.tsx','FocusContextMenu.tsx','FocusContextHover.tsx','focus-context.ts','launcher-resume.ts','agent-roster-menu.ts','agent-address.ts','clipboard-copy.ts','RegionContextMenu.tsx','WindowOverlayHost.tsx','TransientErrorNotice.tsx','store.ts'])assert.ok([...inputs.keys()].some(path=>path.endsWith('/'+suffix)),'Nonempty actual module '+suffix)
  const html=join(out,'index.html');await writeFile(html,'<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="./app.css"><div id="root"></div><script type="module" src="./app.js"></script></html>')
  receipt.compiled={renderer:hash(await readFile(join(out,'app.js'))),css:hash(await readFile(join(out,'app.css')))}
  const env={...process.env,AGENTMUX_DESKTOP_USER_DATA:join(privateRoot,'user-data'),AGENTMUX_RUNTIME_DIRECTORY:join(privateRoot,'runtime'),AGENTMUX_STATE_DIRECTORY:join(privateRoot,'state')};delete env.ELECTRON_RUN_AS_NODE
  receipt.process=await runProbeProcess(require('electron'),[join(fixture,'main.cjs'),html,privateRoot,evidence],{temporaryRoot:privateRoot,cwd:root,env,timeoutMs:90000,onLine:line=>logs.push(line)})
  receipt.actual=JSON.parse(await readFile(join(evidence,'actual.json'),'utf8'));assert.equal(receipt.process.exitCode,0,receipt.actual.failure?.message);assert.equal(receipt.actual.passed,true)
  receipt.frames=await Promise.all(receipt.actual.frames.map(async frame=>({...frame,sha256:hash(await readFile(join(evidence,frame.file)))})))
  assert.equal(receipt.frames.length,23,'Three window widths; hover, pointer selection/internal scroll, exact SID menus, rename transitions and explicit Focus selection')
  receipt.sourceAfter=Object.fromEntries(await Promise.all([...inputs.keys()].map(async path=>[relative(root,path),hash(await readFile(path))])));assert.deepEqual(receipt.sourceAfter,receipt.inputs,'Exact nonempty Source stable before/after')
  receipt.owningSourceScope=['GlobalFocusSurface.tsx','FocusContextRow.tsx','FocusContextMenu.tsx','FocusContextHover.tsx','focus-context.ts','store.ts','styles/focus.css'];receipt.captureOnly=true;receipt.capturedPass=true
}catch(error){receipt.failure={name:error.name,message:error.message,stack:error.stack};process.exitCode=1}
finally{
  await writeFile(join(evidence,'process.log'),logs.join('\n'))
  const remaining=await listProbeProcesses(-1,privateRoot);receipt.cleanup={privateRoot,remaining,removed:false,evidencePreserved:true,compiledBytesPreserved:false}
  if(!remaining.length){await rm(privateRoot,{recursive:true});receipt.cleanup.removed=true}
  await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({capturedPass:receipt.capturedPass,evidence,failure:receipt.failure?.message,pendingIndependentVisualReview:true}))
}
