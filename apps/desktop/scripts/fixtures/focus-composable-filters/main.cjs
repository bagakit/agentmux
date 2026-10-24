const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { schema: 'agentmux.focus-composable-filters-actual.v1', passed: false, pid: process.pid, frames: [], scenarios: [], rendererConsole: [],
  boundary: 'Actual App/FocusFilters/Store/Workbench using typed preview input, isolated PTY and unused Monaco painting. Mote remains the current coordination owner, explicitly outside the execution set. No live Runtime, Run/PID, restart or installation proof.' }
let win
app.whenReady().then(async () => { try {
  win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) result.rendererConsole.push(String(message).slice(0, 2000)) })
  const read = async code => { try { return await win.webContents.executeJavaScript(code) } catch (error) { result.failedEvaluation = code; throw error } }
  const pause = ms => new Promise(done => setTimeout(done, ms))
  const until = async (label, predicate) => { const end = Date.now() + 10000; do { if (await predicate()) return; await pause(30) } while (Date.now() < end); throw new Error('Filter scene did not settle: ' + label) }
  const settle = () => read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
  const element = target => typeof target === 'string' ? `document.querySelector(${JSON.stringify(target)})`
    : target.text ? `[...document.querySelectorAll('.focus-filter-menu [role="menuitem"]')].find(e=>e.textContent===${JSON.stringify(target.text)})`
      : `[...document.querySelectorAll('.focus-filter-menu [data-focus-${target.dimension}]')].find(e=>e.getAttribute('data-focus-${target.dimension}')===${JSON.stringify(target.id)})`
  const rect = async target => { await read(`(${element(target)})?.scrollIntoView({block:'nearest'})`); await settle(); return read(`(()=>{const e=${element(target)};if(!e)throw new Error('Missing exact control '+${JSON.stringify(JSON.stringify(target))});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`) }
  const click = async target => { const r = await rect(target); assert.equal(r.hit, true, 'Actual click ' + JSON.stringify(target)); for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 }); await settle() }
  const key = async (value, code = value) => { const virtualCode = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, ' ': 32, ArrowUp: 38, ArrowDown: 40 }[value]; for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: value, code, modifiers: 0, ...(virtualCode ? { windowsVirtualKeyCode: virtualCode, nativeVirtualKeyCode: virtualCode } : {}) }); await settle() }
  const input = async (selector, text) => { await click(selector); await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4, commands: ['selectAll'] }); await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 0 }); await key('Backspace'); if (text) await win.webContents.debugger.sendCommand('Input.insertText', { text }); await settle(); assert.equal(await read(`document.querySelector(${JSON.stringify(selector)}).value`), text, 'Real keyboard option search edit') }
  const ids = () => read(`[...document.querySelectorAll('.global-focus-main .focus-context[data-session-id]')].map(e=>e.dataset.sessionId).sort()`)
  const checked = async (dimension, id) => read(`(${element({ dimension, id })})?.getAttribute('aria-checked')`)
  const expectIds = async (label, expected) => { await until(label, async () => JSON.stringify(await ids()) === JSON.stringify([...expected].sort())); result.scenarios.push({ label, ids: await ids() }) }
  const open = async () => { if (!await read('!!document.querySelector(".focus-filter-menu")')) await click('[aria-label="Focus filters"]'); await until('actual filter menu', () => read(`(()=>{const m=document.querySelector('.focus-filter-menu');return !!m&&getComputedStyle(m).opacity==='1'&&!m.getAnimations({subtree:true}).some(a=>a.playState==='running')})()`)) }
  const close = async () => { await key('Escape'); await until('menu dismissed', () => read('!document.querySelector(".focus-filter-menu")')) }
  const option = async (dimension, id) => { await open(); await click({ dimension, id }); assert.equal(await read('!!document.querySelector(".focus-filter-menu")'), true, 'Multi-select stays open'); await until('option toggled', async () => await checked(dimension, id) === 'true') }
  const frame = async (file, label, menu = false) => { if (!menu) { const r = await rect('[aria-label="Search contexts"]'); await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y }) } await settle(); const geometry = await read(`(()=>{const measure=e=>{const r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}};const toolbar=document.querySelector('.focus-toolbar'),trigger=document.querySelector('[aria-label="Focus filters"]'),search=document.querySelector('[aria-label="Search contexts"]'),menu=document.querySelector('.focus-filter-menu');return{viewport:innerWidth,appearance:document.documentElement.dataset.appearance,toolbar:measure(toolbar),trigger:measure(trigger),search:measure(search),menu:menu?measure(menu):null,chips:[...document.querySelectorAll('.focus-filter-chip__value')].map(e=>e.getAttribute('aria-label')),count:trigger.querySelector('.focus-filter-trigger__count')?.textContent??null,summary:trigger.getAttribute('aria-description'),ids:[...document.querySelectorAll('.global-focus-main .focus-context[data-session-id]')].map(e=>e.dataset.sessionId),nativeSelects:toolbar.querySelectorAll('select').length,overflow:toolbar.scrollWidth>toolbar.clientWidth+1}})()`)
    for (const [name, r] of Object.entries({ trigger: geometry.trigger, search: geometry.search })) { assert.ok(r.width > 0 && r.left >= 0 && r.right <= geometry.viewport + .5, 'Readable viewport control ' + name); if (!menu) assert.equal(r.hit, true, 'Actual control hit ' + name) }
    assert.equal(geometry.nativeSelects, 0); assert.equal(geometry.overflow, false, 'Toolbar has no horizontal overflow')
    if (menu) assert.ok(geometry.menu.left >= 0 && geometry.menu.right <= geometry.viewport + .5, 'Menu fits viewport')
    await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); result.frames.push({ file, label, ...geometry }) }

  await win.loadFile(html); win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await until('typed original workface', () => read('window.filterProof?.ready&&!!document.querySelector("[data-owner-tab=original] textarea")'))
  await read('window.filterProof.enter()'); await click('button.surface-navigation__focus')
  await until('original workface retained in Focus', () => read('document.querySelector(".focused-tab-workspace")?.dataset.focusTabId==="original"'))
  await read('window.filterProof.remember()'); await pause(300); result.before = await read('window.filterProof.facts()'); result.sources = await read('window.filterProof.sources()')
  assert.deepEqual(result.sources.memberships['alpha-working'], ['project']); assert.deepEqual(result.sources.memberships['alpha-survey'], ['project', 'survey'])
  assert.deepEqual(result.sources.memberships['topic-working'], ['topic', 'survey']); assert.deepEqual(result.sources.memberships['unknown-source'], ['unknown'])
  assert.deepEqual(result.sources.pmoAttention, ['mote-coordinator']); assert.equal(result.sources.memberships['mote-coordinator'], undefined, 'Current Mote coordination identity stays outside execution filtering')
  const all = ['alpha-working', 'alpha-survey', 'alpha-attention', 'alpha-results', 'beta-working', 'topic-working', 'unknown-source']
  await expectIds('nonempty original execution set', all)
  for (const theme of ['dark', 'light']) { await read(`window.filterProof.theme(${JSON.stringify(theme)})`); for (const width of [1440, 640, 320]) { win.setContentSize(width, 900); await settle(); await frame(`${theme}-all-${width}.png`, `${theme} original execution contexts at ${width}`) } }

  // Real keyboard opens the shared menu, enters its search and toggles Survey.
  await click('[aria-label="Focus filters"]'); await until('keyboard-ready menu', () => read('!!document.querySelector(".focus-filter-menu")')); await key('Tab')
  assert.equal(await read('document.activeElement?.getAttribute("aria-label")'), 'Find Focus filter options')
  await win.webContents.debugger.sendCommand('Input.insertText', { text: 'Survey' }); await key('ArrowDown'); await key('ArrowDown'); await key(' ', 'Space')
  await until('keyboard Survey checked', async () => await checked('type', 'survey') === 'true'); assert.equal(await read('!!document.querySelector(".focus-filter-menu")'), true)
  await expectIds('Survey includes only exact member Contexts', ['alpha-survey', 'topic-working'])
  await input('[aria-label="Find Focus filter options"]', ''); await option('type', 'project')
  await expectIds('type OR includes Project and Survey', ['alpha-working', 'alpha-survey', 'alpha-attention', 'alpha-results', 'beta-working', 'topic-working'])
  const alphaKey = await read('window.filterProof.alphaKey'); await option('project', alphaKey)
  await expectIds('project AND type scopes the original Project', ['alpha-working', 'alpha-survey', 'alpha-attention', 'alpha-results'])
  await option('state', 'working'); await expectIds('state AND project AND type', ['alpha-working', 'alpha-survey'])
  await option('type', 'all'); await option('type', 'survey'); await expectIds('mixed lane does not leak Survey to sibling Session', ['alpha-survey'])
  win.setContentSize(320, 900); await settle(); await frame('light-selected-menu-320.png', 'Long original project name and three checked dimensions', true)
  result.menu = await read(`(()=>{const menu=document.querySelector('.focus-filter-menu'),r=menu.getBoundingClientRect(),original=[...menu.querySelectorAll('[data-focus-project]')].find(e=>e.getAttribute('data-focus-project')===window.filterProof.alphaKey),name=original.querySelector('.focus-filter-menu__name'),range=document.createRange();range.selectNodeContents(name);return{longText:name.textContent,lines:[...range.getClientRects()].map(r=>({left:r.left,right:r.right,top:r.top,bottom:r.bottom})),bounds:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},checked:[...menu.querySelectorAll('[aria-checked=true]')].map(e=>e.textContent)}})()`)
  assert.equal(result.menu.longText, await read('window.filterProof.longProject')); assert.ok(result.menu.lines.length > 0)
  result.menu.longNameFits = result.menu.lines.every(line => line.left >= result.menu.bounds.left && line.right <= result.menu.bounds.right)
  await close(); assert.equal(await read('document.activeElement?.getAttribute("aria-label")'), 'Focus filters', 'Escape returns to original trigger')
  // The original Workbench stays open. Widen Focus with its real resize handle
  // so the wide-container chip presentation is exercised at a 1440px window.
  win.setContentSize(1440, 900); await settle(); const divider = await rect('[aria-label="Resize Focus workspace"]')
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: divider.x, y: divider.y, button: 'left', clickCount: 1 })
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 930, y: divider.y, buttons: 1 })
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 930, y: divider.y, button: 'left', clickCount: 1 }); await settle()
  result.wideGeometry = await read(`(()=>{const measure=e=>{if(!e)return null;const r=e.getBoundingClientRect();const s=getComputedStyle(e);return{clientWidth:e.clientWidth,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,display:s.display,flex:s.flex,gap:s.gap,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}};return{viewport:innerWidth,ratio:document.querySelector('[aria-label="Resize Focus workspace"]').getAttribute('aria-valuenow'),toolbar:measure(document.querySelector('.focus-toolbar')),filterArea:measure(document.querySelector('.focus-toolbar__filters')),controls:measure(document.querySelector('.focus-filters .global-board-toolbar__controls')),search:measure(document.querySelector('.focus-filters .global-board-search')),mode:measure(document.querySelector('.focus-filters .global-board-toolbar__mode')),chips:measure(document.querySelector('.focus-filter-chips')),individualChips:[...document.querySelectorAll('.focus-filter-chip')].map(e=>({...measure(e),name:e.querySelector('.focus-filter-chip__value').getAttribute('aria-label'),value:measure(e.querySelector('.focus-filter-chip__value')),remove:measure(e.querySelector('.focus-filter-chip__remove'))})),trigger:measure(document.querySelector('[aria-label="Focus filters"]')),context:measure(document.querySelector('.focus-toolbar__context')),contextButtons:[...document.querySelectorAll('.focus-toolbar__context button')].map(e=>({...measure(e),name:e.getAttribute('aria-label')??e.textContent})).filter(e=>e.width>0&&e.height>0)}})()`)
  await fs.writeFile(path.join(evidence, 'wide-geometry.json'), JSON.stringify(result.wideGeometry, null, 2) + '\n')
  assert.notEqual(await read('getComputedStyle(document.querySelector(".focus-filter-chips")).display'), 'none', 'Real wide Focus container shows removable conditions')
  assert.ok(result.wideGeometry.search.width >= 70, 'Wide conditions preserve at least 70px search field')
  assert.equal(result.wideGeometry.individualChips.length, 3)
  for (const chip of result.wideGeometry.individualChips) { assert.ok(chip.value.width >= 24, 'Readable condition value ' + chip.name); assert.ok(chip.remove.width >= 20, 'Remove condition target ' + chip.name); assert.equal(chip.value.hit, true, 'Condition value hit ' + chip.name); assert.equal(chip.remove.hit, true, 'Remove condition hit ' + chip.name) }
  assert.ok(result.wideGeometry.contextButtons.length > 0)
  for (const button of result.wideGeometry.contextButtons) assert.equal(button.hit, true, 'Context action hit ' + button.name)
  for (const [index, a] of result.wideGeometry.contextButtons.entries()) for (const b of result.wideGeometry.contextButtons.slice(index + 1)) assert.ok(a.right <= b.left + .5 || b.right <= a.left + .5 || a.bottom <= b.top + .5 || b.bottom <= a.top + .5, 'Independent context action bounds: ' + a.name + ' / ' + b.name)
  for (const theme of ['dark', 'light']) { await read(`window.filterProof.theme(${JSON.stringify(theme)})`); for (const width of [1440, 640, 320]) { win.setContentSize(width, 900); await settle(); await frame(`${theme}-selected-${width}.png`, `${theme} three composed dimensions at ${width}`) } }
  win.setContentSize(1440, 900); await settle(); await click('[aria-label="Remove Type filter"]'); await expectIds('removing one chip keeps project and state', ['alpha-working', 'alpha-survey'])
  await open(); await click({ text: 'Clear filters' }); await until('clear closes menu', () => read('!document.querySelector(".focus-filter-menu")')); await expectIds('clear restores original full set', all)
  win.setContentSize(320, 900); await settle(); await option('type', 'mote'); await expectIds('Mote has explicit zero execution members under current owner', []); await close(); await frame('light-mote-empty-320.png', 'Mote filter zero state with coordination entry preserved')
  assert.ok(await read('!!document.querySelector(".focus-pmo-attention")'), 'Original coordination entry remains available')
  await open(); await option('type', 'all'); await option('type', 'unknown'); await close(); await expectIds('unknown source remains explicitly discoverable', ['unknown-source']); await frame('light-unknown-320.png', 'Unknown source condition')

  const beforeUpdates = await read('window.filterProof.facts()'); await read('window.filterProof.irrelevantOutputs()'); await settle(); const afterUpdates = await read('window.filterProof.facts()')
  assert.deepEqual(afterUpdates.reads, beforeUpdates.reads, 'Unrelated bytes do not add reads'); assert.deepEqual(afterUpdates.calls, beforeUpdates.calls); assert.deepEqual(afterUpdates.mounts, beforeUpdates.mounts); assert.deepEqual(afterUpdates.unmounts, beforeUpdates.unmounts)
  result.cost = { unrelatedUpdates: 20, before: beforeUpdates, after: afterUpdates }; result.after = await read('window.filterProof.facts()')
  for (const name of ['sameSearch', 'sameTrigger', 'sameDraft', 'sameTabs', 'sameLayouts', 'sameDrafts', 'sameFocus', 'sameRunObjects']) assert.equal(result.after[name], true, name)
  assert.equal(result.after.draft, 'Original unsent draft — keep this range'); assert.deepEqual(result.after.range, [7, 15]); assert.deepEqual(result.after.runs, result.before.runs); assert.deepEqual(result.after.unmounts, []); assert.deepEqual(result.after.calls, result.before.calls)
  const newAppearanceCalls = result.after.appearanceCalls.slice(result.before.appearanceCalls.length)
  result.filterReadCost = { before: result.before.reads, after: result.after.reads, additionalAppearanceCalls: newAppearanceCalls,
    boundary: 'Explicit filtering can remove and attach existing ProjectIcon consumers. The original ProjectIcon effect owns these appearance reads; exact mount/request timing is unmeasured. History, directory and control reads do not grow. Unrelated output updates must add no reads, including appearance.' }
  const { appearance: beforeAppearance, ...beforeDataReads } = result.before.reads, { appearance: afterAppearance, ...afterDataReads } = result.after.reads
  assert.deepEqual(afterDataReads, beforeDataReads, 'Filter conditions add no history or directory reads')
  assert.equal(newAppearanceCalls.length, afterAppearance - beforeAppearance, 'Every new appearance read is recorded')
  assert.equal(result.menu.longNameFits, true, 'Full long name within menu width')
  result.passed = true
} catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) await fs.writeFile(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) }
finally { await fs.writeFile(path.join(evidence, 'actual.json'), JSON.stringify(result, null, 2) + '\n'); if (win && !win.isDestroyed()) win.destroy(); app.exit(result.passed ? 0 : 1) } })
