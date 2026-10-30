import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const root=resolve(import.meta.dirname,'../../..'), desktop=join(root,'apps/desktop')
assert.ok(process.argv.length===4&&process.argv[2]==='--evidence'&&process.argv[3],'Use --evidence <private evidence directory>')
const evidence=resolve(process.argv[3]);await mkdir(evidence,{recursive:true})
const fixture=join(desktop,'scripts/fixtures/focus-context-recap-menu')
const require=createRequire(join(desktop,'package.json')), {build}=createRequire(require.resolve('vite/package.json'))('esbuild')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),inputs=new Map(),transformations=[],logs=[]
const widthMutation=process.env.AGENTMUX_FOCUS_MENU_WIDTH_MUTATION==='1'
const shiftMutation=process.env.AGENTMUX_FOCUS_MENU_SHIFT_MUTATION==='1'
assert.ok(!(widthMutation&&shiftMutation),'Each private positioning mutation runs independently')
const receipt={schema:'agentmux.focus-context-recap-menu-scene.v1',capturedPass:false,aestheticReview:'not-performed',userAppRunRuntimeControlled:false,
  privateCssMutation:widthMutation?'unbounded-focus-menu-width':null,
  privateSourceMutation:shiftMutation?'unshifted-focus-submenu':null,
  boundary:'Original compiled Global/Store/projection/Row/menu/clipboard/reportError and CSS. Maintained typed preview API; only PTY and unused editor paint isolated. No true Core/PTY/Run/PID, Writer, OS input, restart or user installation.'}
const requiredFrames=['cards-1200.png','cards-360.png','pointer-menu-360.png','keyboard-menu-360.png','clipboard-failure-360.png',
  'menu-dark-1200.png','menu-light-1200.png','menu-light-360.png','native-avatar-tooltip-1200.png','fork-destination-1200.png','fork-ready-1200.png','menu-spatial-1200.png','connections-1200.png']
const menuOwnerFiles=[...['AgentMenuContent','FocusContextMenu','FocusContextRow','AgentNativeSourceControls','SessionStop','SessionRestart','WorkbenchMenuSubmenu','WorkbenchCopyLinkRow','WorkbenchActionRows','AgentContextContent',
    'AgentMenuIdentityActions','AgentAvatar','AgentSessionReadingSurface','ActivityView','SessionLearningSurface','SessionTakeoverSurface','AgentCurrentForkControls','FocusAgentWorkspaceMenu','AgentConnectorDialog','SelectionField','RegionContextMenu'].map(name=>`apps/desktop/src/renderer/src/components/${name}.tsx`),
  ...['agent-menu-target','focus-agent-menu-location','agent-current-fork','agent-new-tab-destination','session-takeover','session-conversation-window'].map(name=>`apps/desktop/src/renderer/src/lib/${name}.ts`),
  'apps/desktop/src/renderer/src/lib/use-agent-connector-menu.tsx',
  ...['agent-region-header','focus','chrome','agent-current-fork','agent-session-action-surface','session-takeover','session-learning'].map(name=>`apps/desktop/src/renderer/src/styles/${name}.css`),
  ...['runtime','icons','icon-sprite'].map(name=>`packages/client-ui/src/theme/${name}.${name==='icons'?'tsx':'ts'}`)]
