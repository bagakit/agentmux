const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow, ipcMain } = require('electron')
const [html, coreOwner, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { schema: 'agentmux.project-activity-cascade-actual.v1', passed: false, frames: [], operations: [], consoleErrors: [], userRuntimeControlled: false }
const pause = ms => new Promise(done => setTimeout(done, ms))
let win, unsubscribe
app.whenReady().then(async () => { try {
  const { AgentMuxSpatialStateStore } = await import(pathToFileURL(coreOwner).href)
  const spatial = new AgentMuxSpatialStateStore(path.join(privateRoot, 'spatial-state.json'))
  const channel = 'activity-cascade:'
  ipcMain.handle(channel + 'read', () => spatial.readForLayout())
  ipcMain.handle(channel + 'commit', (_event, input) => spatial.commit(input))
  ipcMain.handle(channel + 'retain', (_event, values) => spatial.retainDisplayLabels(values))
  ipcMain.handle(channel + 'flush', () => win.webContents.session.flushStorageData())
  const preload = path.join(privateRoot, 'preload.cjs')
  await fs.writeFile(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('activityCascadeBridge',{read:()=>ipcRenderer.invoke('${channel}read'),commit:input=>ipcRenderer.invoke('${channel}commit',input),retainLabels:values=>ipcRenderer.invoke('${channel}retain',values),flush:()=>ipcRenderer.invoke('${channel}flush'),onChange:listener=>{const wrapped=(_event,value)=>listener(value);ipcRenderer.on('${channel}changed',wrapped);return()=>ipcRenderer.removeListener('${channel}changed',wrapped)}})`)
  win = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, show: false, webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  unsubscribe = spatial.subscribe(value => { if (!win.isDestroyed()) win.webContents.send(channel + 'changed', value) })
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) result.consoleErrors.push(String(message).slice(0, 2000)) })
  const read = async code => { try { return await win.webContents.executeJavaScript(code) } catch (error) { result.failedEvaluation = code; throw error } }
  const until = async (label, expression) => { const end = Date.now() + 10000; do { if (await read(expression)) return; await pause(30) } while (Date.now() < end); throw new Error('Scene did not settle: ' + label) }
  const stable = async () => { await read('document.fonts.ready'); await read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))'); await pause(80) }
  const rect = selector => read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`)
  const move = (x, y) => win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) })
  const click = async selector => { const r = await rect(selector); assert.ok(r.hit, 'Input hits ' + selector); move(r.x, r.y); for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: Math.round(r.x), y: Math.round(r.y), button: 'left', clickCount: 1 }); result.operations.push({ type: 'click', selector }); await stable(); return r }
  const key = async keyCode => { const nativeKey = { ArrowDown: 'Down', ArrowUp: 'Up', ArrowRight: 'Right', ArrowLeft: 'Left' }[keyCode] ?? keyCode; for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: nativeKey }); result.operations.push({ type: 'key', keyCode, nativeKey }); await pause(80) }
  const hover = async selector => { const r = await rect(selector); assert.ok(r.hit, 'Hover hits ' + selector); move(r.x, r.y); await pause(350); await stable(); return r }
  const facts = () => read('window.activityCascadeScene.facts()')
  const closed = async () => { move(1250, 880); for (let index = 0; index < 4; index++) { if (await read('!document.querySelector(".project-activity-menu,.agent-information-reader")')) break; await key('Escape') } await until('All transient activity surfaces close', '!document.querySelector(".project-activity-menu,.agent-information-reader")') }
  const originalWorkface = async label => { const current = await facts(); assert.deepEqual(current.selection, result.before.selection, label + ' does not navigate'); assert.equal(current.selectedId, result.before.selectedId, label + ' keeps selected Session'); assert.deepEqual(current.controls, [], label + ' issues no Agent control'); assert.equal(current.sameDrafts, true, label + ' keeps original draft owner'); assert.equal(current.draft, result.before.draft) }
  const inputFocus = label => read('document.activeElement===document.querySelector(\'[aria-label="Original workface input"]\')').then(value => assert.equal(value, true, label + ' keeps original input focus'))
  const openZone = async zoneId => { await hover('.project-activity'); await until('Activity menu', '!!document.querySelector(".project-activity-menu")'); await hover(`.project-activity-zone[data-zone-id=${JSON.stringify(zoneId)}]`); await until('Zone hover cascade', '!!document.querySelector(".project-activity-submenu")') }
  const geometry = async () => { const value = await read(`({width:innerWidth,menus:[...document.querySelectorAll('.project-activity-menu,.project-activity-submenu')].map(e=>{const b=e.getBoundingClientRect();return{left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:b.width,clientWidth:e.clientWidth,scrollWidth:e.scrollWidth}})})`); result.currentGeometry=value; assert.ok(value.menus.length >= 2); for (const menu of value.menus) { assert.ok(menu.left >= -1 && menu.right <= value.width + 1, 'Every cascade surface fits the actual viewport: '+JSON.stringify(value)); assert.ok(menu.width > 0 && menu.clientWidth > 0, 'Actual cascade surfaces are nonempty');assert.ok(menu.scrollWidth<=menu.clientWidth+1,'Menu text stays within its actual surface') } return value }
  const shot = async (file, label) => { await stable(); const actual = await read(`({width:innerWidth,height:innerHeight,menus:[...document.querySelectorAll('[role=menu]')].map(e=>e.innerText),reader:document.querySelector('.agent-information-reader')?.innerText??null})`); await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); result.frames.push({ file, label, ...actual }) }
  await win.loadFile(html)
  win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await until('Core-backed actual activity scene', 'window.activityCascadeScene?.ready&&!!document.querySelector(".project-activity")')
  await read(`window.activityCascadeKeys=[];document.addEventListener('keydown',event=>window.activityCascadeKeys.push({key:event.key,trusted:event.isTrusted}),true)`)
  await stable(); result.before = await facts()
  result.spatial = await spatial.readForLayout()
  assert.ok(result.spatial.graph.regions.length >= 5, 'Nonempty original durable spatial graph')
  assert.equal(result.before.executions.length, 5); assert.ok(result.before.executions.every(item => item.value?.hostId === 'local'), 'Every displayed Agent occurrence consumes its actual persisted execution Host')
  await click('[aria-label="Original workface input"]')
  await read(`document.querySelector('[aria-label="Original workface input"]').setSelectionRange(2,7)`)
  const zoneId = await read('window.activityCascadeScene.zoneId')
  await openZone(zoneId); await inputFocus('Zone hover'); await originalWorkface('Zone hover')
  assert.deepEqual(await read(`[...document.querySelectorAll('.project-activity-tab[data-tab-id]')].map(e=>e.dataset.tabId)`), ['activity-main-tab', 'activity-second-tab'])
  assert.deepEqual(await read(`[...document.querySelectorAll('.project-activity-agent')].map(e=>[e.dataset.sessionId,e.dataset.regionId])`), [['activity-a','activity-a-left'], ['activity-b','activity-b-right'], ['activity-a','activity-a-second']])
  assert.ok(await read(`document.querySelector('.project-activity-menu').innerText.includes('Needs you')&&document.querySelector('.project-activity-menu').innerText.includes('Working')`), 'Open activity menu retains the original attention categories')
  result.wideGeometry = await geometry()
  await shot('wide-cascade.png', 'Activity status context and direct Zone/Tab cascade')
  const source = await hover('.project-activity-agent[data-region-id="activity-a-left"]')
  await until('Shared reader', '!!document.querySelector(".agent-information-reader")')
  await inputFocus('Agent hover'); await originalWorkface('Agent hover')
  assert.deepEqual(await read(`(()=>{const e=document.querySelector('[aria-label="Original workface input"]');return[e.selectionStart,e.selectionEnd]})()`), [2,7], 'Hover keeps the original caret selection')
  assert.ok(await read(`document.querySelector('.agent-information-reader').textContent.includes(window.activityCascadeScene.longReply)`), 'Shared reader contains complete original reply')
  await read('window.__activityOriginalReader=document.querySelector(".agent-information-reader")')
  const reader = await rect('.agent-information-reader'), target = { x: reader.left + Math.min(reader.width / 2, 140), y: reader.top + 110 }
  for (let step = 1; step <= 8; step++) { move(source.x + (target.x - source.x) * step / 8, source.y + (target.y - source.y) * step / 8); await pause(15) }
  await pause(220); await until('Natural pointer transfer keeps shared reader and cascade', '!!document.querySelector(".agent-information-reader")&&!!document.querySelector(".project-activity-submenu")')
  await inputFocus('Reader pointer transfer')
  await shot('wide-reader.png', 'Shared Focus Agent reader reached from activity cascade')
  const text = await read(`(()=>{const p=document.querySelector('.agent-information-reader .focus-context-hover__recap p'),n=[...p.childNodes].find(n=>n.nodeType===Node.TEXT_NODE),r=document.createRange();r.setStart(n,0);r.setEnd(n,Math.min(18,n.textContent.length));const b=r.getClientRects()[0];return{x:b.left+2,y:b.top+b.height/2,end:b.right-2}})()`)
  move(text.x,text.y); win.webContents.sendInputEvent({type:'mouseDown',x:Math.round(text.x),y:Math.round(text.y),button:'left',clickCount:1})
  for(let step=1;step<=8;step++){win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(text.x+(text.end-text.x)*step/8),y:Math.round(text.y),button:'left',modifiers:['leftButtonDown']});await pause(12)}
  win.webContents.sendInputEvent({type:'mouseUp',x:Math.round(text.end),y:Math.round(text.y),button:'left',clickCount:1});await stable()
  result.selection = await read(`(()=>{const s=getSelection(),r=document.querySelector('.agent-information-reader');return{text:s.toString(),inside:r?.contains(s.anchorNode),sameReader:r===window.__activityOriginalReader,menu:!!document.querySelector('.project-activity-menu')}})()`)
  assert.ok(result.selection.text.length > 0 && result.selection.inside && result.selection.sameReader && result.selection.menu, 'Native drag selects original Reader text without dismissing the menu')
  const scrolling = await rect('.agent-information-reader__reading')
  move(scrolling.x, scrolling.y); win.webContents.sendInputEvent({type:'mouseWheel',x:Math.round(scrolling.x),y:Math.round(scrolling.y),deltaX:0,deltaY:-600,canScroll:true})
  await until('Original reader internal wheel scroll', 'document.querySelector(".agent-information-reader__reading")?.scrollTop>0')
  result.readerScroll = await read(`({scrollTop:document.querySelector('.agent-information-reader__reading').scrollTop,menu:!!document.querySelector('.project-activity-menu'),sameReader:document.querySelector('.agent-information-reader')===window.__activityOriginalReader})`)
  assert.ok(result.readerScroll.menu && result.readerScroll.sameReader); await originalWorkface('Reader selection and scrolling')
  await click('.agent-information-reader__pin'); await until('Native Pin keeps same reader', 'document.querySelector(".agent-information-reader")?.dataset.pinned==="true"')
  assert.equal(await read('document.querySelector(".agent-information-reader")===window.__activityOriginalReader'),true)
  move(1250,880);for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,x:1250,y:880,button:'left',clickCount:1});await pause(300)
  await until('Pinned reading outlives source menu', '!document.querySelector(".project-activity-menu")')
  assert.equal(await read('!!document.querySelector(".agent-information-reader[data-pinned=true]")'),true,'Closing the invoking menu retains its pinned reading')
  await shot('wide-pinned-reader.png','Pinned original reading survives source menu dismissal')
  await click('.agent-information-reader__pin'); await click('.agent-information-reader__close'); await closed()

  for(let index=0;index<8&&!await read('document.activeElement?.classList.contains("project-activity")');index++)await key('Tab')
  assert.equal(await read('document.activeElement?.classList.contains("project-activity")'),true,'Native Tab reaches the original activity trigger')
  await key('ArrowDown')
  await until('Keyboard reaches Zone trigger', 'document.activeElement?.classList.contains("project-activity-zone")')
  await key('ArrowRight'); await until('Keyboard enters Agent submenu', 'document.activeElement?.classList.contains("project-activity-agent")')
  const keyboardFirst = await read('document.activeElement.dataset.sessionId')
  await key('ArrowDown'); assert.notEqual(await read('document.activeElement.dataset.sessionId'),keyboardFirst,'ArrowDown continues the menu rather than entering the reading surface')
  await key('ArrowUp'); await key('ArrowRight')
  await until('ArrowRight enters shared Reader', 'document.querySelector(".agent-information-reader")?.contains(document.activeElement)')
  await click('.agent-information-reader__status'); await until('Shared reader source details', '!!document.querySelector(".agent-information-reader__metadata")')
  await key('Escape'); await until('Escape leaves Reader details only', '!!document.querySelector(".agent-information-reader")&&!document.querySelector(".agent-information-reader__metadata")')
  await key('Escape'); await until('Escape returns to exact Agent menu occurrence', '!document.querySelector(".agent-information-reader")&&document.activeElement?.dataset.regionId==="activity-a-left"')
  await pause(240); assert.ok(await read('!!document.querySelector(".project-activity-submenu")'),'Returning from Reader keeps its original keyboard menu beyond hover grace')
  await hover('.project-activity-agent[data-region-id="activity-a-left"]');await key('ArrowRight');await until('Hovered focused Agent enters Reader', 'document.querySelector(".agent-information-reader")?.contains(document.activeElement)')
  await click('.agent-information-reader__pin');await key('Escape')
  await until('Pinned foreground Reader Escape keeps source menu', '!document.querySelector(".agent-information-reader")&&!!document.querySelector(".project-activity-menu")')
  await pause(240);assert.ok(await read('!!document.querySelector(".project-activity-submenu")'),'Pinned Reader Escape keeps source keyboard menu beyond hover grace')
  await key('ArrowLeft'); await until('ArrowLeft returns to Zone', 'document.activeElement?.classList.contains("project-activity-zone")&&!document.querySelector(".project-activity-submenu")')
  await key('Escape'); await until('Escape closes activity root', '!document.querySelector(".project-activity-menu")')
  await originalWorkface('Keyboard inspection')
  result.keyboard = { rightToReader: true, detailsEscape: true, readerEscapeToExactOccurrence: true, retainedBeyondHoverGrace: true, pinnedReaderEscape: true, leftToZone: true, menuEscape: true }

  for(const width of [640,360]){
    win.setContentSize(width,900);await stable();move(width-4,880)
    await openZone(zoneId);result['geometry'+width]=await geometry()
    await shot(`narrow-cascade-${width}.png`,'Readable activity cascade at '+width+' CSS pixels');await closed()
  }
  win.setContentSize(1280,900);await stable();await openZone(zoneId)
  await click('.project-activity-agent[data-region-id="activity-a-second"]')
  await until('Exact repeated Agent occurrence navigation', 'window.activityCascadeScene.facts().selection?.tabId==="activity-second-tab"&&window.activityCascadeScene.facts().selection?.regionId==="activity-a-second"')
  result.secondOccurrence = await facts();assert.equal(result.secondOccurrence.activeWorkspaceId,'activity-project')
  await openZone(await read('window.activityCascadeScene.reviewZone'));await click('.project-activity-agent[data-region-id="activity-review-region"]')
  await until('Cross-Zone explicit navigation', 'window.activityCascadeScene.facts().selection?.tabId==="activity-review-tab"&&window.activityCascadeScene.facts().selection?.regionId==="activity-review-region"')
  result.reviewNavigation = await facts();assert.equal(result.reviewNavigation.activeWorkspaceId,'activity-review')
  await openZone(await read('window.activityCascadeScene.moteZone'));await click('.project-activity-agent[data-region-id="activity-mote-region"]')
  await until('Mote occurrence navigation', 'window.activityCascadeScene.facts().selection?.tabId==="activity-mote-tab"&&window.activityCascadeScene.facts().selection?.regionId==="activity-mote-region"')
  result.moteNavigation=await facts();assert.equal(result.moteNavigation.activeWorkspaceId,'__scratch__')
  await hover('.project-activity');await hover('.project-activity-zone[data-unplaced]');await click('.project-activity-agent[data-session-id="activity-orphan"]')
  await until('Unplaced Agent retains original selectSession action', 'window.activityCascadeScene.facts().selectedId==="activity-orphan"')
  result.after = await facts(); result.keyboardEvents=await read('window.activityCascadeKeys')
  assert.ok(result.keyboardEvents.length>0);assert.ok(result.keyboardEvents.every(event=>event.trusted),'Every keyboard action is trusted Chromium native input')
  assert.ok(result.keyboardEvents.some(event=>event.key==='ArrowRight'),'Native accelerator mapping reaches DOM ArrowRight')
  assert.equal(result.after.sameDrafts,true);assert.equal(result.after.draft,result.before.draft);assert.deepEqual(result.after.controls,[])
  result.passed = true
} catch (error) {
  result.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1
  try { result.failureFacts = await win.webContents.executeJavaScript(`({active:document.activeElement?.outerHTML.slice(0,1200),text:document.body.innerText.slice(0,5000),facts:window.activityCascadeScene?.facts()})`);await fs.writeFile(path.join(evidence,'failure.png'),(await win.webContents.capturePage()).toPNG()) } catch {}
}
finally { unsubscribe?.(); await fs.writeFile(path.join(evidence, 'actual.json'), JSON.stringify(result, null, 2) + '\n'); if (win && !win.isDestroyed()) win.destroy(); app.exit(result.passed ? 0 : 1) } })
