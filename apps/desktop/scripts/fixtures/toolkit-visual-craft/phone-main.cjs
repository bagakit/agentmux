const {app,BrowserWindow,Menu}=require('electron'),fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto')
const [html,_owner,_preload,privateRoot,evidence,stage]=process.argv.slice(2)
for(const key of ['home','userData','sessionData'])app.setPath(key,path.join(privateRoot,key))
const raw={completed:false,frames:[],controlledDTO:true,physicalPhone:false,boundary:'Actual Phone component and full product CSS in private Chromium. Synthetic typed result is presentation only; no Host query or system clipboard.'}
app.on('window-all-closed',()=>{})
app.whenReady().then(async()=>{let win
 try{
  Menu.setApplicationMenu(null);win=new BrowserWindow({width:740,height:920,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}})
  await win.loadFile(html)
  const read=code=>win.webContents.executeJavaScript(code),pause=ms=>new Promise(r=>setTimeout(r,ms))
  const until=async code=>{for(let i=0;i<150;i++){if(await read(code))return;await pause(20)}throw Error('Private phone condition not reached: '+code)}
  const frame=async(file,width,height,theme,scene)=>{
    win.setContentSize(width,height);await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await pause(120)
    const facts=await read(`(()=>{
      const state=document.querySelector('.phone-connection__code-state'),card=document.querySelector('.phone-link-card__frame')
      return{width:innerWidth,height:innerHeight,documentWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,
        appearance:document.documentElement.dataset.appearance,statusGap:state&&card?card.getBoundingClientRect().top-state.getBoundingClientRect().bottom:null}
    })()`)
    assert.ok(facts.scrollWidth<=facts.documentWidth);assert.equal(facts.appearance,theme)
    if(facts.statusGap!==null)assert.ok(facts.statusGap>=8,'The full connection status stays above the QR frame with readable separation')
    const image=await win.webContents.capturePage(),bytes=image.toPNG();await fs.writeFile(path.join(evidence,file),bytes)
    raw.frames.push({file,theme,scene,actualCSS:facts,sha256:createHash('sha256').update(bytes).digest('hex')})
  }
  await until('!!window.phoneLinkScene');await read("window.phoneLinkScene.show('light')");await until("!!document.querySelector('.phone-connection__buttons')")
  await frame('phone-current-light-wide.png',740,920,'light','current')
  await read("window.phoneLinkScene.show('dark')");await until("document.documentElement.dataset.appearance==='dark'")
  await frame('phone-current-dark-narrow.png',390,860,'dark','current')
  // Native renderer input reaches the actual product action; the port remains a controlled DTO.
  const rect=await read("(()=>{const n=document.querySelector('.phone-connection__buttons button'),r=n.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()")
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...rect});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...rect})
  await until("document.querySelector('.phone-connection__buttons button').textContent.includes('Reading current link')")
  await frame('phone-pending-dark-narrow.png',390,860,'dark','pending')
  await read("window.phoneLinkScene.show('light',true)");await until("!!document.querySelector('.phone-connection__service')")
  await read("document.querySelector('.phone-connection__link').open=true")
  await frame('phone-saved-light-narrow.png',390,960,'light','saved-details')
  assert.deepEqual(await read('window.phoneLinkScene.copies'),[]);raw.completed=true
  await fs.writeFile(path.join(evidence,stage+'-scene.json'),JSON.stringify(raw,null,2)+'\n');win.destroy();app.exit(0)
 }catch(error){raw.errorName=error.name;raw.failure=error.stack;await fs.writeFile(path.join(evidence,stage+'-scene.json'),JSON.stringify(raw,null,2)+'\n');console.error(raw.failure);win?.destroy();app.exit(1)}
})