async function menuOwnerHashes(){return Object.fromEntries(await Promise.all(menuOwnerFiles.map(async path=>[path,hash(await readFile(join(root,path)))])))}
async function mutationEvidence(path){
  const bytes=await readFile(path),saved=JSON.parse(bytes)
  assert.equal(saved.schema,'agentmux.renderer-source-mutation.v1');assert.equal(saved.passed,true)
  assert.ok(saved.cases.length>0);assert.equal(saved.sharedTreeMutations,0)
  const unchangedSemanticInputs={},changedSemanticInputs={}
  for(const[name,sha256]of Object.entries(saved.sourceBefore))if(!name.endsWith('.css')){
    const current=hash(await readFile(join(root,name)))
    if(current===sha256)unchangedSemanticInputs[name]=sha256
    else changedSemanticInputs[name]={prior:sha256,current}
  }
  assert.ok(Object.keys(unchangedSemanticInputs).length>0)
  return{path,sha256:hash(bytes),supplemental:true,unchangedSemanticInputs,changedSemanticInputs,
    originalCssInputs:Object.fromEntries(Object.entries(saved.sourceBefore).filter(([name])=>name.endsWith('.css'))),
    boundary:'Supplemental prior Task evidence retains all original identities; changed inputs are reported, not requalified. This scene binds its own current implementation, CSS, dependencies and positioning counterexample.'}
}
if(process.env.AGENTMUX_FOCUS_MENU_SCENE_RECEIPT){
  assert.ok(!widthMutation&&!shiftMutation,'A private positioning mutation must execute its Renderer instead of reusing a normal scene')
  const path=resolve(process.env.AGENTMUX_FOCUS_MENU_SCENE_RECEIPT),saved=JSON.parse(await readFile(path,'utf8'))
  assert.equal(saved.schema,receipt.schema);assert.equal(saved.capturedPass,true);assert.equal(saved.actual.passed,true);assert.equal(saved.userAppRunRuntimeControlled,false)
  assert.equal(saved.privateCssMutation,null)
  assert.equal(saved.privateSourceMutation,null)
  assert.deepEqual(saved.menuOwnerSources,await menuOwnerHashes());assert.ok(Object.keys(saved.inputs).length>0&&saved.workspaceSources.length>0)
  assert.ok(Object.keys(saved.menuDependencies).length>0)
  for(const[name,sha256]of Object.entries(saved.menuDependencies))assert.equal(hash(await readFile(join(root,name))),sha256,'The actual loaded menu dependency remains unchanged: '+name)
  assert.deepEqual(saved.frames.map(frame=>frame.file).sort(),[...requiredFrames].sort())
  assert.deepEqual(saved.frames.map(frame=>frame.file),saved.actual.frames.map(frame=>frame.file))
  for(const owner of menuOwnerFiles)assert.equal(saved.inputs[owner],saved.menuOwnerSources[owner],'The archived Renderer loaded its original menu owner: '+owner)
  for(const frame of saved.frames){const bytes=await readFile(join(path,'..',frame.file));assert.ok(bytes.length>0);assert.equal(hash(bytes),frame.sha256)}
  assert.deepEqual(Object.keys(saved.drivers).sort(),['capture-focus-context-recap-menu.mjs','entry.mjs','main.cjs'])
  for(const[name,driver]of Object.entries(saved.drivers)){
    assert.equal(hash(await readFile(join(root,driver.path))),driver.sha256);assert.equal(hash(await readFile(join(path,'..','driver-'+name))),driver.sha256)
  }
  assert.equal(saved.compiled.renderer.length,64);assert.equal(saved.compiled.css.length,64)
  assert.deepEqual(await mutationEvidence(saved.mutationEvidence.path),saved.mutationEvidence)
  assert.equal(saved.cleanup.removed,true);assert.deepEqual(saved.cleanup.remaining,[])
  console.log(JSON.stringify({capturedPass:true,exactEvidenceReused:true,receipt:path,frames:saved.frames.length}));process.exit(0)
}
const privateRoot=await mkdtemp(join(tmpdir(),'amux-focus-card-recap-'))
try{
  receipt.menuOwnerSources=await menuOwnerHashes()
  receipt.mutationEvidence=await mutationEvidence(resolve(process.env.AGENTMUX_FOCUS_MENU_MUTATION_RECEIPT??join(root,'.tmp/unified-agent-menu-composition/receipt.json')))
  // This source probe must not depend on stale workspace dist or rebuild another
  // collaborator's in-progress Core. Resolve the original public exports to their
  // current source entries, as the existing source-alias Renderer suites do.
  const manifests=new Map(),workspaceSources=[]
  const workspaceSource={name:'current-workspace-public-sources',setup(builder){builder.onResolve({filter:/^@agentmux\//},async({path:specifier})=>{
    const [,name,...parts]=specifier.split('/'),directory=join(root,name==='host'?'apps':'packages',name)
    if(!manifests.has(name)){
      const path=join(directory,'package.json'),source=await readFile(path,'utf8')
      inputs.set(path,hash(source));manifests.set(name,JSON.parse(source))
    }
    const entry=parts.length?'./'+parts.join('/'):'.',exports=manifests.get(name).exports
    const key=Object.keys(exports).sort((a,b)=>Number(a.includes('*'))-Number(b.includes('*'))||b.length-a.length)
      .find(key=>key===entry||key.includes('*')&&entry.startsWith(key.split('*')[0])&&entry.endsWith(key.split('*')[1]))
    assert.ok(key,'Original public export exists: '+specifier)
    const declared=exports[key],target=typeof declared==='string'?declared:declared.browser??declared.import
    assert.ok(target,'A browser/import target exists: '+specifier)
    const wildcard=key.includes('*')?entry.slice(key.split('*')[0].length,entry.length-key.split('*')[1].length):''
    let source=target.replace('*',wildcard).replace('./dist/src/','./src/').replace('./dist/','./src/').replace(/\.js$/,'.ts')
    if(name==='identity'&&key==='./runtime-source')source=target
    if(name==='identity'&&key==='./runtime')source='./src/runtime-entry.ts'
    const path=[join(directory,source),join(directory,source.replace(/\.ts$/,'.tsx'))].find(existsSync)
    assert.ok(path,'The original source entry exists: '+specifier)
    workspaceSources.push({specifier,declared:target,path:relative(root,path)})
    return{path}
  })}}
  const menuDependency=path=>/\/@radix-ui\/react-(?:context-menu|menu|popper)\/dist\/index\.[cm]?js$/.test(path)
  const observe={name:'original-focus-card-source-binding',setup(builder){builder.onLoad({filter:/\.[cm]?[jt]sx?$/},async({path})=>{
    if(!path.startsWith(root+'/')||path.includes('/node_modules/')&&!menuDependency(path))return
    const source=await readFile(path,'utf8');inputs.set(path,hash(source));const component=path.slice(path.lastIndexOf('/')+1)
    if(shiftMutation&&component==='WorkbenchMenuSubmenu.tsx'){
      assert.equal(source.split('shiftCrossAxis').length-1,1,'Unique actual shared submenu cross-axis opt-in')
      const contents=source.replace('shiftCrossAxis','shiftCrossAxis={false}')
      transformations.push({path:relative(root,path),mutation:'unshifted-focus-submenu',sourceSHA256:hash(source),loadedSHA256:hash(contents),productionWritten:false})
      return{contents,loader:'tsx'}
    }
    if(['SessionPane.tsx','EditorPane.tsx','GitBranchDiffPane.tsx','FileSurfaceView.tsx'].includes(component)){
      const code=`export function ${component.slice(0,-4)}(){return null}`
      transformations.push({path:relative(root,path),isolated:component==='SessionPane.tsx'?'Unselected PTY paint, no lifecycle or input replacement':'Unused Monaco paint, no file Region in this scene',sourceSHA256:hash(source),loadedSHA256:hash(code)})
      return{contents:code,loader:'js'}
    }
    return{contents:source,loader:path.endsWith('tsx')?'tsx':path.endsWith('ts')?'ts':'js'}
  });builder.onLoad({filter:/\.css$/},async({path})=>{
    if(!path.startsWith(root+'/')||path.includes('/node_modules/'))return
    const source=await readFile(path,'utf8');inputs.set(path,hash(source))
    if(widthMutation&&path===join(desktop,'src/renderer/src/styles/agent-region-header.css')){
      const anchor='width: min(280px, var(--radix-context-menu-content-available-width, var(--radix-dropdown-menu-content-available-width, 280px)))'
      assert.equal(source.split(anchor).length-1,1,'Unique actual shared menu width rule')
      const contents=source.replace(anchor,'width: 280px')
      transformations.push({path:relative(root,path),mutation:'unbounded-focus-menu-width',sourceSHA256:hash(source),loadedSHA256:hash(contents),productionWritten:false})
      return{contents,loader:'css'}
    }
    return{contents:source,loader:'css'}
  })}}
  const unusedEditorWorkers={name:'unselected-file-editor-workers',setup(builder){
    builder.onResolve({filter:/\?worker$/},async args=>{
      const original=await builder.resolve(args.path.replace(/\?worker$/,''),{resolveDir:args.resolveDir,kind:args.kind})
      assert.equal(original.errors.length,0,'The original unselected editor worker resolves')
      inputs.set(original.path,hash(await readFile(original.path)))
      return{path:original.path,namespace:'unselected-editor-worker'}
    })
    builder.onLoad({filter:/.*/,namespace:'unselected-editor-worker'},({path})=>{
      const contents='export default class UnselectedEditorWorker { constructor(){throw new Error("A File editor worker was requested in the Focus menu-only scene.")} }'
      transformations.push({path:relative(root,path),isolated:'No File Region or editor exists in this scene; creating its worker fails explicitly',sourceSHA256:inputs.get(path),loadedSHA256:hash(contents)})
      return{contents,loader:'js'}
    })
  }}
  receipt.drivers={}
  for(const path of [join(fixture,'entry.mjs'),join(fixture,'main.cjs'),new URL(import.meta.url).pathname]){
    const bytes=await readFile(path),name=path.slice(path.lastIndexOf('/')+1);inputs.set(path,hash(bytes))
    receipt.drivers[name]={path:relative(root,path),sha256:hash(bytes)};await writeFile(join(evidence,'driver-'+name),bytes)
  }
  const out=join(privateRoot,'out');await mkdir(out)
  const buildResult=await build({entryPoints:[join(fixture,'entry.mjs')],outfile:join(out,'app.js'),bundle:true,platform:'browser',format:'esm',target:'es2022',jsx:'automatic',metafile:true,plugins:[workspaceSource,unusedEditorWorkers,observe],logLevel:'silent',
    alias:{react:join(desktop,'node_modules/react'),'react-dom':join(desktop,'node_modules/react-dom'),
      'react-dom/server':join(desktop,'node_modules/react-dom/server.browser.js')},
    define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},loader:{'.png':'file','.svg':'file','.woff2':'file','.woff':'file','.ttf':'file'}})
  assert.ok(workspaceSources.length>0,'The actual current-source public export set is nonempty')
  receipt.menuDependencies=Object.fromEntries([...inputs].filter(([path])=>menuDependency(path)).map(([path,sha256])=>[relative(root,path),sha256]))
  for(const name of ['context-menu','menu','popper'])assert.ok(Object.keys(receipt.menuDependencies).some(path=>path.includes('/@radix-ui/react-'+name+'/')),'The actual Renderer loads its original '+name+' dependency')
  receipt.workspaceSources=workspaceSources;receipt.metafile=buildResult.metafile;receipt.inputs=Object.fromEntries([...inputs].map(([path,sha])=>[relative(root,path),sha]));receipt.transformations=transformations
  for(const suffix of ['GlobalFocusSurface.tsx','FocusContextRow.tsx','FocusContextMenu.tsx','AgentMenuContent.tsx','focus-context.ts','launcher-resume.ts','agent-roster-menu.ts','agent-address.ts','clipboard-copy.ts','RegionContextMenu.tsx','WindowOverlayHost.tsx','GlobalSystemNotices.tsx','NotificationItem.tsx','store.ts'])assert.ok([...inputs.keys()].some(path=>path.endsWith('/'+suffix)),'Nonempty actual module '+suffix)
  for(const owner of menuOwnerFiles)assert.equal(receipt.inputs[owner],receipt.menuOwnerSources[owner],'The captured Renderer loaded its original menu owner: '+owner)
  const html=join(out,'index.html');await writeFile(html,'<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="./app.css"><div id="root"></div><script type="module" src="./app.js"></script></html>')
  receipt.compiled={renderer:hash(await readFile(join(out,'app.js'))),css:hash(await readFile(join(out,'app.css')))}
  const env={...process.env,AGENTMUX_DESKTOP_USER_DATA:join(privateRoot,'user-data'),AGENTMUX_RUNTIME_DIRECTORY:join(privateRoot,'runtime'),AGENTMUX_STATE_DIRECTORY:join(privateRoot,'state')};delete env.ELECTRON_RUN_AS_NODE
  receipt.process=await runProbeProcess(require('electron'),[join(fixture,'main.cjs'),html,privateRoot,evidence],{temporaryRoot:privateRoot,cwd:root,env,timeoutMs:60000,onLine:line=>logs.push(line)})
  receipt.actual=JSON.parse(await readFile(join(evidence,'actual.json'),'utf8'))
  receipt.frames=await Promise.all(receipt.actual.frames.map(async frame=>({...frame,sha256:hash(await readFile(join(evidence,frame.file)))})))
  assert.equal(receipt.process.exitCode,0,receipt.actual.failure?.message);assert.equal(receipt.actual.passed,true)
  assert.deepEqual(receipt.frames.map(frame=>frame.file).sort(),[...requiredFrames].sort(),'Original five frames plus bounded parity/identity/action review frames')
  receipt.sourceAfter=Object.fromEntries(await Promise.all([...inputs.keys()].map(async path=>[relative(root,path),hash(await readFile(path))])))
  receipt.parallelInputChanges=Object.keys(receipt.inputs).filter(path=>receipt.sourceAfter[path]!==receipt.inputs[path])
  for(const[name,sha256]of Object.entries(receipt.menuDependencies))assert.equal(receipt.sourceAfter[name],sha256,'The actual loaded menu dependency remains stable: '+name)
  assert.deepEqual(await menuOwnerHashes(),receipt.menuOwnerSources,'The exact Focus menu candidate remains unchanged')
  for(const driver of Object.values(receipt.drivers))assert.equal(hash(await readFile(join(root,driver.path))),driver.sha256,'The actual scene driver remains unchanged')
  receipt.capturedPass=true
}catch(error){receipt.failure={name:error.name,message:error.message,stack:error.stack};process.exitCode=1}
finally{
  await writeFile(join(evidence,'process.log'),logs.join('\n'))
  receipt.cleanup={privateRoot,remaining:null,removed:false,evidencePreserved:true,compiledBytesPreserved:false}
  try{receipt.cleanup.remaining=await listProbeProcesses(-1,privateRoot)}catch(error){receipt.cleanup.error={name:error.name,message:error.message,signal:error.signal??null};receipt.capturedPass=false;receipt.failure??={name:'Error',message:'Owned probe cleanup is unconfirmed; its private root is retained.'};process.exitCode=1}
  if(receipt.cleanup.remaining?.length===0){await rm(privateRoot,{recursive:true});receipt.cleanup.removed=true}
  await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({capturedPass:receipt.capturedPass,evidence,failure:receipt.failure?.message,pendingIndependentVisualReview:true}))
}
