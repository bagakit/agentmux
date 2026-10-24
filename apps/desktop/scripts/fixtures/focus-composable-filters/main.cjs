const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), vm = require('node:vm')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { schema: 'agentmux.focus-composable-filters-actual.v1', passed: false, pid: process.pid, frames: [], scenarios: [], rendererConsole: [],
  boundary: 'Actual App/FocusFilters/Store/Workbench using typed preview input, isolated PTY and unused Monaco painting. Mote metadata filtering and exact original location navigation stay separate from execution focus/history. No live Runtime, Run/PID, restart or installation proof.' }
let win
const syntaxSources = new Set()
app.whenReady().then(async () => { try {
  win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) result.rendererConsole.push(String(message).slice(0, 2000)) })
  const read = async code => { try { new vm.Script(code, { filename: 'focus-capture-read.js' }); syntaxSources.add(code); return await win.webContents.executeJavaScript(code) } catch (error) { result.failedEvaluation = code; throw error } }
  const pause = ms => new Promise(done => setTimeout(done, ms))
  const until = async (label, predicate) => { const end = Date.now() + 10000; do { if (await predicate()) return; await pause(30) } while (Date.now() < end); throw new Error('Filter scene did not settle: ' + label) }
  const settle = () => read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
  const element = target => typeof target === 'string' ? `document.querySelector(${JSON.stringify(target)})`
    : target.text ? `[...document.querySelectorAll(${JSON.stringify(target.scope ?? '.focus-filter-menu [role="menuitem"]')})].find(e=>e.textContent===${JSON.stringify(target.text)})`
      : `[...document.querySelectorAll('.focus-filter-menu [data-focus-${target.dimension}]')].find(e=>e.getAttribute('data-focus-${target.dimension}')===${JSON.stringify(target.id)})`
  const rect = async target => { await read(`(${element(target)})?.scrollIntoView({block:'nearest'})`); await settle(); return read(`(()=>{const e=${element(target)};if(!e)throw new Error('Missing exact control '+${JSON.stringify(JSON.stringify(target))});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`) }
  const click = async target => { const r = await rect(target); assert.equal(r.hit, true, 'Actual click ' + JSON.stringify(target)); for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 }); await settle() }
  const key = async (value, code = value) => { const virtualCode = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, ' ': 32, ArrowUp: 38, ArrowDown: 40 }[value]; for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: value, code, modifiers: 0, ...(virtualCode ? { windowsVirtualKeyCode: virtualCode, nativeVirtualKeyCode: virtualCode } : {}), ...(type === 'keyDown' && (value === 'Enter' || value === ' ') ? { text: value === 'Enter' ? '\r' : ' ', unmodifiedText: value === 'Enter' ? '\r' : ' ' } : {}) }); await settle() }
  const focusByTab = async selector => { await click('[aria-label="Search contexts"]'); for (let step = 0; step < 100; step++) { await key('Tab'); if (await read(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`)) return } throw new Error('Keyboard could not reach exact existing control ' + selector) }
  const input = async (selector, text) => { await click(selector); await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4, commands: ['selectAll'] }); await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 0 }); await key('Backspace'); if (text) await win.webContents.debugger.sendCommand('Input.insertText', { text }); await settle(); assert.equal(await read(`document.querySelector(${JSON.stringify(selector)}).value`), text, 'Real keyboard option search edit') }
  const ids = () => read(`[...document.querySelectorAll('.focus-project-lanes__row .focus-context[data-session-id]')].map(e=>e.dataset.sessionId).sort()`)
  const coordinationIds = () => read(`[...document.querySelectorAll('.focus-coordination-results .focus-context[data-session-id]')].map(e=>e.dataset.sessionId).sort()`)
  const checked = async (dimension, id) => read(`(${element({ dimension, id })})?.getAttribute('aria-checked')`)
  const expectIds = async (label, expected) => { await until(label, async () => JSON.stringify(await ids()) === JSON.stringify([...expected].sort())); result.scenarios.push({ label, ids: await ids() }) }
  const expectCoordination = async (label, expected) => { await until(label, async () => JSON.stringify(await coordinationIds()) === JSON.stringify([...expected].sort())); result.scenarios.push({ label, coordinationIds: await coordinationIds() }) }
  const open = async () => { if (!await read('!!document.querySelector(".focus-filter-menu")')) await click('[aria-label="Focus filters"]'); await until('actual filter menu', () => read(`(()=>{const m=document.querySelector('.focus-filter-menu');return !!m&&getComputedStyle(m).opacity==='1'&&!m.getAnimations({subtree:true}).some(a=>a.playState==='running')})()`)) }
  const close = async () => { await key('Escape'); await until('menu dismissed', () => read('!document.querySelector(".focus-filter-menu")')) }
  const option = async (dimension, id, selected = true) => { await open(); await click({ dimension, id }); assert.equal(await read('!!document.querySelector(".focus-filter-menu")'), true, 'Multi-select stays open'); await until('option toggled', async () => await checked(dimension, id) === String(selected)) }
  const clear = async () => { await open(); await click({ text: 'Clear filters' }); await until('clear closes menu', () => read('!document.querySelector(".focus-filter-menu")')); await input('[aria-label="Search contexts"]', '') }
  const dismissChoices = { text: 'Dismiss location choices', scope: '[aria-label="Choose original Mote location"] button' }
  const chooserSelector = '[aria-label="Choose original Mote location"]', chooserNode = `document.querySelector(${JSON.stringify(chooserSelector)})`
  const choiceList = `document.querySelectorAll(${JSON.stringify(chooserSelector + ' .focus-location-choice')})`
  const searchNode = `document.querySelector(${JSON.stringify('[aria-label="Search contexts"]')})`
  const frame = async (file, label, menu = false, overlay = false) => { if (!menu && !overlay) { const r = await rect('[aria-label="Search contexts"]'); await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y }) } await settle(); const geometry = await read(`(()=>{const measure=e=>{const r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}};const toolbar=document.querySelector('.focus-toolbar'),trigger=document.querySelector('[aria-label="Focus filters"]'),search=document.querySelector('[aria-label="Search contexts"]'),menu=document.querySelector('.focus-filter-menu'),rows=document.querySelector('.focus-project-lanes__rows'),coord=document.querySelector('.focus-coordination-results');return{viewport:innerWidth,appearance:document.documentElement.dataset.appearance,toolbar:measure(toolbar),trigger:measure(trigger),search:measure(search),menu:menu?measure(menu):null,chips:[...document.querySelectorAll('.focus-filter-chip__value')].map(e=>e.getAttribute('aria-label')),count:trigger.querySelector('.focus-filter-trigger__count')?.textContent??null,summary:trigger.getAttribute('aria-description'),ids:[...document.querySelectorAll('.focus-project-lanes__row .focus-context[data-session-id]')].map(e=>e.dataset.sessionId),coordinationIds:[...document.querySelectorAll('.focus-coordination-results .focus-context[data-session-id]')].map(e=>e.dataset.sessionId),coordinationInOriginalScrollport:!coord||coord.closest('.focus-project-lanes__rows')===rows,scrollport:rows?{...measure(rows),clientHeight:rows.clientHeight,scrollHeight:rows.scrollHeight,scrollTop:rows.scrollTop}:null,nativeSelects:toolbar.querySelectorAll('select').length,overflow:toolbar.scrollWidth>toolbar.clientWidth+1}})()`)
    for (const [name, r] of Object.entries({ trigger: geometry.trigger, search: geometry.search })) { assert.ok(r.width > 0 && r.left >= 0 && r.right <= geometry.viewport + .5, 'Readable viewport control ' + name); if (!menu && !overlay) assert.equal(r.hit, true, 'Actual control hit ' + name) }
    assert.equal(geometry.nativeSelects, 0); assert.equal(geometry.overflow, false, 'Toolbar has no horizontal overflow')
    assert.equal(geometry.coordinationInOriginalScrollport, true, 'Mote results use original Focus scrollport')
    if (menu) assert.ok(geometry.menu.left >= 0 && geometry.menu.right <= geometry.viewport + .5, 'Menu fits viewport')
    await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); result.frames.push({ file, label, ...geometry }) }

  await win.loadFile(html); win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await until('typed original workface', () => read('window.filterProof?.ready&&!!document.querySelector("[data-owner-tab=original] textarea")'))
  await read('window.filterProof.enter()'); await click('button.surface-navigation__focus')
  await until('original workface retained in Focus', () => read('document.querySelector(".focused-tab-workspace")?.dataset.focusTabId==="original"'))
  await read('window.filterProof.remember()'); await pause(300); result.before = await read('window.filterProof.facts()'); result.sources = await read('window.filterProof.sources()')
  assert.deepEqual(result.sources.memberships['alpha-working'], ['project']); assert.deepEqual(result.sources.memberships['alpha-survey'], ['project', 'survey'])
  assert.deepEqual(result.sources.memberships['topic-working'], ['topic', 'survey']); assert.deepEqual(result.sources.memberships['unknown-source'], ['unknown'])
  assert.deepEqual(result.sources.pmoAttention, ['mote-coordinator']); assert.deepEqual(result.sources.memberships['mote-coordinator'], ['mote', 'survey']); assert.deepEqual(result.sources.memberships['mote-writer'], ['mote'])
  assert.deepEqual(result.sources.coordination.map(row => row.id), ['mote-coordinator', 'mote-writer']); assert.ok(result.sources.coordination.every(row => row.recap === null), 'Coordination metadata has explicit no-body recap')
  const all = ['alpha-working', 'alpha-survey', 'alpha-attention', 'alpha-results', 'beta-working', 'topic-working', 'unknown-source']
  await expectIds('nonempty original execution set', all)
  await expectCoordination('default keeps coordination compact', [])
  for (const theme of ['dark', 'light']) { await read(`window.filterProof.theme(${JSON.stringify(theme)})`); for (const width of [1440, 640, 320]) { win.setContentSize(width, 900); await settle(); await frame(`${theme}-all-${width}.png`, `${theme} original execution contexts at ${width}`) } }

  // Real keyboard opens the shared menu, enters its search and toggles Survey.
  await click('[aria-label="Focus filters"]'); await until('keyboard-ready menu', () => read('!!document.querySelector(".focus-filter-menu")')); await key('Tab')
  assert.equal(await read('document.activeElement?.getAttribute("aria-label")'), 'Find Focus filter options')
  await win.webContents.debugger.sendCommand('Input.insertText', { text: 'Survey' }); await key('ArrowDown'); await key('ArrowDown'); await key(' ', 'Space')
  await until('keyboard Survey checked', async () => await checked('type', 'survey') === 'true'); assert.equal(await read('!!document.querySelector(".focus-filter-menu")'), true)
  await expectIds('Survey includes only exact member Contexts', ['alpha-survey', 'topic-working'])
  await expectCoordination('Survey includes original Mote source overlap', ['mote-coordinator'])
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
  result.singleStateMenu = await read(`({ states: [...document.querySelectorAll('.focus-filter-menu [data-focus-state]')].map(e=>e.getAttribute('data-focus-state')), actions: [...document.querySelectorAll('.focus-filter-menu [role="menuitem"]')].map(e=>e.textContent) })`)
  assert.deepEqual(result.singleStateMenu.states, ['all', 'attention', 'working', 'results', 'idle', 'unknown', 'recovery'])
  assert.deepEqual(result.singleStateMenu.actions, ['Clear filters', 'Search all retained conversation text', 'Done'], 'States are offered once in the original group, without duplicate shortcuts')
  await rect('.focus-filter-menu [data-focus-state="recovery"]')
  for (const theme of ['dark', 'light']) { await read(`window.filterProof.theme(${JSON.stringify(theme)})`); for (const width of [1440, 320]) { win.setContentSize(width, 900); await settle(); await frame(`${theme}-state-menu-${width}.png`, `${theme} single State group without duplicate shortcut actions at ${width}`, true) } }
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
  await clear(); await expectIds('clear restores original full set', all); await expectCoordination('clear restores compact Mote reminder', [])
  await open(); assert.equal(await read(`document.querySelector('[data-focus-type="mote"] .focus-filter-menu__count')?.textContent`), '2', 'Mote menu count comes from real coordination candidates')
  await expectCoordination('inspecting counts keeps coordination compact', []); await option('type', 'mote'); await close()
  await expectIds('Mote filtering leaves execution set separate', []); await expectCoordination('Mote positively matches both original coordinators', ['mote-coordinator', 'mote-writer'])
  for (const theme of ['dark', 'light']) { await read(`window.filterProof.theme(${JSON.stringify(theme)})`); for (const width of [1440, 320]) { win.setContentSize(width, 900); await settle(); await frame(`${theme}-mote-${width}.png`, `${theme} independent Mote coordination group at ${width}`) } }
  await option('type', 'survey'); await expectIds('Mote OR Survey keeps execution Survey members', ['alpha-survey', 'topic-working']); await expectCoordination('Mote OR Survey preserves two original coordinators without duplication', ['mote-coordinator', 'mote-writer'])
  await option('type', 'mote', false); await expectCoordination('Survey alone narrows to its exact original Mote', ['mote-coordinator'])
  await option('project', await read('window.filterProof.scratchKey')); await option('state', 'attention'); await close(); await input('[aria-label="Search contexts"]', 'Research coordinator')
  await expectIds('Mote metadata Project State Query adds no execution rows', []); await expectCoordination('Project AND State AND Query selects original surveyed coordinator', ['mote-coordinator'])
  await frame('light-mote-composed-320.png', 'Mote source overlap composed with original Project, Attention and metadata query')
  await input('[aria-label="Search contexts"]', 'Mote writer'); await expectCoordination('query does not cross original Mote metadata', [])
  await clear(); await option('type', 'unknown'); await close(); await expectIds('unknown source remains explicitly discoverable', ['unknown-source']); await expectCoordination('Unknown does not fabricate Mote membership', []); await frame('light-unknown-320.png', 'Unknown source condition')
  await clear(); await option('type', 'mote'); await close(); await expectCoordination('Mote cost scenario has two real results', ['mote-coordinator', 'mote-writer'])

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

  // Navigation is explicit user work after the filter-only read oracle. The
  // original Mote Reader can now consume its body; it is not a filter cost.
  win.setContentSize(320, 900); await settle()
  assert.equal(result.after.moteOriginalActiveRegion, 'mote-active-neighbor')
  await click('.focus-coordination-results [data-session-id="mote-coordinator"]')
  await until('exact original inactive Mote Region opened', () => read(`window.filterProof.facts().floating?.open&&document.querySelector('[data-pmo-teams-topic-floating]:popover-open')?.dataset.moteTargetRegion==='mote-target-region'`))
  result.moteNavigation = await read('window.filterProof.facts()')
  assert.equal(result.moteNavigation.pmo.sessionId, 'mote-coordinator'); assert.equal(result.moteNavigation.sameExecutionFocus, true)
  assert.equal(result.moteNavigation.floating.reference.tabId, 'mote-tab'); assert.equal(result.moteNavigation.floating.reference.regionId, 'mote-target-region')
  assert.equal(result.moteNavigation.sameDraft, true); assert.deepEqual(result.moteNavigation.range, [7, 15]); assert.equal(result.moteNavigation.sameRunObjects, true)
  await frame('light-mote-original-location-320.png', 'Explicit Mote navigation opens the original inactive Region while execution focus stays intact', false, true)
  await click('[data-pmo-teams-topic-floating]:popover-open [aria-label="Close Mote"]')
  await until('original Mote popover closed', () => read('!document.querySelector("[data-pmo-teams-topic-floating]:popover-open")'))

  await read('window.filterProof.positions("multiple")'); await settle(); const beforeChoice = await read('window.filterProof.facts()')
  const writerCard = '.focus-coordination-results [data-session-id="mote-writer"]'
  await focusByTab(writerCard); await key('Enter')
  await until('exact original Mote location choices', () => read(`${choiceList}.length===2`))
  assert.equal(await read(`document.activeElement===${choiceList}[0]`), true, 'Keyboard entry focuses first original location choice')
  const unchosen = await read('window.filterProof.facts()'); assert.deepEqual(unchosen.floating, beforeChoice.floating); assert.deepEqual(unchosen.pmo, beforeChoice.pmo)
  assert.equal(unchosen.sameExecutionFocus, true)
  await frame('light-mote-location-choices-320.png', 'Multiple original locations remain explicit, inside the original Focus scrollport')
  await key('Tab'); await key('Tab')
  assert.equal(await read(`document.activeElement===${element(dismissChoices)}`), true, 'Keyboard reaches Dismiss after original location choices')
  await key('Enter'); await until('keyboard Dismiss closes choices', () => read(`!${chooserNode}`))
  result.choiceKeyboard = { firstChoiceFocused: true, dismissReached: true, returnedToOriginal: await read(`document.activeElement===document.querySelector(${JSON.stringify(writerCard)})`), returnedToSearch: await read(`document.activeElement===${searchNode}`) }
  assert.ok(result.choiceKeyboard.returnedToOriginal || result.choiceKeyboard.returnedToSearch, 'Dismiss restores original triggering card or retained search')
  await click('[aria-label="Search contexts"]'); await pause(150); await settle()
  result.choiceKeyboard.laterSearchFocusPreserved = await read(`document.activeElement===${searchNode}`)
  assert.equal(result.choiceKeyboard.laterSearchFocusPreserved, true, 'Dismiss cannot steal subsequent deliberate focus')
  await focusByTab(writerCard); await key('Enter'); await until('original choices reopen', () => read(`${choiceList}.length===2`))
  const secondChoice = `[...${choiceList}].find(e=>e.textContent.includes('Second original writing Mote location'))`
  await read(`(${secondChoice}).scrollIntoView({block:'nearest'})`); await settle()
  // Resolve the original rendered choice by its accessible visible label, then
  // dispatch real pointer input to that exact existing button.
  const second = await read(`(()=>{const e=${secondChoice},r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`)
  assert.equal(second.hit, true); for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: second.x, y: second.y, button: 'left', clickCount: 1 }); await settle()
  await until('explicit second original location opened', () => read('window.filterProof.facts().floating?.reference?.tabId==="writer-second-location"&&window.filterProof.facts().floating.open'))
  result.multipleLocationNavigation = await read('window.filterProof.facts()'); assert.equal(result.multipleLocationNavigation.sameExecutionFocus, true)
  await click('[data-pmo-teams-topic-floating]:popover-open [aria-label="Close Mote"]'); await settle()
  await read('window.filterProof.positions("none")'); await settle(); const beforeMissing = await read('window.filterProof.facts()')
  await click('.focus-coordination-results [data-session-id="mote-writer"]')
  await until('missing location preserves original context', () => read(`${chooserNode}?.textContent.includes('No original Mote location is confirmed')`))
  result.missingLocation = await read('window.filterProof.facts()'); assert.equal(result.missingLocation.sameExecutionFocus, true); assert.deepEqual(result.missingLocation.pmo, beforeMissing.pmo)
  assert.deepEqual(result.missingLocation.floating, beforeMissing.floating); assert.equal(result.missingLocation.sameDraft, true)
  await frame('light-mote-missing-location-320.png', 'Missing original location keeps current work and explicit context visible')
  await click(dismissChoices); await read('window.filterProof.restoreVariants()'); await settle()

  const growthIds = await read('window.filterProof.grow()'); await settle()
  await expectCoordination('real coordination metadata count grows in the existing scrollport', ['mote-coordinator', 'mote-writer', ...growthIds])
  await read(`(()=>{const rows=document.querySelector('.focus-project-lanes__rows');rows.scrollTop=rows.scrollHeight})()`)
  await settle(); await pause(100)
  result.growth = await read(`(()=>{const rows=document.querySelector('.focus-project-lanes__rows'),cards=[...rows.querySelectorAll('.focus-coordination-results .focus-context[data-session-id]')],last=cards.at(-1),r=last.getBoundingClientRect(),v=rows.getBoundingClientRect();return{count:cards.length,lastId:last.dataset.sessionId,scrollTop:rows.scrollTop,scrollHeight:rows.scrollHeight,clientHeight:rows.clientHeight,within: r.top>=v.top-.5&&r.bottom<=v.bottom+.5,hit:last.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),executionFocus:window.filterProof.facts().sameExecutionFocus}})()`)
  assert.equal(result.growth.count, 18); assert.ok(result.growth.scrollHeight > result.growth.clientHeight); assert.ok(result.growth.scrollTop > 0); assert.equal(result.growth.within, true); assert.equal(result.growth.hit, true); assert.equal(result.growth.executionFocus, true)
  await frame('light-mote-growth-bottom-320.png', 'Eighteen real Mote metadata results: final result remains reachable and pointer hit at 320px')
  await focusByTab(`.focus-coordination-results [data-session-id="${result.growth.lastId}"]`); await key('Enter')
  await until('last real Mote result responds', () => read(`!!${chooserNode}`))
  assert.equal(await read('window.filterProof.facts().sameExecutionFocus'), true)
  await read('window.filterProof.restoreVariants()'); await settle()
  // The original temporary candidate has now disappeared; Dismiss must use the
  // retained search instead of focusing its disconnected triggering card.
  assert.equal(await read(`document.activeElement===${element(dismissChoices)}`), true, 'Missing location keeps keyboard on Dismiss')
  await key('Enter'); await until('missing trigger Dismiss closes choices', () => read(`!${chooserNode}`))
  result.choiceKeyboard.removedTriggerFallsBackToSearch = await read(`document.activeElement===${searchNode}`)
  assert.equal(result.choiceKeyboard.removedTriggerFallsBackToSearch, true, 'Removed original trigger falls back to retained search')
  result.final = await read('window.filterProof.facts()')
  for (const name of ['sameSearch', 'sameTrigger', 'sameDraft', 'sameTabs', 'sameLayouts', 'sameDrafts', 'sameExecutionFocus', 'sameRunObjects']) assert.equal(result.final[name], true, 'Final preserved original ' + name)
  assert.deepEqual(result.final.runs, result.before.runs); assert.deepEqual(result.final.range, [7, 15]); assert.deepEqual(result.final.calls, result.before.calls)
  result.keyboardNativeEvents = await read('window.filterProof.inputEvents()')
  for (const type of ['keydown', 'keypress', 'click']) assert.ok(result.keyboardNativeEvents.some(event => event.type === type && event.sessionId === 'mote-writer' && event.trusted && (type === 'click' ? event.detail === 0 : event.key === 'Enter')), 'Original Chromium button receives trusted keyboard activation ' + type)
  assert.ok(result.keyboardNativeEvents.some(event => event.type === 'click' && event.scope === 'locations' && event.text === 'Dismiss location choices' && event.trusted && event.detail === 0), 'Dismiss receives trusted native keyboard click')
  result.passed = true
} catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) { result.keyboardNativeEvents = await win.webContents.executeJavaScript('window.filterProof?.inputEvents?.()??[]').catch(() => []); await fs.writeFile(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) } }
finally { result.evalSyntax = { uniqueSourcesChecked: syntaxSources.size, method: 'Every exact generated eval source compiled with vm.Script without DOM before Chromium execution.' }; await fs.writeFile(path.join(evidence, 'actual.json'), JSON.stringify(result, null, 2) + '\n'); if (win && !win.isDestroyed()) win.destroy(); app.exit(result.passed ? 0 : 1) } })
