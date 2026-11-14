const {app,BrowserWindow}=require('electron')
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict')
const [html,profile,output]=process.argv.slice(2)
app.setPath('userData',profile);app.disableHardwareAcceleration()
const receipt={frames:[],checks:[],console:[],passed:false}
let window
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
app.whenReady().then(async()=>{
 try{
  window=new BrowserWindow({show:false,width:1180,height:850,webPreferences:{backgroundThrottling:false,sandbox:false}})
  window.webContents.on('console-message',(_e,_level,message)=>receipt.console.push(message.slice(0,500)))
  const evaluate=code=>window.webContents.executeJavaScript(code,true)
  const paint=async()=>{await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await delay(140)}
  const wait=async expression=>{for(let n=0;n<200;n++){if(await evaluate(expression))return;await delay(50)}throw Error('Missing actual Renderer condition: '+expression)}
  const frame=async name=>{await paint();const file=name+'.png';await fs.writeFile(path.join(output,file),(await window.webContents.capturePage()).toPNG());receipt.frames.push(file)}
  await window.loadFile(html);window.webContents.debugger.attach('1.3')
  const pointer=async(label)=>{
   const point=await evaluate(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(label)});if(!b)throw Error('Missing button');const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
   for(const type of ['mouseMoved','mousePressed','mouseReleased'])await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...point,...(type==='mouseMoved'?{}:{button:'left',clickCount:1})})
   await paint()
  }
  const metrics=async(width,height,theme)=>{
   await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false})
   await evaluate(`memberWorkface.theme(${JSON.stringify(theme)})`);await paint()
  }
  await wait('Boolean(window.memberWorkface&&memberWorkface.facts().resizes.length)')
  for(const [name,width,height,theme] of [['wide-dark',1180,850,'dark'],['wide-light',1180,850,'light'],['narrow-dark',460,760,'dark'],['narrow-light',460,760,'light'],['short-dark',840,430,'dark']]){
   await metrics(width,height,theme)
   const layout=await evaluate(`(()=>{const surface=document.querySelector('.mounted-space-agent'),terminal=surface.querySelector('.mounted-space-agent__terminal'),stage=surface.querySelector('.agent-terminal-stage'),composer=surface.querySelector('.agent-input-stack');return{width:surface.clientWidth,scrollWidth:surface.scrollWidth,terminal:terminal.getBoundingClientRect().toJSON(),stage:stage.getBoundingClientRect().toJSON(),composer:composer.getBoundingClientRect().toJSON(),facts:memberWorkface.facts()}})()`)
   assert.equal(layout.width,layout.scrollWidth,'Common workface has no horizontal overflow')
   assert(Math.abs(layout.terminal.height-layout.stage.height)<2,'Original terminal fills the shared reading stage')
   assert(layout.facts.terminal.every(t=>t.cols>1&&t.rows>1),'Real xterm has usable measured dimensions')
   receipt.checks.push({name,layout});await frame(name)
   if(name==='short-dark'){
    const point=await evaluate("(()=>{const r=document.querySelector('.mounted-space-region').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()")
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:1500});await paint()
    const reach=await evaluate("(()=>{const a=document.querySelector('[aria-label=\"Send new message\"]'),r=a.getBoundingClientRect();return{top:r.top,bottom:r.bottom,height:innerHeight,text:document.querySelector('[role=\"textbox\"]').textContent}})()")
    assert(reach.top>=0&&reach.bottom<=height,'Native wheel keeps full original input action reachable')
    assert(reach.text.includes('private draft'),'Original draft preserved');receipt.checks.push({name:'short-actions-native-wheel',reach});await frame('short-actions')
   }
  }
  await metrics(1180,850,'dark');await pointer('Conversation')
  await wait('document.body.textContent.includes("Actual Source conversation, original D answer.")')
  await frame('conversation-wide-dark')
  await metrics(460,760,'light');await frame('conversation-narrow-light')
  await pointer('Terminal');await wait('Boolean(document.querySelector(".mounted-space-agent__terminal:not([hidden])"))')
  await evaluate('memberWorkface.failUpdates()');await frame('observation-unconfirmed')
  await metrics(1180,850,'dark');await evaluate('memberWorkface.split()');await wait('document.querySelectorAll(".mounted-space-agent").length===2');await paint()
  await frame('split-dark')
  const handle=await evaluate("(()=>{const r=document.querySelector('[data-panel-resize-handle-id]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()")
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...handle})
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',...handle,button:'left',clickCount:1})
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:handle.x+90,y:handle.y,buttons:1})
  await paint();const during=await evaluate('memberWorkface.facts().resizes.length')
  await delay(100);assert.equal(await evaluate('memberWorkface.facts().resizes.length'),during,'No settled PTY resize while the actual split handle is dragging')
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',x:handle.x+90,y:handle.y,button:'left',clickCount:1})
  await wait(`memberWorkface.facts().resizes.length>${during}`);await frame('split-after-drag')
  const facts=await evaluate('memberWorkface.facts()');assert.equal(facts.sessions,0);assert.deepEqual(facts.controls,[]);assert(facts.draft.includes('private draft'))
  receipt.checks.push({name:'actual-pointer-split-release',during,after:facts.resizes.length});receipt.facts=facts;receipt.passed=true
 }catch(error){receipt.failure={message:error.message,stack:error.stack};process.exitCode=1}
 finally{await fs.writeFile(path.join(output,'ui-receipt.json'),JSON.stringify(receipt,null,2));window?.destroy();app.exit(process.exitCode||0)}
})
