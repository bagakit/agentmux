const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path'), { createHash } = require('node:crypto')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { schema: 'agentmux.terminal-region-menu-render.v1', passed: false, frames: [], scenarios: [], consoleErrors: [], userRunTouched: false }
let win
const evaluate = expression => win.webContents.executeJavaScript(expression)
const delay = ms => new Promise(done => setTimeout(done, ms))
const region = `document.querySelector('[data-workbench-region-id="region-actions-target"]')`
const body = `${region}.querySelector('.xterm-screen')`, textarea = `${region}.querySelector('.xterm-helper-textarea')`
const menu = `document.querySelector('[role="menu"][data-state="open"]')`
const item = label => `([...${menu}.querySelectorAll('[role="menuitem"]')].find(node=>(node.getAttribute('aria-label')??node.querySelector('span')?.textContent??node.textContent).trim()===${JSON.stringify(label)}))`
async function waitFor(expression) {
  for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(25) }
  throw new Error('Timed out: '+expression)
}
async function painted() {
  await evaluate(`(async()=>{const popup=${menu};if(popup){popup.getBoundingClientRect();await Promise.all(popup.getAnimations().map(animation=>animation.finished.catch(()=>{})))}await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))})()`)
}
async function point(expression) { return evaluate(`(()=>{const r=${expression}.getBoundingClientRect();return{x:r.left+Math.min(20,r.width/2),y:r.top+Math.min(8,r.height/2)}})()`) }
async function key(key, code, windowsVirtualKeyCode, modifiers = 0) {
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode,modifiers})
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode,modifiers})
}
async function click(expression) {
  const p=await point(expression)
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',clickCount:1})
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'left',clickCount:1})
}
async function close() { if(await evaluate(`Boolean(${menu})`)){await key('Escape','Escape',27);await waitFor(`!${menu}`);await painted()} }
async function seed(width, appearance='dark') {
  await close()
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:width*2+1,height:780,deviceScaleFactor:1,mobile:false})
  await evaluate(`identityMenu.appearance(${JSON.stringify(appearance)});terminalMenu.seed()`)
  await waitFor(`Boolean(${body})&&!${region}.querySelector('.terminal-view__xterm--hydrating')`)
  await evaluate('terminalMenu.prepare()');await painted()
}
async function opened() {
  await waitFor(`Boolean(${menu})`);await painted()
  assert.equal(await evaluate(`${menu}.classList.contains('agent-region-menu')`),true,'The actual terminal body reaches the shared Agent menu')
  assert.equal(await evaluate(`document.querySelectorAll('[role="menu"][data-state="open"]').length`),1,'One original Root owns the popup')
  for(const label of ['Split Right','Copy Agent Link','Copy Region Link','Session details','Stop Agent'])assert.equal(await evaluate(`Boolean(${item(label)})`),true,'Common Agent action remains available: '+label)
  assert.equal(await evaluate(`${menu}.querySelectorAll('[aria-label="Copy Agent Link"]').length`),1,'The exact Agent identity is present once')
}
async function openBody(blank = false) {
  const p=await point(body)
  if(blank)p.y=await evaluate(`(()=>{const r=${body}.getBoundingClientRect(),rows=terminalMenu.facts().terminal.rows;return r.top+(Math.min(5,rows-1)+.5)*r.height/rows})()`)
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'right',clickCount:1})
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'right',clickCount:1})
  await opened()
  assert.equal(await evaluate(`Boolean(${menu}.querySelector('[data-terminal-menu-tools]'))`),true,'The actual source contributes its original terminal tools')
}
async function frame(file) {
  const bounds=await evaluate(`(()=>{const e=${menu},r=e.getBoundingClientRect(),style=getComputedStyle(e);return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth,opacity:Number(style.opacity),transform:style.transform,transformSettled:style.transform==='none'||new DOMMatrixReadOnly(style.transform).isIdentity}})()`)
  const png=(await win.webContents.capturePage()).toPNG();await fs.writeFile(path.join(evidence,file+'.png'),png)
  result.frames.push({file:file+'.png',png:createHash('sha256').update(png).digest('hex'),bounds})
  assert.equal(bounds.opacity,1,'Capture waits for the actual menu entry animation opacity')
  assert.equal(bounds.transformSettled,true,'Capture waits for the actual menu entry animation transform')
  assert.ok(bounds.left>=0&&bounds.right<=bounds.width&&bounds.top>=0&&bounds.bottom<=bounds.height,'Menu remains inside the actual viewport: '+JSON.stringify(bounds))
  assert.ok(bounds.scrollWidth<=bounds.clientWidth,'The actual shared menu has no horizontal overflow')
}
app.whenReady().then(async()=>{
  try {
    await fs.mkdir(evidence,{recursive:true});win=new BrowserWindow({show:false,width:1281,height:780,webPreferences:{backgroundThrottling:false,sandbox:false}})
    win.webContents.on('console-message',details=>{if(details.level==='error')result.consoleErrors.push(details.message)})
    await win.loadFile(html);win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
    await waitFor('Boolean(window.terminalMenu)')
    for(const appearance of ['dark','light'])for(const width of [640,320]){
      await seed(width,appearance);const before=await evaluate('terminalMenu.facts().terminal')
      await openBody()
      assert.equal(await evaluate(`Boolean(${body}.closest('[aria-hidden="true"]'))`),true,'The real modal isolates the original terminal for accessibility')
      await evaluate('terminalMenu.appendOutput()');await waitFor(`terminalMenu.facts().outputLine==='Fresh output while the menu is open'`);await painted()
      assert.equal(await evaluate(`Boolean(${menu}.querySelector('[data-terminal-menu-tools]'))`),true,'Normal output keeps the original context tools after modal isolation')
      for(const label of ['Copy','Paste','Select all','Find'])assert.equal(await evaluate(`${item(label)}.querySelector('span').textContent`),label,'Common terminal action has a visible label')
      await frame(`${width}-${appearance}-body`)
      const { cursor: beforeCursor, ...beforeSurface }=before
      const { cursor: afterCursor, ...afterSurface }=await evaluate('terminalMenu.facts().terminal')
      assert.deepEqual(afterSurface,beforeSurface,'Body disclosure and normal output preserve the original terminal and geometry')
      await close();await evaluate(`${region}.querySelector('.agent-region-header__more').focus()`);await key('ArrowDown','ArrowDown',40);await opened()
      assert.equal(await evaluate(`Boolean(${menu}.querySelector('[data-terminal-menu-tools]'))`),false,'More has no residual terminal source')
      await frame(`${width}-${appearance}-more`);await close()
    }
    await seed(320);await evaluate('terminalMenu.mouseReporting(true)');await openBody(true)
    assert.equal(await evaluate(`${item('Copy')}.hasAttribute('data-disabled')`),true,'No selection keeps Copy disabled')
    assert.equal(await evaluate(`${menu}.querySelector('[role="note"]').textContent.toLowerCase().includes('drag')`),true,'Actual mouse reporting keeps its selection escape hint')
    await frame('320-dark-mouse-reporting');await close()
    await evaluate('(async()=>{await terminalMenu.mouseReporting(false);terminalMenu.select()})()');await painted();await openBody()
    assert.equal(await evaluate(`${item('Copy')}.hasAttribute('data-disabled')`),false,'The actual original selection remains copyable')
    await frame('320-dark-selection');await click(item('Copy'));await waitFor(`!${menu}`)
    assert.equal(await evaluate('terminalMenu.facts().clipboard.at(-1)'),'src/original.txt')
    for(const chord of [{key:'ContextMenu',code:'ContextMenu',vk:93,modifiers:0},{key:'F10',code:'F10',vk:121,modifiers:8}]){
      await evaluate(`${textarea}.focus();terminalMenu.clearInputs()`);await key(chord.key,chord.code,chord.vk,chord.modifiers);await opened()
      const facts=await evaluate('terminalMenu.facts()')
      assert.equal(facts.inputs.length,0,'A real context-menu chord never reaches PTY input')
      assert.ok(facts.gestures.some(event=>event.type==='keydown'&&event.trusted&&event.key===chord.key),'The original menu key was trusted browser input')
      assert.equal(await evaluate(`Boolean(${menu}.querySelector('[data-terminal-menu-tools]'))`),true)
      assert.equal(await evaluate(`Boolean(${menu}.querySelector('[title*="src/original.txt"]'))`),false,'A keyboard request does not reuse the prior pointer path')
      if(chord.key==='ContextMenu')await frame('320-dark-keyboard')
      result.scenarios.push({kind:'keyboard',chord,inputs:facts.inputs,gestures:facts.gestures});await close()
    }
    await evaluate('terminalMenu.clearInputs()');await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1})
    await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...await point(body),id:1}]})
    await opened();await frame('320-dark-touch')
    await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
    await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled',{enabled:false})
    const touch=await evaluate('terminalMenu.facts()');assert.equal(touch.inputs.length,0,'A touch menu gesture does not type into the original Run')
    assert.ok(touch.gestures.some(event=>event.type==='pointerdown'&&event.trusted&&event.pointerType==='touch'))
    result.scenarios.push({kind:'touch',inputs:touch.inputs,gestures:touch.gestures});await close()
    await openBody();await evaluate('identityMenu.focusNeighbor()');const exact=await evaluate('terminalMenu.facts()')
    await click(item('Copy Agent Link'));await waitFor(`!${menu}`);let after=await evaluate('terminalMenu.facts()')
    assert.equal(after.clipboard.at(-1),`amux://agent/${encodeURIComponent(exact.tab.regions['region-actions-target'].sessionId)}`)
    assert.equal(after.active,'region-actions-survivor');assert.deepEqual(after.sessions,exact.sessions);assert.equal(after.draft,exact.draft)
    await openBody();await click(item('Copy visible output'));await waitFor(`!${menu}`);after=await evaluate('terminalMenu.facts()')
    assert.ok(after.clipboard.at(-1).includes('Original retained terminal output'),'Output copy uses the original actual terminal buffer')
    assert.equal(result.frames.length,12);assert.equal(result.scenarios.length,3);assert.deepEqual(result.consoleErrors,[])
    result.passed=true
  } catch(error) { result.failure={name:error.name,message:error.message,stack:error.stack};result.failureFacts=await evaluate('window.terminalMenu?.facts()').catch(()=>null) }
  finally { await fs.writeFile(path.join(evidence,'render.json'),JSON.stringify(result,null,2));win?.destroy();app.exit(result.passed?0:1) }
})
