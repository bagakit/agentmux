import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'vite'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
const desktop=resolve(import.meta.dirname,'..'),repository=resolve(desktop,'../..'),fixture=join(desktop,'scripts/fixtures/files-frame-layout'),require=createRequire(join(desktop,'package.json'))
const evidence=resolve(process.argv[2]??'.local/state/mote-watchlamp-pauses/files-layout'),privateRoot=await mkdtemp(join(tmpdir(),'agentmux-files-layout-')),hash=b=>createHash('sha256').update(b).digest('hex')
const result={schema:'agentmux.files-frame-layout-proof.v1',passed:false,scope:'directory-first complete App/ordinary Topic, no restart claim',aestheticReview:'not-performed',userRunTouched:false,phases:[],cleanup:null}
await mkdir(evidence,{recursive:true})
try{
 const harness=new Map()
 for(const file of [import.meta.filename,join(fixture,'main.cjs'),join(fixture,'entry.mjs'),join(fixture,'index.html'),join(desktop,'scripts/fixtures/mote-shared-space-frame/entry.mjs'),join(desktop,'scripts/probe-process.mjs')])harness.set(file,hash(await readFile(file)))
 result.harness=Object.fromEntries([...harness].map(([file,digest])=>[relative(repository,file),digest]))
 const aliases=[]
 for(const name of ['core','demand','layout','client-ui']){
  const directory=join(repository,'packages',name),manifestBytes=await readFile(join(directory,'package.json')),manifest=JSON.parse(manifestBytes);harness.set(join(directory,'package.json'),hash(manifestBytes))
  for(const [subpath,target]of Object.entries(manifest.exports).sort(([a],[b])=>Number(a.includes('*'))-Number(b.includes('*'))||b.length-a.length)){
   const entry=typeof target==='string'?target:name==='client-ui'?target.browser??target.types:target.import
   assert(entry,'Original workspace export is explicit')
   const source=name==='client-ui'?entry:entry.endsWith('.ts')?entry:entry.replace('./dist/',name==='demand'?'./':'./src/').replace(/\.js$/u,'.ts')
   const specifier='@agentmux/'+name+(subpath==='.'?'':subpath.slice(1)),expression=specifier.split('*').map(p=>p.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('(.+)')
   aliases.push({find:new RegExp('^'+expression+'$'),replacement:resolve(directory,source).replace('*','$1')})
  }
 }
 for(const mutant of [false,true]){
  const name=mutant?'directory-block-mutant':'baseline',phaseDir=join(evidence,name),outDir=join(privateRoot,name,'renderer'),profile=join(privateRoot,name),inputs=new Map(harness),originals=new Map(),styles=new Map(),loaded=[];await mkdir(phaseDir,{recursive:true})
  let controlledApiTransforms=0,mutationCount=0
  const cssBinding={postcssPlugin:'files-layout-actual-consumed-css',async Once(root){
   const consumed=new Map();const remember=node=>{const input=node.source?.input;if(input?.file?.startsWith(repository+'/')&&!input.file.includes('/node_modules/'))consumed.set(input.file,input.css)};remember(root);root.walk(remember)
   for(const[file,css]of consumed){assert.equal(hash(await readFile(file)),hash(css),'Original consumed CSS bytes');styles.set(file,hash(css));inputs.set(file,hash(css))}
   const original=root.toString();let changed=false
   if(mutant)root.walkRules(rule=>{if(rule.selector!=='.workspace-tool-explorer--directory-first')return;assert(rule.source?.input.file.endsWith('/styles/topic-knowledge.css'));rule.append({prop:'display',value:'block'});mutationCount++;changed=true})
   if(changed){const transformed=root.toString();await writeFile(join(phaseDir,'consumed-before.css'),original);await writeFile(join(phaseDir,'consumed-loaded.css'),transformed);loaded.push({source:'apps/desktop/src/renderer/src/styles/topic-knowledge.css',rawSHA256:styles.get(join(desktop,'src/renderer/src/styles/topic-knowledge.css')),originalConsumedSHA256:hash(original),loadedConsumedSHA256:hash(transformed),operation:'Only restore the original directory-first display:block declaration in the actual PostCSS source consumer.'})}
  }}
  await build({configFile:false,root:fixture,base:'./',logLevel:'error',esbuild:{jsx:'automatic'},worker:{format:'es'},resolve:{alias:aliases},define:{__AGENTMUX_WEB_PREVIEW__:'false'},css:{postcss:{plugins:[cssBinding]}},plugins:[{name:'files-layout-bound-complete-source',enforce:'pre',async load(id){const file=id.split('?')[0];if(file.startsWith(repository+'/')&&!file.includes('/node_modules/')&&!inputs.has(file)){const bytes=await readFile(file);inputs.set(file,hash(bytes));originals.set(file,bytes)}return null},transform(code,id){if(id.startsWith(repository+'/')&&!id.includes('/node_modules/')&&!id.includes('?')&&/\.(?:ts|tsx|js|mjs)$/u.test(id)){inputs.set(id,hash(code));originals.set(id,Buffer.from(code))}if(id.split('?')[0]!==join(desktop,'src/renderer/src/lib/api.ts'))return null;const anchor='export const api = __AGENTMUX_WEB_PREVIEW__ ? mockApi : requireDesktopApi()';assert.equal(code.split(anchor).length,2);controlledApiTransforms++;return{code:code.replace(anchor,'export const api = mockApi'),map:null}}}],build:{target:'esnext',outDir,emptyOutDir:true}})
  assert.equal(controlledApiTransforms,1);assert(styles.size>1);assert.equal(mutationCount,mutant?1:0)
  for(const source of ['App.tsx','store.ts','WorkspaceFilesFrame.tsx','TopicFilesTool.tsx','SourceFilesAccess.tsx','source-files-workbench.ts','FileExplorer.tsx'])assert([...inputs.keys()].some(file=>file.endsWith('/'+source)),'Actual original consumer compiled: '+source)
  const sourceGraph=Object.fromEntries([...inputs].map(([file,digest])=>[relative(repository,file),digest])),readbackDrift=[]
  const exactOwners=['App.tsx','store.ts','WorkspaceFilesFrame.tsx','TopicFilesTool.tsx','WorkspaceFilesTool.tsx','TopicNavigationPanel.tsx','SourceFilesAccess.tsx','source-files-workbench.ts','source-files-discovery.ts','FileExplorer.tsx','dock.css','topic-knowledge.css']
  for(const[file,digest]of inputs){const currentSHA256=hash(await readFile(file));if(currentSHA256===digest)continue;const path=relative(repository,file);assert(!harness.has(file)&&!exactOwners.some(owner=>file.endsWith('/'+owner)),'Bounded layout owner changed during compilation: '+path);const original=originals.get(file);assert(original&&hash(original)===digest,'Retain the actual consumed source snapshot');const snapshot='outside-scope-snapshot-'+readbackDrift.length+file.slice(file.lastIndexOf('.'));await writeFile(join(phaseDir,snapshot),original);readbackDrift.push({path,loadedSHA256:digest,currentSHA256,snapshot,scope:'Exact imported snapshot retained; no claim that this imported module matches current bytes. Current Mote proof is separately owned by the Root.'})}
  for(const file of ['WorkspaceFilesFrame.tsx','../styles/dock.css','../styles/topic-knowledge.css']){const path=resolve(desktop,'src/renderer/src/components',file);await writeFile(join(phaseDir,path.endsWith('.tsx')?'WorkspaceFilesFrame.tsx':file.split('/').at(-1)),await readFile(path))}
  const compiled={};for(const entry of await readdir(outDir,{recursive:true,withFileTypes:true}))if(entry.isFile()){const file=join(entry.parentPath,entry.name);compiled[relative(outDir,file)]=hash(await readFile(file))}
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const logs=[]
  const execution=await runProbeProcess(require('electron'),[join(fixture,'main.cjs'),join(outDir,'index.html'),profile,phaseDir],{temporaryRoot:privateRoot,cwd:repository,env,timeoutMs:90000,onLine:line=>logs.push(line)}),exit=execution.exitCode
  await writeFile(join(phaseDir,'process.log'),logs.join('\n'));const app=JSON.parse(await readFile(join(phaseDir,'app.json'),'utf8'))
  const proof={name,exit,execution,app,sourceGraph,readbackDrift,stylesheets:Object.fromEntries([...styles].map(([p,s])=>[relative(repository,p),s])),compiled,controlledApiTransforms,loaded,mutationCount};result.phases.push(proof)
  if(!mutant){assert.equal(exit,0,app.failure?.message);assert.equal(app.passed,true);assert.equal(app.frames.length,4);assert.equal(app.checks.length,4);assert.equal(app.errors.length,0);assert(app.input.length>=10)}
  else{assert.notEqual(exit,0);assert.equal(app.passed,false);assert.match(app.failure?.message??'',/Original (?:Topic and Files (?:each retain rendered height|remain within their original frame)|Chromium hit test)/u,'The changed loaded producer must fail original rendered geometry/input assertions');assert(loaded.length&&loaded.every(r=>r.originalConsumedSHA256!==r.loadedConsumedSHA256));assert(app.checks.length>0,'Mutant must reach original layout consumer')}
  for(const[file,digest]of harness)assert.equal(hash(await readFile(file)),digest,'The exact executed harness stayed unchanged')
 }
 result.passed=true
} catch(error){result.failure={message:error.message,stack:error.stack};throw error}
finally{
 const remaining=await listProbeProcesses(0,privateRoot);assert.equal(remaining.length,0,'Only this private probe group is clean');await rm(privateRoot,{recursive:true,force:true});const removed=await access(privateRoot).then(()=>false,error=>{if(error.code==='ENOENT')return true;throw error});result.cleanup={privateRoot,remaining,removed}
 result.runner={path:relative(repository,import.meta.filename),sha256:hash(await readFile(import.meta.filename))};await writeFile(join(evidence,'receipt.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({passed:result.passed,receipt:join(evidence,'receipt.json')}))
}
