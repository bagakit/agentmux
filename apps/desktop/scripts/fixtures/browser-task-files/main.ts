import assert from 'node:assert/strict'
import { app, BrowserWindow, ipcMain } from 'electron'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { AgentMuxControlServer, LocalExecutionHost } from '@agentmux/core'
import { DESKTOP_BROWSER_DIALOG_TYPES } from '../../../src/main/browser-cdp-session'
import { BrowserViewManager } from '../../../src/main/browser-view-manager'
import { BrowserTaskAssets, BrowserTaskAssetFileStore } from '../../../src/main/browser-task-assets'
import { BrowserRefLedgerStore } from '@agentmux/browser/operations'
import { BrowserOperationJournal, BrowserOperationFileStore } from '@agentmux/browser/operations'
import { BrowserUploads } from '../../../src/main/browser-uploads'
import { BrowserDownloads } from '../../../src/main/browser-downloads'
import { WorkspaceFiles } from '../../../src/main/workspace-files'
import { executeBrowserTaskControl } from '../../../src/main/browser-task-control'
import { importTaskRecording } from '../../../test/helpers/import-task-recording'
import type { BrowserTaskContent } from '../../../src/shared/browser-task-assets'

const home=process.env.TASK_FILES_HOME!,out=process.env.TASK_FILES_OUT!,repo=process.env.TASK_FILES_REPO!,node=process.env.TASK_FILES_NODE!,phase=process.env.TASK_FILES_PHASE!
const browserId='original-files',privateAnswer='private-native-answer',payload=Buffer.from([2,4,6,8,0])
const report:any={passed:false,cases:[],captures:[],boundary:'Private actual Electron Main/TaskAssets/Workspace owners and production Editor/theme; no installed App, user Profile, Agent or Run is used. Recording source is a nonempty Main fixture of a trigger only, not a captured human dialog answer.'}
app.on('window-all-closed',()=>{})
let pageWindow:BrowserWindow|undefined,editorWindow:BrowserWindow|undefined,manager:BrowserViewManager|undefined,control:AgentMuxControlServer|undefined,http:ReturnType<typeof createServer>|undefined
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(check:()=>Promise<boolean>,label:string){const end=performance.now()+20000;while(!await check()){if(performance.now()>end)throw Error('Native observation unavailable: '+label);await pause(25)}}
async function cli(args:string[],input=''){
 console.error('files-proof:cli',args[0])
 const result=await new Promise<any>((resolve,reject)=>{const child=spawn(node,[join(repo,'packages/core/bin/amux'),'--endpoint','unix:'+join(home,'control.sock'),'browser','task',...args],{env:{...process.env,ELECTRON_RUN_AS_NODE:undefined},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(Error('Private compiled task CLI observation unavailable: '+args[0]))},args[0]==='run'?150000:20000);child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.once('error',reject);child.once('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr})});child.stdin.end(input)})
 assert.equal(result.code,0,result.stderr+' '+result.stdout);return JSON.parse(result.stdout).result
}
async function captureEditor(initial:any,dialogTypes:any,ports:{save(asset:any,draft:any):Promise<any>;publish(asset:any,draft:any):Promise<any>;run(asset:any,input:any):Promise<any>}){
 let current=initial
 ipcMain.handle('task-files:initial',()=>({asset:current,dialogTypes:dialogTypes}))
 ipcMain.handle('task-files:save',async(_event,draft)=>current=await ports.save(current,draft))
 ipcMain.handle('task-files:publish',async(_event,draft)=>current=await ports.publish(current,draft))
 ipcMain.handle('task-files:run',(_event,input)=>ports.run(current,input))
 editorWindow=new BrowserWindow({show:false,width:620,height:1250,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false,preload:join(out,'preload.cjs')}})
 await editorWindow.loadFile(join(out,'renderer/index.html'));editorWindow.showInactive();await until(()=>editorWindow!.webContents.executeJavaScript('!!document.querySelector("[data-task-asset-id]")'),'production Editor')
 for(const appearance of ['dark','light'])for(const width of [620,390]){editorWindow.setSize(width,1250);await editorWindow.webContents.executeJavaScript(`taskFilesAppearance(${JSON.stringify(appearance)});scrollTo(0,0);new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);const overflow=await editorWindow.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.browser-task-asset input,.browser-task-asset select')).filter(element=>{const box=element.getBoundingClientRect();return box.width>0&&(box.right>innerWidth+1||box.left<0)}).map(element=>element.getAttribute('aria-label'))`);assert.deepEqual(overflow,[],'Actual controls fit their visible width');const file='task-files-'+appearance+'-'+width+'.png';await writeFile(join(out,file),(await editorWindow.webContents.capturePage()).toPNG());report.captures.push(file)}
 return current
}
async function run(){
 await app.whenReady();app.setActivationPolicy?.('prohibited');console.error('files-proof:ready',phase)
 const workspace={id:'workspace-files',name:'Files',hostId:'local',path:join(home,'workspace'),kind:'folder' as const};await mkdir(workspace.path,{recursive:true});await mkdir(join(workspace.path,'outputs'),{recursive:true})
 const assets=new BrowserTaskAssets(new BrowserTaskAssetFileStore(join(home,'assets.json'))),files=new WorkspaceFiles(()=>new LocalExecutionHost()),downloads=new BrowserDownloads(join(home,'downloads'),files,()=>workspace)
 if(phase==='ui-only'){
  const initial=(await assets.state(browserId)).assets[0];assert.ok(initial)
  await captureEditor(initial,DESKTOP_BROWSER_DIALOG_TYPES,{save:(asset,draft)=>assets.edit(asset.id,asset.revision,draft),publish:async(asset,draft)=>{const saved=await assets.edit(asset.id,asset.revision,draft);return assets.saveVersion(saved.id,saved.revision)},run:async()=>{throw Error('This isolated visual fixture has no page execution owner')}})
  report.boundary='UI-only copy of the original validated asset bytes through the same asset owner, production Editor and theme. No native task, transfer, Runtime or restart is replayed.'
  report.cases.push({label:'seeded-production-editor-widths',passed:true});report.passed=true;return
 }
 if(phase==='restart'){
  const saved=JSON.parse(await readFile(join(home,'descriptor.json'),'utf8')),state=await assets.state(browserId),asset=state.assets.find(a=>a.id===saved.assetId)!
  assert.equal(asset.id,saved.assetId);assert.deepEqual(asset.versions,saved.versions);assert.deepEqual(state.runs.map(r=>({id:r.id,status:r.status,nextStep:r.nextStep,operationIds:r.operationIds})),saved.runs)
  const receipts=await downloads.list({workspaceId:workspace.id,browserId});assert.equal(receipts.filter(r=>r.status==='completed').length,saved.downloadCount)
  const bytes=await downloads.read(saved.reference,{workspaceId:workspace.id,browserId});assert.deepEqual(Buffer.from(bytes.data,'base64'),payload)
  report.cases.push({label:'separate-process-original-asset-cursor-and-readable-file',passed:true});report.passed=true;return
 }
 await writeFile(join(workspace.path,'source.bin'),Buffer.from([1,3,5]))
 const html=`<!doctype html><style>body{font:16px system-ui;padding:24px}input,button,a{display:block;margin:18px;padding:12px}</style><input id="files" type="file" aria-label="Files"><button id="confirm" aria-label="Confirm">Confirm</button><button id="prompt" aria-label="Prompt">Prompt</button><a href="/download" download aria-label="Download">Download</a><input aria-label="Draft" value="original draft"><button aria-label="Activate">Activate</button><a href="/after" aria-label="Leave">Leave</a><script>globalThis.proof={confirmCalls:0,confirmed:0,promptCalls:0,promptMatched:false};document.querySelector('#confirm').onclick=()=>{proof.confirmCalls++;if(window.confirm('Page-authored request'))proof.confirmed++};document.querySelector('#prompt').onclick=()=>{proof.promptCalls++;proof.promptMatched=window.prompt('Page-authored request')===${JSON.stringify(privateAnswer)}};</script>`
 let requests=0
 http=createServer((req,res)=>{if(req.url==='/download'){requests++;res.writeHead(200,{'content-type':'application/octet-stream','content-disposition':'attachment; filename="result.bin"'});res.end(payload)}else{res.writeHead(200,{'content-type':'text/html'});res.end(html)}})
 await new Promise<void>(resolve=>http!.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+(http.address() as any).port+'/form'
 pageWindow=new BrowserWindow({show:false,width:960,height:760,webPreferences:{backgroundThrottling:false}})
 const uploads=new BrowserUploads(join(home,'uploads'),files,()=>workspace)
 manager=new BrowserViewManager(pageWindow,{defaultProfileId:()=> 'private-files',resolvePartition:()=> 'persist:private-files'},new BrowserRefLedgerStore(join(home,'refs.json')),
  {rememberedSchemes:async()=>({}),rememberScheme:async()=>{},openExternal:async()=>{}},new BrowserOperationJournal(new BrowserOperationFileStore(join(home,'operations.sqlite'))),undefined,undefined,undefined,assets,downloads,uploads)
 await manager.create(browserId,url,workspace.id,undefined,undefined,'responsive',{agent:{hostId:'private-fixture',agentSessionId:'private-unobserved-association'}})
 manager.setBounds(browserId,{x:0,y:0,width:940,height:700});pageWindow.showInactive()
 const contents=manager.nativeOwner(browserId)!.view.webContents;report.nativeDialogs=[];contents.debugger.on('message',(_event,method,params)=>{if(method==='Page.javascriptDialogOpening'||method==='Page.javascriptDialogClosed')report.nativeDialogs.push({method,type:params?.type,result:params?.result})});await until(()=>contents.executeJavaScript('!!document.querySelector("#files")'),'original native document')
 if(phase==='beforeunload'){
  const target=(role:string,name:string)=>({role,name,ordinal:1,count:1})
  await contents.executeJavaScript(`(()=>{window.onbeforeunload=event=>{event.preventDefault();event.returnValue=''};return true})()`)
  const source=await importTaskRecording(assets,{id:'activation-source',browserId,navigationId:'recorded',url,revision:1,status:'stopped',startedAt:1,updatedAt:2,steps:[]})
  const asset=await manager.saveTaskAssetVersion(browserId,source.id,source.revision,{name:'Keep original page',url,parameters:[],steps:[{id:'activate',kind:'click',url,target:target('button','Activate'),reviewed:true},{id:'leave',kind:'click',url,target:target('link','Leave'),dialog:{type:'beforeunload',action:'dismiss'},reviewed:true}]})
  const run=await manager.runTaskAsset({browserId,assetId:asset.id,version:1,parameters:{}})
  report.beforeunloadRun=run;report.lastOperation=await manager.getOperation(run.operationIds.at(-1)!)
  assert.equal(run.status,'completed');assert.equal(run.nextStep,2);assert.equal(contents.getURL(),url)
  assert.equal(await contents.executeJavaScript('document.querySelector("[aria-label=Draft]").value'),'original draft')
  assert.ok(report.nativeDialogs.some((event:any)=>event.method==='Page.javascriptDialogOpening'&&event.type==='beforeunload'))
  assert.ok(report.nativeDialogs.some((event:any)=>event.method==='Page.javascriptDialogClosed'&&event.result===false))
  await contents.executeJavaScript('window.onbeforeunload=null')
  report.cases.push({label:'beforeunload-dismiss-preserves-original-document-and-draft',passed:true});report.passed=true;return
 }
 if(phase==='prompt-probe'){
  if(!contents.debugger.isAttached())contents.debugger.attach('1.3')
  const cancel=(_event:any,method:string)=>{if(method==='Page.javascriptDialogOpening')void contents.debugger.sendCommand('Page.handleJavaScriptDialog',{accept:false})}
  contents.debugger.on('message',cancel);await contents.debugger.sendCommand('Page.enable')
  report.promptProbe=await contents.debugger.sendCommand('Runtime.evaluate',{expression:`(()=>{try {const value=window.prompt('Private native capability probe');return {returned:true,valueType:typeof value}}catch(error){return {threw:true,name:error.name,message:error.message}}})()`,returnByValue:true})
  report.promptHandler=await contents.executeJavaScript('({kind:typeof window.prompt,handler:typeof document.querySelector("#prompt").onclick})')
  contents.debugger.removeListener('message',cancel);report.cases.push({label:'native-prompt-protocol-observation',passed:true});report.passed=true;return
 }
 await manager.create('neighbor',url+'/neighbor',workspace.id);manager.setBounds('neighbor',{x:0,y:710,width:940,height:45});const neighbor=manager.nativeOwner('neighbor')!.view.webContents
 const target=(name:string)=>({role:name==='Download'?'link':'button',name,ordinal:1,count:1})
 const source=await importTaskRecording(assets,{id:'real-trigger-fixture',browserId,navigationId:'recorded',url,revision:1,status:'stopped',startedAt:1,updatedAt:2,steps:[{id:'confirm',sequence:1,recordedAt:1,navigationId:'recorded',source:'native-human',method:'click',url,args:[],target:target('Confirm')}]})
 const definition:BrowserTaskContent={name:'Files and page dialogs',url,parameters:[{key:'file',label:'Workspace file',secret:true},{key:'answer',label:'Prompt answer',secret:true}],steps:[
  {id:'upload',kind:'upload',url,target:target('Files'),parameterKeys:['file'],reviewed:true},
  {id:'confirm',kind:'click',url,target:target('Confirm'),dialog:{type:'confirm',action:'accept'},reviewed:true},
  {id:'prompt',kind:'click',url,target:target('Prompt'),dialog:{type:'prompt',action:'accept',promptParameterKey:'answer'},reviewed:true},
  {id:'download',kind:'click',url,target:target('Download'),reviewed:true}],completion:{criteria:[{kind:'download-readable',stepId:'download',path:'outputs/result.bin'}]}}
 control=new AgentMuxControlServer({socketPath:join(home,'control.sock'),coreClients:()=>[],execute:request=>executeBrowserTaskControl(request,manager!,true)});await control.start()
 const edited=await cli(['edit','--browser',browserId,'--asset',source.id,'--expected-revision',String(source.revision),'--input','-'],JSON.stringify({...definition,steps:definition.steps.filter(step=>step.id!=='prompt')}))
 const published=await cli(['publish','--browser',browserId,'--asset',source.id,'--expected-revision',String(edited.asset.revision)]);assert.equal(published.publishedVersion,1)
 await manager.returnControl(browserId)
 const first=await cli(['run','--browser',browserId,'--asset',source.id,'--version','1'],JSON.stringify({file:'source.bin',answer:privateAnswer}));assert.equal(first.run.status,'completed');assert.equal(first.run.operationIds.length,3)
 assert.deepEqual(await contents.executeJavaScript('Promise.all([...document.querySelector("#files").files].map(async f=>Array.from(new Uint8Array(await f.arrayBuffer()))))'),[[1,3,5]])
 assert.deepEqual(await contents.executeJavaScript('proof'),{confirmCalls:1,confirmed:1,promptCalls:0,promptMatched:false});assert.equal(requests,1)
 const receipts=await downloads.list({workspaceId:workspace.id,browserId});assert.equal(receipts.length,1);assert.equal(receipts[0]!.status,'completed');assert.deepEqual(Buffer.from((await downloads.read(receipts[0]!.reference!,{workspaceId:workspace.id,browserId})).data,'base64'),payload)
 assert.deepEqual(await neighbor.executeJavaScript('proof'),{confirmCalls:0,confirmed:0,promptCalls:0,promptMatched:false})
 report.cases.push({label:'compiled-cli-native-filelist-confirm-and-immediate-download',passed:true})
 let lostAnswer=false,lostUpload=false
 const original=contents.debugger.sendCommand.bind(contents.debugger)
 contents.debugger.sendCommand=async(method:string,params?:any,sessionId?:string)=>{const result=await original(method,params,sessionId);if(method==='Page.handleJavaScriptDialog'&&params?.accept&&lostAnswer){lostAnswer=false;throw Error('Private native answer reply unavailable')}if(method==='DOM.setFileInputFiles'&&lostUpload){lostUpload=false;throw Error('Private native upload reply unavailable')}return result}
 for(const kind of ['upload','answer'] as const){
  manager.takeControl(browserId);await manager.navigate(browserId,url);await until(()=>contents.executeJavaScript('!!document.querySelector("#files")'),'original page for lost acknowledgement')
  const current=(await assets.get(source.id))!,step=definition.steps[kind==='upload'?0:1]!,draft={...definition,steps:[step]};delete draft.completion
  const asset=await manager.saveTaskAssetVersion(browserId,source.id,current.revision,draft);lostAnswer=kind==='answer';lostUpload=kind==='upload'
  const run=await manager.runTaskAsset({browserId,assetId:source.id,version:asset.versions.at(-1)!.version,parameters:{file:'source.bin',answer:privateAnswer}})
  assert.notEqual(run.status,'completed');assert.equal(run.nextStep,0);assert.equal(run.operationIds.length,1)
  if(kind==='answer')assert.deepEqual(await contents.executeJavaScript('proof'),{confirmCalls:1,confirmed:1,promptCalls:0,promptMatched:false})
  else assert.deepEqual(await contents.executeJavaScript('Promise.all([...document.querySelector("#files").files].map(async f=>Array.from(new Uint8Array(await f.arrayBuffer()))))'),[[1,3,5]])
  report.cases.push({label:'lost-native-'+kind+'-reply-no-replay',passed:true})
 }
 const final=(await assets.get(source.id))!;const editedForUi=await manager.saveTaskAssetDraft(browserId,source.id,final.revision,definition)
 const current=await captureEditor(editedForUi,manager.target(browserId)!.dialogTypes,{save:(asset,draft)=>manager!.saveTaskAssetDraft(browserId,asset.id,asset.revision,draft),publish:(asset,draft)=>manager!.saveTaskAssetVersion(browserId,asset.id,asset.revision,draft),run:(asset,input)=>manager!.runTaskAsset({browserId,assetId:asset.id,...input})})
 report.cases.push({label:'production-themed-editor-widths',passed:true})
 const state=await assets.state(browserId),completed=await downloads.list({workspaceId:workspace.id,browserId})
 await writeFile(join(home,'descriptor.json'),JSON.stringify({assetId:current.id,versions:current.versions,runs:state.runs.map(r=>({id:r.id,status:r.status,nextStep:r.nextStep,operationIds:r.operationIds})),downloadCount:completed.filter(r=>r.status==='completed').length,reference:receipts[0]!.reference}))
 for(const file of ['assets.json'])assert.equal((await readFile(join(home,file),'utf8')).includes(privateAnswer),false)
 assert.equal(requests,1);report.passed=true
}
run().catch(async error=>{report.failure={message:error.message,stack:error.stack};if(manager){try{const state=await manager.getTaskAssets(browserId),run=state.runs.at(-1);if(run?.operationIds.length)report.lastOperation=await manager.getOperation(run.operationIds.at(-1)!)}catch{}}console.error(error)}).finally(async()=>{for(const channel of ['initial','save','publish','run'])ipcMain.removeHandler('task-files:'+channel);await control?.stop();await manager?.dispose();http?.closeAllConnections();http?.close();pageWindow?.destroy();editorWindow?.destroy();await writeFile(join(out,phase+'.json'),JSON.stringify(report,null,2)+'\n');app.exit(report.passed?0:1)})
