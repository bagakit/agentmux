const { fixturePath: _hygiene_fixturePath } = require("../../lib/fixture-values.mjs")
const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const [html, privateRoot, evidence, mode, spatialModule, frameScope] = process.argv.slice(2)
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
    const animations=document.getAnimations().filter(a=>a.playState==='running'&&Number.isFinite(a.effect?.getComputedTiming().endTime));
    await Promise.all(animations.map(a=>a.finished.catch(()=>{})));await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
    if(!document.getAnimations().some(a=>a.playState==='running'&&Number.isFinite(a.effect?.getComputedTiming().endTime)))return true
  }})(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Finite animations did not settle')),4000)})])}finally{clearTimeout(timer)}})()`)
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
async function cancel(index = 0) {
  const before = await evaluate('takeoverProbe.facts()')
  await key('Escape', 'Escape', 27)
  await wait(`!${picker}`); await painted()
  const after = await evaluate('takeoverProbe.facts()')
  assert.equal(after.launches.length, before.launches.length, 'Opening and cancelling do not launch or send')
  assert.deepEqual(after.drafts, before.drafts, 'Cancel retains the actual original unsent draft')
  const returned = await evaluate(`document.activeElement===${more(index)}`)
  if (!returned) result.cancelFocusFailure = await evaluate(`({activeTag:document.activeElement?.tagName,activeClass:document.activeElement?.className,activeLabel:document.activeElement?.getAttribute('aria-label'),morePresent:Boolean(${more(index)}),moreInert:${more(index)}?.closest('[inert]')?.className,source:${source(index)}})`)
  assert.equal(returned, true, 'Cancel restores the same actual Region More trigger')
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
async function pauseMotion(name) {
  const motion = await evaluate(`(()=>{const animation=document.getAnimations().find(a=>a.animationName===${JSON.stringify(name)});if(!animation)throw new Error('Actual production animation missing');const duration=animation.effect.getTiming().duration;animation.pause();animation.currentTime=duration/2;window.takeoverPausedAnimation=animation;return{name:animation.animationName,duration,currentTime:animation.currentTime,playState:animation.playState}})()`)
  assert.ok(Number.isFinite(motion.duration)); assert.equal(motion.playState, 'paused')
  assert.equal(motion.currentTime, motion.duration / 2)
  return motion
}
async function resumeMotion() { await evaluate(`{window.takeoverPausedAnimation?.play();delete window.takeoverPausedAnimation}`) }
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
      webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.cjs') } })
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) errors.push(message) })
    await win.loadFile(html)
    win.webContents.debugger.attach('1.3')
    await wait(`Boolean(window.takeoverProbe) && document.documentElement.dataset.takeoverReady`)
    result.nativeDevicePixelRatio = await evaluate('devicePixelRatio')
    if (mode === 'first') {
      result.initial = await evaluate('takeoverProbe.facts()')
      result.originalVisibleBaseline = await originalTerminalReady()
      await frame('01-original-work')
      result.originalTerminalBefore = result.frameObservations.at(-1).terminal.terminals.find(t => t.regionId === result.initial.origins[0].regionId)
      for (const theme of ['dark', 'light']) for (const width of [940, 360]) {
        result.stage = `${theme}-${width}`
        await evaluate(`void takeoverProbe.appearance(${JSON.stringify(theme)})`); await size(width)
        await open(0, theme === 'light')
        await frame(`02-${theme}-${width}-picker`)
        const available = await evaluate(`${picker}.querySelector('[data-executor-id="cursor"]')?.disabled===false`)
        assert.equal(available, true, 'Unknown discovery remains an available configured choice')
        assert.equal(await evaluate(`${picker}.querySelector('[data-executor-id="pi"]')===null`), true, 'Only an authoritative missing command is excluded')
        await cancel(0)
      }
      await evaluate(`void takeoverProbe.appearance('dark')`); await size(940)
      result.stage = 'short-region-motion'
      await size(360, 420)
      await open(0, false, false)
      const entering = await pauseMotion('takeover-enter')
      assert.equal(entering.duration, 220, 'Finite production entrance uses 220ms')
      await frame('03-short-enter-midpoint', false, { motion: entering })
      await resumeMotion(); await painted(); await frame('03-short-picker')
      const beforeMotionCancel = await evaluate('takeoverProbe.facts()')
      await key('Escape', 'Escape', 27)
      const leaving = await pauseMotion('takeover-leave')
      assert.equal(leaving.duration, 140, 'Finite production exit uses 140ms')
      const immediateRelease = await evaluate(`(()=>{const p=${picker};const source=p?.parentElement;return{closing:p?.dataset.state,inert:p?.inert,moreFocused:document.activeElement===${more(0)},siblingsReleased:[...source?.children??[]].filter(e=>e!==p).every(e=>!e.inert)}})()`)
      const closingLayer = await evaluate(`({surfaceOpacity:getComputedStyle(${picker}).opacity,surfaceAnimation:getComputedStyle(${picker}).animationName,contentAnimation:getComputedStyle(${picker}.querySelector('.session-takeover__content')).animationName})`)
      assert.deepEqual(closingLayer,{surfaceOpacity:'1',surfaceAnimation:'none',contentAnimation:'takeover-leave'},'Exit keeps one opaque surface while only the picker content fades')
      assert.deepEqual(immediateRelease, { closing: 'closing', inert: true, moreFocused: true, siblingsReleased: true }, 'Exit immediately releases keyboard and underlying workface')
      await frame('03-short-exit-midpoint', false, { motion: leaving, immediateRelease, closingLayer })
      await resumeMotion(); await wait(`!${picker}`); await painted()
      const afterMotionCancel = await evaluate('takeoverProbe.facts()')
      assert.deepEqual(afterMotionCancel.drafts, beforeMotionCancel.drafts)
      assert.equal(afterMotionCancel.launches.length, beforeMotionCancel.launches.length)
      assert.equal(await evaluate(`document.activeElement===${more(0)}`), true)
      result.motion = { entering, leaving, immediateRelease, shortRegion: { width: 360, height: 420 } }
      await size(940)
      result.stage = 'focus-header-portal'
      await evaluate('takeoverProbe.focusProjection(true)')
      await wait(`Boolean(document.querySelector('#takeover-focus-slot-header .agent-region-header__more'))`)
      await open(0, true); await frame('03-focus-original-picker'); await cancel(0)
      result.focus = { actualWorkbenchProjection: true, headerPortalled: true, menuEntryOperated: true, cancelReturnsOriginalMore: true }
      await evaluate('takeoverProbe.focusProjection(false)')
      await painted()
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
      await open(0); await frame('03-reduced-motion-picker')
      assert.equal(result.frameObservations.at(-1).reducedMotion, true)
      assert.equal(result.frameObservations.at(-1).picker.animation, 'none')
      await cancel(0)
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
      await open(0)
      await click(`${picker}.querySelector('.launcher-other-agents')`)
      await wait(`Boolean(${picker}.querySelector('.launcher-unavailable-agents'))`)
      await frame('04-unavailable-command'); await cancel(0)
      // An independent original identity exercises unconfirmed admission. The
      // successful source's durable request identity is never erased or reused.
      result.stage = 'unconfirmed-creation'
      await evaluate('takeoverProbe.failure(true)'); await open(1)
      await click(`${picker}.querySelector('[data-executor-id="codex"]')`)
      await wait(`Boolean(${picker}?.querySelector('.session-takeover__issue'))`)
      await frame('05-unconfirmed-creation')
      const unknownBefore = await evaluate('takeoverProbe.facts()')
      const unknownOrigin = unknownBefore.origins[1]
      assert.equal(unknownBefore.layouts[unknownOrigin.workspaceId].groups.find(g => g.id === unknownOrigin.groupId).activeTabId, unknownOrigin.tabId, 'Unconfirmed creation visibly retains the original selected workface')
      await click(`${picker}.querySelector('.session-takeover__issue button')`)
      await painted(); await wait(`${picker}.getAttribute('aria-busy')==='false'`)
      const unknownAfter = await evaluate('takeoverProbe.facts()')
      assert.equal(unknownAfter.launches.length, unknownBefore.launches.length, 'Check again reads the same intent without another native launch')
      assert.deepEqual(Object.keys(unknownAfter.requests), Object.keys(unknownBefore.requests))
      result.unconfirmed = { before: unknownBefore, after: unknownAfter, launchNotRepeated: true }
      await cancel(1); await evaluate('takeoverProbe.failure(false)')
      result.stage = 'confirmed-creation'
      await open(0)
      const beforeLaunch = await evaluate('takeoverProbe.facts()')
      result.choiceFocus = []
      for (let n = 0; n < 3; n++) {
        if (n) await key('Tab', 'Tab', 9)
        result.choiceFocus.push(await evaluate(`({tag:document.activeElement?.tagName,class:document.activeElement?.className,executor:document.activeElement?.dataset.executorId,label:document.activeElement?.getAttribute('aria-label')})`))
      }
      assert.deepEqual(result.choiceFocus.map(f => f.executor ?? f.label), ['codex', 'claude', 'gemini'], 'Entry focus and each real Tab reach one configured choice button')
      assert.equal(await evaluate(`document.activeElement?.dataset.executorId`), 'gemini', 'Actual Tab navigation reaches the shared configured Gemini choice')
      await frame('06-keyboard-agent-choice')
      await key('Enter', 'Enter', 13)
      await wait(`takeoverProbe.facts().launches.length===${beforeLaunch.launches.length + 1}`)
      await wait(`takeoverProbe.facts().sessions.length===${beforeLaunch.sessions.length + 1}`)
      await wait(`!${picker}`)
      await painted()
      const afterLaunch = await evaluate('takeoverProbe.facts()')
      const originalSource = beforeLaunch.origins[0]
      assert.deepEqual(afterLaunch.tabs[originalSource.tabId].regions[originalSource.regionId], beforeLaunch.tabs[originalSource.tabId].regions[originalSource.regionId], 'Actual original Region binding is retained')
      assert.deepEqual(afterLaunch.drafts, beforeLaunch.drafts, 'Actual original drafts are retained')
      const launched = afterLaunch.launches.at(-1)
      assert.equal(launched.hostId, 'local'); assert.equal(launched.workspacePath, _hygiene_fixturePath("private/takeover-project"))
      assert.match(launched.prompt, /agent context --host local --session 'session-codex'/)
      const addedTabs = Object.keys(afterLaunch.tabs).filter(id => !beforeLaunch.tabs[id])
      assert.equal(addedTabs.length, 1, 'Actual production agent.open creates one separate Tab')
      assert.notEqual(addedTabs[0], originalSource.tabId)
      assert.equal(afterLaunch.layouts[originalSource.workspaceId].groups.find(g => g.tabOrder.includes(addedTabs[0])).activeTabId, addedTabs[0], 'Confirmed creation selects the actual successor Tab')
      assert.ok(afterLaunch.trusted.some(event => event.type === 'click' && event.trusted && event.executor === 'gemini' && event.takeover), 'Complete native Enter produces trusted browser button activation')
      result.launch = { before: beforeLaunch, after: afterLaunch, newTabId: addedTabs[0], promptIncluded: true }
      await frame('06-successor-new-tab')
      await evaluate('takeoverProbe.focus(0)'); await painted(); await frame('07-original-retained')
      const retainedTerminal = result.frameObservations.at(-1).terminal.terminals.find(t => t.regionId === originalSource.regionId)
      assert.deepEqual(retainedTerminal.options, result.originalTerminalBefore.options, 'Retained original terminal font options remain unchanged')
      assert.deepEqual(retainedTerminal.renderDimensions, result.originalTerminalBefore.renderDimensions, 'Retained original terminal CSS/device geometry remains unchanged')
      assert.deepEqual(retainedTerminal.buffer, result.originalTerminalBefore.buffer, 'Retained original terminal text and viewport remain unchanged')
      assert.deepEqual(retainedTerminal.screen, result.originalTerminalBefore.screen, 'Retained original terminal returns to the same visible coordinates')
      result.originalTerminalRetained = retainedTerminal
      // Wait for the real Renderer debounced persistence writer, then commit the
      // current spatial owner and Chromium localStorage, not a synthetic export.
      await wait(`(()=>{const f=takeoverProbe.facts();const p=JSON.parse(f.persisted??'null');return p?.state?.agentComposerDrafts?.[f.origins[0].sessionId]===f.drafts[f.origins[0].sessionId]})()`)
      result.sealed = await evaluate('takeoverProbe.seal()')
      result.spatial = await spatial.read()
      assert.ok(result.spatial.graph.tabs.some(tab => tab.tabId === result.launch.newTabId), 'Production spatial persistence owns the successor Tab')
      assert.ok(result.spatial.graph.regions.some(region => region.regionId === originalSource.regionId), 'Production spatial persistence owns the original Region')
      await fs.writeFile(path.join(evidence, 'restart-baseline.json'), JSON.stringify({
        tabs: result.sealed.tabs, layouts: result.sealed.layouts, drafts: result.sealed.drafts, sessions: result.sealed.sessions,
        spatial: result.spatial, newTabId: result.launch.newTabId, origins: result.sealed.origins
      }, null, 2))
    } else {
      const baseline = JSON.parse(await fs.readFile(path.join(evidence, 'restart-baseline.json'), 'utf8'))
      const restored = await evaluate('takeoverProbe.facts()')
      assert.equal(restored.bootRestored, true, 'Second actual Electron process reads external Native facts')
      assert.deepEqual(restored.tabs, baseline.tabs, 'Second actual Renderer loads saved original and new Tabs without workface reseeding')
      assert.deepEqual(restored.layouts, baseline.layouts, 'Second actual Renderer loads saved layout and selection')
      assert.deepEqual(restored.drafts, baseline.drafts, 'Second actual Renderer loads original unsent drafts from Chromium profile')
      assert.deepEqual(restored.sessions, baseline.sessions)
      assert.equal(restored.launches.length, 0, 'Cold restart sends and creates nothing')
      result.restored = restored
      result.spatial = await spatial.read()
      result.restart = { tabs: Object.keys(restored.tabs), drafts: Object.keys(restored.drafts), noWorkfaceReseed: true, noLaunch: true }
      result.restartVisibleBaseline = await originalTerminalReady()
      await frame('08-restart-original')
      await open(0); await frame('09-restart-picker'); await cancel(0)
    }
    result.consoleErrors = errors
    result.passed = true
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
