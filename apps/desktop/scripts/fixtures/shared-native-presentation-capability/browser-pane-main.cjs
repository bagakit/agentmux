const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),{pathToFileURL}=require('node:url'),{createServer}=require('node:http'),{app,BrowserWindow}=require('electron')
const [privateRoot,evidence,nativeBundle,preload,genericPage,output]=process.argv.slice(2)
app.setPath('userData',path.join(privateRoot,'user-data'));app.setPath('sessionData',path.join(privateRoot,'session-data'))
const receipt={schema:'agentmux.shared-native-browser-pane-capability.v1',passed:false,pid:process.pid,electron:process.versions.electron,cases:[],frames:[],captureRequests:[],nativeInputs:[],controls:{userApp:0,userRun:0,sharedRuntime:0},productImplemented:false,T004Qualified:false}
const pause=ms=>new Promise(r=>setTimeout(r,ms));let win,native,server,requesterSession,original,wc,pinned,sourceSession,expectedFrame,consumerUrl,origin
const grantLifetime={sourceDocument:true,requesterDocument:true};const navigationEvents=[];let invalidateSource,invalidateRequester
const save=async stage=>{receipt.stage=stage;await fs.writeFile(path.join(evidence,'actual-live.json'),JSON.stringify(receipt,null,2)+'\n')}
const until=async(label,fn)=>{const end=Date.now()+8000;do{if(await fn())return;await pause(30)}while(Date.now()<end);throw new Error('Did not settle: '+label)}
let renderer;const describe=()=>({wcId:wc.id,sourceSessionSame:wc.session===sourceSession,mainFrameSame:wc.mainFrame===pinned.frame,originalViewSame:native.browsers.nativeOwner('one-original-page')?.view===original,visible:original.getVisible(),bounds:original.getBounds(),url:wc.getURL(),resources:native.browsers.resourceOwnerCounts(),viewChildren:win.contentView.children.map(v=>({sameOriginal:v===original,wcId:v.webContents?.id,visible:v.getVisible(),bounds:v.getBounds()}))})
app.whenReady().then(async()=>{
 try{
  server=createServer(async(req,res)=>{try{const name=req.url==='/'?'index.html':new URL(req.url,'http://local').pathname.slice(1);assert.ok(/^[\w.-]+$/.test(name));const bytes=await fs.readFile(path.join(output,name));res.writeHead(200,{'content-type':name.endsWith('.html')?'text/html':name.endsWith('.css')?'text/css':'text/javascript','cache-control':'no-store'}).end(bytes)}catch{res.writeHead(404).end()}})
  await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r)})
  consumerUrl='http://127.0.0.1:'+server.address().port+'/index.html';origin=new URL(consumerUrl).origin
  win=new BrowserWindow({width:1200,height:700,useContentSize:true,show:false,webPreferences:{preload,partition:'shared-native-pane-private-consumer',sandbox:true,contextIsolation:true,nodeIntegration:false}})
  const {installMoteNative}=await import(pathToFileURL(nativeBundle).href)
  native=await installMoteNative({window:win,privateRoot,evidence,phase:'pane-capability',fixturePage:genericPage})
  win.webContents.on('console-message',(_,level,message)=>console.error('renderer:',level,message))
  win.webContents.on('render-process-gone',(_,details)=>{receipt.rendererGone=details})
  await win.loadURL(consumerUrl);renderer=expression=>win.webContents.executeJavaScript(expression)
  await until('two actual BrowserPane stages',()=>renderer("Boolean(window.paneProbe?.ready&&document.querySelectorAll('.browser-stage').length===2)"))
  await until('original Native owner',()=>native.browsers.nativeOwner('one-original-page'))
  original=native.browsers.nativeOwner('one-original-page').view;wc=original.webContents;sourceSession=wc.session
  await until('source page ready',()=>!wc.isLoading()&&wc.executeJavaScript('Boolean(window.nativeFixture)'))
  const snapshot=await renderer('window.paneProbe.browser')
  pinned={frame:wc.mainFrame,url:wc.getURL(),snapshot,session:sourceSession,view:original}
  expectedFrame=win.webContents.mainFrame;requesterSession=win.webContents.session
  receipt.source={browserId:snapshot.id,profileId:snapshot.profileId,navigationId:snapshot.navigationId,sourceWC:wc.id,requesterWC:win.webContents.id,sourceOrigin:new URL(pinned.url).origin,requesterOrigin:origin,sourcePartitionAuthority:'Original private BrowserProfileManager',requesterPartition:'shared-native-pane-private-consumer'}
  assert.notEqual(sourceSession,requesterSession)
  wc.on('input-event',(_,input)=>receipt.nativeInputs.push({wcId:wc.id,input,at:Date.now()}))
  await wc.executeJavaScript("(()=>{const e=document.getElementById('native-proof-editor');e.value='Same original page draft';e.setSelectionRange(2,9);const t=document.createElement('div');t.id='live-color';t.style='position:fixed;left:8px;top:8px;width:64px;height:64px;background:rgb(15,22,29);z-index:999';document.body.append(t)})()")
  const page=()=>wc.executeJavaScript("(()=>{const e=document.getElementById('native-proof-editor');return {...window.nativeFixture.facts(),selectionStart:e.selectionStart,selectionEnd:e.selectionEnd,url:location.href,viewport:{width:innerWidth,height:innerHeight}}})()")
  receipt.original={owner:describe(),page:await page()};const viewport=receipt.original.page.viewport
  await renderer('window.paneProbe.configure('+JSON.stringify(viewport)+')')
  assert.deepEqual({width:original.getBounds().width,height:original.getBounds().height},{width:480,height:240})
  // One grant lifetime on the existing WebContents events, never a Browser registry.
  invalidateSource=details=>{if(details.isMainFrame){grantLifetime.sourceDocument=false;navigationEvents.push({side:'source',url:details.url,isMainFrame:details.isMainFrame,isSameDocument:details.isSameDocument,at:Date.now()})}}
  invalidateRequester=details=>{if(details.isMainFrame){grantLifetime.requesterDocument=false;navigationEvents.push({side:'requester',url:details.url,isMainFrame:details.isMainFrame,isSameDocument:details.isSameDocument,at:Date.now()})}}
  wc.on('did-start-navigation',invalidateSource);win.webContents.on('did-start-navigation',invalidateRequester)
  requesterSession.setDisplayMediaRequestHandler((request,callback)=>{
   let requestOrigin;try{requestOrigin=new URL(request.securityOrigin).origin}catch{}
   const sourceAlive=!wc.isDestroyed(),requesterAlive=!win.isDestroyed()&&!win.webContents.isDestroyed()
   const checks={exactRequesterFrame:requesterAlive&&request.frame===expectedFrame&&expectedFrame===win.webContents.mainFrame,exactRequesterSession:requesterAlive&&win.webContents.session===requesterSession,exactRequesterDocument:requesterAlive&&grantLifetime.requesterDocument&&expectedFrame.url===consumerUrl,exactOrigin:requestOrigin===origin,gesture:request.userGesture===true,videoOnly:request.videoRequested===true&&request.audioRequested===false,sourceAlive,sourceSameSession:sourceAlive&&wc.session===sourceSession,sourceSameFrame:sourceAlive&&wc.mainFrame===pinned.frame,sourceSameDocument:sourceAlive&&wc.getURL()===pinned.url,sourceSameView:original===pinned.view,sourceGrantLive:grantLifetime.sourceDocument}
   const allowed=Object.values(checks).every(v=>v===true);receipt.captureRequests.push({allowed,checks,requestOrigin,securityOrigin:request.securityOrigin,frameProcessId:request.frame?.processId,frameRoutingId:request.frame?.routingId,sourceWC:wc.id,requesterWC:win.webContents.id,userGesture:request.userGesture,videoRequested:request.videoRequested,audioRequested:request.audioRequested})
   callback(allowed?{video:pinned.frame}:null)
  },{useSystemPicker:false})
  receipt.permissionBoundary={displayHandlerInstalledOnExactRequester:true,sourceProductionPermissionPolicyChanged:false,sourcePermissionCallbackInvoked:'not-instrumented; do not infer',systemPicker:false}
  win.show();win.focus();await pause(150)
  receipt.focus={focusedWindowId:BrowserWindow.getFocusedWindow()?.id??null,focused:win.isFocused(),appActive:app.isActive(),exclusiveWindows:BrowserWindow.getAllWindows().map(w=>w.id),mechanism:'Only exact private BrowserWindow.show/focus; no application-level steal or user App controls'}
  assert.deepEqual(BrowserWindow.getAllWindows().map(w=>w.id),[win.id]);assert.ok(process.argv.includes(privateRoot))
  win.webContents.debugger.attach('1.3')
  const click=async id=>{const p=await renderer("(()=>{const e=document.getElementById("+JSON.stringify(id)+"),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return{x,y,hit:document.elementFromPoint(x,y)===e,text:e.textContent}})()");assert.equal(p.hit,true);for(const type of ['mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:p.x,y:p.y,button:'left',clickCount:1});return p}
  receipt.cost={before:app.getAppMetrics(),sampleOnly:true,notBenchmark:true}
  await save('capture-guard-installed-real-button-next');receipt.captureButton=await click('start')
  await until('single capture or actual capture error',async()=>{const f=await renderer('window.paneProbe.facts()');receipt.renderer=f;return f.ready||f.failure})
  assert.equal(receipt.renderer.failure,undefined);assert.equal(receipt.renderer.captureAttempts,1);assert.equal(receipt.renderer.captureCount,1)
  assert.equal(receipt.renderer.buttonEvents[0].trusted,true);assert.equal(receipt.renderer.buttonEvents[0].active,true);assert.equal(receipt.captureRequests.length,1);assert.equal(receipt.captureRequests[0].allowed,true)
  receipt.captureInvocation='Actual DOM button clicked by trusted CDP Input.dispatchMouseEvent; not executeJavaScript(userGesture=true), not physical OS mouse'
  assert.ok(receipt.renderer.videos.every(v=>v.sameStream&&v.trackIds.length===1));assert.ok(receipt.renderer.settings.width<=viewport.width&&receipt.renderer.settings.height<=viewport.height)
  const color=async(label,rgb,ids=['a','b'])=>{await wc.executeJavaScript("document.getElementById('live-color').style.background="+JSON.stringify('rgb('+rgb.join(',')+')'));const actual=await renderer('window.paneProbe.color('+JSON.stringify(label)+','+JSON.stringify(rgb)+','+JSON.stringify(ids)+')');assert.ok(ids.length>0);for(const id of ids)assert.equal(actual.matches[id],true);receipt.cases.push({label,actual,owner:describe(),renderer:await renderer('window.paneProbe.facts()')});await save(label)}
  const shot=async label=>{const image=await win.webContents.capturePage(),file=label+'.png';assert.equal(image.isEmpty(),false);await fs.writeFile(path.join(evidence,file),image.toPNG());receipt.frames.push({file,source:'Requester Renderer capture only; original Native overlay separately captured',notTransport:true});const nativeImage=await wc.capturePage(),nf=label+'-native.png';await fs.writeFile(path.join(evidence,nf),nativeImage.toPNG());receipt.frames.push({file:nf,source:'Same original source WebContents capture; not OS composition',notTransport:true})}
  await color('two-real-browser-pane-live',[239,45,64]);await shot('position-a')
  await click('passive');await until('original native view hidden',()=>!original.getVisible());await color('hidden-original-new-two-position-pixels',[35,182,103]);await shot('stream-only')
  receipt.input={attempted:false,qualified:false,physicalOS:false,IME:'unknown',clipboard:'not-read-or-written',reason:null,phases:[]}
  for(const id of ['b','a']){
   await click('activate-'+id);await until('same original view at '+id,async()=>{const b=await renderer("document.querySelector('[data-binding="+id+"] .browser-stage').getBoundingClientRect().toJSON()");const a=original.getBounds();return original.getVisible()&&Math.abs(a.x-b.x)<1&&Math.abs(a.y-b.y)<1})
   assert.deepEqual({width:original.getBounds().width,height:original.getBounds().height},{width:480,height:240});assert.equal(wc.session,sourceSession);assert.equal(wc.mainFrame,pinned.frame);assert.equal(wc.getURL(),pinned.url)
   const phase={binding:id,owner:describe(),focusWindowId:BrowserWindow.getFocusedWindow()?.id??null,windowFocused:win.isFocused(),pageBefore:await page(),nativeInputStart:receipt.nativeInputs.length}
   if(win.isFocused()){
    receipt.input.attempted=true;wc.debugger.attach('1.3');try{const point=await wc.executeJavaScript("(()=>{const e=document.getElementById('native-proof-editor'),r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e}})()");assert.equal(point.hit,true);for(const type of ['mousePressed','mouseReleased'])await wc.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:point.x,y:point.y,button:'left',clickCount:1});await wc.debugger.sendCommand('Input.insertText',{text:'-'+id.toUpperCase()});phase.pageAfter=await page();phase.nativeEvents=receipt.nativeInputs.slice(phase.nativeInputStart);assert.equal(phase.pageAfter.editorFocused,true);assert.ok(phase.pageAfter.keyboardEvents.some(e=>e.type==='input'&&e.trusted));assert.ok(phase.nativeEvents.length>0);phase.qualified=true;phase.mechanism='Trusted CDP directly targets same original WC; native view at actual BrowserPane geometry, not physical window hit'}finally{wc.debugger.detach()}
   }else{phase.qualified=false;phase.reason='Exact private containing Window not focused; native input prerequisite unqualified, not guessed'}
   receipt.input.phases.push(phase);await color('same-page-transfer-'+id,id==='a'?[71,111,231]:[220,153,38]);await shot('position-'+id+'-input')
  }
  receipt.input.qualified=receipt.input.phases.length===2&&receipt.input.phases.every(p=>p.qualified)
  await click('activate-b');await until('native transfer back to B',async()=>Math.abs(original.getBounds().x-(await renderer("document.querySelector('[data-binding=b] .browser-stage').getBoundingClientRect().x")))<1)
  await click('hide-a');await color('only-a-hidden-b-continues',[178,70,202],['b']);receipt.localHide={originalAlive:!wc.isDestroyed(),originalSessionSame:wc.session===sourceSession,owner:describe(),renderer:await renderer('window.paneProbe.facts()')}
  assert.equal(receipt.localHide.originalAlive,true);assert.equal(receipt.localHide.renderer.captureCount,1);assert.equal(receipt.localHide.renderer.videos.find(v=>v.id==='video-b').hidden,false)
  receipt.finalPage=await page();receipt.cost.after=app.getAppMetrics();receipt.cost.output={...receipt.renderer.settings,sourceLogicalViewport:viewport,simultaneousPlayers:2,singleSource:1,singleStream:1,scope:'Single fixed equal-size capability sample, not full app/any-size/scale benchmark'}
  assert.equal(native.receipt.bindings.length,1);assert.equal(native.browsers.resourceOwnerCounts().browserViews,1)
  // A same-URL document replacement is not detected by URL equality alone.
  // Preserve the five earlier valid stages before provoking this exact private source.
  receipt.validPhaseFinalPage=receipt.finalPage
  const negativeBefore={owner:describe(),renderer:await renderer('window.paneProbe.facts()'),sourceUrl:wc.getURL(),captureRequests:receipt.captureRequests.length}
  await save('before-one-actual-invalid-document-request')
  await native.browsers.reload('one-original-page')
  await until('actual same-URL source navigation completed',()=>navigationEvents.some(e=>e.side==='source'&&e.isMainFrame)&&!wc.isLoading()&&wc.executeJavaScript('Boolean(window.nativeFixture)'))
  assert.equal(wc.getURL(),negativeBefore.sourceUrl,'Negative uses the same URL, not a conveniently different source')
  assert.equal(wc.id,receipt.source.sourceWC);assert.equal(wc.session,sourceSession);assert.equal(grantLifetime.sourceDocument,false)
  receipt.negativeCaptureButton=await click('start')
  await until('actual invalid grant denial',async()=>{const f=await renderer('window.paneProbe.facts()');receipt.invalidRenderer=f;return f.captureAttempts===2&&(f.failure||f.captureCount>1)})
  const request=receipt.captureRequests.at(-1)
  receipt.invalidGrant={before:negativeBefore,afterOwner:describe(),sourcePageAfterReload:await page(),navigationEvents:[...navigationEvents],grantLifetime:{...grantLifetime},request,renderer:receipt.invalidRenderer,
   qualification:'Actual trusted DOM second request after original same-URL reload; only new grant rejection is tested. Already-authorized stream revocation on navigation is NOT qualified.'}
  assert.equal(receipt.captureRequests.length,2,'Both valid and actual rejected callbacks are nonempty')
  assert.ok(navigationEvents.some(e=>e.side==='source'&&e.isMainFrame))
  assert.equal(request.allowed,false,'Original grant lifetime is invalid after source document navigation')
  assert.equal(request.checks.sourceGrantLive,false)
  assert.equal(receipt.invalidRenderer.failure?.name,'AbortError','The actual getDisplayMedia promise rejects, not a synthetic guard-only result')
  assert.equal(receipt.invalidRenderer.failure?.message,'Invalid capture constraints','Exact observed Electron43 denial; raw prior failure is preserved')
  assert.equal(receipt.invalidRenderer.captureCount,1,'A failed new request cannot be counted as a second stream')
  receipt.invalidGrant.passed=true
  await save('actual-same-url-invalid-grant-rejected')
  receipt.passed=true;receipt.capability='one-original-page-two-real-BrowserPane-live-paint and one original Native view moves at equal fixed viewport';receipt.productGap='Private BrowserPane slot/native-owner candidate and mote-native typed bridge; registered product stream/presentation caller not implemented'
 }catch(e){receipt.failure={name:e.name,message:e.message,stack:e.stack};try{receipt.renderer=await renderer('window.paneProbe?.facts()');if(wc&&!wc.isDestroyed())receipt.failureOwner=describe();if(win&&!win.isDestroyed()){const image=await win.webContents.capturePage();await fs.writeFile(path.join(evidence,'failure.png'),image.toPNG());receipt.failureImage='failure.png'}}catch(f){receipt.failureObservation=f.message}}
 finally{
  try{if(renderer)receipt.stoppedTracks=await renderer('window.paneProbe?.stop()')}catch(e){receipt.stopFailure=e.message}
  if(requesterSession)requesterSession.setDisplayMediaRequestHandler(null)
  if(wc&&invalidateSource)wc.off('did-start-navigation',invalidateSource)
  if(win&&!win.isDestroyed()&&invalidateRequester)win.webContents.off('did-start-navigation',invalidateRequester)
  try{if(win?.webContents.debugger.isAttached())win.webContents.debugger.detach()}catch{}
  try{if(native){receipt.nativeBeforeDispose=native.owners();await native.dispose();receipt.nativeAfterDispose=native.owners()}}catch(e){receipt.cleanupFailure=e.message;receipt.passed=false}
  if(server)await new Promise(r=>server.close(r))
  await fs.writeFile(path.join(evidence,'native-receipt.json'),JSON.stringify(receipt,null,2)+'\n')
  if(win&&!win.isDestroyed())win.destroy()
  console.log('private_pane_capability='+JSON.stringify({passed:receipt.passed,pid:process.pid,stage:receipt.stage,error:receipt.failure?.message}))
  app.exit(receipt.passed?0:1)
 }
})
