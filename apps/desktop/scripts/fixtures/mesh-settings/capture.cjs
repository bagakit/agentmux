const {app,BrowserWindow}=require('electron'),fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict')
const [url,profile,output]=process.argv.slice(2)
app.setPath('userData',path.resolve(profile));app.disableHardwareAcceleration()
const delay=ms=>new Promise(r=>setTimeout(r,ms));const receipt={captureOnly:true,visualReview:'pending-independent-review',frames:[],console:[],passed:false,boundary:'Production Settings/components/theme using controlled observations; separate actual Unix Core/Native tests prove transport.'}
let window
app.whenReady().then(async()=>{try{
 window=new BrowserWindow({show:false,width:1280,height:980,webPreferences:{backgroundThrottling:false,sandbox:false}})
 window.webContents.on('console-message',(_event,_level,text)=>{if(receipt.console.length<40)receipt.console.push(text.slice(0,500))})
 const evaluate=code=>window.webContents.executeJavaScript(code,true)
 await window.loadURL(url)
 const openGateway=()=>evaluate('Array.from(document.querySelectorAll(".mesh-overview-actions button")).find(button=>button.textContent==="Gateway")?.click()')
 await openGateway()
 for(let i=0;i<250;i++){if(await evaluate('Boolean(document.querySelector("[aria-label=\\"Mesh network\\"]"))'))break;await delay(40)}
 assert.equal(await evaluate('Boolean(document.querySelector("[data-mesh-settings]"))'),true,'actual Settings Mesh editor mounted')
 const paint=async()=>{await evaluate('document.fonts.ready');await delay(400)}
 const frame=async name=>{await paint();const file=name+'.png';await fs.writeFile(path.join(output,file),(await window.webContents.capturePage()).toPNG());receipt.frames.push(file)}
 await frame('wide-dark')
 await evaluate('meshFixture.theme("light")');await frame('wide-light')
 window.setContentSize(520,900);await evaluate('meshFixture.theme("dark")');await frame('narrow-dark')
 window.setContentSize(1280,980);await evaluate('meshFixture.failure();document.querySelector(".mesh-network-heading button").click()');await frame('failed-new-listener')
 window.webContents.debugger.attach('1.3'); const point=await evaluate('(()=>{const r=document.querySelector("[data-mesh-view=network]").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()'); await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaY:2400,deltaX:0});await paint();assert.ok(await evaluate('document.querySelector("[data-mesh-view=network]").scrollTop>0'),'actual native wheel scrolls the Mesh network fields');await frame('lower-fields')
 await evaluate('document.querySelector(".mesh-access-links").open=true;meshFixture.endpoint();document.querySelector(".mesh-network-heading button").click()');await paint();await evaluate('document.querySelector("[data-settings-field=mesh-link]").scrollIntoView({block:"end"})');await frame('original-host-endpoint')
 await evaluate(`(()=>{const e=document.querySelector('[aria-label="Original Mesh endpoint offer"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,JSON.stringify(meshFixture.originalOffer));e.dispatchEvent(new Event('input',{bubbles:true}))})()`);await paint();await evaluate('document.querySelector("[data-settings-field=mesh-link]>button").click()');await paint();await evaluate('document.querySelector(".mesh-link-result details").open=true;document.querySelector(".mesh-link-result").scrollIntoView({block:"center"})');await frame('original-link-identity')
 await evaluate('document.querySelector(".mesh-editor-navigation button").click();Array.from(document.querySelectorAll(".mesh-overview-actions button")).find(button=>button.textContent==="Manage devices").click()');await frame('saved-connections')
 for (const scenario of ['initial','unavailable','settings-error']) {
  window.setContentSize(1280,980);await window.loadURL(url+'?scenario='+scenario);await openGateway()
  const selector=scenario==='initial'?'[aria-label="Mesh network"]':'.mesh-availability details';for(let i=0;i<200;i++){if(await evaluate('Boolean(document.querySelector('+JSON.stringify(selector)+'))'))break;await delay(30)}
  await frame(scenario+'-dark')
  if(scenario!=='settings-error') {
   await evaluate('meshFixture.theme("light")');await frame(scenario+'-light')
   window.setContentSize(520,900);await frame(scenario+'-narrow-light')
   await evaluate('meshFixture.theme("dark")');await frame(scenario+'-narrow-dark')
  }
 }
 receipt.overflow=await evaluate('Array.from(document.querySelectorAll("[data-mesh-settings] input,[data-mesh-settings] textarea")).map(e=>({label:e.getAttribute("aria-label"),width:e.getBoundingClientRect().width}))')
 receipt.passed=true
}catch(error){receipt.failure={message:error.message,stack:error.stack};process.exitCode=1}finally{await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'capture.json'),JSON.stringify(receipt,null,2));window?.destroy();app.exit(receipt.passed?0:1)}})
