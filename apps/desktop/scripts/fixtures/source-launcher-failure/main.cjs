const {app,BrowserWindow,ipcMain}=require('electron')
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict')
const {registerNativeDesktopIpc}=require('./native-ipc.cjs')
const [html,profile,output]=process.argv.slice(2)
app.setPath('userData',profile);app.disableHardwareAcceleration()
const receipt={frames:[],checks:[],passed:false,clipboardBoundary:'Production Preload IPC and Main registerNativeDesktopIpc; OS clipboard leaf private in-memory, system clipboard untouched.'},delay=ms=>new Promise(r=>setTimeout(r,ms))
let window,clipboardText='',clipboardWrites=0
app.whenReady().then(async()=>{
 try{
  window=new BrowserWindow({show:false,width:1180,height:850,webPreferences:{preload:path.join(__dirname,'preload.cjs'),backgroundThrottling:false,sandbox:false}})
  registerNativeDesktopIpc({capture:async()=>null,native:()=>({readClipboardText:async()=>clipboardText,writeClipboardText:async text=>{clipboardText=text;clipboardWrites++},writeClipboardImage:async()=>{throw Error('Unexpected image copy')},captureScreenshot:async()=>{throw Error('Unexpected screenshot')}}),handle:(channel,handler)=>ipcMain.handle(channel,(event,...args)=>{assert.equal(event.sender,window.webContents);return handler(event,...args)})})
  ipcMain.handle('clientIncidents:open',()=>null) // private capture has no diagnostics publication owner
  ipcMain.on('ui:themeBootstrap',event=>{event.returnValue={status:'unavailable',message:'Private capture theme is set explicitly by its fixture.'}})
  const evaluate=code=>window.webContents.executeJavaScript(code,true)
  const paint=async()=>{await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await delay(100)}
  const wait=async expression=>{for(let n=0;n<100;n++){if(await evaluate(expression))return;await delay(40)}throw Error('Missing actual consumer: '+expression)}
  const frame=async name=>{await paint();const file=name+'.png';await fs.writeFile(path.join(output,file),(await window.webContents.capturePage()).toPNG());receipt.frames.push(file)}
  const wheel=async(deltaY,selector='.launch-surface')=>{const point=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.right-10,y:r.y+r.height/2}})()`);await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY});await paint()}
  const click=async text=>{await evaluate(`Array.from(document.querySelectorAll('.launcher-source-original button')).find(b=>b.textContent===${JSON.stringify(text)}).click()`);await paint()}
  await window.loadFile(html);window.webContents.debugger.attach('1.3');await wait("Boolean(window.sourceFailure && document.querySelector('.source-launch-feedback'))")
  for(const [name,width,height,theme]of[['attach-wide-dark',1180,850,'dark'],['attach-wide-light',1180,850,'light'],['attach-narrow-dark',460,760,'dark'],['attach-narrow-light',460,760,'light'],['attach-short-dark',840,430,'dark']]){
   await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false})
   await evaluate(`sourceFailure.theme(${JSON.stringify(theme)});document.querySelector('.launch-surface').scrollTop=0`);await paint()
   const geometry=await evaluate("(()=>{const s=document.querySelector('.launch-surface'),c=s.querySelector('.source-launch-feedback'),d=c.querySelector('details'),h=c.querySelector('.source-launch-feedback__status');return{width:s.clientWidth,scrollWidth:s.scrollWidth,height:c.getBoundingClientRect().height,detailsOpen:d.open,title:h.textContent}})()")
   assert.equal(geometry.width,geometry.scrollWidth);assert.equal(geometry.detailsOpen,false);assert(geometry.height<220,'Compact closed feedback height');assert(geometry.title.includes('attachment is unconfirmed'));receipt.checks.push({name,geometry});await frame(name)
   if(name==='attach-short-dark'){
    let draft
    for(let step=0;step<10;step++){await wheel(150);draft=await evaluate("(()=>{const s=document.querySelector('.launch-surface'),d=s.querySelector('[contenteditable=true]'),r=d.getBoundingClientRect(),v=s.getBoundingClientRect();return{top:s.scrollTop,visible:r.top>=v.top&&r.bottom<=v.bottom,text:d.textContent}})()");if(draft.top>0&&draft.visible)break}
    assert(draft.top>0&&draft.visible&&draft.text.includes('newer private draft'));receipt.checks.push({name:'native-draft-scroll',draft});await frame('short-draft')
    await evaluate("document.querySelector('.source-launch-feedback summary').click();document.querySelector('.source-launch-feedback details').scrollIntoView({block:'start'})");await paint();await frame('short-details')
    for(let step=0;step<12;step++)await wheel(180,'.source-launch-feedback__detail-body')
    const details=await evaluate("(()=>{const d=document.querySelector('.source-launch-feedback__detail-body');return{top:d.scrollTop,max:d.scrollHeight-d.clientHeight,text:d.textContent,width:d.clientWidth,scrollWidth:d.scrollWidth}})()")
    assert(details.top>0&&Math.abs(details.max-details.top)<3);assert.equal(details.width,details.scrollWidth);assert(details.text.includes('original-creation-operation'));receipt.checks.push({name:'native-detail-scroll',details});await frame('short-details-bottom')
    await evaluate("document.querySelector('.source-launch-feedback summary').click()")
   }
  }
  await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:1180,height:850,deviceScaleFactor:1,mobile:false});await evaluate("sourceFailure.theme('dark');document.querySelector('.launch-surface').scrollTop=0")
  await click('Copy diagnostics');await wait("document.body.textContent.includes('Diagnostics copied')");assert.equal(clipboardWrites,1);const diagnosis=JSON.parse(clipboardText);assert.equal(diagnosis.operationId,'original-creation-operation');assert(!clipboardText.includes('Expected'));assert(!clipboardText.includes('original submitted task'));assert(!clipboardText.includes('newer private draft'));receipt.clipboard={writes:clipboardWrites,diagnosis};await frame('copy-confirmed')
  await click('Check original task');await wait("document.querySelector('[aria-label=\"Source observation issues\"]')?.textContent.includes('HOST_ROUTE_AUTHORIZATION_REQUIRED')");await frame('observer-denied')
  await evaluate('sourceFailure.fail()');await click('Check original task');await wait("document.body.textContent.includes('Latest check could not be completed')");await frame('observation-failed')
  for(const scenario of ['writer','confirmed','retired']){await evaluate(`sourceFailure.scenario(${JSON.stringify(scenario)});document.querySelector('.launch-surface').scrollTop=0`);await paint();await frame(scenario+'-wide-dark')}
  const facts=await evaluate('sourceFailure.facts()');assert.equal(facts.effects,0);assert(facts.prompt.includes('newer private draft'));assert.equal(facts.calls.launches.length,0);assert.equal(facts.calls.submissions.length,0);receipt.facts=facts;receipt.passed=true
 }catch(error){receipt.failure={message:error.message,stack:error.stack};process.exitCode=1}
 finally{await fs.writeFile(path.join(output,'ui-receipt.json'),JSON.stringify(receipt,null,2));window?.destroy();app.exit(process.exitCode||0)}
})
