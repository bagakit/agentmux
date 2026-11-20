import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile,writeFile,mkdir,rename,rm,stat } from 'node:fs/promises'
import { renameSync,mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app,BrowserWindow,ipcMain,dialog } from 'electron'
import { AgentMuxControlServer } from '@agentmux/core'
import { BrowserRefLedgerStore } from '@agentmux/browser/operations'
import { BrowserOperationJournal,BrowserOperationFileStore } from '@agentmux/browser/operations'
import { BrowserProfileManager } from '../../../src/main/browser-profile-manager.js'
import { BrowserProfileStore } from '../../../src/main/browser-profile-store.js'
import { BrowserViewManager } from '../../../src/main/browser-view-manager.js'
import { registerBrowserProfileEditorIpc } from '../../../src/main/browser-profile-editor-ipc.js'
import { executeBrowserProfileControl } from '../../../src/main/browser-profile-control.js'
import { createProfileCookieFileIo } from '../../../src/main/browser-profile-cookie-file-io.js'
import { confirmProfileCookieFile } from '../../../src/main/browser-profile-cookie-file-confirmation.js'
import { openProfileCookieFileNative } from '../../../src/main/browser-profile-cookie-file-native.js'
import { normalizeProfileFileCookie,profileCookieIdentity } from '../../../src/main/browser-profile-cookie-file-format.js'
import { WorkspaceFiles } from '../../../src/main/workspace-files.js'
import { THEME_BOOTSTRAP_CHANNEL } from '../../../src/shared/theme-bootstrap.js'
const home=process.env.COOKIE_FILES_HOME!,out=process.env.COOKIE_FILES_OUT!,phase=process.env.COOKIE_FILES_PHASE!,base=process.env.COOKIE_FILES_BASE!,node=process.env.COOKIE_FILES_NODE!
app.setActivationPolicy?.('prohibited');app.on('window-all-closed',()=>{})
const report:any={passed:false,phase,pid:process.pid,cases:[],cli:[],guiCalls:[],confirmations:[]}
let host:BrowserWindow|undefined,profiles:BrowserProfileManager|undefined,browsers:BrowserViewManager|undefined,control:AgentMuxControlServer|undefined
let guiSource='',guiDirectory=home,approval=true,breakAdmission=false,expireDuringPrompt=false
let confirming:import('../../../src/main/browser-profile-cookie-files.js').ProfileCookieFileConfirmation|undefined
const metadata=join(home,'profiles.json'),backup=join(home,'pending-original.json'),browserId='cookie-original-browser',otherBrowserId='cookie-independent-browser'
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms)),contents=(id=browserId)=>browsers!.nativeOwner(id)!.view.webContents
const scope={kind:'profile' as const},location=(path:string)=>({kind:'local' as const,path})
const safe=(value:unknown)=>{assert.doesNotMatch(JSON.stringify(value),/FIXTURE-COOKIE-SECRET|private-cookie-source|private-output-secret|signed-in-name|lost-ack-cookie/u,'Ordinary public facts must contain no Cookie body or private file basename')}
async function cli(method:string,input:object,success=true){
  const result=await new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{const child=spawn(node,[join(out,'cli.mjs'),'--endpoint','unix:'+join(home,'control.sock'),'browser','profile','cookie-file',method,'--input','-'],{env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>key!=='ELECTRON_RUN_AS_NODE'&&!/^(AGENTMUX_|CTXMUX_)/u.test(key))),NODE_NO_WARNINGS:'1'},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(Error('Cookie CLI exceeded its observation deadline'))},90000);child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr})});child.stdin.end(JSON.stringify(input))})
  const body=JSON.parse(result.stdout||result.stderr);safe(body);report.cli.push({method,code:result.code,...(body.result?.receipt?{receipt:body.result.receipt}:{}),...(body.error?{errorCode:body.error.code}:{})});assert.equal(result.code===0,success,result.stderr||result.stdout);return success?body.result:body
}
async function ready(expression:string){for(let i=0;i<200;i++){if(await host!.webContents.executeJavaScript(expression))return;await pause(30)}throw Error('The actual Cookie GUI did not reach its expected state: '+expression)}
async function click(selector:string){
  if(!host!.webContents.debugger.isAttached())host!.webContents.debugger.attach('1.3')
  await host!.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center',behavior:'instant'})`);await pause(40)
  const point=await host!.webContents.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing actual Cookie control');const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('Actual Cookie control is covered');return{x,y}})()`)
  await host!.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...point,button:'none'})
  for(const type of ['mousePressed','mouseReleased'])await host!.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...point,button:'left',buttons:type==='mousePressed'?1:0,clickCount:1});await pause(120)
}
async function openCookiePanel(){await click('.profile-cookie-files__heading');await ready(`Boolean(document.querySelector('.profile-cookie-files__history')||document.querySelector('.profile-cookie-files__issue'))`)}
async function button(text:string){const selector=await host!.webContents.executeJavaScript(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Missing named Cookie control');e.dataset.nativeClick='original';return'[data-native-click="original"]'})()`);await click(selector);await host!.webContents.executeJavaScript('document.querySelector("[data-native-click]")?.removeAttribute("data-native-click")')}
async function chooseProfileScope(){await ready(`Boolean(document.querySelector('[aria-label="Cookie scope"]'))`);await host!.webContents.executeJavaScript(`(()=>{const s=document.querySelector('[aria-label="Cookie scope"]');s.value='profile';s.dispatchEvent(new Event('change',{bubbles:true}))})()`);await ready(`document.querySelector('[aria-label="Cookie scope"]')?.value==='profile'`)}

const note=(kind:string,data:object={})=>{report.cases.push({kind,...data});console.error('cookie-files-proof: confirmed case '+report.cases.length)}
async function native(id:string){return openProfileCookieFileNative(profiles!.sessions.nativeSession(id))}
async function readNative(id:string){const n=await native(id);try{return await n.read()}finally{await n.close()}}
async function prepare(id:string,op:string,path:string,selected=scope){return cli('prepare-import',{profileId:id,operationId:op,source:location(path),scope:selected})}
async function importReviewReady(profileId:string){
  try{await ready('document.querySelector("[data-cookie-submit]")?.textContent.includes("confirmation")')}
  catch(cause){
    const original=report.guiCalls.filter((call:any)=>call.channel==='browser:prepareProfileCookieImport').at(-1),view=await host!.webContents.executeJavaScript('cookieFilesNative.read()'),inspection=await profiles!.cookieFiles.inspect(profileId,original?.operationId),cookies=await readNative(profileId)
    report.guiFailure={operationId:original?.operationId,prepareReachedOriginalMain:!!original,originalIdVisible:!!original&&view.text.includes(original.operationId),unconfirmed:view.text.includes('Original operation unconfirmed'),durableImportIntentAbsent:inspection.receipt===null,nativeGuiCookieAbsent:!cookies.some((c:any)=>c.name==='gui-original-cookie')}
    assert.equal(report.guiFailure.unconfirmed,false,'The actual GUI prepare must consume its original safe review instead of locking that original operation as unknown')
    throw cause
  }
}
async function main(){
  try{
    host=new BrowserWindow({show:false,width:760,height:840,webPreferences:{sandbox:false,contextIsolation:true,nodeIntegration:false,preload:join(out,'preload.cjs')}})
    host.webContents.on('console-message',(_event,_level,message)=>console.error('cookie-files-renderer:',message))
    profiles=new BrowserProfileManager(new BrowserProfileStore(metadata));await profiles.initialize()
    const retained=phase==='second'?JSON.parse(await readFile(join(home,'retained.json'),'utf8')):null,profileId=retained?.profileId??profiles.defaultProfileId()
    browsers=new BrowserViewManager(host,profiles,new BrowserRefLedgerStore(join(home,'refs.json')),{rememberedSchemes:async()=>({}),rememberScheme:async()=>{},openExternal:async()=>{}},new BrowserOperationJournal(new BrowserOperationFileStore(join(home,'browser-operations.json'))))
    const files=new WorkspaceFiles(()=>({kind:'local'}) as never)
    const workspace={id:'cookie-fixture-workspace',hostId:'local',path:home,label:'Private Cookie fixture'} as never
    profiles.cookieFiles.setFileOwner(createProfileCookieFileIo({files,workspace:resource=>{assert.equal(resource.hostId,'local');assert.equal(resource.workspaceId,'cookie-fixture-workspace');assert.equal(resource.workspacePath,home);return workspace},revealLocal:()=>{report.revealed=true}}))
    const originalDialog=dialog.showMessageBox
    dialog.showMessageBox=(async(_window:any,options:any)=>{assert.equal(_window,host);assert.equal(options.defaultId,0);assert.equal(options.cancelId,0);assert.ok(confirming);assert.ok(options.detail.includes('Profile '+confirming.profileId));const target=confirming.kind==='import'?confirming.source:confirming.destination;assert.ok(target);assert.ok(options.detail.includes(target.path));if(target.kind==='workspace'){assert.ok(options.detail.includes('Host '+target.resource.hostId));assert.ok(options.detail.includes('Workspace '+target.resource.workspaceId));assert.ok(options.detail.includes('Root '+target.resource.workspacePath))}else assert.ok(options.detail.includes('Local Host'));assert.ok(options.detail.includes('Agent request does not grant'));assert.doesNotMatch(options.detail,/FIXTURE-COOKIE-SECRET/u);report.confirmations.push({kind:options.buttons[1].startsWith('Import')?'import':'export',cancelDefault:true,exactOriginalWindow:true,exactHostAndLocation:true,personInput:approval});if(expireDuringPrompt){expireDuringPrompt=false;await pause(1800)}if(breakAdmission){breakAdmission=false;await rename(metadata,backup);await mkdir(metadata)}return{response:approval?1:0,checkboxChecked:false}}) as typeof dialog.showMessageBox
    profiles.cookieFiles.setConfirmationHandler(async(request,signal)=>{confirming=request;try{return await confirmProfileCookieFile(request,signal,host!,profiles!.listProfiles().find(p=>p.id===request.profileId))}finally{confirming=undefined}})
    registerBrowserProfileEditorIpc({profiles,handle:(channel,listener)=>ipcMain.handle(channel,(event,...args)=>{if(event.sender!==host!.webContents||event.senderFrame!==host!.webContents.mainFrame)throw Error('This proof requires its original trusted Workbench frame');if(/Cookie/u.test(channel))report.guiCalls.push({channel,profileId:args[0],operationId:args[1]});return listener(event,...args)})})
    ipcMain.on(THEME_BOOTSTRAP_CHANNEL,event=>{event.returnValue={status:'unavailable',message:'Private appearance fixture; original Cookie operations are active.'}})
    ipcMain.handle('ui:chooseFiles',()=>[guiSource]);ipcMain.handle('ui:chooseDirectory',()=>guiDirectory)
    control=new AgentMuxControlServer({socketPath:join(home,'control.sock'),coreClients:()=>[],execute:(request,context)=>executeBrowserProfileControl(request as never,{profiles:profiles!,usage:{} as never,network:{} as never},context?.actor)});await control.start()
    await host.loadFile(join(out,'renderer/index.html'));await ready('Boolean(window.cookieFilesNative)');await host.webContents.executeJavaScript(`cookieFilesNative.setProfile(${JSON.stringify(profiles.listProfiles().find(p=>p.id===profileId))})`)
    if(retained){
      assert.equal(profiles.sessions.observedSession?.(profileId),undefined)
      const before=report.confirmations.length,inspection=await cli('inspect',{profileId,operationId:'native-lost-ack'});assert.equal(inspection.receipt.status,'pending');assert.ok(inspection.pending.some((r:any)=>r.operationId==='native-lost-ack'))
      await cli('import',{profileId,reviewId:'native-lost-ack'},false);await cli('export',{profileId,operationId:'native-lost-ack',destination:location(join(home,'different.json')),scope},false)
      assert.equal(report.confirmations.length,before);assert.equal(profiles.sessions.observedSession?.(profileId),undefined)
      note('second-process-original-operation-cold-inspect-no-native-replay',{originalProfileId:profileId,operationId:'native-lost-ack',originalNativeSessionNotAcquired:true})
      await browsers.create(browserId,base+'/restart',undefined,profileId);browsers.setBounds(browserId,{x:0,y:0,width:660,height:500});await browsers.create(otherBrowserId,base+'/target-restart',undefined,retained.otherId);browsers.setBounds(otherBrowserId,{x:0,y:0,width:660,height:500})
      assert.equal(await contents().executeJavaScript('localStorage.getItem("original-note")'),'kept-native-work')
      const jar=await readNative(profileId);assert.ok(jar.some((c:any)=>c.name==='lost-ack-cookie'&&c.value==='FIXTURE-COOKIE-SECRET-lost'))
      assert.ok((await readNative(retained.otherId)).some((c:any)=>c.name==='signed-in-name'&&c.value==='FIXTURE-COOKIE-SECRET-auth'))
      const auth=await contents(otherBrowserId).executeJavaScript(`fetch(${JSON.stringify(base+'/auth')}).then(r=>r.json()).then(r=>r.authenticated)`);assert.equal(auth,true)
      browsers.setBounds(browserId,null);browsers.setBounds(otherBrowserId,null);host.showInactive()
      await openCookiePanel();await ready('document.body.textContent.includes("native-lost-ack")');await click('[data-cookie-check="native-lost-ack"]')
      note('second-process-native-Profile-and-signin-and-GUI-original-pending',{originalProfileId:profileId,targetProfileId:retained.otherId,realSiteAuthenticated:true,guiOriginalIdVisible:true})
    }else{
      const other=await profiles.createProfile('Independent target','create-cookie-independent-profile',{kind:'user',id:'private-cookie-files-fixture',verified:true}),otherId=other.id
      await browsers.create(browserId,base+'/original',undefined,profileId);browsers.setBounds(browserId,{x:0,y:0,width:660,height:500});await browsers.create(otherBrowserId,base+'/independent',undefined,otherId);browsers.setBounds(otherBrowserId,{x:0,y:0,width:660,height:500})
      await contents().executeJavaScript('localStorage.setItem("original-note","kept-native-work");document.querySelector("input").value="original-unsent"')
      await contents(otherBrowserId).executeJavaScript('document.querySelector("input").value="independent-unsent"')
      contents().debugger.attach('1.3');await contents().debugger.sendCommand('Runtime.enable')
      await contents().session.cookies.set({url:base,name:'signed-in-name',value:'FIXTURE-COOKIE-SECRET-auth',httpOnly:true,expirationDate:Date.now()/1000+86400})
      await contents(otherBrowserId).session.cookies.set({url:base,name:'unrelated-original',value:'FIXTURE-COOKIE-SECRET-unrelated',expirationDate:Date.now()/1000+86400})
      const seed=await native(profileId)
      try{for(const c of [
        {domain:'.cookie-probe.invalid',name:'coexisting',value:'FIXTURE-COOKIE-SECRET-domain',path:'/a',expires:Date.now()/1000+86400,secure:true,httpOnly:true,sameSite:'Strict'},
        {domain:'cookie-probe.invalid',hostOnly:true,name:'coexisting',value:'FIXTURE-COOKIE-SECRET-host',path:'/',expires:null,secure:true,sameSite:'Lax'},
        ...[true,false].map(hasCrossSiteAncestor=>({domain:'cookie-probe.invalid',name:'chips',value:'FIXTURE-COOKIE-SECRET-'+hasCrossSiteAncestor,expires:Date.now()/1000+86400,secure:true,httpOnly:true,sameSite:'None',partitionKey:{topLevelSite:'https://top-probe.invalid',hasCrossSiteAncestor}}))
      ])assert.equal(await seed.set(normalizeProfileFileCookie(c,Date.now()/1000)),'applied');await seed.flush()}finally{await seed.close()}
      const output=join(home,'private-output-secret.json')
      approval=false;const denied=await cli('export',{profileId,operationId:'native-denied',destination:location(output),scope});assert.equal(denied.receipt.status,'cancelled');await assert.rejects(readFile(output));approval=true
      const exported=await cli('export',{profileId,operationId:'native-export',destination:location(output),scope});assert.equal(exported.receipt.fileOutcome,'written');assert.ok(exported.receipt.counts.applied>=5);assert.equal((await stat(output)).mode&0o777,0o600)
      const array=JSON.parse(await readFile(output,'utf8'));assert.ok(array.some((c:any)=>c.partitionKey?.hasCrossSiteAncestor===true));assert.ok(array.some((c:any)=>c.partitionKey?.hasCrossSiteAncestor===false));assert.ok(array.some((c:any)=>c.hostOnly===false&&c.httpOnly&&c.path==='/a'));assert.ok(!array.some((c:any)=>c.name==='unrelated-original'))
      const originalBytes=await readFile(output);const existing=await cli('export',{profileId,operationId:'no-overwrite',destination:location(output),scope});assert.equal(existing.receipt.fileOutcome,'not-written');assert.ok(originalBytes.equals(await readFile(output)))
      await prepare(otherId,'native-roundtrip',output);const imported=await cli('import',{profileId:otherId,reviewId:'native-roundtrip'});assert.equal(imported.receipt.status,'completed')
      const target=await readNative(otherId),targetNormalized=target.map(c=>normalizeProfileFileCookie(c,Date.now()/1000)),sourceNormalized=array.map((c:any)=>normalizeProfileFileCookie(c,Date.now()/1000))
      for(const c of sourceNormalized)assert.ok(targetNormalized.some(t=>profileCookieIdentity(t)===profileCookieIdentity(c)&&t.value===c.value),'The target preserves every native Cookie identity and value')
      assert.ok(target.some((c:any)=>c.name==='unrelated-original'));assert.equal(await contents(otherBrowserId).executeJavaScript(`fetch(${JSON.stringify(base+'/auth')}).then(r=>r.json()).then(r=>r.authenticated)`),true)
      assert.equal(await contents().executeJavaScript('document.querySelector("input").value'),'original-unsent');assert.equal(await contents(otherBrowserId).executeJavaScript('document.querySelector("input").value'),'independent-unsent');assert.equal(contents().debugger.isAttached(),true)
      note('real-public-file-native-roundtrip-and-site-signin',{originalProfileId:profileId,targetProfileId:otherId,completeNativeIdentitiesPreserved:true,CHIPSAncestorVariants:true,hostOnlyDomainAndPath:true,httpOnlySameSiteExpiry:true,privateMode600:true,existingOutputKept:true,originalDevtoolsAndUnsentInputsKept:true})
      const workspaceFile={kind:'workspace',resource:{hostId:'local',workspaceId:'cookie-fixture-workspace',workspacePath:home},path:'workspace-cookies.json'}
      const scoped=await cli('export',{profileId,operationId:'native-workspace-export',destination:workspaceFile,scope:{kind:'sites',sites:['127.0.0.1']}});assert.equal(scoped.receipt.fileOutcome,'written');const workspaceBytes=await readFile(join(home,workspaceFile.path));assert.equal((await stat(join(home,workspaceFile.path))).mode&0o777,0o600);assert.ok(JSON.parse(workspaceBytes.toString()).every((c:any)=>c.domain==='127.0.0.1'))
      await cli('prepare-import',{profileId:otherId,operationId:'native-workspace-import',source:workspaceFile,scope:{kind:'sites',sites:['127.0.0.1']}});assert.equal((await cli('import',{profileId:otherId,reviewId:'native-workspace-import'})).receipt.status,'completed');assert.ok(workspaceBytes.equals(await readFile(join(home,workspaceFile.path))))
      note('original-Workspace-byte-file-owner-private-scope-roundtrip',{resourceIdentityBound:true,scopedFilePrivateMode600:true,sourceBytesKept:true})
      const source=join(home,'private-cookie-source.json'),expires=Date.now()/1000+1
      await writeFile(source,JSON.stringify([{domain:'127.0.0.1',name:'preserve-expired',value:'FIXTURE-COOKIE-SECRET-expiring',expires,secure:false}]))
      await contents().session.cookies.set({url:base,name:'preserve-expired',value:'FIXTURE-COOKIE-SECRET-newer',expirationDate:Date.now()/1000+86400});await prepare(profileId,'cross-expiry',source);expireDuringPrompt=true
      const expired=await cli('import',{profileId,reviewId:'cross-expiry'});assert.equal(expired.receipt.counts.applied,0);assert.equal(expired.receipt.counts.skipped,1);assert.ok((await readNative(profileId)).some((c:any)=>c.name==='preserve-expired'&&c.value==='FIXTURE-COOKIE-SECRET-newer'))
      note('real-confirmation-crossing-expiry-preserves-newer-target',{expiredSkipped:true,originalSameKeyCookiePreserved:true})
      await writeFile(source,JSON.stringify([{domain:'127.0.0.1',name:'frozen-reviewed',value:'FIXTURE-COOKIE-SECRET-frozen',secure:false}, {domain:'127.0.0.1',name:'invalid',value:'bad\nvalue'}, {domain:'outside.invalid',name:'outside',value:'FIXTURE-COOKIE-SECRET-outside'}]))
      await cli('prepare-import',{profileId,operationId:'fixed-bytes',source:location(source),scope:{kind:'sites',sites:['127.0.0.1']}});await writeFile(source,'[]');const frozen=await cli('import',{profileId,reviewId:'fixed-bytes'});assert.equal(frozen.receipt.counts.applied,1);assert.equal(frozen.receipt.counts.skipped,2);assert.ok((await readNative(profileId)).some((c:any)=>c.name==='frozen-reviewed'))
      note('fixed-source-and-partial-item-preservation',{frozenSourceUsed:true,invalidAndOutsideSkipped:true})
      // Opening Settings parks the original page surfaces through their existing owner.
      browsers.setBounds(browserId,null);browsers.setBounds(otherBrowserId,null);host.showInactive()
      guiSource=source;await writeFile(source,JSON.stringify([{domain:'127.0.0.1',name:'gui-original-cookie',value:'FIXTURE-COOKIE-SECRET-gui',secure:false}]))
      await openCookiePanel();await click('[data-cookie-action="import"]');await chooseProfileScope();await click('[data-cookie-submit]');await importReviewReady(profileId);await click('[data-cookie-submit]');await ready(`!document.querySelector('[aria-label="Cookie file operation"]')`);assert.ok((await readNative(profileId)).some((c:any)=>c.name==='gui-original-cookie'&&c.value==='FIXTURE-COOKIE-SECRET-gui'))
      await click('[data-cookie-action="export"]');await chooseProfileScope();await button('Choose destination folder…');await click('[data-cookie-submit]');await ready(`!document.querySelector('[aria-label="Cookie file operation"]')`);assert.ok(JSON.parse(await readFile(join(home,'cookies.json'),'utf8')).some((c:any)=>c.name==='gui-original-cookie'))
      await button('Reveal original export location');assert.equal(report.revealed,true)
      const last=(await profiles.cookieFiles.inspect(profileId)).recent.find(r=>r.kind==='export')!;await cli('reveal',{profileId,operationId:last.operationId})
      await click('[data-cookie-action="import"]');await chooseProfileScope();await click('[data-cookie-submit]');await ready('document.querySelector("[data-cookie-submit]")?.textContent.includes("confirmation")');await button('Cancel')
      for(const method of ['prepareProfileCookieImport','importProfileCookies','exportProfileCookies','inspectProfileCookieFiles','discardProfileCookieImport','revealProfileCookieFile'])assert.ok(report.guiCalls.some((c:any)=>c.channel==='browser:'+method),'Actual GUI consumes '+method)
      note('actual-production-Renderer-preload-six-methods-and-native-effects',{guiCookieActuallySet:true,guiOutputActuallyWritten:true,originalFileRevealed:true,sixActualBusinessMethods:true})
      await writeFile(source,JSON.stringify([{domain:'127.0.0.1',name:'before-save-cookie',value:'FIXTURE-COOKIE-SECRET-before',secure:false}]))
      await prepare(profileId,'native-before-save',source);breakAdmission=true;await cli('import',{profileId,reviewId:'native-before-save'},false);await rm(metadata,{recursive:true});await rename(backup,metadata);assert.ok(!(await readNative(profileId)).some((c:any)=>c.name==='before-save-cookie'))
      note('real-before-save-failure-no-native-effect',{notDispatched:true})
      await writeFile(source,JSON.stringify([{domain:'127.0.0.1',name:'lost-ack-cookie',value:'FIXTURE-COOKIE-SECRET-lost',expires:Date.now()/1000+86400,secure:false}]))
      await prepare(profileId,'native-lost-ack',source);let faultApplied=false
      const changed=(_event:unknown,cookie:any)=>{if(cookie.name==='lost-ack-cookie'&&!faultApplied){faultApplied=true;renameSync(metadata,backup);mkdirSync(metadata)}}
      const originalCookies=profiles.sessions.nativeSession(profileId).cookies
      originalCookies.on('changed',changed);await cli('import',{profileId,reviewId:'native-lost-ack'},false);originalCookies.off('changed',changed);assert.equal(faultApplied,true);await rm(metadata,{recursive:true});await rename(backup,metadata)
      assert.ok((await readNative(profileId)).some((c:any)=>c.name==='lost-ack-cookie'));assert.equal((await cli('inspect',{profileId,operationId:'native-lost-ack'})).receipt.status,'pending')
      assert.doesNotMatch(await readFile(metadata,'utf8'),/FIXTURE-COOKIE-SECRET|signed-in-name|lost-ack-cookie/u);report.retained={profileId,otherId,operationId:'native-lost-ack'};await writeFile(join(home,'retained.json'),JSON.stringify(report.retained));note('actual-native-effect-with-lost-final-save-original-pending',{originalProfileId:profileId,operationId:'native-lost-ack',nativeCookieEffectConfirmed:true})
      profiles.sessions.nativeSession(profileId).flushStorageData();profiles.sessions.nativeSession(otherId).flushStorageData()
    }
    safe(report);dialog.showMessageBox=originalDialog;report.passed=true
  }catch(error){report.failure={message:(error as Error).message,stack:(error as Error).stack};try{report.renderer=await host?.webContents.executeJavaScript('window.cookieFilesNative?.read()')}catch{}console.error(error)}
  finally{await control?.stop();browsers?.dispose();await profiles?.dispose();host?.destroy();await writeFile(join(out,phase+'.json'),JSON.stringify(report,null,2));app.exit(report.passed?0:1)}
}
void main()
