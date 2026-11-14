import { browserSourceBuild } from '../../../packages/browser/scripts/source-build.mjs'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {existsSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve,relative} from 'node:path'
import {pathToFileURL} from 'node:url'
import {runProbeProcess,listProbeProcesses} from './probe-process.mjs'

const root=resolve(import.meta.dirname,'../../..'),desktop=join(root,'apps/desktop')
assert.ok(process.argv[2]==='--evidence'&&process.argv[3]&&(process.argv.length===4||process.argv.length===5&&['--primary-only','--member-state','--unconfirmed','--source-recovery','--source-connection','--takeover-feedback'].includes(process.argv[4])),'Use --evidence <private evidence directory> [--primary-only|--member-state|--unconfirmed|--source-recovery|--source-connection|--takeover-feedback]')
const sourceConnection=process.argv[4]==='--source-connection'
const takeoverFeedback=process.argv[4]==='--takeover-feedback',sourceRecovery=process.argv[4]==='--source-recovery',primaryOnly=process.argv[4]==='--primary-only',memberState=process.argv[4]==='--member-state',unconfirmed=process.argv[4]==='--unconfirmed'||sourceRecovery
const sourceOnly=sourceRecovery||takeoverFeedback||sourceConnection
const evidence=resolve(process.argv[3]);await mkdir(evidence,{recursive:true})
const privateRoot=await mkdtemp(join(tmpdir(),'amux-focus-source-unification-')),fixture=join(desktop,'scripts/fixtures/focus-source-unification'),mainFixture=join(fixture,'main.cjs')
const require=createRequire(join(desktop,'package.json')), {build}=browserSourceBuild(createRequire(require.resolve('vite/package.json'))('esbuild'))
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),inputs=new Map(),transformations=[],logs=[]
const receipt={schema:'agentmux.focus-source-unification-scene.v1',framePolicy:sourceConnection?'source-connection':takeoverFeedback?'takeover-feedback':sourceRecovery?'source-recovery':unconfirmed?'unconfirmed-source':memberState?'source-member-state':primaryOnly?'source-primary-only':'all-scenes',capturedPass:false,captureOnly:true,aestheticReview:'not-performed',userAppRunRuntimeControlled:false,
  boundary:'Light Renderer-only actual App/Focus/Workbench/Stable/Store and installed Panel browser primary. Maintained typed preview API; only SessionPane PTY/Agent paint and unused Monaco painting leaves isolated. No Runtime/native simultaneous presentation, Writer, ordinary restart or user installation.'}
