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
 const button=async name=>{await evaluate(`(()=>{const e=Array.from(document.querySelectorAll('.mesh-settings-pane button')).find(e=>!e.closest('[hidden]')&&e.textContent.trim()===${JSON.stringify(name)});if(!e)throw Error('Missing visible action '+${JSON.stringify(name)});e.click()})()`);await delay(200)}
 const nav=field=>click('.settings-sidebar nav [data-settings-target="hosts'+(field?':'+field:'')+'"]')
 const frame=async name=>{await evaluate('document.fonts.ready');await delay(350);await fs.writeFile(path.join(output,name+'.png'),(await window.webContents.capturePage()).toPNG());receipt.frames.push(name+'.png');receipt.frameOverflow??={};receipt.frameOverflow[name]=await evaluate('document.documentElement.scrollWidth>window.innerWidth')}
 const pathVisibility=async name=>{const value=await evaluate("(()=>{const c=document.querySelector('.mesh-explorer__canvas').getBoundingClientRect();return Array.from(document.querySelectorAll('.react-flow__node')).filter(e=>e.querySelector('[data-on-path]')).map(e=>{const r=e.getBoundingClientRect();return {id:e.dataset.id,inside:r.left>=c.left-1&&r.right<=c.right+1&&r.top>=c.top-1&&r.bottom<=c.bottom+1}})})()");assert.ok(value.length>=3&&value.every(e=>e.inside),'the selected '+name+' must be fully visible beside the inspector');receipt.pathVisibility??={};receipt.pathVisibility[name]=value}
 const top=()=>evaluate("document.querySelector('[data-mesh-view]:not([hidden])').scrollTop=0")
 await fs.mkdir(output,{recursive:true})
 await window.loadURL(url);await wait('[data-mesh-topology]');await delay(1100)
 assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.settings-nav-children button')).map(e=>e.textContent.trim())"),['Gateways','Machines','Device connections'])
 assert.equal(await evaluate("document.querySelectorAll('[data-cluster-host]').length"),6)
 assert.equal(await evaluate("Boolean(document.querySelector('[aria-label=\"Selected network object\"]'))"),false)
 await wait('.mesh-explorer-edge path')
 for(let i=0;i<150;i++){if(await evaluate('document.querySelector(".cluster-machines-coverage").textContent.includes("4 / 6")'))break;await delay(50)}
 await frame('overview-dark')
 await evaluate('meshFixture.theme("light")');await frame('overview-light');await evaluate('meshFixture.theme("dark")')
 await click('[aria-label="Advertised gateways"] li:nth-child(2) button');await frame('gateway-selected-dark');await button('Clear')
 // Real browser input crosses ReactFlow's pointer/drag handlers. Only this private window is addressed.
 window.webContents.debugger.attach('1.3')
 await evaluate("window.meshPointerEvents=[];for(const type of ['pointerdown','pointermove','pointerup','mousedown','mousemove','mouseup'])document.addEventListener(type,e=>{if(window.meshPointerEvents.length<40)window.meshPointerEvents.push({type:e.type,x:e.clientX,y:e.clientY,button:e.button,buttons:e.buttons,node:e.target.closest?.('.react-flow__node')?.dataset.id,tag:e.target.tagName})},true)")
 const point=await evaluate("(()=>{const bounds=document.querySelector('.mesh-explorer__canvas').getBoundingClientRect();const e=Array.from(document.querySelectorAll('.react-flow__node')).sort((a,b)=>Math.abs(a.getBoundingClientRect().y-(bounds.top+bounds.bottom)/2)-Math.abs(b.getBoundingClientRect().y-(bounds.top+bounds.bottom)/2)).find(e=>{const r=e.getBoundingClientRect();return r.left>bounds.left+50&&r.right<bounds.right-50&&r.top>bounds.top+30&&r.bottom<bounds.bottom-45});if(!e)throw Error('No visible draggable peer');const r=e.getBoundingClientRect();return {id:e.dataset.id,x:r.x+Math.min(50,r.width/2),y:r.y+r.height/2,left:r.left,top:r.top}})()")
 await frame('drag-before')
 await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y,button:'none',buttons:0})
 await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',buttons:1,clickCount:1})
 await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+4,y:point.y+2,button:'left',buttons:1});await delay(30)
 await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+25,y:point.y+7,button:'left',buttons:1});await delay(160);await frame('drag-during')
 await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+38,y:point.y+12,button:'left',buttons:1});await delay(50)
 await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x+38,y:point.y+12,button:'left',buttons:0,clickCount:1});await delay(160);await frame('drag-after')
 const moved=await evaluate('(()=>{const e=Array.from(document.querySelectorAll(".react-flow__node")).find(e=>e.dataset.id==='+JSON.stringify(point.id)+');const r=e.getBoundingClientRect();return {left:r.left,top:r.top}})()')
 receipt.drag={before:point,after:moved,actualInput:'CDP Input.dispatchMouseEvent',events:await evaluate('window.meshPointerEvents')}
 assert.ok(Math.hypot(moved.left-point.left,moved.top-point.top)>10,'the actual graph node must move through pointer handlers')
 window.webContents.debugger.detach()
 await click('[aria-label="Rearrange observed topology"]');await delay(550)
 await click('.mesh-explorer__categories button:nth-child(2)');await click('[data-mesh-object=route]');await frame('endpoint-dark');await pathVisibility('available-route')
 await click('[aria-label="Network scope"] button:nth-child(2)');await frame('selected-path-dark')
 await click('.mesh-explorer__categories button:nth-child(3)');await click('[data-mesh-object=circuit]');await frame('adopted-circuit-dark');await pathVisibility('adopted-circuit')
 await evaluate('meshFixture.theme("light")');await click('[aria-label="Network view"] button:nth-child(2)');await frame('list-light');await evaluate('meshFixture.theme("dark")');await frame('list-dark');await evaluate('meshFixture.theme("light")')
 window.setContentSize(560,930);await top();await frame('overview-narrow-light');await evaluate('meshFixture.theme("dark")');await frame('overview-narrow-dark')
 await click('[aria-label="Network view"] button:first-child');await click('[aria-label="Fit observed topology"]');await frame('overview-narrow-graph-dark')
 await evaluate("document.querySelector('.cluster-machines').scrollIntoView({block:'start'})");await frame('devices-narrow-dark')
 await type('[aria-label="Filter saved devices"]','studio');assert.equal(await evaluate("document.querySelectorAll('[data-cluster-host]').length"),1);await frame('devices-filter-narrow-dark')
 await type('[aria-label="Filter saved devices"]','no-such-device');assert.equal(await evaluate("document.querySelectorAll('[data-cluster-host]').length"),0);await frame('devices-filter-empty-narrow-dark');await type('[aria-label="Filter saved devices"]','')
 await evaluate(`(()=>{const element=document.querySelector('[aria-label="Settings section"]');element.focus();element.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`)
 await wait('.settings-section-menu [data-settings-target="hosts:mesh-machines"]')
 await evaluate(`document.querySelector('.settings-section-menu [data-settings-target="hosts:mesh-machines"]').scrollIntoView({block:'center'})`)
 await frame('narrow-mesh-menu')
 await click('.settings-section-menu [data-settings-target="hosts:mesh-machines"]')
 assert.equal(await evaluate("document.querySelector('[data-mesh-home-view]').dataset.meshHomeView"),'machines')
 window.setContentSize(1440,1050);await top();await nav('mesh-machines');await wait('[data-cluster-host="farm-cn1"]');for(let i=0;i<160;i++){if(await evaluate('document.querySelector(".cluster-machines-coverage").textContent.includes("4 / 6")'))break;await delay(50)};assert.ok(await evaluate('document.querySelector(".cluster-machines-coverage").textContent.includes("4 / 6")'),'mixed observed/withheld/unavailable coverage');await frame('machines-dark')
 await evaluate('meshFixture.theme("light")');window.setContentSize(560,930);await frame('machines-narrow-light')
 window.setContentSize(1440,1050);await evaluate('meshFixture.theme("dark")');await nav();await top();await nav('mesh-configuration');await wait('[aria-label="Mesh network"]');await type('[aria-label="Mesh network"]','unsaved-network-draft');await frame('gateway-draft-dark')
 await button('← Mesh overview');await nav('mesh-machines');await nav();await nav('mesh-configuration');assert.equal(await evaluate('document.querySelector("[aria-label=\\"Mesh network\\"]").value'),'unsaved-network-draft','original Gateway draft retained after returning through homepage')
 receipt.draftRetainedAcrossViews=true
 await button('← Mesh overview');await click('[data-cluster-host="farm-cn1"] .cluster-machine-manage');await wait('[data-resource-editor="farm-cn1"]');await type('[data-resource-editor="farm-cn1"] [data-host-name]','Farm CN1 draft');await frame('device-editor-dark')
 await button('← Mesh overview');await nav('mesh-machines');await nav();await click('[data-cluster-host="farm-cn1"] .cluster-machine-manage');assert.equal(await evaluate('document.querySelector("[data-resource-editor=\\"farm-cn1\\"] [data-host-name]").value'),'Farm CN1 draft');receipt.hostDraftRetainedAcrossViews=true
 await button('← Mesh overview');await button('Add device');await wait('[data-resource-editor] [data-host-name]');await frame('add-device-dark')
 await button('← Mesh overview');await top();await click('[aria-label="Network view"] button:first-child');await button('Clear');await click('[aria-label="Network scope"] button:first-child');await click('[aria-label="Fit observed topology"]');await frame('overview-final-dark')
 window.setContentSize(1440,720);await top();await frame('overview-short-dark')
 await window.loadURL(url+'?scenario=initial');await wait('.mesh-explorer__world img')
 await wait('[aria-label="Saved gateway targets"]')
 assert.equal(await evaluate("document.querySelectorAll('.mesh-explorer-node').length"),0)
 assert.equal(await evaluate("document.querySelectorAll('[data-cluster-host]').length"),6)
 window.setContentSize(1440,950);await frame('mesh-disabled-dark')
 window.setContentSize(560,930);await frame('mesh-disabled-narrow-dark')
 receipt.overflow=Object.values(receipt.frameOverflow).some(Boolean)
 assert.equal(receipt.overflow,false,'every full frame fits horizontally')
 receipt.passed=true
}catch(error){receipt.failure={message:error.message,stack:error.stack};process.exitCode=1}finally{await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'capture.json'),JSON.stringify(receipt,null,2));window?.destroy();app.exit(receipt.passed?0:1)}})
