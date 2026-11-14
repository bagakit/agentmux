const { app, BrowserWindow, Menu } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), { createHash } = require('node:crypto')
const [html, temporary, evidence, mode] = process.argv.slice(2)
const detailsOnly = mode === '--details'
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
const multiple='持续阅读与交互设计 · 原会话和草稿保留', single='校对手机排版', zero='尚未绑定展示位置'
async function sourceVisibility() {
  await settle()
  const geometry=await call(()=>{
    const reader=document.querySelector('.agent-information-reader'),metadata=reader?.querySelector('.agent-information-reader__metadata'),action=metadata?.querySelector('.agent-locations')
    const header=reader?.querySelector('.agent-information-reader__header'),footer=reader?.querySelector('.agent-information-reader__footer')
    if(!reader||!metadata||!action||!header||!footer)throw Error('Original Source action and reading chrome must be mounted together')
    const rect=node=>{const r=node.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}}
    const client=node=>{const r=node.getBoundingClientRect();return{left:r.left+node.clientLeft,top:r.top+node.clientTop,right:r.left+node.clientLeft+node.clientWidth,bottom:r.top+node.clientTop+node.clientHeight}}
    const inside=(a,b)=>a.left>=b.left-.5&&a.top>=b.top-.5&&a.right<=b.right+.5&&a.bottom<=b.bottom+.5
    const overlap=(a,b)=>Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top))
    const a=rect(action),h=rect(header),f=rect(footer),metadataClip=client(metadata),clip={left:0,top:0,right:innerWidth,bottom:innerHeight}
    const clippedAncestors=[]
    for(let node=action.parentElement;node;node=node.parentElement){
      const style=getComputedStyle(node),r=client(node),x=['auto','hidden','clip','scroll'].includes(style.overflowX),y=['auto','hidden','clip','scroll'].includes(style.overflowY)
      if(x){clip.left=Math.max(clip.left,r.left);clip.right=Math.min(clip.right,r.right)}
      if(y){clip.top=Math.max(clip.top,r.top);clip.bottom=Math.min(clip.bottom,r.bottom)}
      if(x||y)clippedAncestors.push({className:node.className,rect:r,x,y})
    }
    const actionStyle=getComputedStyle(action),radius=Math.max(...[actionStyle.borderTopLeftRadius,actionStyle.borderTopRightRadius,actionStyle.borderBottomLeftRadius,actionStyle.borderBottomRightRadius].map(value=>parseFloat(value)||0)),insetX=Math.min(a.width/4,radius+1),insetY=Math.min(a.height/4,radius+1)
    const points=[[a.left+insetX,a.top+insetY],[a.right-insetX,a.top+insetY],[a.left+insetX,a.bottom-insetY],[a.right-insetX,a.bottom-insetY],[(a.left+a.right)/2,(a.top+a.bottom)/2]].map(([x,y])=>{const hit=document.elementFromPoint(x,y);return{x,y,hit:hit?{tag:hit.tagName,className:hit.getAttribute('class')}:null,uncovered:hit===action||Boolean(hit&&action.contains(hit))}})
    return{action:a,header:h,footer:f,metadataClip,clip,clippedAncestors,nonempty:a.width>0&&a.height>0,insideMetadata:inside(a,metadataClip),insideAllClips:inside(a,clip),headerOverlap:overlap(a,h),footerOverlap:overlap(a,f),chromeOverlap:overlap(h,f),points}
  })
  result.operations.push({action:'source-visibility',geometry})
  assert.ok(geometry.nonempty&&geometry.insideMetadata&&geometry.insideAllClips,'The full Source location action must be inside its actual metadata viewport and every clipping ancestor: '+JSON.stringify(geometry))
  assert.equal(geometry.headerOverlap,0,'Original reading header must not cover the Source action')
  assert.equal(geometry.footerOverlap,0,'Original reading footer must not cover the Source action')
  assert.equal(geometry.chromeOverlap,0,'Original reading header and footer must not overlap')
  assert.ok(geometry.points.every(point=>point.uncovered),'The full Source action must be visible to actual pointer hit testing')
  result.checks.push({sourceActionVisibility:geometry})
}
async function showDetails(name=multiple,scope='.global-focus-surface') {
  await call((name,scope)=>{
    if(document.querySelector(scope+' .agent-locations'))throw Error('Main lists must not retain location controls')
    const cards=[...document.querySelectorAll(scope+' .focus-context')].filter(node=>node.textContent.includes(name))
    if(cards.length!==1)throw Error('Original Agent card must be exact: '+name+' ('+cards.length+')')
    window.originalLocationTrigger=cards[0];originalLocationTrigger.focus()
  },name,scope)
  await key('ArrowDown','ArrowDown',40)
  await wait(()=>Boolean(document.querySelector('.agent-information-reader')))
  await click('.agent-information-reader__facts')
  await click('.agent-information-details__tabs button[id$="-source"]')
  await wait(()=>Boolean(document.querySelector('.agent-information-reader .agent-locations')))
  await sourceVisibility()
  return '.agent-information-reader .agent-locations'
}
async function open(name=multiple,scope='.global-focus-surface',unknown=false) {
  const before=await call(()=>agentLocationsScene.facts())
  const selector=await showDetails(name,scope)
  const quantity=unknown?'locations unconfirmed':`${name===single?1:name===zero?0:3} location`
  assert.equal(await call((selector,quantity)=>document.querySelector(selector)?.getAttribute('aria-label').includes(quantity),selector,quantity),true,'Source details report current physical locations without counting Space aliases twice')
  await click(selector);await wait(()=>!!document.querySelector('.quick-switch [role=combobox]'));await settle()
  assert.equal(await call(()=>document.activeElement===document.querySelector('[aria-label="Search Session locations"]')),true)
  assert.equal(await call(()=>agentLocationsScene.facts().selection===null),before.selection===null)
  assert.equal(await call(()=>document.querySelector('.agent-information-reader')===null),true,'Transient details close before the original picker owns focus')
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
  const facts=await call(()=>{const node=document.querySelector('.quick-switch')||document.querySelector('.agent-information-reader')||document.querySelector('.agent-roster')||document.querySelector('main');const r=node.getBoundingClientRect();return {rect:r.toJSON(),width:innerWidth,height:innerHeight,scroll:node.scrollWidth,client:node.clientWidth,theme:document.documentElement.dataset.theme,choices:[...document.querySelectorAll('.quick-switch__row')].map(n=>({title:n.title,text:n.textContent})),...agentLocationsScene.facts()}})
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
    if(detailsOnly) {
      await setup('dark',1080,760);await frame('details-focus-overview-wide-dark')
      await setup('light',1080,760,true);await frame('details-space-overview-wide-light')
      await setup('dark',1080,760);await click('.agent-roster__trigger');await wait(()=>Boolean(document.querySelector('.agent-roster')));await frame('details-roster-menu-wide-dark')
      assert.equal(await call(()=>document.querySelector('.agent-roster .agent-locations')===null),true)
      await key('Escape','Escape',27);await wait(()=>!document.querySelector('.agent-roster'))
      await showDetails();await frame('details-source-wide-dark')
      const multipleBefore=await call(()=>agentLocationsScene.facts())
      await click('.agent-information-reader .agent-locations');await wait(()=>!!document.querySelector('.quick-switch [role=combobox]'));await settle()
      assert.equal(await call(()=>document.querySelectorAll('.quick-switch__row[data-kind=location]').length),6)
      await frame('details-picker-multiple-wide-dark');await close(multipleBefore)
      await setup('dark',1080,760);await call(()=>agentLocationsScene.unknown())
      const unknownBefore=await open(multiple,'.global-focus-surface',true)
      const unknownTarget=await call(()=>[...document.querySelectorAll('.quick-switch__row')].findIndex(node=>node.title.includes('right-region')))
      assert.ok(unknownTarget>=0)
      for(let n=0;n<unknownTarget;n++)await key('ArrowDown','ArrowDown',40)
      await key('Enter','Enter',13)
      assert.equal(await call(()=>Boolean(document.querySelector('.quick-switch__notice')?.textContent.includes('unconfirmed'))),true)
      await frame('details-picker-unknown-wide-dark');await close(unknownBefore)
    } else {
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
    assert.equal(await call(()=>document.querySelector('.agent-roster .agent-locations')===null),true)
    await key('Escape','Escape',27);await wait(()=>!document.querySelector('.agent-roster'))
    await showDetails();await frame('locations-source-wide-dark')
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
    await showDetails();await click('.agent-information-reader .agent-locations')
    const sample=await call(async()=>{for(let n=0;n<40;n++){await new Promise(resolve=>requestAnimationFrame(resolve));const dialog=document.querySelector('.quick-switch'),animation=dialog?.getAnimations().find(a=>a.effect?.getComputedTiming().iterations!==Infinity),p=animation?.effect?.getComputedTiming().progress;if(typeof p==='number'&&p>0&&p<1){const animations=document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity);animations.forEach(a=>a.pause());return{progress:p,opacity:getComputedStyle(dialog).opacity,transform:getComputedStyle(dialog).transform}}}throw Error('A non-endpoint actual opening frame was not observed')})
    assert.equal(Number(sample.opacity),1,'Location picker remains opaque throughout its actual opening frame')
    result.operations.push({action:'opening-sample',...sample});await frame('locations-opening-wide-dark',{intermediate:true});await call(()=>document.getAnimations().filter(a=>a.playState==='paused').forEach(a=>a.play()));await key('Escape','Escape',27)
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
    await setup('light',640,600);const reduced=await open();assert.equal(await call(()=>matchMedia('(prefers-reduced-motion: reduce)').matches&&getComputedStyle(document.querySelector('.quick-switch')).animationName==='none'),true)
    await frame('locations-reduced-narrow-light');await close(reduced)
    }
    result.checks.push({realEntrypoints:['GlobalFocusSurface','WorkspaceAgentRow','AgentInformationPreviewHost','AgentInformationReader Source'],originalOwner:'Store and QuickSwitcher',noInputOrLifecycle:true,retainedDraftAndSessionRunReferences:true,sourceKnown:await call(()=>agentLocationsScene.facts().known)})
    result.passed=true
  }catch(error){result.failure={name:error.name,message:error.message,stack:error.stack};if(win)try{await fs.writeFile(path.join(evidence,'failed.png'),(await win.webContents.capturePage()).toPNG())}catch{}}
  finally{await fs.writeFile(path.join(evidence,'render.json'),JSON.stringify(result,null,2));win?.destroy();app.exit(result.passed?0:1)}
})
