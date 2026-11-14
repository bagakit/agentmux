const { app, BrowserWindow, Menu } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), { createHash } = require('node:crypto')
const [html, temporary, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(temporary, 'user-data')); app.setPath('sessionData', path.join(temporary, 'session-data'))
const result = { passed:false, captureOnly:true, aestheticReview:'not-performed', userRunTouched:false, frames:[], checks:[], operations:[], errors:[] }
let win
const call = (fn,...args) => win.webContents.executeJavaScript('('+fn.toString()+')(...'+JSON.stringify(args)+')')
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms))
async function wait(fn) { for(let n=0;n<200;n++) { if(await call(fn))return; await delay(30) }; throw Error('Actual location consumer condition absent: '+fn.toString()) }
async function settle() { await call(()=>Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))); await call(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))) }
async function key(key,code,vk) { for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:vk}); await settle() }
async function click(selector) {
  const point = await call(selector=>{
    const nodes=[...document.querySelectorAll(selector)].filter(n=>n.getClientRects().length)
    if(nodes.length!==1)throw Error('Actual visible entry must be unique: '+selector+' ('+nodes.length+')')
    const node=nodes[0];node.scrollIntoView({block:'nearest'}); const rect=node.getBoundingClientRect(),x=rect.x+rect.width/2,y=rect.y+rect.height/2,hit=document.elementFromPoint(x,y)
    if(hit!==node&&!node.contains(hit))throw Error('Original entry is covered: '+selector)
    return {x,y,label:node.getAttribute('aria-label')||node.textContent}
  },selector)
  result.operations.push({action:'click',selector,...point})
  for(const type of ['mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:point.x,y:point.y,button:'left',clickCount:1})
}
async function setup(theme,width,height,space=false) {
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false})
  await call((theme,space)=>agentLocationsScene.reset(theme,space),theme,space); await settle()
}
const location = (name,scope='') => scope+' .agent-locations[aria-label^='+JSON.stringify(name+' ·')+']'
const multiple='持续阅读与交互设计 · 原会话和草稿保留', single='校对手机排版', zero='尚未绑定展示位置'
async function open(name=multiple,scope='.global-focus-surface') {
  const selector=location(name,scope)
  assert.equal(await call(selector=>document.querySelector(selector)?.getAttribute('aria-label').includes(`${selector.includes('校对手机排版')?1:selector.includes('尚未绑定展示位置')?0:3} location`),selector),true,'The actual entry reports physical locations without counting Space aliases twice')
  await call(selector=>{window.originalLocationTrigger=document.querySelector(selector);originalLocationTrigger.focus()},selector)
  const before=await call(()=>agentLocationsScene.facts())
  await click(selector); await wait(()=>!!document.querySelector('.quick-switch [role=combobox]')); await settle()
  assert.equal(await call(()=>document.activeElement===document.querySelector('[aria-label="Search Session locations"]')),true)
  assert.equal(await call(()=>agentLocationsScene.facts().selection===null),before.selection===null)
  return before
}
async function close(before,returnFocus=true) {
  await key('Escape','Escape',27); await wait(()=>!document.querySelector('.quick-switch'))
  const after=await call(()=>agentLocationsScene.facts())
  assert.deepEqual(after.selection,before.selection); assert.equal(after.draft,before.draft)
  assert.equal(after.draftsPreserved,true); assert.equal(after.sessionsPreserved,true); assert.deepEqual(after.runIds,before.runIds)
  if(returnFocus)assert.equal(await call(()=>document.activeElement===window.originalLocationTrigger),true,'Cancel returns to its original mounted location entry')
}
async function frame(name,{intermediate=false}={}) {
  if(!intermediate)await settle()
  const facts=await call(()=>{const node=document.querySelector('.quick-switch')||document.querySelector('.agent-roster')||document.querySelector('main');const r=node.getBoundingClientRect();return {rect:r.toJSON(),width:innerWidth,height:innerHeight,scroll:node.scrollWidth,client:node.clientWidth,theme:document.documentElement.dataset.theme,choices:[...document.querySelectorAll('.quick-switch__row')].map(n=>({title:n.title,text:n.textContent})),...agentLocationsScene.facts()}})
  assert.ok(facts.rect.left>=0&&facts.rect.right<=facts.width+1&&facts.rect.top>=0&&facts.rect.bottom<=facts.height+1,'Full original surface fits this viewport')
  assert.equal(facts.scroll,facts.client,'Original surface has no horizontal overflow')
  assert.equal(facts.draftsPreserved,true);assert.equal(facts.sessionsPreserved,true);assert.deepEqual(facts.controls,{})
  const file=name+'.png',bytes=(await win.webContents.capturePage()).toPNG();await fs.writeFile(path.join(evidence,file),bytes)
  result.frames.push({file,sha256:createHash('sha256').update(bytes).digest('hex'),intermediate,facts})
}
app.whenReady().then(async()=>{
  try {
    Menu.setApplicationMenu(null);win=new BrowserWindow({show:false,width:1080,height:760,webPreferences:{backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}})
    win.webContents.on('console-message',event=>{if(event.level==='error')result.errors.push(event.message)})
    await win.loadFile(html);win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
    await wait(()=>Boolean(window.agentLocationsScene?.ready))
    await setup('dark',1080,760);await frame('locations-focus-overview-wide-dark')
    for(const [theme,width,height] of [['dark',1080,760],['light',640,600],['light',1080,760]]) {
      await setup(theme,width,height);const before=await open();
      assert.equal(await call(()=>document.querySelectorAll('.quick-switch__row[data-kind=location]').length),6,'Three original physical locations retain both Space contexts')
      await frame(`locations-focus-${width}-${theme}`);await close(before)
    }
    await setup('light',1080,760,true);await frame('locations-space-overview-wide-light')
    for(const [theme,width,height] of [['light',1080,760],['dark',640,430]]) {
      await setup(theme,width,height,true);const before=await open(multiple,'.workspace-agent-list');await frame(`locations-space-${width}-${height}-${theme}`);await close(before)
    }
    await setup('dark',1080,760);await click('.agent-roster__trigger');await wait(()=>Boolean(document.querySelector('.agent-roster')));await settle();await frame('locations-roster-menu-wide-dark')
    const rosterBefore=await open(multiple,'.agent-roster');await frame('locations-roster-picker-wide-dark');await close(rosterBefore,false)
    await setup('light',640,600);const one=await open(single);assert.equal(await call(()=>document.querySelectorAll('.quick-switch__row').length),2,'One physical location retains its two Space contexts');await frame('locations-single-narrow-light');await close(one)
    await setup('light',1080,760);const none=await open(zero);assert.equal(await call(()=>document.querySelectorAll('.quick-switch__row').length),0);await frame('locations-zero-wide-light');await close(none)
    await setup('dark',640,500);const stale=await open()
    const target=await call(()=>[...document.querySelectorAll('.quick-switch__row')].findIndex(n=>n.title.includes('second-region')))
    assert.ok(target>=0)
    for(let n=0;n<target;n++)await key('ArrowDown','ArrowDown',40)
    await call(()=>agentLocationsScene.invalidate());await key('Enter','Enter',13)
    assert.equal(await call(()=>Boolean(document.querySelector('.quick-switch__notice')&&agentLocationsScene.facts().request)),true,'Changed highlighted target keeps its original picker and reason')
    await frame('locations-stale-narrow-dark');await close(stale)
    await setup('dark',1080,760)
    await click(location(multiple,'.global-focus-surface'))
    const sample=await call(async()=>{for(let n=0;n<40;n++){await new Promise(resolve=>requestAnimationFrame(resolve));const dialog=document.querySelector('.quick-switch'),animation=dialog?.getAnimations().find(a=>a.effect?.getComputedTiming().iterations!==Infinity),p=animation?.effect?.getComputedTiming().progress;if(typeof p==='number'&&p>0&&p<1){const animations=document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity);animations.forEach(a=>a.pause());return{progress:p,opacity:getComputedStyle(dialog).opacity,transform:getComputedStyle(dialog).transform}}}throw Error('A non-endpoint actual opening frame was not observed')})
    assert.equal(Number(sample.opacity),1,'Location picker remains opaque throughout its actual opening frame')
    result.operations.push({action:'opening-sample',...sample});await frame('locations-opening-wide-dark',{intermediate:true});await call(()=>document.getAnimations().filter(a=>a.playState==='paused').forEach(a=>a.play()));await key('Escape','Escape',27)
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
    await setup('light',640,600);const reduced=await open();assert.equal(await call(()=>matchMedia('(prefers-reduced-motion: reduce)').matches&&getComputedStyle(document.querySelector('.quick-switch')).animationName==='none'),true)
    await frame('locations-reduced-narrow-light');await close(reduced)
    result.checks.push({realEntrypoints:['GlobalFocusSurface','WorkspaceAgentRow','AgentRoster'],originalOwner:'Store and QuickSwitcher',noInputOrLifecycle:true,retainedDraftAndSessionRunReferences:true,sourceKnown:await call(()=>agentLocationsScene.facts().known)})
    result.passed=true
  }catch(error){result.failure={name:error.name,message:error.message,stack:error.stack};if(win)try{await fs.writeFile(path.join(evidence,'failed.png'),(await win.webContents.capturePage()).toPNG())}catch{}}
  finally{await fs.writeFile(path.join(evidence,'render.json'),JSON.stringify(result,null,2));win?.destroy();app.exit(result.passed?0:1)}
})
