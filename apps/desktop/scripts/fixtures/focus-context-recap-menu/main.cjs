const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot,'user-data')); app.setPath('sessionData', path.join(privateRoot,'session-data'))
const result = { schema: 'agentmux.focus-context-recap-menu-actual.v1', passed: false, pid: process.pid, frames: [], rendererConsole: [], boundary: 'Original compiled Global/Store/projection/Row/ContextMenu/clipboard/reportError and CSS. Typed preview transport only; unrelated PTY and unused editor paint isolated. No Runtime, real Run/PID retention, Native writer, OS input, restart or installation.' }
let win
app.whenReady().then(async () => { try {
  win = new BrowserWindow({ width: 1200, height: 820, useContentSize: true, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) result.rendererConsole.push(String(message).slice(0,2000)) })
  const read = async code => { try { return await win.webContents.executeJavaScript(code) } catch(error) { result.failedEvaluation=code; throw error } }
  const until = async (label,predicate) => { const end=Date.now()+10000; do { if(await predicate())return; await new Promise(done=>setTimeout(done,30)) } while(Date.now()<end); throw new Error('Scene did not settle: '+label) }
  const settle = () => read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
  const row = id => `.global-focus-main .focus-context[data-session-id="${id}"]`
  const rect = selector => read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing actual control '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`)
  const mouse = async (selector,button='left') => { const r=await rect(selector);assert.equal(r.hit,true,'Center hit '+selector);for(const type of ['mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:r.x,y:r.y,button,clickCount:1});return r }
  const key = async (value,modifiers=0) => { for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:value,code:value,modifiers,...({F10:121,Escape:27,ArrowLeft:37,ArrowRight:39}[value]?{windowsVirtualKeyCode:{F10:121,Escape:27,ArrowLeft:37,ArrowRight:39}[value]}:{})}) }
  const menuSettled = () => until('actual shared menu visible and stable', () => read(`(()=>{const menu=document.querySelector('.focus-context-menu');return !!menu&&menu.querySelector('[role=menuitem][aria-label="Copy Agent Link"]')&&[...menu.querySelectorAll('[role=menuitem]')].some(e=>e.textContent.trim()==='Session details')&&Number(getComputedStyle(menu).opacity)>=.999&&!menu.getAnimations({subtree:true}).some(a=>a.playState==='running')})()`))
  const menuItems = () => read(`[...document.querySelectorAll('.focus-context-menu [role=menuitem]')].map(e=>(e.getAttribute('aria-label')??e.textContent).trim())`)
  const menuGlyphs = () => read(`[...document.querySelectorAll('.focus-context-menu svg[data-semantic-icon]')].map(svg=>{const href=svg.querySelector('use')?.getAttribute('href'),symbol=href?.startsWith('#')?svg.ownerDocument.getElementById(href.slice(1)):null,bounds=svg.getBBox();return{name:svg.dataset.semanticIcon,href,registered:!!symbol?.childElementCount,paint:{width:bounds.width,height:bounds.height}}})`)
  const menuGeometry = () => read(`(()=>{const e=document.querySelector('.focus-context-menu'),r=e.getBoundingClientRect(),wrapper=e.closest('[data-radix-popper-content-wrapper]'),s=getComputedStyle(e);return{bounds:{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height},viewport:{width:innerWidth,height:innerHeight,clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth},wrapper:{style:wrapper?.getAttribute('style'),bounds:wrapper?.getBoundingClientRect().toJSON()},menu:{side:e.dataset.side,align:e.dataset.align,width:s.width,maxWidth:s.maxWidth,availableWidth:s.getPropertyValue('--radix-context-menu-content-available-width'),availableHeight:s.getPropertyValue('--radix-context-menu-content-available-height')}}})()`)
  const copyAgent = '.focus-context-menu [role="menuitem"][aria-label="Copy Agent Link"]'
  const sharedItems = ['Copy Agent Link','Rename Agent','Session details','Restart Session…','Stop Agent','Maintenance']
  async function submenu(label) {
    await read(`(()=>{const item=[...document.querySelectorAll('.focus-context-menu [role="menuitem"]')].find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!item)throw new Error('Missing shared menu disclosure');item.focus()})()`)
    await key('ArrowRight')
    const selector=`.focus-context-menu [role="menuitem"][data-state="open"]`
    await until('original shared disclosure '+label,()=>read(`Boolean(document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-controls'))`))
    const identity=await read(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-controls')`)
    assert.ok(identity,'The original disclosure names its actual submenu')
    await until('shared submenu '+label,()=>read(`Boolean(document.getElementById(${JSON.stringify(identity)}))`))
    await until('stable shared submenu '+label,()=>read(`(()=>{const e=document.getElementById(${JSON.stringify(identity)});return Number(getComputedStyle(e).opacity)>=.999&&!e.getAnimations({subtree:true}).some(a=>a.playState==='running')})()`))
    await settle()
    const geometry=await read(`(()=>{const e=document.getElementById(${JSON.stringify(identity)}),r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,text:e.textContent}})()`)
    result.submenuGeometry??=[];result.submenuGeometry.push({label,...geometry})
    assert.ok(geometry.left>=0&&geometry.right<=geometry.width&&geometry.top>=0&&geometry.bottom<=geometry.height,'The shared Focus disclosure remains inside its viewport: '+JSON.stringify(geometry))
    return identity
  }
  async function pointerSubmenu(label) {
    const trigger=await read(`(()=>{const e=[...document.querySelectorAll('.focus-context-menu [role="menuitem"]')].find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!e)throw new Error('The original parent submenu trigger is missing');const r=e.getBoundingClientRect();e.dataset.privatePointerSubmenu='true';return{x:r.left+r.width/2,y:r.top+r.height/2}})()`)
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...trigger,buttons:0})
    await until('pointer opens shared '+label,()=>read(`Boolean(document.querySelector('.focus-context-menu [data-private-pointer-submenu="true"][data-state="open"]')?.getAttribute('aria-controls'))`))
    const id=await read(`document.querySelector('.focus-context-menu [data-private-pointer-submenu="true"]').getAttribute('aria-controls')`)
    await until('pointer submenu paint '+label,()=>read(`(()=>{const e=document.getElementById(${JSON.stringify(id)});return !!e&&Number(getComputedStyle(e).opacity)>=.999&&!e.getAnimations({subtree:true}).some(a=>a.playState==='running')})()`))
    const destination=await read(`(()=>{const e=document.getElementById(${JSON.stringify(id)}),r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`)
    for(let step=1;step<=4;step++){await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:trigger.x+(destination.x-trigger.x)*step/4,y:trigger.y+(destination.y-trigger.y)*step/4,buttons:0});await settle()}
    const entered=await read(`(()=>{const e=document.getElementById(${JSON.stringify(id)});return !!e&&e.contains(document.elementFromPoint(${destination.x},${destination.y}))})()`)
    assert.equal(entered,true,'A real pointer can enter the overlapping shared '+label+' submenu')
    const back=await rect(copyAgent)
    for(let step=1;step<=4;step++){await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:destination.x+(back.x-destination.x)*step/4,y:destination.y+(back.y-destination.y)*step/4,buttons:0});await settle()}
    await until('pointer returns to original parent menu',()=>read(`!document.getElementById(${JSON.stringify(id)})&&Boolean(document.querySelector('.focus-context-menu'))`))
    await read(`document.querySelector('.focus-context-menu [data-private-pointer-submenu="true"]').removeAttribute('data-private-pointer-submenu')`)
    result.pointerSubmenus??=[];result.pointerSubmenus.push({label,id,trigger,destination,entered,returned:true})
  }
  const shot = async (file,label) => { await settle(); await until('stable original menu paint', () => read(`!document.querySelector('.focus-context-menu')||(()=>{const e=document.querySelector('.focus-context-menu');return Number(getComputedStyle(e).opacity)>=.999&&!e.getAnimations({subtree:true}).some(a=>a.playState==='running')})()`)); await fs.writeFile(path.join(evidence,file),(await win.webContents.capturePage()).toPNG()); const geometry=await read(`Boolean(document.querySelector('.focus-context-menu'))`)?await menuGeometry():null;result.frames.push({file,label,viewport:await read('innerWidth'),...(geometry?{menuGeometry:geometry}:{})});if(geometry){geometry.glyphs=await menuGlyphs();assert.ok(geometry.glyphs.length>0,'The real shared menu has semantic glyphs');assert.ok(geometry.glyphs.every(glyph=>glyph.registered&&glyph.paint.width>0&&glyph.paint.height>0),'The original theme runtime paints each menu glyph');const r=geometry.bounds,v=geometry.viewport;assert.ok(r.left>=0&&r.right<=v.width&&r.top>=0&&r.bottom<=v.height,'The original shared Focus menu is fully inside its actual viewport: '+JSON.stringify(geometry))} }
  const geometry = () => read(`(()=>{const rows=[...document.querySelectorAll('.focus-context')];const measure=e=>{const r=e.getBoundingClientRect(),style=getComputedStyle(e);return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),display:style.display,text:e.textContent,aria:e.getAttribute('aria-label'),title:e.getAttribute('title')}};return{rows:rows.map(e=>({id:e.dataset.sessionId,compact:e.classList.contains('focus-context--compact'),bounds:measure(e),recap:e.querySelector('.focus-context__recap')?measure(e.querySelector('.focus-context__recap')):null,activity:e.querySelector('.focus-context__activity')?measure(e.querySelector('.focus-context__activity')):null,detail:e.querySelector('.focus-context__detail')?measure(e.querySelector('.focus-context__detail')):null})),minColumn:measure(document.querySelector('[data-min-column]')),compact:measure(document.querySelector('[data-compact-column] .focus-context')),viewport:innerWidth}})()`)
  await win.loadFile(html); win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
  await until('real card population', () => read(`(()=>{if(!window.recapProof?.ready)return false;const actual=[...document.querySelectorAll('.global-focus-main .focus-context')].map(card=>card.dataset.sessionId).sort(),expected=[...window.recapProof.population].sort();return expected.length>0&&JSON.stringify(actual)===JSON.stringify(expected)})()`))
  await read('window.recapProof.remember()'); result.before = await read('window.recapProof.facts()')
  result.geometry=[]
  for(const width of [1200,360]) {
    win.setContentSize(width,820); await settle(); const g=await geometry(); result.geometry.push(g)
    assert.equal(g.compact.height,28);assert.equal(g.minColumn.width,160)
    const recap=g.rows.find(e=>e.id==='recap-a'&&e.recap);assert.ok(recap);assert.ok(recap.recap.text.includes('已经修复'));assert.ok(recap.bounds.aria.includes('Last reply observation (timeline)'),'Unattributed captured replies retain their original observation source')
    const next=g.rows.find(e=>e.id==='next-prompt');assert.ok(next);assert.ok(next.bounds.aria.includes('接下来检查加载'));assert.ok(next.bounds.aria.includes('Last reply observation (timeline)'))
    const critical=g.rows.filter(e=>e.id==='permission'||e.id==='failed');assert.equal(critical.length,2);assert.ok(critical.every(e=>!e.recap&&e.detail.text.length>0))
    const empty=g.rows.find(e=>e.id==='recap-b');assert.ok(empty);assert.equal(empty.detail.text,'No activity details observed')
    await shot('cards-'+width+'.png','original cards + minimum160 + compact28')
  }
  await mouse(row('recap-b'),'right'); await menuSettled(); assert.deepEqual(await menuItems(),sharedItems)
  result.pointerMenu={bounds:await rect('.focus-context-menu'),sessionId:await read('document.querySelector(".focus-context-menu").dataset.agentSessionId')};assert.equal(result.pointerMenu.sessionId,'recap-b')
  await shot('pointer-menu-360.png','same-name second SID exact original Session menu')
  await mouse(copyAgent);await until('menu selected',()=>read('!document.querySelector(".focus-context-menu")'))
  await settle()
  result.afterPointer=await read('window.recapProof.facts()');assert.equal(result.afterPointer.clipboard[0],await read('window.recapProof.expectedSecondAddress'))
  await read(`document.querySelector(${JSON.stringify(row('recap-b'))}).focus()`); await key('F10',8); await menuSettled()
  result.keyboardMenu={sessionId:await read('document.querySelector(".focus-context-menu").dataset.agentSessionId'),items:await menuItems()};assert.equal(result.keyboardMenu.sessionId,'recap-b')
  assert.deepEqual(result.keyboardMenu.items,sharedItems,'Pointer and keyboard share the common Agent content')
  const details=await submenu('Session details')
  result.sessionDetails=await read(`document.getElementById(${JSON.stringify(details)}).textContent`)
  assert.ok(result.sessionDetails.includes('Session: recap-b')&&result.sessionDetails.includes('Host ID: local'),'Shared details preserve the canonical Session and execution Host')
  result.detailsReadability=await read(`(()=>{const menu=document.getElementById(${JSON.stringify(details)}),label=[...menu.querySelectorAll('.agent-region-menu__context > span')].find(e=>e.textContent==='Host ID: local');if(!label)throw new Error('The original short Host identity field is missing');const range=document.createRange();range.selectNodeContents(label);const lines=[...new Set([...range.getClientRects()].map(rect=>Math.round(rect.top)))];return{menuWidth:menu.getBoundingClientRect().width,label:label.textContent,lineCount:lines.length,scrollWidth:menu.scrollWidth,clientWidth:menu.clientWidth}})()`)
  assert.equal(result.detailsReadability.lineCount,1,'The available viewport keeps a short identity field on one readable line')
  assert.ok(result.detailsReadability.scrollWidth<=result.detailsReadability.clientWidth+1,'The complete shared Session details do not overflow horizontally')
  await shot('keyboard-menu-360.png','Shift+F10 and shared Session details retain the exact SID')
  await key('ArrowLeft');await until('return from shared details',()=>read(`!document.getElementById(${JSON.stringify(details)})`))
  const maintenance=await submenu('Maintenance')
  result.maintenance=await read(`[...document.getElementById(${JSON.stringify(maintenance)}).querySelectorAll('[role="menuitem"]')].map(e=>e.textContent.trim())`)
  assert.deepEqual(result.maintenance,['Check native source','Refresh observation'],'Shared maintenance actions remain reachable on the original card')
  result.maintenanceReadability=await read(`(()=>{const menu=document.getElementById(${JSON.stringify(maintenance)}),bounds=menu.getBoundingClientRect();return{left:bounds.left,right:bounds.right,scrollWidth:menu.scrollWidth,clientWidth:menu.clientWidth,labels:[...menu.querySelectorAll('[role="menuitem"]')].map(item=>{const label=[...item.children].find(e=>e.tagName==='SPAN'&&e.textContent.trim()===item.textContent.trim());if(!label)throw new Error('The original maintenance action label is missing');const range=document.createRange();range.selectNodeContents(label);return{text:label.textContent,rects:[...range.getClientRects()].map(rect=>({left:rect.left,right:rect.right}))}})}})()`)
  assert.ok(result.maintenanceReadability.scrollWidth<=result.maintenanceReadability.clientWidth+1,'Maintenance remains readable without horizontal clipping')
  assert.equal(result.maintenanceReadability.labels.length,2)
  for(const label of result.maintenanceReadability.labels){assert.ok(label.rects.length>0);assert.ok(label.rects.every(rect=>rect.left>=result.maintenanceReadability.left-.5&&rect.right<=result.maintenanceReadability.right+.5),'The complete original maintenance label stays visible: '+label.text)}
  await key('ArrowLeft');await until('return from shared maintenance',()=>read(`!document.getElementById(${JSON.stringify(maintenance)})`))
  await pointerSubmenu('Session details');await pointerSubmenu('Maintenance')
  await key('Escape');await until('Escape restores exact trigger',()=>read(`!document.querySelector('.focus-context-menu')&&document.activeElement===document.querySelector(${JSON.stringify(row('recap-b'))})`))
  await settle()
  result.escape={exactTrigger:true}
  await key('F10',8);await menuSettled();await mouse('[aria-label="Later explicit input"]');await until('later input wins',()=>read(`!document.querySelector('.focus-context-menu')&&document.activeElement===document.querySelector('[aria-label="Later explicit input"]')`));result.laterFocus={preserved:true}
  await read('window.recapProof.denyClipboard(true)');await mouse(row('recap-b'),'right');await menuSettled();await mouse(copyAgent)
  await until('clipboard action releases its original menu',()=>read('!document.querySelector(".focus-context-menu")'))
  await until('original clipboard error event recorded',()=>read('window.recapProof.facts().events.some(event=>event.message.includes("Clipboard denied: private presentation probe"))'))
  await mouse('.global-system-notices__trigger')
  await until('original notification Activity entry',()=>read('Boolean(document.querySelector(".global-system-notices [role=tab][data-section=history]"))'))
  await settle()
  await mouse('.global-system-notices [role="tab"][data-section="history"]')
  const clipboardEvents=await read('window.recapProof.facts().events.filter(event=>event.message.includes("Clipboard denied: private presentation probe"))')
  assert.equal(clipboardEvents.length,1,'The original clipboard failure has one exact notification event')
  const clipboardNotice=`.notification-item[data-event-id=${JSON.stringify(clipboardEvents[0].id)}]`
  await until('original clipboard failure item',()=>read(`Boolean(document.querySelector(${JSON.stringify(clipboardNotice+' .notification-item__details > summary')}))`))
  await mouse(clipboardNotice+' .notification-item__details > summary')
  await until('original clipboard failure outlet',()=>read(`document.querySelector(${JSON.stringify(clipboardNotice+' .notification-item__original')})?.innerText.includes("Clipboard denied: private presentation probe")`))
  result.clipboardFailure=await read('window.recapProof.facts()');await shot('clipboard-failure-360.png','actual original error outlet + draft retention')
  const before=await read('window.recapProof.facts()');await read('window.recapProof.churn()');await settle();const after=await read('window.recapProof.facts()');assert.deepEqual(after.reads,before.reads);assert.deepEqual(after.controls,before.controls);result.cost={updates:200,before,after}
  result.after=after;for(const key of ['sameNodes','originalFocus','originalDrafts','originalControls'])assert.equal(after[key],true,key)
  assert.deepEqual(after.controls,{stop:0,resume:0,launchAgent:0,write:0,interrupt:0});assert.equal(after.draft,result.before.draft)
  result.passed=true
}catch(error){result.failure={name:error.name,message:error.message,stack:error.stack};if(win&&!win.isDestroyed())await fs.writeFile(path.join(evidence,'failure.png'),(await win.webContents.capturePage()).toPNG())}
finally{await fs.writeFile(path.join(evidence,'actual.json'),JSON.stringify(result,null,2)+'\n');if(win&&!win.isDestroyed())win.destroy();app.exit(result.passed?0:1)}})
