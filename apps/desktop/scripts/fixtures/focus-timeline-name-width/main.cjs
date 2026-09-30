const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, evidence, mutation = 'baseline'] = process.argv.slice(2)
const scrollAddendum = mutation === 'vertical-scroll-addendum'
app.setPath('userData', path.join(privateRoot, 'profile')); app.setPath('sessionData', path.join(privateRoot, 'session'))
const actual = { passed: false, pid: process.pid, mutation, frames: [], controls: [], boundary: 'One ordinary private Electron process; compiled Timeline/Store with isolated typed presentation I/O. Not actual Core Run/PID, normal whole Desktop build or restart qualification.' }
app.whenReady().then(async () => {
 let win
 try {
  win = new BrowserWindow({ width: 1200, height: 500, show: false, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  await win.loadFile(html); win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  const evaluate = expression => win.webContents.executeJavaScript(expression)
  const until = async expression => { for (let i = 0; i < 150; i++) { const value = await evaluate(expression); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)) } throw new Error(`Did not settle: ${expression}`) }
  const point = selector => evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw new Error('Missing target');const r=node.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  const click = async selector => { const p = await point(selector); for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...p, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }) }
  const key = async value => { for (const type of ['rawKeyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: value, code: value, windowsVirtualKeyCode: value === 'ArrowRight' ? 39 : value === 'ArrowLeft' ? 37 : value === 'End' ? 35 : 36 }) }
  const drag = async (x, moves = [x]) => {
   const start = await point('[aria-label="Resize timeline names"]')
   await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start })
   await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', buttons: 1, clickCount: 1 })
   for (const target of moves) { await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target, y: start.y, button: 'left', buttons: 1 }); await evaluate('new Promise(requestAnimationFrame)') }
   const draft = await evaluate('widthSceneState()')
   await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: start.y, button: 'left', buttons: 0, clickCount: 1 })
   return draft
  }
  const geometry = () => evaluate(`(()=>{const scene=document.querySelector('.recent-focus'),ruler=scene.querySelector('.recent-focus__ruler'),scale=scene.querySelector('.recent-focus__time-scale'),tracks=[...scene.querySelectorAll('.recent-focus__track')],projects=[...scene.querySelectorAll('.recent-focus__project')].filter(n=>!n.hidden),rect=n=>n.getBoundingClientRect().toJSON();return{scene:rect(scene),header:rect(scene.querySelector('.recent-focus__header')),ruler:rect(ruler),scale:rect(scale),rulerName:rect(ruler.firstElementChild),names:tracks.filter(n=>!n.parentElement.inert).map(n=>rect(n.firstElementChild)),projectNames:projects.map(n=>rect(n.querySelector('.recent-focus__gutter'))),collapsed:tracks.filter(n=>n.parentElement.inert).map(n=>rect(n.querySelector('.recent-focus__lane'))),labels:[...scale.querySelectorAll('time')].map(n=>({text:n.textContent,...rect(n)})),handle:rect(scene.querySelector('[aria-label="Resize timeline names"]')),state:widthSceneState()}})()`)
  const assertGeometry = g => {
   assert.ok(g.scene.width > 0); assert.ok(g.scale.width > 0); assert.ok(g.names.length > 0); assert.ok(g.projectNames.length >= 2); assert.ok(g.collapsed.length > 0)
   assert.equal(g.rulerName.width, g.state.width)
   for (const name of [...g.names, ...g.projectNames]) assert.equal(name.right, g.rulerName.right)
   for (const lane of g.collapsed) assert.equal(lane.left, g.scale.left)
   assert.equal(g.header.height, 28); assert.ok(g.scale.width >= 144)
   const labels = g.labels.sort((a,b)=>a.left-b.left)
   assert.ok(labels.length > 0); for (let i = 1; i < labels.length; i++) assert.ok(labels[i-1].right <= labels[i].left + 1, 'Visible time labels do not overlap')
  }
  const shot = async name => { await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))'); const g = await geometry(); assertGeometry(g); const image = `${name}.png`; await fs.writeFile(path.join(evidence, image), (await win.webContents.capturePage()).toPNG()); actual.frames.push({ image, width: g.scene.width, geometry: g }); return g }
  await until('window.widthSceneState&&document.querySelectorAll(".recent-focus__segment").length===3')
  actual.initial = await evaluate('widthSceneState()'); assert.equal(actual.initial.savedWidth, 112)
  await click('[data-timeline-project] + [data-timeline-project] .recent-focus__project-heading')
  const draft = await drag(244)
  assert.equal(draft.savedWidth, 112); assert.equal(draft.width, 244)
  await until('widthSceneState().savedWidth===244')
  if(!scrollAddendum) await shot('wide')
  if (mutation !== 'baseline' && !scrollAddendum) { actual.passed = true; return }
  if (scrollAddendum) {
   await evaluate("document.querySelector('[aria-label=\"Resize Focus timeline\"]').focus({preventScroll:true})")
   await key('Home')
   await until("document.querySelector('.recent-focus').getBoundingClientRect().height===Number(document.querySelector('[aria-label=\"Resize Focus timeline\"]').getAttribute('aria-valuemin'))")
   actual.heightControl = await evaluate(`(()=>{const viewport=document.querySelector('.recent-focus__viewport'),handle=document.querySelector('[aria-label="Resize Focus timeline"]');return{height:Number(handle.getAttribute('aria-valuenow')),minimum:Number(handle.getAttribute('aria-valuemin')),scrollTop:viewport.scrollTop,scrollHeight:viewport.scrollHeight,clientHeight:viewport.clientHeight,tracks:document.querySelectorAll('[data-focus-timeline-id]').length,projects:document.querySelectorAll('[data-timeline-project]').length}})()`)
   assert.ok(actual.heightControl.scrollHeight > actual.heightControl.clientHeight, 'Real viewport must overflow before nonzero scroll')
   assert.equal(actual.heightControl.height,actual.heightControl.minimum); assert.equal(actual.heightControl.tracks,3); assert.equal(actual.heightControl.projects,2)
   const p = await evaluate(`(()=>{const viewport=document.querySelector('.recent-focus__viewport'),r=viewport.getBoundingClientRect();return{x:r.right-30,y:r.bottom-8}})()`)
   actual.wheelHit = await evaluate(`document.querySelector('.recent-focus__viewport').contains(document.elementFromPoint(${p.x},${p.y}))`)
   assert.equal(actual.wheelHit,true)
   await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',...p,deltaX:0,deltaY:16})
   await until("document.querySelector('.recent-focus__viewport').scrollTop>0")
   actual.actualVerticalWheel = await evaluate(`(()=>{const viewport=document.querySelector('.recent-focus__viewport');return{scrollTop:viewport.scrollTop,scrollHeight:viewport.scrollHeight,clientHeight:viewport.clientHeight}})()`)
   assert.ok(actual.actualVerticalWheel.scrollTop>0)
  }
  await click('[aria-label="View input records"]')
  await evaluate(`(()=>{const select=document.querySelector('[aria-label="Input records Context"]');select.value='width-archive';select.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await until('widthSceneState().inputs===91'); await click('[data-input-message-id]'); await until('!!document.querySelector("[data-input-preview-id]")')
  actual.preview = await evaluate(`(()=>{const node=document.querySelector('[data-input-preview-id]');window.widthOriginalBody=node;const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);let text;while(text=walker.nextNode()){if(text.textContent.includes('Original retained width task'))break}if(!text)throw new Error('No original native text');const range=document.createRange();range.selectNodeContents(text);window.getSelection().removeAllRanges();window.getSelection().addRange(range);const viewport=document.querySelector('.recent-focus__viewport');viewport.scrollTop=12;window.widthScroll=[viewport.scrollTop,viewport.scrollLeft];return{selection:window.getSelection().toString(),state:widthSceneState()}})()`)
  if(scrollAddendum){ assert.ok(actual.preview.selection.length>0); assert.ok((await evaluate('window.widthScroll'))[0]>0, 'Actual selected-body viewport scroll must be nonzero'); actual.beforeWidthOperations = await evaluate(`(()=>{const viewport=document.querySelector('.recent-focus__viewport');return{scrollTop:viewport.scrollTop,scrollHeight:viewport.scrollHeight,clientHeight:viewport.clientHeight}})()`); assert.ok(actual.beforeWidthOperations.scrollHeight>actual.beforeWidthOperations.clientHeight) }
  await drag(244, Array.from({ length: 100 }, (_, i) => i % 2 ? 244 : 228))
  await evaluate('document.querySelector("[aria-label=\\"Resize timeline names\\"]").focus({preventScroll:true})')
  for (let i = 0; i < 100; i++) await key(i % 2 ? 'ArrowRight' : 'ArrowLeft')
  actual.preservation = await evaluate(`(()=>{const viewport=document.querySelector('.recent-focus__viewport');return{sameBody:window.widthOriginalBody===document.querySelector('[data-input-preview-id]'),selection:window.getSelection().toString(),scroll:[viewport.scrollTop,viewport.scrollLeft],state:widthSceneState(),bodyCursor:document.body.style.cursor,userSelect:document.body.style.userSelect}})()`)
  assert.equal(actual.preservation.sameBody, true); assert.equal(actual.preservation.selection, actual.preview.selection); assert.deepEqual(actual.preservation.scroll, await evaluate('window.widthScroll'))
  assert.deepEqual(actual.preservation.state.counts, actual.preview.state.counts); assert.equal(actual.preservation.state.inputs, 91); assert.equal(actual.preservation.state.draft, 'Keep the original width draft'); assert.equal(actual.preservation.bodyCursor, ''); assert.equal(actual.preservation.userSelect, '')
  if(scrollAddendum){assert.ok(actual.preservation.scroll[0]>0); await shot('nonzero-scroll-preserved'); actual.controls=(await evaluate('widthSceneState()')).controls;assert.deepEqual(actual.controls,[]);actual.passed=true;return}
  // Close the reader with a trusted Escape before testing narrow display geometry.
  for (const type of ['rawKeyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await until('!document.querySelector(".recent-focus__message-preview")')
  await evaluate('document.querySelector("[aria-label=\\"Resize timeline names\\"]").focus({preventScroll:true})'); await key('End'); await until('widthSceneState().savedWidth===320')
  win.setContentSize(360, 360); await until('innerWidth===360&&widthSceneState().width===176')
  const narrow = await shot('narrow'); assert.equal(narrow.state.savedWidth, 320)
  const before = narrow.state
  const p = await point('.recent-focus__time-scale')
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...p, deltaX: 20, deltaY: 0 })
  await until(`widthSceneState().start>${before.start}`)
  const after = await evaluate('widthSceneState()'); assert.ok(Math.abs((after.start-before.start)-20/narrow.scale.width*4*3600000)<1)
  actual.wheel = { before, after, actualTimeWidth: narrow.scale.width }
  win.setContentSize(1200,500);await until('innerWidth===1200&&widthSceneState().width===320');await shot('restored-wide')
  actual.controls = (await evaluate('widthSceneState()')).controls; assert.deepEqual(actual.controls, []); actual.passed = true
 } catch (error) { actual.failure = { name: error.name, message: error.message, stack: error.stack }; if(win&&!win.isDestroyed())await fs.writeFile(path.join(evidence,'failure.png'),(await win.webContents.capturePage()).toPNG()) }
 finally { await fs.writeFile(path.join(evidence, 'actual.json'), JSON.stringify(actual, null, 2)+'\n');if(win&&!win.isDestroyed())win.destroy();app.exit(actual.passed?0:1) }
})
