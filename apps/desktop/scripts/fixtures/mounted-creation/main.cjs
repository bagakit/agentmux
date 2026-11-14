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
  const paint=async()=>{await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await delay(120)}
  const wait=async expression=>{for(let n=0;n<160;n++){if(await evaluate(expression))return;await delay(50)}throw Error('Missing Renderer condition: '+expression)}
  const frame=async name=>{await paint();const file=name+'.png';await fs.writeFile(path.join(output,file),(await window.webContents.capturePage()).toPNG());receipt.frames.push(file)}
  const click=async label=>{await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(label)}).click()`);await paint()}
  await window.loadFile(html);window.webContents.debugger.attach('1.3')
  await wait('Boolean(window.mountedCreation && Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="Continue original request"))')
  for(const [name,width,height,theme] of [['wide-dark',1180,850,'dark'],['wide-light',1180,850,'light'],['narrow-dark',460,760,'dark'],['short-dark',840,430,'dark']]){
   await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false})
   await evaluate(`mountedCreation.theme(${JSON.stringify(theme)});document.querySelector('.full-page-loading .surface-state').scrollTop=0`);await paint()
   const layout=await evaluate(`(()=>{const s=document.querySelector('.full-page-loading');return{width:s.clientWidth,scrollWidth:s.scrollWidth,buttons:Array.from(s.querySelectorAll('button')).map(b=>({label:b.textContent,width:b.getBoundingClientRect().width}))}})()`)
   assert.equal(layout.width,layout.scrollWidth,'No horizontal overflow');assert.ok(layout.buttons.every(b=>b.width>60),'Actions retain readable width')
   receipt.checks.push({name,layout});await frame(name)
   if(name==='short-dark'){
    const point=await evaluate("(()=>{const r=document.querySelector('.full-page-loading .surface-state').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()")
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:2000});await paint()
    const scrolling=await evaluate("(()=>{const s=document.querySelector('.full-page-loading .surface-state'),draft=document.querySelector('textarea').getBoundingClientRect(),r=s.getBoundingClientRect();return{top:s.scrollTop,draftVisible:draft.bottom>r.top&&draft.top<r.bottom}})()")
    assert(scrolling.top>0&&scrolling.draftVisible,'Native wheel reaches private draft');receipt.checks.push({name:'short-wheel-bottom',scrolling});await frame('short-dark-bottom')
    await evaluate("Array.from(document.querySelectorAll('summary')).find(s=>s.textContent==='Original request details').click()")
    await paint();await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:2000});await paint()
    const details=await evaluate("(()=>{const s=document.querySelector('.full-page-loading .surface-state'),d=Array.from(document.querySelectorAll('details')).find(d=>d.querySelector('summary').textContent==='Original request details'),r=d.getBoundingClientRect(),v=s.getBoundingClientRect();return{open:d.open,top:s.scrollTop,visible:r.bottom>v.top&&r.top<v.bottom,text:d.textContent,badge:Boolean(d.querySelector('.agent-work-mode-badge'))}})()")
    assert(details.open&&details.top>0&&details.visible&&details.badge&&details.text.includes('original-creation-'),'Original request, identity and mode badge remain reachable');receipt.checks.push({name:'short-original-details',details});await frame('short-dark-details')
    await evaluate("Array.from(document.querySelectorAll('summary')).find(s=>s.textContent==='Original request details').click()")
   }
  }
  await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:1180,height:850,deviceScaleFactor:1,mobile:false})
  await evaluate("mountedCreation.failObservation();document.querySelector('.full-page-loading .surface-state').scrollTop=0")
  await click('Check original status');await wait('document.body.textContent.includes("Latest observation:")')
  await frame('observation-failed')
  for(const variant of ['confirmed','retired']){await evaluate(`mountedCreation.scenario(${JSON.stringify(variant)})`);await click('Check original status');await wait(`document.body.textContent.includes(${JSON.stringify(variant==='confirmed'?'Original Agent confirmed':'Original Session retired')})`);await frame(variant)}
  const facts=await evaluate('mountedCreation.facts()');assert.equal(facts.effectCount,0);assert.ok(facts.draft.includes('private draft unsent'))
  receipt.facts=facts;receipt.passed=true
 }catch(error){receipt.failure={message:error.message,stack:error.stack};process.exitCode=1}
 finally{await fs.writeFile(path.join(output,'ui-receipt.json'),JSON.stringify(receipt,null,2));window?.destroy();app.exit(process.exitCode||0)}
})
