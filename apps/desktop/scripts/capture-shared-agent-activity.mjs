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
assert.equal(process.argv[2],'--evidence');assert.ok(process.argv[3]);assert.equal(process.argv.length,4)
const evidence=resolve(process.argv[3]);await mkdir(evidence,{recursive:true})
const privateRoot=await mkdtemp(join(tmpdir(),'amux-activity-stage-')),fixture=join(desktop,'scripts/fixtures/shared-agent-activity')
const require=createRequire(join(desktop,'package.json')), {build}=createRequire(require.resolve('vite/package.json'))('esbuild')
const hash=b=>createHash('sha256').update(b).digest('hex'),inputs=new Map(),transformations=[],logs=[]
const receipt={capturedPass:false,aestheticReview:'not-performed',userAppRunRuntimeControlled:false,boundary:'Light actual Renderer only; isolated unused PTY paint/Monaco leaves, public native DTO fixture. No Runtime, Native Writer, ordinary recovery, packaging or installation.'}
try{
 const freshness=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',`const {assertWorkspaceDistBuiltFromCurrentSource}=await import(${JSON.stringify(pathToFileURL(join(root,'vitest.dist-freshness.ts')).href)});await assertWorkspaceDistBuiltFromCurrentSource(${JSON.stringify(root)});`],{cwd:root,encoding:'utf8'});await writeFile(join(evidence,'freshness.log'),freshness.stdout+freshness.stderr);assert.equal(freshness.status,0)
 const observe={name:'actual-app-source-binding',setup(builder){builder.onLoad({filter:/\.[cm]?[jt]sx?$/},async({path})=>{if(!path.startsWith(root+'/')||path.includes('/node_modules/'))return;const source=await readFile(path,'utf8');inputs.set(path,hash(source));const component=path.slice(path.lastIndexOf('/')+1);if(component==='TerminalView.tsx'||component==='EditorPane.tsx'||component==='GitBranchDiffPane.tsx'){const code=component==='TerminalView.tsx'?`import{createElement as h}from'react';export function TerminalView(){return h('div',{'data-terminal-paint-probe':''},'Original Terminal paint isolated')}`:`export function ${component.slice(0,-4)}(){return null}`;transformations.push({path:relative(root,path),sourceSHA256:hash(source),loadedSHA256:hash(code),isolated:component==='TerminalView.tsx'?'PTY paint only; exact App/SessionPane terminal route tested, no physical terminal or resize effect':'Unused Monaco paint leaf; no File view rendered'});return{contents:code,loader:'js'}}return{contents:source,loader:path.endsWith('tsx')?'tsx':path.endsWith('ts')?'ts':'js'}});builder.onLoad({filter:/\.css$/},async({path})=>{if(!path.startsWith(root+'/')||path.includes('/node_modules/'))return;const s=await readFile(path);inputs.set(path,hash(s));return{contents:s.toString(),loader:'css'}})}}
 for(const file of ['entry.mjs','main.cjs'])inputs.set(join(fixture,file),hash(await readFile(join(fixture,file))))
 inputs.set(new URL(import.meta.url).pathname,hash(await readFile(new URL(import.meta.url))))
 const out=join(privateRoot,'out');await mkdir(out);const renderer=join(out,'app.js')
 const compiled=await build({entryPoints:[join(fixture,'entry.mjs')],outfile:renderer,bundle:true,platform:'browser',format:'esm',target:'es2022',jsx:'automatic',metafile:true,plugins:[observe],logLevel:'silent',define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},loader:{'.png':'file','.svg':'file','.woff2':'file','.woff':'file','.ttf':'file'}})
 receipt.metafile=compiled.metafile;receipt.inputs=Object.fromEntries([...inputs].map(([p,sha])=>[relative(root,p),sha]));receipt.transformations=transformations
 for(const suffix of ['App.tsx','WorkspaceWorkbench.tsx','StableWorkbenchView.tsx','SessionPane.tsx','SessionActivityPresentation.tsx','ActivityView.tsx','AgentSessionComposer.tsx','SessionMailbox.tsx','store.ts','workbench-presentation.ts'])assert.ok([...inputs.keys()].some(p=>p.endsWith('/'+suffix)),'Actual nonempty loaded '+suffix)
 const html=join(out,'index.html');await writeFile(html,'<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="./app.css"><div id="root"></div><script type="module" src="./app.js"></script></html>')
 receipt.compiled={renderer:hash(await readFile(renderer)),css:hash(await readFile(join(out,'app.css')))}
 const env={...process.env,AGENTMUX_DESKTOP_USER_DATA:join(privateRoot,'user-data'),AGENTMUX_RUNTIME_DIRECTORY:join(privateRoot,'runtime'),AGENTMUX_STATE_DIRECTORY:join(privateRoot,'state')};delete env.ELECTRON_RUN_AS_NODE
 receipt.process=await runProbeProcess(require('electron'),[join(fixture,'main.cjs'),html,privateRoot,evidence],{temporaryRoot:privateRoot,cwd:root,env,timeoutMs:60000,onLine:s=>logs.push(s)})
 receipt.actual=JSON.parse(await readFile(join(evidence,'actual.json'),'utf8'));assert.equal(receipt.process.exitCode,0,receipt.actual.failure?.message);assert.equal(receipt.actual.passed,true)
 receipt.frames=await Promise.all(receipt.actual.frames.map(async f=>({...f,sha256:hash(await readFile(join(evidence,f.file)))})));assert.equal(receipt.frames.length,4)
 receipt.sourceAfter=Object.fromEntries(await Promise.all([...inputs.keys()].map(async p=>[relative(root,p),hash(await readFile(p))])));assert.deepEqual(receipt.sourceAfter,receipt.inputs,'Actual nonempty Source stable B=A');receipt.capturedPass=true
}catch(error){receipt.failure={name:error.name,message:error.message,stack:error.stack};process.exitCode=1}finally{await writeFile(join(evidence,'process.log'),logs.join('\n'));const remaining=await listProbeProcesses(-1,privateRoot);receipt.cleanup={privateRoot,remaining,removed:false,evidencePreserved:true};if(!remaining.length){await rm(privateRoot,{recursive:true});receipt.cleanup.removed=true}await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({capturedPass:receipt.capturedPass,failure:receipt.failure?.message,evidence}))}
