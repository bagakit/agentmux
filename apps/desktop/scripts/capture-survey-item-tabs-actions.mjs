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
assert.ok(process.argv[2]==='--evidence'&&process.argv[3]&&process.argv.length===4,'Use --evidence <private evidence directory>')
const evidence=resolve(process.argv[3]);await mkdir(evidence,{recursive:true})
const privateRoot=await mkdtemp(join(tmpdir(),'amux-survey-item-tabs-actions-')),fixture=join(desktop,'scripts/fixtures/survey-item-tabs-actions')
const require=createRequire(join(desktop,'package.json')),{build}=createRequire(require.resolve('vite/package.json'))('esbuild')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),inputs=new Map(),transformations=[],logs=[]
const receipt={schema:'agentmux.survey-item-tabs-actions.v1',capturedPass:false,captureOnly:true,aestheticReview:'not-performed',userAppRunRuntimeControlled:false,
 boundary:'Actual App/GlobalSurveySurface/SurveyZoneItem/SurveyItemOptions/Store/WorkbenchZone and complete CSS. Maintained typed preview API; only SessionPane PTY/Agent, File Editor and unused diff paint leaves isolated. No user Runtime, profile, Session, ordinary restart or installation.'}
try{
 const freshness=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',`const {assertWorkspaceDistBuiltFromCurrentSource}=await import(${JSON.stringify(pathToFileURL(join(root,'vitest.dist-freshness.ts')).href)});await assertWorkspaceDistBuiltFromCurrentSource(${JSON.stringify(root)});`],{cwd:root,encoding:'utf8'})
 await writeFile(join(evidence,'freshness.log'),freshness.stdout+freshness.stderr);assert.equal(freshness.status,0,'Original public freshness guard')
 const observe={name:'actual-survey-source-and-paint-leaf',setup(builder){
  builder.onResolve({filter:/\?(worker|url)$/},args=>({path:createRequire(args.importer).resolve(args.path.replace(/\?(worker|url)$/,'')),namespace:args.path.endsWith('?worker')?'survey-vite-worker':'survey-vite-url'}))
  builder.onLoad({filter:/.*/,namespace:'survey-vite-url'},async({path})=>{const file='asset-'+hash(path).slice(0,12)+'.mjs';await writeFile(join(out,file),await readFile(path));return{contents:`export default new URL('./${file}',import.meta.url).href`,loader:'js'}})
  builder.onLoad({filter:/.*/,namespace:'survey-vite-worker'},async({path})=>{const file='worker-'+hash(path).slice(0,12)+'.js';await build({entryPoints:[path],outfile:join(out,file),bundle:true,platform:'browser',format:'esm',target:'es2022',logLevel:'silent'});return{contents:`export default class extends Worker {constructor(options){super(new URL('./${file}',import.meta.url),{...options,type:'module'})}}`,loader:'js'}})
  builder.onLoad({filter:/\.[cm]?[jt]sx?$/},async({path})=>{
  if(!path.startsWith(root+'/')||path.includes('/node_modules/'))return
  const source=await readFile(path,'utf8');inputs.set(path,hash(source));const component=path.slice(path.lastIndexOf('/')+1)
  if(component==='SessionPane.tsx'||component==='EditorPane.tsx'||component==='GitBranchDiffPane.tsx'){
   const name=component.slice(0,-4),code=component==='SessionPane.tsx'?`import{createElement as h}from'react';import{useAppStore}from ${JSON.stringify(join(desktop,'src/renderer/src/store.ts'))};export function SessionPane({sessionId}){const draft=useAppStore(s=>s.agentComposerDrafts[sessionId]??'');return h('section',{'data-fixture-session':sessionId,style:{padding:24,color:'var(--text-2)'}},h('strong',null,'Research agent'),h('p',null,'Original work surface'),h('textarea',{'aria-label':'Original research draft',value:draft,readOnly:true,style:{width:'100%',height:160}}))}`
    :component==='EditorPane.tsx'?`import{createElement as h}from'react';export function EditorPane(){return h('section',{'data-file-paint':'',style:{padding:24,color:'var(--text-2)'}},h('strong',null,'Research draft'),h('p',null,'Original file Region'),h('pre',null,'# Research notes\\n\\nKeep the original sources and draft.'))}`:`export function ${name}(){return null}`
   transformations.push({path:relative(root,path),isolated:component==='SessionPane.tsx'?'PTY/Agent painting only':component==='EditorPane.tsx'?'File Editor painting only':'Unused diff painting',sourceSHA256:hash(source),loadedSHA256:hash(code)})
   return{contents:code,loader:'js'}
  }
  return{contents:source,loader:path.endsWith('tsx')?'tsx':path.endsWith('ts')?'ts':'js'}
 });builder.onLoad({filter:/\.css$/},async({path})=>{if(!path.startsWith(root+'/')||path.includes('/node_modules/'))return;const source=await readFile(path,'utf8');inputs.set(path,hash(source));return{contents:source,loader:'css'}})}}
 for(const file of ['main.cjs','entry.mjs','scene.md'])inputs.set(join(fixture,file),hash(await readFile(join(fixture,file))))
 inputs.set(new URL(import.meta.url).pathname,hash(await readFile(new URL(import.meta.url))))
 const out=join(privateRoot,'out');await mkdir(out);const renderer=join(out,'app.js')
 const buildResult=await build({entryPoints:[join(fixture,'entry.mjs')],outfile:renderer,bundle:true,platform:'browser',format:'esm',target:'es2022',jsx:'automatic',conditions:['production'],metafile:true,plugins:[observe],logLevel:'silent',define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},loader:{'.png':'file','.gif':'file','.svg':'file','.woff2':'file','.woff':'file','.ttf':'file'}})
 receipt.metafile=buildResult.metafile;receipt.inputs=Object.fromEntries([...inputs].map(([path,sha])=>[relative(root,path),sha]));receipt.transformations=transformations
 for(const suffix of ['App.tsx','GlobalSurveySurface.tsx','SurveyZoneItem.tsx','SurveyItemOptions.tsx','SurveyTabColumn.tsx','WorkbenchTabMarks.tsx','workbench-tab-marks.ts','store.ts','WorkbenchZone.tsx','survey.css'])assert.ok([...inputs.keys()].some(path=>path.endsWith('/'+suffix)),'Actual loaded '+suffix)
 const html=join(out,'index.html');await writeFile(html,'<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="./app.css"><div id="root"></div><script type="module" src="./app.js"></script></html>')
 receipt.compiled={renderer:hash(await readFile(renderer)),css:hash(await readFile(join(out,'app.css')))}
 const env={...process.env,AGENTMUX_DESKTOP_USER_DATA:join(privateRoot,'user-data'),AGENTMUX_RUNTIME_DIRECTORY:join(privateRoot,'runtime'),AGENTMUX_STATE_DIRECTORY:join(privateRoot,'state')};delete env.ELECTRON_RUN_AS_NODE
 receipt.process=await runProbeProcess(require('electron'),[join(fixture,'main.cjs'),html,privateRoot,evidence],{temporaryRoot:privateRoot,cwd:root,env,timeoutMs:60000,onLine:line=>logs.push(line)})
 receipt.actual=JSON.parse(await readFile(join(evidence,'actual.json'),'utf8'));assert.equal(receipt.process.exitCode,0,receipt.actual.failure?.message);assert.equal(receipt.actual.passed,true)
 receipt.frames=await Promise.all(receipt.actual.frames.map(async frame=>({...frame,sha256:hash(await readFile(join(evidence,frame.file)))})));assert.equal(receipt.frames.length,9)
 receipt.sourceAfter=Object.fromEntries(await Promise.all([...inputs.keys()].map(async path=>[relative(root,path),hash(await readFile(path))])));assert.deepEqual(receipt.sourceAfter,receipt.inputs,'Nonempty current Source stable before/after');receipt.capturedPass=true
}catch(error){receipt.failure={name:error.name,message:error.message,stack:error.stack};process.exitCode=1}
finally{
 await writeFile(join(evidence,'process.log'),logs.join('\n'));const remaining=await listProbeProcesses(-1,privateRoot);receipt.cleanup={privateRoot,remaining,removed:false,evidencePreserved:true}
 if(!remaining.length){await rm(privateRoot,{recursive:true});receipt.cleanup.removed=true}
 await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({capturedPass:receipt.capturedPass,evidence,failure:receipt.failure?.message,pendingIndependentVisualReview:true}))
}
