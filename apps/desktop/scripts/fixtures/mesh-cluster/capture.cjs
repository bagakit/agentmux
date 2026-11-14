const {app,BrowserWindow}=require('electron'),fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict')
const [url,profile,output]=process.argv.slice(2)
app.setPath('userData',path.resolve(profile));app.disableHardwareAcceleration()
const delay=ms=>new Promise(done=>setTimeout(done,ms)),receipt={captureOnly:true,aestheticReview:'pending-independent-review',passed:false,frames:[],console:[],boundary:'Production SettingsPanel and Mesh components inside private Electron; controlled mesh/resource observations. Actual original Core/RPC/Native consumers are proven separately.'}
let window
app.whenReady().then(async()=>{try{
 window=new BrowserWindow({show:false,width:1440,height:1050,webPreferences:{backgroundThrottling:false,sandbox:false}})
 window.webContents.on('console-message',(_event,_level,text)=>{if(receipt.console.length<40)receipt.console.push(text.slice(0,500))})
 const evaluate=code=>window.webContents.executeJavaScript(code,true)
 const wait=async selector=>{for(let i=0;i<240;i++){if(await evaluate('Boolean(document.querySelector('+JSON.stringify(selector)+'))'))return;await delay(50)}throw Error('Missing rendered product '+selector)}
 const click=async selector=>{await wait(selector);await evaluate('document.querySelector('+JSON.stringify(selector)+').click()');await delay(180)}
 const type=async(selector,value)=>{await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`);await delay(150)}
 const tab=async name=>{await evaluate(`Array.from(document.querySelectorAll('.mesh-view-tabs button')).find(e=>e.textContent===${JSON.stringify(name)}).click()`);await delay(200)}
 const frame=async name=>{await evaluate('document.fonts.ready');await delay(450);await fs.writeFile(path.join(output,name+'.png'),(await window.webContents.capturePage()).toPNG());receipt.frames.push(name+'.png')}
 await window.loadURL(url);await wait('[data-mesh-topology]');await delay(1000);await frame('paths-dark')
 await click('.mesh-explorer__categories button:nth-child(2)');await click('[data-mesh-object=route]');await frame('endpoint-dark')
 await click('[aria-label="Network scope"] button:nth-child(2)');await frame('selected-path-dark')
 await click('.mesh-explorer__categories button:nth-child(3)');await click('[data-mesh-object=circuit]');await frame('adopted-circuit-dark')
 await evaluate('meshFixture.theme("light")');await click('[aria-label="Network view"] button:nth-child(2)');await frame('list-light')
 window.setContentSize(560,930);await frame('paths-narrow-light');await evaluate('meshFixture.theme("dark")');await frame('paths-narrow-dark')
 window.setContentSize(1440,1050);await tab('Machines');await wait('[data-cluster-host="farm-cn1"]');for(let i=0;i<160;i++){if(await evaluate('document.querySelector(".cluster-machines-coverage").textContent.includes("4 / 6")'))break;await delay(50)};assert.ok(await evaluate('document.querySelector(".cluster-machines-coverage").textContent.includes("4 / 6")'),'mixed observed/withheld/unavailable coverage');await frame('machines-dark')
 await evaluate('meshFixture.theme("light")');await frame('machines-light');window.setContentSize(560,930);await frame('machines-narrow-light');await evaluate('meshFixture.theme("dark")');await frame('machines-narrow-dark')
 window.setContentSize(1440,1050);await click('[aria-label="Machine status filter"] button:nth-child(3)');await frame('machines-attention-dark')
 await tab('Gateway');await wait('[aria-label="Mesh network"]');await type('[aria-label="Mesh network"]','unsaved-network-draft');await frame('gateway-draft-dark')
 await tab('Machines');await tab('Paths');await tab('Gateway');assert.equal(await evaluate('document.querySelector("[aria-label=\\"Mesh network\\"]").value'),'unsaved-network-draft','original Gateway draft retained after observation tabs')
 receipt.draftRetainedAcrossViews=true
 receipt.overflow=await evaluate('document.documentElement.scrollWidth>window.innerWidth')
 receipt.passed=true
}catch(error){receipt.failure={message:error.message,stack:error.stack};process.exitCode=1}finally{await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'capture.json'),JSON.stringify(receipt,null,2));window?.destroy();app.exit(receipt.passed?0:1)}})
