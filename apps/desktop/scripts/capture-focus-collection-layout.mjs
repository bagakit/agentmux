import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const root=resolve(import.meta.dirname,'../../..'),desktop=join(root,'apps/desktop'),argument=process.argv.indexOf('--evidence')
assert.ok(argument>=0&&process.argv[argument+1],'Use --evidence <private directory>')
const evidence=resolve(process.argv[argument+1]),fixture=join(desktop,'scripts/fixtures/focus-collection-layout')
await mkdir(evidence,{recursive:true})
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const owners=[...['GlobalFocusSurface','FocusProjectLanes','FocusScanLaneContent','FocusContextCards','FocusContextCardBody','FocusContextRow','FocusContextMenu','AgentContextContent','FocusTopicLabel','FocusLaneGroups','WorkbenchNameTooltip','settings/FocusSettingsPane','settings/FocusSettingsPreview'].map(name=>`apps/desktop/src/renderer/src/components/${name}.tsx`),
 ...['focus-collection-lanes','use-focus-collection-lanes','use-focus-project-order','focus-project-lanes','focus-context','focus-lane-origin','focus-lane-layout','focus-preferences'].map(name=>`apps/desktop/src/renderer/src/lib/${name}.ts`),
 ...['focus','settings-focus','settings-workview-layout'].map(name=>`apps/desktop/src/renderer/src/styles/${name}.css`),
 'apps/desktop/src/shared/focus-preferences.ts','apps/desktop/src/shared/config-edit.ts']
const ownerHashes=()=>Promise.all(owners.map(async name=>[name,hash(await readFile(join(root,name)))])).then(Object.fromEntries)
if(process.env.AGENTMUX_FOCUS_COLLECTION_SCENE_RECEIPT){
 const path=resolve(process.env.AGENTMUX_FOCUS_COLLECTION_SCENE_RECEIPT),saved=JSON.parse(await readFile(path,'utf8'))
 assert.equal(saved.schema,'agentmux.focus-collection-scene.v1');assert.equal(saved.capturedPass,true);assert.equal(saved.actual.passed,true);assert.equal(saved.userRuntimeTouched,false)
 assert.deepEqual(saved.ownerSources,await ownerHashes());assert.equal(saved.frames.length,20)
 for(const name of owners)assert.equal(saved.inputs[name],saved.ownerSources[name],'The Renderer actually loaded '+name)
 for(const[name,sha]of Object.entries(saved.drivers))assert.equal(hash(await readFile(join(root,name))),sha)
 for(const[name,sha]of Object.entries(saved.menuDependencies))assert.equal(hash(await readFile(join(root,name))),sha)
 for(const frame of saved.frames)assert.equal(hash(await readFile(join(resolve(path,'..'),frame.file))),frame.sha256)
 assert.equal(saved.cleanup.removed,true);assert.deepEqual(saved.cleanup.remaining,[])
 console.log(JSON.stringify({capturedPass:true,receipt:path,exactEvidenceReused:true}));process.exit(0)
}
const require=createRequire(join(desktop,'package.json')),{build}=createRequire(require.resolve('vite/package.json'))('esbuild')
const temporary=await mkdtemp(join(tmpdir(),'amx-focus-collection-')),inputs=new Map(),transformations=[],manifests=new Map(),logs=[]
const receipt={schema:'agentmux.focus-collection-scene.v1',capturedPass:false,aestheticReview:'not-performed',userRuntimeTouched:false,
 boundary:'Actual original current-source Global Focus/Store/cards/Collection projection and original Settings/Preview. Static private typed transport; adjacent Timeline and unselected PTY/editor paint isolated. No real Provider, Native Session receipt, persisted settings or user installation is represented by these images.'}
