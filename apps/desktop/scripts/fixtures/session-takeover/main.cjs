const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const [html, privateRoot, evidence, mode, spatialModule, frameScope, qualification, nativeMutant] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { mode, processId: process.pid, passed: false, frames: [], frameObservations: [], frameScope: frameScope ?? 'all', userSessionTouched: false,
  scope: 'Actual production Electron Renderer operations, real Core spatial file owner and Chromium profile persistence; Native session API is controlled preview, not a vendor CLI run.' }
let win, spatial
const errors = []
const delay = ms => new Promise(done => setTimeout(done, ms))
const evaluate = code => win.webContents.executeJavaScript(code)
async function wait(code, label = code) {
  const deadline = Date.now() + 15000
  do { if (await evaluate(code)) return; await delay(25) } while (Date.now() < deadline)
  throw new Error('Actual Renderer deadline: ' + label)
}
async function painted() {
  return evaluate(`(async()=>{let timer;try{return await Promise.race([(async()=>{for(;;){
    const animations=document.getAnimations().filter(a=>a.playState==='running'&&Number.isFinite(a.effect?.getComputedTiming().endTime)&&!a.effect?.target?.closest?.('.xterm'));
    await Promise.all(animations.map(a=>a.finished.catch(()=>{})));await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
    if(!document.getAnimations().some(a=>a.playState==='running'&&Number.isFinite(a.effect?.getComputedTiming().endTime)&&!a.effect?.target?.closest?.('.xterm')))return true
  }})(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Finite animations did not settle: '+JSON.stringify(document.getAnimations().map(a=>({name:a.animationName,state:a.playState,time:a.currentTime,timing:a.effect?.getComputedTiming(),target:a.effect?.target?.className}))))),4000)})])}finally{clearTimeout(timer)}})()`)
}
async function point(expression) {
  return evaluate(`(()=>{const e=${expression};if(!e)throw new Error('Actual target is missing: '+${JSON.stringify(expression)});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
}
async function click(expression) {
  const p = await point(expression)
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 })
}
async function key(key, code, windowsVirtualKeyCode) {
  for (const type of key === 'Enter' ? ['rawKeyDown', 'char', 'keyUp'] : ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode, ...(type === 'char' ? { text: '\r', unmodifiedText: '\r' } : {}) })
}
const source = index => `takeoverProbe.facts().origins[${index}]`
const original = index => `document.querySelector('[data-workbench-region-id="'+${source(index)}.regionId+'"]')`
const more = index => `document.querySelector('.agent-region-header[data-agent-session-id="'+${source(index)}.sessionId+'"][data-owner-region-id="'+${source(index)}.regionId+'"] .agent-region-header__more')`
const picker = `document.querySelector('.session-takeover:not([hidden])')`
async function open(index = 0, keyboard = false, settle = true) {
  await evaluate(`takeoverProbe.focus(${index})`)
  await wait(`(()=>{const e=${more(index)};if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility==='visible'})()`)
  if (keyboard) { await evaluate(`${more(index)}.focus()`); await key('ArrowDown', 'ArrowDown', 40) }
  else await click(more(index))
  const item = `([...document.querySelectorAll('.agent-region-menu[role="menu"] [role="menuitem"]')].find(item=>item.textContent.trim()==='Take over'))`
  await wait(`Boolean(${item})`)
  if (keyboard) { await evaluate(`${item}.focus()`); await key('Enter', 'Enter', 13) }
  else await click(item)
  await wait(`Boolean(${picker}) && ${picker}.querySelectorAll('.agent-pick').length>0`)
  if (settle) await painted()
  await wait(`${picker}.contains(document.activeElement)`)
  assert.equal(await evaluate(`document.querySelectorAll('[role="dialog"]').length`), 0, 'Take over uses a Region local surface, not a modal')
  assert.equal(await evaluate(`${picker}.querySelectorAll('select').length`), 0, 'No technical history source or independent Executor dropdown')
  const acquired = await evaluate(`${picker}.contains(document.activeElement)`)
  if (!acquired) {
    result.pickerFocusFailure = await evaluate(`({activeTag:document.activeElement?.tagName,activeClass:document.activeElement?.className,activeLabel:document.activeElement?.getAttribute('aria-label'),pickerInert:${picker}.closest('[inert]')?.outerHTML.slice(0,400),pickerRect:${picker}.getBoundingClientRect().toJSON(),moreConnected:${more(index)}?.isConnected,moreActive:document.activeElement===${more(index)}})`)
    await frame('focus-entry-diagnostic')
  }
  assert.equal(acquired, true, 'Picker acquires actual focus')
}
async function originalTerminalReady() {
  await wait(`(()=>{const region=${original(0)};const xterm=region?.querySelector('.terminal-view__xterm');const term=takeoverProbe.terminalFacts().terminals.find(t=>t.regionId===${source(0)}.regionId);return Boolean(xterm&&!xterm.classList.contains('terminal-view__xterm--hydrating')&&!region.querySelector('.full-page-loading')&&getComputedStyle(xterm).visibility==='visible'&&term?.viewObservation?.liveReady&&term.canvases.some(c=>c.rect.width>0&&c.rect.height>0))})()`, 'Original terminal is visibly restored, no recovery layer remains, actual view is live ready')
  await painted()
  return evaluate(`({recoveryLayerAbsent:!${original(0)}.querySelector('.full-page-loading'),hydratingAbsent:!${original(0)}.querySelector('.terminal-view__xterm--hydrating'),liveReady:takeoverProbe.terminalFacts().terminals.find(t=>t.regionId===${source(0)}.regionId)?.viewObservation?.liveReady})`)
}
async function frame(name, settle = true, extra = {}) {
  if (settle) await painted()
  const capture = frameScope !== 'terminal' || ['01-original-work', '06-successor-new-tab', '07-original-retained', '08-restart-original'].includes(name)
  const observed = await evaluate(`(()=>{const p=${picker};const r=p?.getBoundingClientRect();return {width:innerWidth,height:innerHeight,
    appearance:document.documentElement.dataset.appearance??'unset',
    reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,
    picker:p?{x:r.x,y:r.y,width:r.width,height:r.height,choices:[...p.querySelectorAll('.agent-pick')].map(item=>({id:item.dataset.executorId,label:item.textContent,disabled:item.disabled,unknown:!!item.querySelector('.agent-pick__unconfirmed')})),issue:p.querySelector('[role="status"]')?.textContent,animation:getComputedStyle(p.querySelector('.session-takeover__content')).animationName}:null}})()`)
  const terminal = await evaluate('takeoverProbe.terminalFacts()')
  assert.equal(terminal.dpr, result.nativeDevicePixelRatio, 'Real window resizing preserves physical display DPR')
  for (const term of terminal.terminals) {
    assert.equal(term.browserDpr, terminal.dpr, 'Actual xterm browser DPR agrees with the private native window')
    for (const canvas of term.canvases.filter(c => c.rect.width > 0 && c.rect.height > 0)) {
      assert.ok(Math.abs(canvas.width - canvas.rect.width * terminal.dpr) <= 2, 'Actual canvas backing width agrees with CSS geometry and native DPR')
      assert.ok(Math.abs(canvas.height - canvas.rect.height * terminal.dpr) <= 2, 'Actual canvas backing height agrees with CSS geometry and native DPR')
    }
  }
  result.frameObservations.push({ name, captured: capture, ...observed, terminal, ...extra })
  if (!capture) return
  const image = (await win.webContents.capturePage()).toPNG()
  assert.ok(image.length > 0)
  const file = name + '.png'
  await fs.writeFile(path.join(evidence, file), image)
  result.frames.push({ file, sha256: createHash('sha256').update(image).digest('hex'), fullScene: true,
    png: { width: image.readUInt32BE(16), height: image.readUInt32BE(20) }, ...observed, terminal, ...extra })
}
async function size(width, height = 740) {
  // Resize the actual private window. A synthetic DPR override leaves native
  // device-pixel-content-box at the display DPR and splits WebGL geometry.
  win.setContentSize(width, height)
  await wait(`innerWidth===${width} && innerHeight===${height}`)
  await painted()
}
app.whenReady().then(async () => {
  try {
    await fs.mkdir(evidence, { recursive: true })
    const { AgentMuxSpatialStateStore } = await import(pathToFileURL(spatialModule).href)
    spatial = new AgentMuxSpatialStateStore(path.join(privateRoot, 'spatial-state.json'))
    const runtimePath = path.join(privateRoot, 'runtime-facts.json')
    ipcMain.handle('takeover:boot', async () => { try { return JSON.parse(await fs.readFile(runtimePath, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error } })
    ipcMain.handle('takeover:runtime', async (_event, value) => { await fs.writeFile(runtimePath, JSON.stringify(value)); return true })
    ipcMain.handle('takeover:spatial-read', () => spatial.read())
    ipcMain.handle('takeover:spatial-commit', (_event, value) => spatial.commit(value))
    ipcMain.handle('takeover:flush', async () => { await win.webContents.session.flushStorageData(); return true })
    win = new BrowserWindow({ width: 940, height: 740, show: false, frame: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: path.join(__dirname, 'preload.cjs') } })
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) errors.push(message) })
    await win.loadFile(html, ['agent-operations', 'operation-motion', 'operation-workload'].includes(qualification) ? { query: { agentOperations: '1' } } : undefined)
    win.webContents.debugger.attach('1.3')
    await wait(`Boolean(window.takeoverProbe) && document.documentElement.dataset.takeoverReady`)
    result.nativeDevicePixelRatio = await evaluate('devicePixelRatio')
    if (qualification === 'live-adoption') {
      const { runLiveAdoption } = require('./live-adoption-main.cjs')
      await runLiveAdoption({ result, evaluate, wait, click, open, frame, spatial, evidence, mode })
      result.consoleErrors = errors; result.passed = true; return
    }
    if (['agent-operations', 'operation-motion', 'operation-workload'].includes(qualification)) {
      const { runAgentOperations } = require('./agent-operations-main.cjs')
      // Live ordered output continually renews xterm's scrollbar transitions.
      // Observe painted frames without requiring the healthy terminal to go idle.
      const operationPainted = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      const operationFrame = async (name, _settle, extra) => { await operationPainted(); return frame(name, false, extra) }
      await runAgentOperations({ win, result, evaluate, wait, click, key, size, frame: operationFrame, painted: operationPainted, originalTerminalReady, spatial, evidence, mode, nativeMutant, motionOnly: ['operation-motion', 'operation-workload'].includes(qualification), workloadPreflight: qualification === 'operation-workload' })
      result.consoleErrors = errors; result.passed = true; return
    }
    throw new Error('This native fixture requires explicit live-adoption or agent-operations qualification')
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack, stage: result.stage, consoleErrors: errors }
    if (win && !win.isDestroyed()) {
      try { result.failureFacts = await evaluate('takeoverProbe.facts()') } catch {}
      try { result.failureSurface = await evaluate(`({activeTag:document.activeElement?.tagName,activeClass:document.activeElement?.className,notices:[...document.querySelectorAll('.terminal-service-window')].map(e=>e.textContent),surfaces:[...document.querySelectorAll('.session-takeover')].map(s=>({hidden:s.hidden,ariaBusy:s.getAttribute('aria-busy'),region:s.closest('[data-workbench-region-id]')?.dataset.workbenchRegionId,rect:s.getBoundingClientRect().toJSON(),issue:s.querySelector('.session-takeover__issue')?.textContent}))})`) } catch {}
      try { await frame('failure-diagnostic') } catch {}
    }
  }
  finally {
    if (win && !win.isDestroyed()) await win.webContents.session.flushStorageData()
    await fs.writeFile(path.join(evidence, `${mode}-render.json`), JSON.stringify(result, null, 2))
    win?.destroy(); app.exit(result.passed ? 0 : 1)
  }
})
