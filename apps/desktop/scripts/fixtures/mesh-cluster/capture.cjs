const {app,BrowserWindow}=require('electron'),fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict')
const [url,profile,output,scope]=process.argv.slice(2)
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
 if(scope!=='geography'){
 await window.loadURL(url);await wait('[data-mesh-topology]');await delay(1100)
 assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.settings-nav-children button')).map(e=>e.textContent.trim())"),['Gateways','Machines','Device connections'])
 assert.equal(await evaluate("document.querySelectorAll('[data-cluster-host]').length"),6)
 assert.equal(await evaluate("Boolean(document.querySelector('[aria-label=\"Selected network object\"]'))"),false)
 await wait('.mesh-explorer-edge path')
 const graphFacts = () => evaluate(`(() => {
  const canvas = document.querySelector('.mesh-explorer__canvas')
  const paths = kind => [...canvas.querySelectorAll('.mesh-explorer-edge--' + kind + ' .react-flow__edge-path')]
  const saved = paths('saved'), relay = paths('relay')
  const touchesLocal = path => path.closest('[data-testid^="rf__edge-"]').getAttribute('aria-label').split(' ').includes('saved:client')
  return { graphs: canvas.querySelectorAll('.react-flow').length, hosts: canvas.querySelectorAll('[data-host-node]').length, saved: saved.length, relay: relay.length,
    sharedLocal: canvas.querySelectorAll('[data-id="saved:client"] [data-shared-local]').length,
    savedAtLocal: saved.filter(touchesLocal).length, relayAtLocal: relay.filter(touchesLocal).length,
    geography: Boolean(canvas.querySelector('.mesh-geography__atlas')),
    savedDashed: saved.every(path => getComputedStyle(path).strokeDasharray !== 'none'),
    relaySolid: relay.every(path => getComputedStyle(path).strokeDasharray === 'none') }
 })()`)
 receipt.mixed = await graphFacts()
 assert.deepEqual(receipt.mixed,{graphs:1,hosts:5,saved:5,relay:5,sharedLocal:1,savedAtLocal:5,relayAtLocal:2,geography:false,savedDashed:true,relaySolid:true})
 for(let i=0;i<150;i++){if(await evaluate('document.querySelector(".cluster-machines-coverage").textContent.includes("4 / 6")'))break;await delay(50)}
 await frame('overview-dark')
 window.setContentSize(560,930);await wait('.mesh-explorer__canvas[data-narrow]')
 for(let i=0;i<180;i++){
  if(await evaluate("document.querySelector('[aria-label=\"Rearrange observed topology\"]').textContent==='Arrange'"))break
  await delay(50)
 }
 await frame('mixed-narrow-dark')
 receipt.narrowType = await evaluate(`(() => {
  const card = document.querySelector('[data-shared-local]')
  const scale = card.getBoundingClientRect().width / card.offsetWidth
  const size = selector => parseFloat(getComputedStyle(card.querySelector(selector)).fontSize) * scale
  return { name: size('strong'), state: size('.mesh-explorer-node__state') }
 })()`)
 assert.ok(receipt.narrowType.name >= 10 && receipt.narrowType.state >= 7.5, 'narrow layout keeps the main node label and status legible at its default zoom')
 await evaluate('meshFixture.theme("light")');await frame('mixed-narrow-light')
 window.setContentSize(1440,1050)
 await evaluate('meshFixture.theme("light")');await frame('overview-light');await evaluate('meshFixture.theme("dark")')
 await click('[aria-label="Advertised gateways"] li:nth-child(2) button');await frame('gateway-selected-dark');await button('Clear')
 await click('.mesh-explorer__canvas [data-host-node="studio"]');await frame('mixed-saved-selected-dark');await button('Clear')
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
 receipt.focused = await graphFacts()
 assert.deepEqual(receipt.focused,receipt.mixed,'focusing the Relay path retains the same nodes, edge sources and line styles')
 assert.equal(await evaluate("document.querySelectorAll('.mesh-explorer-edge--saved.mesh-explorer-edge--muted').length"),5)
 assert.equal(await evaluate("document.querySelectorAll('.mesh-explorer-edge--relay.mesh-explorer-edge--selected').length"),2)
 await click('[aria-label="Network scope"] button:first-child')
 assert.equal(await evaluate("document.querySelectorAll('.mesh-explorer-edge--muted').length"),0,'returning to the full map restores link emphasis')
 await click('[aria-label="Network scope"] button:nth-child(2)')
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
 await evaluate('meshFixture.relayOff()');await button('Refresh network');await frame('relay-off-after-refresh')
 assert.equal((await graphFacts()).hosts,5)
 assert.equal((await graphFacts()).relay,0)
 await window.loadURL(url+'?scenario=initial');await wait('.mesh-explorer__canvas [data-host-node]')
 await wait('[aria-label="Saved gateway targets"]')
 const savedNodes = async () => (await graphFacts()).hosts
 assert.equal(await savedNodes(),8)
 for(let i=0;i<150;i++){if(await evaluate('document.querySelector(".cluster-machines-coverage").textContent.includes("4 / 9")'))break;await delay(50)}
 window.setContentSize(1440,950);await frame('mesh-disabled-dark')
 window.setContentSize(560,930);await frame('mesh-disabled-narrow-unselected')
 window.setContentSize(1440,950)
 await click('.mesh-explorer__canvas [data-host-node="studio"]');await frame('saved-device-selected-dark')
 await evaluate('meshFixture.theme("light")');await frame('mesh-disabled-light')
 window.setContentSize(560,930);await frame('mesh-disabled-narrow-light')
 await evaluate('meshFixture.theme("dark")');await frame('mesh-disabled-narrow-dark')
 receipt.savedOnly = await graphFacts()
 assert.deepEqual(receipt.savedOnly,{graphs:1,hosts:8,saved:8,relay:0,sharedLocal:0,savedAtLocal:8,relayAtLocal:0,geography:false,savedDashed:true,relaySolid:true})
 window.setContentSize(1440,950)
 await window.loadURL(url+'?scenario=empty');await wait('.mesh-explorer__no-connections')
 await frame('no-connections-dark')
 assert.equal(await evaluate("document.querySelector('.mesh-explorer__graph')"),null)
 } else {
  await window.loadURL(url+'?scenario=initial')
  await wait('.mesh-explorer__canvas [data-host-node]')
  assert.equal(await evaluate("document.querySelector('.mesh-explorer__canvas .mesh-geography__atlas')"),null)
  await frame('logical-no-locations-dark')
 }
 await window.loadURL(url+'?scenario=geography')
 await wait('[data-geographic-point="saved:client"] circle')
 await wait('.mesh-explorer-edge--relay path')
 await evaluate("document.querySelector('.mesh-explorer__canvas .mesh-geography__land').decode()")
 const geography = () => evaluate(`(() => {
  const atlas = document.querySelector('.mesh-geography__atlas').getBoundingClientRect()
  const canvas = document.querySelector('.mesh-explorer__canvas').getBoundingClientRect()
  const tray = document.querySelector('.mesh-geography__tray').getBoundingClientRect()
  const pins = Object.fromEntries([...document.querySelectorAll('[data-geographic-point]')].map(mark => {
    const pin = mark.querySelector('circle').getBoundingClientRect()
    return [mark.dataset.geographicPoint, {x: (pin.left + pin.width / 2 - atlas.left) / atlas.width, y: (pin.top + pin.height / 2 - atlas.top) / atlas.height}]
  }))
  const local = document.querySelector('[data-id="saved:client"]').getBoundingClientRect()
  const sameSite = document.querySelector('[data-id="saved:host:private"]').getBoundingClientRect()
  const saved = document.querySelector('[data-testid="rf__edge-saved:host:build"] .react-flow__edge-path').getAttribute('d')
  const loop = document.querySelector('[data-testid="rf__edge-saved:host:private"] .react-flow__edge-path').getAttribute('d')
  return { pins, atlasWidth: atlas.width, canvasWidth: canvas.width, atlasLeft: atlas.left, atlasTop: atlas.top,
    trayFits: tray.bottom <= canvas.bottom + 1 && tray.left >= canvas.left - 1 && tray.right <= canvas.right + 1,
    trayBeside: tray.left >= atlas.right, trayBelow: tray.top >= atlas.bottom, panStart: [atlas.left + atlas.width * .23, atlas.top + atlas.height * .68],
    bothLabels: sameSite.bottom <= local.top || sameSite.top >= local.bottom,
    savedAtEquator: saved.endsWith('500,250'), sameSiteLink: loop.includes(' C '), tray: document.querySelector('.mesh-geography__tray').textContent }
 })()`)
 await frame('geographic-overview-dark')
 receipt.geography = await geography()
 assert.equal(Object.keys(receipt.geography.pins).length,5)
 assert.ok(receipt.geography.bothLabels)
 assert.ok(receipt.geography.savedAtEquator)
 assert.ok(receipt.geography.sameSiteLink)
 assert.ok(receipt.geography.trayBeside && receipt.geography.atlasWidth / receipt.geography.canvasWidth > .68)
 assert.ok(receipt.geography.tray.includes('Location unknown5'))
 const closeTo = (actual, expected) => Math.abs(actual - expected) < .001
 assert.ok(closeTo(receipt.geography.pins['saved:client'].x, (121.4737 + 180) / 360))
 assert.ok(closeTo(receipt.geography.pins['saved:client'].y, (90 - 31.2304) / 180))
 assert.ok(closeTo(receipt.geography.pins['saved:host:farm-cn1'].x, (-123.1207 + 180) / 360))
 assert.ok(closeTo(receipt.geography.pins['saved:host:build'].y, .5))
 await click('[aria-label="Zoom in network"]');await frame('geographic-zoom-dark')
 const zoomed = await geography()
 assert.ok(zoomed.atlasWidth > receipt.geography.atlasWidth * 1.1)
 for (const [id, point] of Object.entries(receipt.geography.pins)) {
   assert.ok(closeTo(zoomed.pins[id].x, point.x) && closeTo(zoomed.pins[id].y, point.y))
 }
 receipt.geography.sharedViewport = true
 await click('[aria-label="Fit observed topology"]')
 const [x,y] = receipt.geography.panStart
 window.webContents.debugger.attach('1.3')
 await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1})
 await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+35,y:y+18,button:'left',buttons:1})
 await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',x:x+35,y:y+18,button:'left',buttons:0,clickCount:1})
 window.webContents.debugger.detach()
 await delay(150)
 const panned = await geography()
 assert.ok(panned.atlasLeft > receipt.geography.atlasLeft + 15)
 assert.ok(closeTo(panned.pins['saved:client'].x, receipt.geography.pins['saved:client'].x))
 receipt.geography.sharedPan = true
 await click('[aria-label="Fit observed topology"]')
 await evaluate('meshFixture.theme("light")');await frame('geographic-overview-light')
 window.setContentSize(560,950);await frame('geographic-narrow-light')
 assert.ok((await geography()).trayBelow && (await geography()).trayFits)
 await evaluate('meshFixture.theme("dark")');await frame('geographic-narrow-dark')
 window.setContentSize(1440,1050)
 await click('.mesh-explorer__canvas [data-host-node="studio"]')
 await click('[aria-label="Selected saved connection"] .mesh-explorer__detail-actions button:first-child')
 await wait('[aria-label="Latitude, longitude"]')
 await evaluate(`(() => {
  const picker = document.querySelector('.mesh-location-picker'), rect = picker.getBoundingClientRect()
  picker.dispatchEvent(new MouseEvent('click', {bubbles:true,detail:1,clientX:rect.left+rect.width*.75,clientY:rect.top+rect.height*.25}))
 })()`)
 assert.equal(await evaluate('document.querySelector(\'[aria-label="Latitude, longitude"]\').value'), '45.0000, 90.0000')
 assert.equal(await evaluate('document.querySelector(\'[data-geographic-point="saved:host:studio"] circle\').getAttribute("cx")'), String((13.405+180)*1000/360))
 await frame('geographic-location-editor')
 await type('[aria-label="Latitude, longitude"]','')
 await button('Save locations')
 assert.equal(await evaluate("document.querySelector('[data-geographic-point=\"saved:host:studio\"]')"),null)
 await frame('geographic-location-cleared')
 receipt.geography.clearedExactHost = true
 receipt.overflow=Object.values(receipt.frameOverflow).some(Boolean)
 assert.equal(receipt.overflow,false,'every full frame fits horizontally')
 receipt.passed=true
}catch(error){receipt.failure={message:error.message,stack:error.stack};process.exitCode=1}finally{try{await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'capture.json'),JSON.stringify(receipt,null,2))}catch(error){receipt.passed=false;console.error(error)}window?.destroy();app.exit(receipt.passed?0:1)}})