try{
  if(takeoverFeedback)receipt.boundary='Actual App, ordinary Focus card, Region header, operation feedback, cancellation parser, existing Stop confirmation and Store persist/checkpoint/rehydration. Typed preview original-owner IO and Core graph observation, recorded writer admission after hydration, and PTY painting only. No user App/Run, Native writer durability, Core fencing or Provider recovery claim.'
  let reader=join(root,'packages/core/dist/conversation-reader.js')
  if(sourceOnly){
    reader=join(privateRoot,'conversation-reader.mjs')
    const sourceReader=await build({absWorkingDir:root,entryPoints:[join(root,'packages/core/src/conversation-reader.ts')],outfile:reader,bundle:true,platform:'node',format:'esm',target:'node22',metafile:true,logLevel:'silent',banner:{js:"import{createRequire as recoveryRequire}from'node:module';const require=recoveryRequire(import.meta.url);"}})
    for(const file of Object.keys(sourceReader.metafile.inputs)){const path=resolve(root,file);if(!path.includes('/node_modules/'))inputs.set(path,hash(await readFile(path)))}
    receipt.readerPolicy='Current Core bounded reader and current Desktop product sources; unchanged installed dependencies are pinned by the loaded bundle.'
  }else{
    const freshness=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',`const {assertWorkspaceDistBuiltFromCurrentSource}=await import(${JSON.stringify(pathToFileURL(join(root,'vitest.dist-freshness.ts')).href)});await assertWorkspaceDistBuiltFromCurrentSource(${JSON.stringify(root)});`],{cwd:root,encoding:'utf8'})
    await writeFile(join(evidence,'freshness.log'),freshness.stdout+freshness.stderr);assert.equal(freshness.status,0,'Original public freshness guard')
  }
  const { ConversationReaderState, readAgentConversation } = await import(pathToFileURL(reader))
  const originalConversationState = new ConversationReaderState(), foreignBody='远端原始核查记录已返回，继续核对原设备上的分析结果。', foreignInput='请核对原设备上的分析数据，并保留这条原始输入。', sid='working', nativeSource={providerId:'codex',nativeSessionId:'original-foreign-native'}
  let originalConversationPage
  try { originalConversationPage=await readAgentConversation({hostId:'local',agentSessionId:sid,limit:3,maxBytes:65536,processDetails:'deferred'}, {
    state:originalConversationState,descriptor:{hostId:'local',agentSessionId:sid,state:'active',history:{providerId:'codex',nativeHandle:{kind:'provider',providerId:'codex',sessionId:nativeSource.nativeSessionId}}},
    captured:async()=>{throw Object.assign(Error('No captured source'),{code:'AGENT_CONVERSATION_SOURCE_UNAVAILABLE'})},nativeCheckpoint:async()=>({agentSessionId:sid,source:nativeSource,cursor:'0'}),
    nativePage:async()=>({agentSessionId:sid,source:nativeSource,items:[{id:'original-request',kind:'user-message',contentParts:[{kind:'text',text:foreignInput}],startedAt:Date.now()-2000},{id:'original-response',kind:'assistant-message',contentParts:[{kind:'text',text:foreignBody}],startedAt:Date.now()-1000}],nextCursor:null}),
    nativeChanges:async()=>{throw Error('Unused source continuation')},nativeRecord:async()=>{throw Error('Unused source record')}
  }) } finally { originalConversationState.dispose() }
  assert.equal(originalConversationPage.window.complete,true);assert.ok(originalConversationPage.items.length>0)
  receipt.previewConversation={owner:'Actual Core bounded reader with controlled native leaf',sha256:hash(JSON.stringify(originalConversationPage)),complete:true,items:originalConversationPage.items.length}
  const coreExports=sourceOnly?JSON.parse(await readFile(join(root,'packages/core/package.json'),'utf8')).exports:{}
  const observe={name:'actual-app-focus-source-and-paint-leaf',setup(builder){
    if(sourceOnly)builder.onResolve({filter:/^@agentmux\/core(?:\/|$)/},args=>{
      const key=args.path==='@agentmux/core'?'.':'.'+args.path.slice('@agentmux/core'.length)
      const match=Object.keys(coreExports).find(entry=>entry===key||entry.includes('*')&&key.startsWith(entry.split('*')[0])&&key.endsWith(entry.split('*')[1]))
      assert.ok(match,'Declared original Core export '+key)
      const declaration=coreExports[match],target=typeof declaration==='string'?declaration:declaration.browser??declaration.import
      const suffix=match.includes('*')?key.slice(match.split('*')[0].length,key.length-match.split('*')[1].length):''
      const path=join(root,'packages/core',target.replace('*',suffix).replace('./dist/','./src/').replace(/\.js$/,'.ts'))
      assert.ok(existsSync(path),'Current original Core source '+key)
      return{path}
    })
    builder.onResolve({filter:/\?url$/},args=>({path:createRequire(args.importer).resolve(args.path.slice(0,-4)),namespace:'actual-url'}))
    builder.onLoad({filter:/.*/,namespace:'actual-url'},async args=>{const bytes=await readFile(args.path),name='asset-'+hash(bytes).slice(0,12)+'.mjs';await writeFile(join(privateRoot,'out',name),bytes);return{contents:`export default new URL('./${name}',import.meta.url).href`,loader:'js'}})
    builder.onResolve({filter:/\?worker$/},args=>({path:createRequire(args.importer).resolve(args.path.slice(0,-7)),namespace:'actual-worker'}))
    builder.onLoad({filter:/.*/,namespace:'actual-worker'},async args=>{
      const name='worker-'+hash(args.path).slice(0,12)+'.js'
      await build({absWorkingDir:root,entryPoints:[args.path],outfile:join(privateRoot,'out',name),bundle:true,format:'esm',platform:'browser',target:'esnext',logLevel:'silent'})
      return{contents:`export default class extends Worker {constructor(options){super(new URL('./${name}',import.meta.url),{...options,type:'module'})}}`,loader:'js'}
    })
    builder.onLoad({filter:/\.[cm]?[jt]sx?$/},async({path})=>{
    if(!path.startsWith(root+'/')||path.includes('/node_modules/'))return
    const source=await readFile(path,'utf8');inputs.set(path,hash(source));const component=path.slice(path.lastIndexOf('/')+1)
    if(takeoverFeedback&&component==='store.ts'){
      const original='return coreSpatialPersistence?.current?.graph ?? null'
      assert.ok(source.includes(original),'Original Core observation read')
      const code=source.replace(original,'return globalThis.__feedbackSpatialGraph ?? null')+'\n;globalThis.__feedbackAdmitWriter=()=>openPersistWrites();'
      transformations.push({path:relative(root,path),isolated:'Capture admits the real local user-document writer after hydration; only the Core spatial read leaf is controlled. Original serializer, merge, checkpoint and all operation/navigation logic remain loaded.',sourceSHA256:hash(source),loadedSHA256:hash(code)})
      return{contents:code,loader:'ts'}
    }
    if(component==='SessionPane.tsx'){
      let code=`import {createElement as h,useEffect} from 'react';import{useAppStore}from ${JSON.stringify(join(desktop,'src/renderer/src/store.ts'))};export function SessionPane({sessionId,linkOrigin}){const key=linkOrigin.tabId+'/'+linkOrigin.regionId;useEffect(()=>{window.presentationLeaves.mounts.push(key);return()=>window.presentationLeaves.unmounts.push(key)},[key]);const draft=useAppStore(s=>s.agentComposerDrafts[sessionId]??'');return h('section',{'data-fixture-session':sessionId,'data-owner-tab':linkOrigin.tabId,'data-owner-region':linkOrigin.regionId,style:{display:'flex',flexDirection:'column',height:'100%',minHeight:0,padding:'16px',gap:'12px'}},h('small',{style:{color:'var(--text-muted)'}},'Isolated PTY painting · '+linkOrigin.regionId),h('strong',null,'Original Agent work surface'),h('textarea',{'aria-label':'Original draft '+key,value:draft,readOnly:true,style:{width:'100%',flex:1,minHeight:'80px',resize:'none'}}))}`
      if(takeoverFeedback){
        code=code.replace("import{useAppStore}","import{AgentRegionHeader}from "+JSON.stringify(join(desktop,'src/renderer/src/components/AgentRegionHeader.tsx'))+";import{regionExecutionHost}from "+JSON.stringify(join(desktop,'src/renderer/src/lib/region-execution-host.ts'))+";import{useAppStore}")
        code=code.replace("h('small',{style:{color:'var(--text-muted)'}},'Isolated PTY painting · '+linkOrigin.regionId)","h(AgentRegionHeader,{name:useAppStore.getState().agentNames[sessionId]??sessionId,executorLabel:'Codex',sessionId,sessionKind:'agent',executionHost:regionExecutionHost(useAppStore.getState().sessions.find(s=>s.id===sessionId)),regionId:linkOrigin.regionId,readOnly:false,onHistory:undefined})")
      }
      transformations.push({path:relative(root,path),isolated:'PTY/Agent painting only',sourceSHA256:hash(source),loadedSHA256:hash(code)})
      return{contents:code,loader:'js'}
    }
    if(component==='TerminalView.tsx'){
      const code=`import {createElement as h} from 'react';export function TerminalView({session}){return h('pre',{'data-fixture-source-terminal':session.id,style:{padding:'16px',fontFamily:'monospace',fontSize:'12px',lineHeight:1.6,whiteSpace:'pre-wrap'}},'Codex\\n\\n> 继续核查原设备上的分析结果\\n\\n原终端内容与输入保持在这个工作面。')}`
      transformations.push({path:relative(root,path),isolated:'Source terminal Native painting only; actual workface, Composer and source target retained',sourceSHA256:hash(source),loadedSHA256:hash(code)})
      return{contents:code,loader:'js'}
    }
    if(component==='EditorPane.tsx'||component==='GitBranchDiffPane.tsx'){
      const code=`export function ${component.slice(0,-4)}(){return null}`
      transformations.push({path:relative(root,path),isolated:'Unused Monaco painting; no file Region in this scene',sourceSHA256:hash(source),loadedSHA256:hash(code)})
      return{contents:code,loader:'js'}
    }
    return{contents:source,loader:path.endsWith('tsx')?'tsx':path.endsWith('ts')?'ts':'js'}
  });builder.onLoad({filter:/\.css$/},async({path})=>{if(!path.startsWith(root+'/')||path.includes('/node_modules/'))return;const source=await readFile(path,'utf8');inputs.set(path,hash(source));return{contents:source,loader:'css'}})}}
  for(const file of ['main.cjs','entry.mjs',...(takeoverFeedback?['feedback.mjs','feedback-main.cjs']:[]),...(sourceConnection?['connection.mjs','connection-main.cjs']:[])])inputs.set(join(fixture,file),hash(await readFile(join(fixture,file))))
  inputs.set(mainFixture,hash(await readFile(mainFixture)))
  inputs.set(new URL(import.meta.url).pathname,hash(await readFile(new URL(import.meta.url))))
  const out=join(privateRoot,'out');await mkdir(out)
  const renderer=join(out,'app.js')
  const buildResult=await build({entryPoints:[join(fixture,'entry.mjs')],outfile:renderer,bundle:true,platform:'browser',format:'esm',conditions:['production'],target:'es2022',jsx:'automatic',metafile:true,plugins:[observe],logLevel:'silent',
    define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},loader:{'.avif':'file','.gif':'file','.png':'file','.svg':'file','.woff2':'file','.woff':'file','.ttf':'file'}})
  receipt.metafile={inputCount:Object.keys(buildResult.metafile.inputs).length,outputs:Object.fromEntries(Object.entries(buildResult.metafile.outputs).map(([name,value])=>[relative(privateRoot,resolve(root,name)),{bytes:value.bytes}])),sha256:hash(JSON.stringify(buildResult.metafile))};receipt.inputs=Object.fromEntries([...inputs].map(([path,sha])=>[relative(root,path),sha]));receipt.transformations=transformations
  for(const suffix of ['App.tsx','GlobalFocusSurface.tsx','WorkspaceWorkbench.tsx','StableWorkbenchView.tsx','store.ts','focus-tab-projection.ts','agent-focus.ts'])assert.ok([...inputs.keys()].some(path=>path.endsWith('/'+suffix)),'Actual loaded '+suffix)
  if(takeoverFeedback)for(const suffix of ['AgentOperationFeedback.tsx','AgentRegionHeader.tsx','session-takeover-cancellation.ts','agent-operation.ts'])assert.ok([...inputs.keys()].some(path=>path.endsWith('/'+suffix)),'Actual cancellation consumer loaded '+suffix)
  if(sourceRecovery)for(const suffix of ['FocusContextMenu.tsx','AgentMenuContent.tsx','AgentInformationReader.tsx','use-focus-sources.tsx'])assert.ok([...inputs.keys()].some(path=>path.endsWith('/'+suffix)),'Actual recovery consumer loaded '+suffix)
  const html=join(out,'index.html');await writeFile(html,'<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="./app.css"><div id="root"></div><script>window.__sourceConnectionScene='+JSON.stringify(sourceConnection)+';window.__takeoverFeedbackScene='+JSON.stringify(takeoverFeedback)+';window.__unconfirmedScene='+JSON.stringify(unconfirmed)+';window.__memberStateScene='+JSON.stringify(memberState)+';window.__originalForeignConversation='+JSON.stringify(originalConversationPage)+';window.__originalForeignBody='+JSON.stringify(foreignBody)+';window.__originalForeignInput='+JSON.stringify(foreignInput)+'</script><script type="module" src="./app.js"></script></html>')
  receipt.compiled={renderer:hash(await readFile(renderer)),css:hash(await readFile(join(out,'app.css')))}
  const env={...process.env,AGENTMUX_DESKTOP_USER_DATA:join(privateRoot,'user-data'),AGENTMUX_RUNTIME_DIRECTORY:join(privateRoot,'runtime'),AGENTMUX_STATE_DIRECTORY:join(privateRoot,'state')};delete env.ELECTRON_RUN_AS_NODE
  receipt.process=await runProbeProcess(require('electron'),[mainFixture,html,privateRoot,evidence,...(sourceConnection?['--source-connection']:takeoverFeedback?['--takeover-feedback']:sourceRecovery?['--source-recovery']:unconfirmed?['--unconfirmed']:memberState?['--member-state']:primaryOnly?['--primary-only']:[])],{temporaryRoot:privateRoot,cwd:root,env,timeoutMs:60000,onLine:line=>logs.push(line)})
  receipt.actual=JSON.parse(await readFile(join(evidence,'actual.json'),'utf8'))
  assert.equal(receipt.process.exitCode,0,receipt.actual.failure?.message);assert.equal(receipt.actual.passed,true)
  if(takeoverFeedback){
    const saved=JSON.parse(await readFile(join(privateRoot,'original-consumer-state.json'),'utf8'))
    const restoredHtml=join(out,'restored.html');await writeFile(restoredHtml,(await readFile(html,'utf8')).replace('<script>','<script>window.__feedbackRestoreSerialized='+JSON.stringify(saved.serialized)+';'))
    const restoredEvidence=join(evidence,'restored');await mkdir(restoredEvidence,{recursive:true})
    receipt.restoreProcess=await runProbeProcess(require('electron'),[mainFixture,restoredHtml,privateRoot,restoredEvidence,'--takeover-feedback-restore'],{temporaryRoot:privateRoot,cwd:root,env,timeoutMs:60000,onLine:line=>logs.push(line)})
    const restored=JSON.parse(await readFile(join(restoredEvidence,'actual.json'),'utf8'))
    assert.equal(receipt.restoreProcess.exitCode,0,restored.failure?.message);assert.equal(restored.restoration.passed,true)
    receipt.restoration=restored.restoration;receipt.actual.frames.push(...restored.frames.map(frame=>({...frame,file:'restored/'+frame.file})))
  }
  receipt.frames=await Promise.all(receipt.actual.frames.map(async frame=>({...frame,sha256:hash(await readFile(join(evidence,frame.file)))})))
  assert.ok(sourceConnection?receipt.frames.length>=6:takeoverFeedback?receipt.frames.length>=12:sourceRecovery?receipt.frames.length>=9:unconfirmed?receipt.frames.length===4:memberState?receipt.frames.length>=6:primaryOnly?receipt.frames.length===1&&receipt.frames[0].file==='unified-focus-source-primary.png':receipt.frames.length>=6,'Requested actual ordinary Focus scenes')
  receipt.sourceAfter=Object.fromEntries(await Promise.all([...inputs.keys()].map(async path=>[relative(root,path),hash(await readFile(path))])))
  receipt.unrelatedSourceDrift=Object.keys(receipt.inputs).filter(path=>receipt.sourceAfter[path]!==receipt.inputs[path])
  const relevant=takeoverFeedback?Object.keys(receipt.inputs).filter(path=>/AgentOperationFeedback|AgentRegionHeader|session-takeover|agent-operation|focus-source-unification/.test(path)):Object.keys(receipt.inputs)
  for(const path of relevant)assert.equal(receipt.sourceAfter[path],receipt.inputs[path],'Current relevant visual candidate remains stable '+path)
  receipt.capturedPass=true
}catch(error){receipt.failure={name:error.name,message:error.message,stack:error.stack};process.exitCode=1}
finally{
  await writeFile(join(evidence,'process.log'),logs.join('\n'))
  const remaining=await listProbeProcesses(-1,privateRoot);receipt.cleanup={privateRoot,remaining,removed:false,evidencePreserved:true}
  if(!remaining.length){await rm(privateRoot,{recursive:true});receipt.cleanup.removed=true}
  await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')
  console.log(JSON.stringify({capturedPass:receipt.capturedPass,evidence,failure:receipt.failure?.message,pendingIndependentVisualReview:true}))
}