try{
 receipt.ownerSources=await ownerHashes()
 const workspaceSources={name:'original-public-workspace-sources',setup(builder){builder.onResolve({filter:/^@agentmux\//},async({path:specifier})=>{
   const[,name,...parts]=specifier.split('/'),directory=join(root,name==='host'?'apps':'packages',name)
   if(!manifests.has(name)){const path=join(directory,'package.json'),bytes=await readFile(path);inputs.set(path,hash(bytes));manifests.set(name,JSON.parse(bytes))}
   const entry=parts.length?'./'+parts.join('/') : '.',exports=manifests.get(name).exports
   const key=Object.keys(exports).sort((a,b)=>Number(a.includes('*'))-Number(b.includes('*'))||b.length-a.length).find(key=>key===entry||key.includes('*')&&entry.startsWith(key.split('*')[0])&&entry.endsWith(key.split('*')[1]))
   assert.ok(key,'Original public export '+specifier)
   const declared=exports[key],target=typeof declared==='string'?declared:declared.browser??declared.import
   const wildcard=key.includes('*')?entry.slice(key.split('*')[0].length,entry.length-key.split('*')[1].length):''
   let source=target.replace('*',wildcard).replace('./dist/src/','./src/').replace('./dist/','./src/').replace(/\.js$/,'.ts')
   if(name==='identity'&&key==='./runtime-source')source=target
   if(name==='identity'&&key==='./runtime')source='./src/runtime-entry.ts'
   const path=[join(directory,source),join(directory,source.replace(/\.ts$/,'.tsx'))].find(existsSync)
   assert.ok(path,'Original source '+specifier);return{path}
 })}}
 const menuDependency=path=>/\/@radix-ui\/react-(?:context-menu|menu|popper)\/dist\/index\.[cm]?js$/.test(path)
 const observe={name:'actual-loaded-collection-owners',setup(builder){
  builder.onLoad({filter:/\.[cm]?[jt]sx?$/},async({path})=>{
   if(!path.startsWith(root+'/')||path.includes('/node_modules/')&&!menuDependency(path))return
   const source=await readFile(path,'utf8');inputs.set(path,hash(source));const name=path.slice(path.lastIndexOf('/')+1)
   if(['SessionPane.tsx','EditorPane.tsx','GitBranchDiffPane.tsx','FileSurfaceView.tsx','RecentFocusTimeline.tsx'].includes(name)){
    const contents=`export function ${name.slice(0,-4)}(){return null}`
    transformations.push({path:relative(root,path),reason:'Adjacent timeline or unselected PTY/editor paint; no input/lifecycle owner replaced',sourceSHA256:hash(source),loadedSHA256:hash(contents)})
    return{contents,loader:'js'}
   }
   return{contents:source,loader:path.endsWith('tsx')?'tsx':path.endsWith('ts')?'ts':'js'}
  })
  builder.onLoad({filter:/\.css$/},async({path})=>{if(!path.startsWith(root+'/')||path.includes('/node_modules/'))return;const contents=await readFile(path,'utf8');inputs.set(path,hash(contents));return{contents,loader:'css'}})
  builder.onResolve({filter:/\?worker$/},async args=>{const found=await builder.resolve(args.path.replace(/\?worker$/,''),{resolveDir:args.resolveDir,kind:args.kind});assert.equal(found.errors.length,0);inputs.set(found.path,hash(await readFile(found.path)));return{path:found.path,namespace:'unselected-worker'}})
  builder.onLoad({filter:/.*/,namespace:'unselected-worker'},()=>({contents:'export default class UnselectedWorker {constructor(){throw new Error("No File editor exists in this scan scene")}}',loader:'js'}))
 }}
 receipt.drivers={}
 for(const name of [relative(root,new URL(import.meta.url).pathname),relative(root,join(fixture,'entry.mjs')),relative(root,join(fixture,'main.cjs'))]){const bytes=await readFile(join(root,name));receipt.drivers[name]=hash(bytes);await writeFile(join(evidence,'driver-'+name.slice(name.lastIndexOf('/')+1)),bytes)}
 const out=join(temporary,'out');await mkdir(out)
 await build({entryPoints:[join(fixture,'entry.mjs')],outfile:join(out,'app.js'),bundle:true,platform:'browser',format:'esm',target:'es2022',jsx:'automatic',plugins:[workspaceSources,observe],logLevel:'silent',
  alias:{react:join(desktop,'node_modules/react'),'react-dom':join(desktop,'node_modules/react-dom'),'react-dom/server':join(desktop,'node_modules/react-dom/server.browser.js')},
  define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},loader:{'.png':'file','.svg':'file','.woff2':'file','.woff':'file','.ttf':'file'}})
 receipt.inputs=Object.fromEntries([...inputs].map(([path,sha])=>[relative(root,path),sha]));receipt.transformations=transformations
 for(const name of owners)assert.equal(receipt.inputs[name],receipt.ownerSources[name],'Actual current Renderer owner '+name)
 receipt.menuDependencies=Object.fromEntries([...inputs].filter(([name])=>menuDependency(name)).map(([name,sha])=>[relative(root,name),sha]))
 assert.ok(Object.keys(receipt.menuDependencies).length>0)
 receipt.compiled={renderer:hash(await readFile(join(out,'app.js'))),css:hash(await readFile(join(out,'app.css')))}
 const html=join(out,'index.html');await writeFile(html,'<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="./app.css"><div id="root"></div><script type="module" src="./app.js"></script></html>')
 const env={...process.env,AGENTMUX_DESKTOP_USER_DATA:join(temporary,'user-data'),AGENTMUX_RUNTIME_DIRECTORY:join(temporary,'runtime'),AGENTMUX_STATE_DIRECTORY:join(temporary,'state')};delete env.ELECTRON_RUN_AS_NODE
 receipt.process=await runProbeProcess(require('electron'),[join(fixture,'main.cjs'),html,temporary,evidence],{temporaryRoot:temporary,cwd:root,env,timeoutMs:90000,onLine:line=>logs.push(line)})
 receipt.actual=JSON.parse(await readFile(join(evidence,'actual.json'),'utf8'))
 receipt.frames=await Promise.all(receipt.actual.frames.map(async frame=>({...frame,sha256:hash(await readFile(join(evidence,frame.file)))})))
 assert.equal(receipt.process.exitCode,0,receipt.actual.failure?.message);assert.equal(receipt.actual.passed,true);assert.equal(receipt.frames.length,20)
 assert.deepEqual(await ownerHashes(),receipt.ownerSources)
 receipt.sourceAfter=Object.fromEntries(await Promise.all([...inputs.keys()].map(async path=>[relative(root,path),hash(await readFile(path))])))
 receipt.parallelInputChanges=Object.keys(receipt.inputs).filter(path=>receipt.inputs[path]!==receipt.sourceAfter[path])
 assert.deepEqual(receipt.parallelInputChanges,[])
 receipt.capturedPass=true
}catch(error){receipt.failure={name:error.name,message:error.message,stack:error.stack};process.exitCode=1}
finally{
 await writeFile(join(evidence,'process.log'),logs.join('\n'))
 const remaining=await listProbeProcesses(process.pid+1_000_000_000,temporary)
 if(!remaining.length){await rm(temporary,{recursive:true,force:true});receipt.cleanup={removed:true,remaining:[]}}
 else{receipt.cleanup={removed:false,remaining};receipt.capturedPass=false;process.exitCode=1}
 await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')
}
console.log(JSON.stringify({capturedPass:receipt.capturedPass,receipt:join(evidence,'receipt.json'),failure:receipt.failure}))
