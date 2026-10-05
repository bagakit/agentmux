const {app,BrowserWindow,Menu,ipcMain,nativeImage}=require('electron')
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict')
const [html,privateRoot,evidence]=process.argv.slice(2)
app.setPath('userData',path.join(privateRoot,'userData'))
const result={passed:false,pid:process.pid,images:[],operations:[],errors:[],immutableReads:0}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
app.whenReady().then(async()=>{
 let win
 try{
  Menu.setApplicationMenu(null)
  const workspacePath=path.join(privateRoot,'workspace','.agentmux','scratch'),original=path.join(workspacePath,'topic--launcher--leader')
  await fs.mkdir(original,{recursive:true})
  const originalFiles=require(path.join(path.dirname(html),'avatar-files.cjs'))
  const png=await fs.readFile(path.resolve(__dirname,'../../../src/renderer/src/assets/pmo-teams-topic-avatar.png'))
  const ref=await originalFiles.saveObjectAvatarFile(original,png)
  ipcMain.handle('fixture:read-immutable-avatar',async(_event,requested)=>{
   assert.deepEqual(requested,ref)
   const saved=await originalFiles.readObjectAvatarFile(original,requested);result.immutableReads++
   const size=nativeImage.createFromBuffer(saved).getSize()
   return {dataUrl:'data:image/png;base64,'+saved.toString('base64'),width:size.width,height:size.height}
  })
  win=new BrowserWindow({width:1080,height:850,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,preload:path.join(__dirname,'avatar-preload.cjs')}})
  win.webContents.on('console-message',(_event,details)=>{if(details.level==='error')result.errors.push(details.message)})
  await win.loadFile(html,{query:{workspacePath,avatarVisual:'true'}})
  const read=script=>win.webContents.executeJavaScript(script)
  const wait=async script=>{for(let i=0;i<100;i++){if(await read(script))return;await pause(30)}throw Error('Timed out: '+script)}
  const click=async selector=>{
   const point=await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing original control');n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);if(!hit||!n.contains(hit))throw Error('Original control is covered');return {x,y}})()`)
   for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,x:Math.round(point.x),y:Math.round(point.y),button:'left',clickCount:1})
   await pause(160);result.operations.push({action:'trusted-click',selector,...point})
  }
  const escape=async()=>{for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode:'Escape'});await pause(160)}
  await wait('!!window.moteQuick && !!document.querySelector("[data-mote-details]")')
  for(const [kind,choice]of [['image',ref],['glyph','rocket']]){
   await read('moteQuick.seedAvatar('+JSON.stringify(choice)+')');await pause(160)
   await click('[data-mote-details] [aria-label="Change Mote avatar"]')
   await wait('!!document.querySelector(".space-icon-picker")')
   assert.equal(await read('document.querySelector("[data-avatar-source=alternative]").getAttribute("aria-pressed")'),'true')
   assert.equal(await read('document.querySelector("[data-avatar-source=face]").getAttribute("aria-pressed")'),'false')
   assert.equal(await read('document.querySelector(".mote-avatar-alternative").hidden'),false)
   if(kind==='image'){
    await wait('(()=>{const n=document.querySelector(".mote-avatar-preview img");return !!n&&n.complete&&n.naturalWidth>0})()')
    assert.equal(await read('document.querySelector(".mote-avatar-preview [data-space-avatar]").dataset.spaceAvatar'),ref.fileName)
   }else{
    assert.equal(await read('document.querySelector("[data-space-icon-choice=rocket]").getAttribute("aria-pressed")'),'true')
    assert.equal(await read('document.querySelector(".mote-avatar-preview [data-space-icon]").dataset.spaceIcon'),'rocket')
   }
   const facts=await read('({state:moteQuick.facts(),alternative:document.querySelector("[data-avatar-source=alternative]").getAttribute("aria-pressed"),preview:document.querySelector(".mote-avatar-preview").innerHTML,saveLabel:document.querySelector(".space-icon-picker__save").getAttribute("aria-label")})')
   assert.equal(facts.saveLabel,'Save avatar');assert.equal(facts.state.calls.filter(call=>call.operation==='saveConfig'||call.operation==='write').length,0)
   const name='saved-'+kind+'-reopened.png'
   await fs.writeFile(path.join(evidence,name),(await win.webContents.capturePage()).toPNG());result.images.push(name);result.operations.push({action:'saved-source-reopened',kind,choice,...facts})
   await escape();assert.equal(await read('!!document.querySelector(".space-icon-picker")'),false)
  }
  assert.ok(result.immutableReads>0);assert.deepEqual(result.errors,[])
  result.immutableAsset={ref,bytes:png.length,owner:'Original isolated Mote directory; production saveObjectAvatarFile/readObjectAvatarFile transport'}
  result.passed=true
 }catch(error){result.error={message:error.message,stack:error.stack};if(win){result.failedFrame=await win.webContents.executeJavaScript('({text:document.body.textContent,html:document.body.innerHTML})').catch(()=>null);await fs.writeFile(path.join(evidence,'failed.png'),(await win.webContents.capturePage()).toPNG())}}
 finally{await fs.writeFile(path.join(evidence,'renderer-result.json'),JSON.stringify(result,null,2));win?.destroy();app.exit(result.passed?0:1)}
})
