import { test } from 'vitest'
import assert from 'node:assert/strict'
import { app, BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createWorkspaceLayout, createWorkbenchViewLayout } from '@agentmux/layout'
import { sourceFolderFixture } from '../../../packages/core/test/helpers/space-folder-directory-fixture.ts'
import { readSpaceSnapshot } from '../../../packages/core/src/space-authority-stream.ts'
import { stopProbeProcesses } from './probe-process.mjs'
import { sourceAliases } from './fixtures/launcher-launchpad/vitest.owning.config.mts'
import { radixOverlayAliases } from '../../../packages/client-ui/scripts/radix-overlay-aliases.ts'

async function freePort(){const server=createServer();await new Promise<void>((done,fail)=>server.listen(0,'127.0.0.1',done).once('error',fail));const address=server.address();if(!address||typeof address==='string')throw Error('No debugger port');const port=address.port;await new Promise<void>(done=>server.close(()=>done()));return port}

const root=resolve(import.meta.dirname,'../../..'),fixture=resolve(import.meta.dirname,'fixtures/source-space-navigation'),evidence=resolve(root,'../..','.local/state/source-space-navigation/T021/visibility')
const require=createRequire(join(root,'apps/desktop/package.json')),cleanup=[],temporary=await mkdtemp(join(root,'.tmp','source-nav-visibility-'))
await mkdir(evidence,{recursive:true})
const close=async()=>{for(const dispose of cleanup.splice(0).reverse())await dispose()}
test('Source workbench is visible in its original Zone with no Mounted or sibling destination',async()=>{try{
  const source=await sourceFolderFixture(cleanup),observed=await source.rpc.call('space.folder.inspect',{runtimeId:source.source.runtimeId,path:source.directory})
  const first=await source.rpc.call('space.folder.register',{runtimeId:source.source.runtimeId,directory:observed.resource}),secondPath=join(source.root,'second-folder')
  await (await import('node:fs/promises')).mkdir(secondPath)
  const second=await source.spatial.registerDirectory({runtimeId:source.source.runtimeId,directory:{hostId:'local',workspacePath:secondPath,projectRootPath:source.directory,witness:{realPath:secondPath,device:'controlled',inode:'controlled'}}},async()=>[],async()=>{})
  const before=(await source.spatial.read()).graph,graph=structuredClone(before)
  graph.tabs.push({tabId:'first-zone-tab',zoneId:first.zoneId,workspaceId:first.workspaceId,name:'First Zone work',regionIds:['first-zone-region']})
  graph.regions.push({regionId:'first-zone-region',tabId:'first-zone-tab',kind:'launcher',agentSessionId:null,runId:null,execution:{hostId:'local',cwd:source.directory,runtimeId:source.source.runtimeId}})
  graph.tabs.push({tabId:'second-zone-tab',zoneId:second.zoneId,workspaceId:second.workspaceId,name:'Second Zone work',regionIds:['second-zone-region']})
  graph.regions.push({regionId:'second-zone-region',tabId:'second-zone-tab',kind:'launcher',agentSessionId:null,runId:null,execution:{hostId:'local',cwd:secondPath,runtimeId:source.source.runtimeId}})
  for(const tabId of ['first-zone-tab','second-zone-tab'])graph.resources[`tab:${tabId}`]={}
  for(const regionId of ['first-zone-region','second-zone-region'])graph.resources[`region:${regionId}`]={}
  graph.layouts[first.workspaceId]=createWorkspaceLayout('first-zone-group',['first-zone-tab']);graph.tabLayouts['first-zone-tab']=createWorkbenchViewLayout('first-zone-region')
  graph.layouts[second.workspaceId]=createWorkspaceLayout('second-zone-group',['second-zone-tab']);graph.tabLayouts['second-zone-tab']=createWorkbenchViewLayout('second-zone-region')
  const committed=await source.spatial.commit({expectedRevision:(await source.spatial.read()).revision,graph})
  const target={hostId:'local',reference:first.reference,zoneId:first.zoneId,workspaceId:first.workspaceId},snapshot=await readSpaceSnapshot(source.rpc,first.reference)
  const built=resolve(temporary,'renderer')
  const {build}=await import(require.resolve('vite'))
  await build({configFile:false,root:fixture,base:'./',logLevel:'error',resolve:{alias:[...Object.entries(radixOverlayAliases).map(([find,replacement])=>({find,replacement})),...sourceAliases],dedupe:['react','react-dom']},define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"development"'},esbuild:{jsx:'automatic',jsxDev:true,jsxImportSource:'react'},worker:{format:'es'},build:{outDir:built,emptyOutDir:true}})
  const debugPort=await freePort(),env={...process.env,SOURCE_NAVIGATION_FACTS:JSON.stringify({target,snapshot}),SOURCE_NAVIGATION_RENDERER:join(built,'index.html'),SOURCE_NAV_DEBUG_PORT:String(debugPort),ELECTRON_RUN_AS_NODE:undefined}
  const child=spawn(require('electron'),[join(fixture,'main.mjs'),`--remote-debugging-port=${debugPort}`,'--remote-debugging-address=127.0.0.1'],{cwd:root,env,detached:true,stdio:['ignore','ignore','pipe']});cleanup.push(()=>stopProbeProcesses(child.pid,temporary))
  let stderr='';child.stderr.on('data',value=>{stderr=(stderr+String(value)).slice(-4000)})
  const rendererTarget=await (async()=>{const deadline=Date.now()+30000;while(Date.now()<deadline){try{const pages=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`,{signal:AbortSignal.timeout(3000)})).json();const target=pages.find(page=>page.type==='page'&&page.url.startsWith('file:'));if(target)return target}catch{}await new Promise(resolve=>setTimeout(resolve,80))}throw Error('Electron debugger timeout')})()
  const socket=new WebSocket(rendererTarget.webSocketDebuggerUrl);await new Promise((done,fail)=>{socket.addEventListener('open',done,{once:true});socket.addEventListener('error',fail,{once:true})})
  let serial=0;const pending=new Map(),runtimeErrors=[];socket.addEventListener('message',({data})=>{const message=JSON.parse(String(data));if(message.method==='Runtime.exceptionThrown'||message.method==='Log.entryAdded'){runtimeErrors.push(message.params);return}const request=pending.get(message.id);if(!request)return;pending.delete(message.id);if(message.error)request.reject(Error(message.error.message));else request.resolve(message.result)})
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}))})
  const evaluate=async expression=>{const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.text);return result.result.value}
  await call('Runtime.enable');await call('Log.enable');await call('Emulation.setFocusEmulationEnabled',{enabled:true})
  const deadline=Date.now()+30000
  let observedState
  while(Date.now()<deadline){observedState=await evaluate(`(()=>{const first=document.querySelector('[data-workbench-tab-id="first-zone-tab"]'),second=document.querySelector('[data-workbench-tab-id="second-zone-tab"]'),region=document.querySelector('[data-workbench-region-id="first-zone-region"]');const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&!e.closest('[inert],[aria-hidden="true"]')};return{first:visible(first),second:Boolean(second),region:visible(region),text:document.body.innerText.slice(0,500),html:document.documentElement.outerHTML.slice(0,2000),scripts:[...document.scripts].map(s=>s.src)}})()`);if(observedState.first&&observedState.region&&!observedState.second)break;await new Promise(resolve=>setTimeout(resolve,80))}
  console.error('SOURCE_VISIBILITY',JSON.stringify({...observedState,runtimeErrors}))
  const screenshot=await call('Page.captureScreenshot',{format:'png'});await writeFile(join(evidence,'source-workbench.png'),Buffer.from(screenshot.data,'base64'))
  await writeFile(join(evidence,'observed.json'),JSON.stringify(observedState,null,2)+'\n')
  assert.ok(observedState?.first,'First Source Tab must be visible, not retained parking')
  assert.ok(observedState.region,'First Source Region must have visible geometry and no inert ancestor')
  assert.equal(observedState.second,false,'Sibling Zone must not enter the selected workface')
  await writeFile(join(evidence,'receipt.json'),JSON.stringify({schema:'agentmux.source-space-navigation-visibility.v1',passed:true,captureOnly:false,independentVisualReview:false,observed:observedState},null,2)+'\n')
  socket.close()
  console.log(JSON.stringify({passed:true,evidence}))
}catch(error){await writeFile(join(evidence,'failure.json'),JSON.stringify({passed:false,message:error.stack},null,2)+'\n');process.exitCode=1;console.error(error)}finally{await close();await rm(temporary,{recursive:true,force:true})}})
