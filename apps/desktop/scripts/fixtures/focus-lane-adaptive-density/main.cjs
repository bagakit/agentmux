const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { schema: 'agentmux.focus-lane-adaptive-actual.v1', passed: false, pid: process.pid, frames: [], scenes: [], rendererConsole: [], boundary: 'Actual App/Focus/Workbench/Store. Typed preview Session/Run references, PTY and unused Monaco paint isolated. No true Run/PID/Writer/restart/installation.' }
let win
app.whenReady().then(async () => { try {
  win = new BrowserWindow({ width: 1440, height: 800, useContentSize: true, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) result.rendererConsole.push(String(message).slice(0, 2000)) })
  const read = async code => { try { return await win.webContents.executeJavaScript(code) } catch (error) { result.failedEvaluation = code; throw error } }, pause = ms => new Promise(done => setTimeout(done, ms))
  const until = async (label, predicate) => { const end = Date.now() + 10000; do { if (await predicate()) return; await pause(30) } while (Date.now() < end); throw new Error('Lane scene did not settle: ' + label) }
  await win.loadFile(html); win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  const settle = () => read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
  const rect = selector => read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing actual control: '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`)
  const move = async selector => { const r = await rect(selector); assert.equal(r.hit, true, 'Actual pointer hit ' + selector); await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y }) }
  const click = async selector => { const r = await rect(selector); assert.equal(r.hit, true, 'Actual click hit ' + selector); for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 }) }
  const key = async value => { for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: value, code: value }) }
  await until('original retained leaf', () => read('window.laneProof?.ready&&document.querySelectorAll("[data-fixture-session]").length===1'))
  await read('window.laneProof.enter()'); await click('button.surface-navigation__focus')
  await until('original Focus projection', () => read('document.querySelector(".focused-tab-workspace")?.dataset.focusTabId==="original"'))
  await click('[aria-label="Close Focus workspace"]'); await until('projection closed only', () => read('!document.querySelector(".global-session-workspace")'))
  await read('window.laneProof.remember()'); result.before = await read('window.laneProof.facts()')
  const laneSelector = '.focus-project-board > .focus-project-lanes [data-project-id="alpha"]'
  const geometry = () => read(`(()=>{const lane=document.querySelector(${JSON.stringify(laneSelector)}),groups=lane.querySelector('.focus-project-lanes__groups');const measure=e=>{const r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};return{viewport:innerWidth,laneId:lane.dataset.laneId,groups:measure(groups),overflow:groups.scrollWidth>groups.clientWidth+1,states:[...groups.children].map(section=>{const header=section.querySelector('.focus-context-group__header'),bucket=header.querySelector('.focus-context-group__bucket'),icon=header.querySelector('svg'),count=section.dataset.bucket==='disconnected'?header.querySelector('button span'):bucket?.querySelector('span'),entry=header.querySelector('button');return{state:section.dataset.bucket,empty:section.dataset.empty==='true',rect:measure(section),header:measure(header),label:header.getAttribute('aria-label'),icon:icon&&measure(icon),count:count&&{text:count.textContent,rect:measure(count)},entry:entry&&{rect:measure(entry),disabled:entry.disabled,label:entry.getAttribute('aria-label')},cards:[...section.querySelectorAll('.focus-context')].map(card=>({id:card.dataset.sessionId,rect:measure(card)}))}})}})()`)
  const qualify = (g, state) => {
    assert.deepEqual(g.states.map(s => s.state), ['attention', 'working', 'results', 'idle', 'disconnected'])
    assert.equal(g.overflow, false, 'No per-lane horizontal scroll')
    assert.equal(g.states.filter(s => s.cards.length).length, 1, 'One actual nonempty state')
    const nonempty = g.states.find(s => s.state === state); assert.ok(nonempty.cards.length > 0)
    for (const item of g.states) {
      assert.ok(item.icon && item.label, 'State icon and accessible label nonempty')
      assert.ok(Math.abs(item.rect.top - g.states[0].rect.top) <= 1, 'Single nonempty state must not turn five states into vertical list')
      if (item.state === 'disconnected') { assert.ok(item.rect.width <= 32.5); assert.equal(item.cards.length, 0) }
      else if (item.empty) { assert.ok(item.rect.width <= 24.5); assert.equal(item.count.text, '0'); assert.ok(item.count.rect.top >= item.icon.bottom - .5, 'Zero counter below state icon') }
      for (const card of item.cards) { assert.ok(card.rect.width >= 179 && card.rect.width <= 320.5, 'Readable bounded card width') }
    }
  }
  const frame = async (file, label, state) => { await move('[aria-label="Search contexts"]'); await pause(240); if (await read('!!document.querySelector(".focus-filter-menu")')) await key('Escape'); await until('unrelated menus actually closed', () => read('!document.querySelector(".focus-navigation-preview,.focus-filter-menu")')); await settle(); const g = await geometry(); result.currentGeometry = g; qualify(g, state); result.scenes.push({ label, actual: g }); await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); result.frames.push({ file, label, viewport: g.viewport }) }
  await read('window.laneProof.mode("results")'); await until('one actual Results', () => read('document.querySelectorAll(".focus-project-board > .focus-project-lanes [data-bucket=results] .focus-context").length===1'))
  const widths = process.env.AGENTMUX_FOCUS_LANE_ADAPTIVE_CSS_MUTATION ? [640] : [320, 640, 799, 801, 1440]
  for (const width of widths) { win.setContentSize(width, 800); await settle(); await frame('results-' + width + '.png', 'single-results-four-empty-' + width, 'results') }
  win.setContentSize(640, 800); await read('window.laneProof.mode("offline")')
  await until('Idle and five confirmed offline', () => read('document.querySelector(".focus-project-board > .focus-project-lanes .focus-disconnected-entry")?.textContent==="5"'))
  await frame('idle-offline-640.png', 'idle-five-offline-640', 'idle')
  win.setContentSize(320, 800); await settle(); await frame('idle-offline-320.png', 'idle-five-offline-320', 'idle')
  const entry = laneSelector + ' .focus-disconnected-entry'
  await pause(60); const hoverBefore = await read('window.laneProof.facts()'); await move(entry)
  await until('actual placed summary', () => read('(()=>{const e=document.querySelector(".focus-disconnected-summary");return e&&getComputedStyle(e).visibility==="visible"})()'))
  result.hover = await read('(()=>{const e=document.querySelector(".focus-disconnected-summary"),r=e.getBoundingClientRect();return{count:e.querySelectorAll("[data-disconnected-summary]").length,text:e.textContent,rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},facts:window.laneProof.facts()}})()')
  assert.equal(result.hover.count, 3); assert.ok(result.hover.text.includes('2 more')); assert.ok(result.hover.rect.left >= 0 && result.hover.rect.right <= 320.5)
  assert.deepEqual(result.hover.facts.reads, hoverBefore.reads); assert.deepEqual(result.hover.facts.calls, hoverBefore.calls); assert.equal(result.hover.facts.sameFocus, true)
  await fs.writeFile(path.join(evidence, 'offline-summary-320.png'), (await win.webContents.capturePage()).toPNG()); result.frames.push({ file: 'offline-summary-320.png', label: 'bounded-five-offline-hover', viewport: 320 })
  await click(entry); await until('one offline retained view', () => read('document.querySelectorAll(".focus-disconnected-projects .focus-context").length===5'))
  result.reveal = await read('(()=>{const view=document.querySelector(".focus-disconnected-projects");return{ids:[...view.querySelectorAll(".focus-context")].map(e=>e.dataset.sessionId),active:document.activeElement?.dataset.sessionId,localRows:document.querySelectorAll(".focus-project-board > .focus-project-lanes [data-bucket=disconnected] .focus-context").length,facts:window.laneProof.facts()}})()')
  assert.deepEqual(result.reveal.ids, Array.from({ length: 5 }, (_, i) => 'archived-' + i)); assert.equal(result.reveal.localRows, 0); assert.equal(result.reveal.facts.sameFocus, true)
  await key('Escape'); await until('Return closes exact view', () => read('document.querySelectorAll(".focus-disconnected-projects .focus-context").length===0')); assert.equal(await read('document.activeElement===document.querySelector(' + JSON.stringify(entry) + ')'), true)
  await read('window.laneProof.mode("multiple")')
  await until('three Working cards and three other live states', () => read('document.querySelectorAll(".focus-project-board > .focus-project-lanes [data-bucket=working] .focus-context").length===3'))
  result.multiple = []
  for (const width of [640, 1440]) {
    win.setContentSize(width, 800); await move('[aria-label="Search contexts"]'); await settle()
    const g = await geometry(); result.multiple.push(g)
    assert.deepEqual(g.states.map(item => item.state), ['attention', 'working', 'results', 'idle', 'disconnected'])
    assert.equal(g.overflow, false, 'Populated lanes remain within the actual viewport')
    const working = g.states.find(item => item.state === 'working'); assert.equal(working.cards.length, 3)
    assert.equal(g.states.find(item => item.state === 'disconnected').cards.length, 0)
    for (const item of g.states) for (const card of item.cards) assert.ok(card.rect.width >= 179 && card.rect.width <= 320.5, 'More width keeps cards bounded')
    if (width === 1440) assert.ok(new Set(working.cards.map(card => Math.round(card.rect.left))).size > 1, 'Wide lanes arrange more Working cards across')
    const file = 'multiple-' + width + '.png'; await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); result.frames.push({ file, label: 'populated-state-width-' + width, viewport: width })
  }
  const scratchSelector = '.focus-project-board > .focus-project-lanes [data-project-id=' + JSON.stringify(await read('window.laneProof.scratchProjectId')) + ']'
  win.setContentSize(640, 800); await read('window.laneProof.mode("topics")'); await until('two exact Topic lanes', () => read(`document.querySelectorAll(${JSON.stringify(scratchSelector)}).length===2`))
  result.topics = await read(`(()=>{const lanes=[...document.querySelectorAll(${JSON.stringify(scratchSelector)})];return lanes.map(e=>({laneId:e.dataset.laneId,name:e.querySelector('.focus-project-lanes__heading').textContent,entry:e.querySelector('.focus-disconnected-entry').getAttribute('aria-label')}))})()`)
  assert.equal(new Set(result.topics.map(lane => lane.laneId)).size, 2)
  await move('[aria-label="Search contexts"]'); await settle(); await fs.writeFile(path.join(evidence, 'two-topics-640.png'), (await win.webContents.capturePage()).toPNG()); result.frames.push({ file: 'two-topics-640.png', label: 'two-precise-topics-one-project', viewport: 640 })
  const desired = result.topics.find(lane => lane.name.includes('Another precise Topic')); assert.ok(desired)
  const exact = '.focus-project-board > .focus-project-lanes [data-lane-id=' + JSON.stringify(desired.laneId) + '] .focus-disconnected-entry'
  await click(exact); await until('precise Topic reveal', () => read('document.activeElement?.dataset.sessionId==="topic-off-1"'))
  result.topicReveal = await read('({active:document.activeElement?.dataset.sessionId,lane:document.activeElement?.closest("[data-lane-id]")?.dataset.laneId,ids:[...document.querySelectorAll(".focus-disconnected-projects .focus-context")].map(e=>e.dataset.sessionId),facts:window.laneProof.facts()})')
  assert.equal(result.topicReveal.lane, desired.laneId); assert.deepEqual(result.topicReveal.ids, ['topic-off-0', 'topic-off-1']); assert.equal(result.topicReveal.facts.sameFocus, true)
  await move('.focus-disconnected-projects__return'); await settle(); await fs.writeFile(path.join(evidence, 'exact-topic-view-640.png'), (await win.webContents.capturePage()).toPNG()); result.frames.push({ file: 'exact-topic-view-640.png', label: 'exact-topic-retained-disconnected-view', viewport: 640 })
  await click('.focus-disconnected-projects__return'); assert.equal(await read('document.activeElement===document.querySelector(' + JSON.stringify(exact) + ')'), true)
  result.after = await read('window.laneProof.facts()')
  for (const field of ['sameSearch', 'sameDraft', 'sameTabs', 'sameLayouts', 'sameDrafts', 'sameFocus']) assert.equal(result.after[field], true, field)
  assert.equal(result.after.draft, 'Original unsent draft'); assert.deepEqual(result.after.range, [7, 15]); assert.equal(result.after.originalRun, result.before.originalRun); assert.deepEqual(result.after.mounts, result.before.mounts); assert.deepEqual(result.after.unmounts, []); assert.deepEqual(result.after.calls, result.before.calls)
  result.passed = true
} catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) await fs.writeFile(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) }
finally { await fs.writeFile(path.join(evidence, 'actual.json'), JSON.stringify(result, null, 2) + '\n'); if (win && !win.isDestroyed()) win.destroy(); app.exit(result.passed ? 0 : 1) } })
