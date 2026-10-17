const assert = require('node:assert/strict')
const { readFile, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, evidence, phase] = process.argv.slice(2)
assert.ok(['seed', 'restore'].includes(phase))
app.setPath('userData', join(privateRoot, 'profile')); app.setPath('sessionData', join(privateRoot, 'session'))
const result = { passed: false, phase, pid: process.pid, frames: [], operations: [], userRunControlled: false }
const delay = ms => new Promise(done => setTimeout(done, ms))
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1200, height: 880, useContentSize: true, show: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
    result.console = []
    win.webContents.on('console-message', (_event, ...details) => result.console.push(details))
    const read = async code => { try { return await win.webContents.executeJavaScript(code) } catch (error) { result.failedEvaluation = code; throw error } }
    const until = async code => { for (let index = 0; index < 240; index++) { if (await read(code)) return; await delay(25) } throw new Error('Did not settle: ' + code) }
    const settle = async () => { await read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))'); await delay(180) }
    const facts = () => read('spaceListScene.facts()')
    const keyFor = id => JSON.stringify(['local', id === 'gamma' ? 'canonical-gamma' : id])
    const row = id => `.workspace-agent-list-item button.focus-context[data-session-id="${id}"]`
    const handle = id => `.workspace-agent-list-item:has([data-session-id="${id}"]) .workspace-agent-list-item__drag`
    const checkbox = id => `.workspace-agent-list-item:has([data-session-id="${id}"]) input[type=checkbox]`
    const button = label => `[aria-label=${JSON.stringify(label)}]`
    const namedButton = async label => {
      const selector = await read(`(()=>{const n=[...document.querySelectorAll('.workspace-agents-tool button')].find(n=>n.getAttribute('aria-label')===${JSON.stringify(label)}||n.textContent.trim()===${JSON.stringify(label)});if(!n)throw new Error('Missing original named control');n.dataset.probeTarget=${JSON.stringify(label)};return '[data-probe-target="'+n.dataset.probeTarget+'"]'})()`)
      return selector
    }
    const point = selector => read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw new Error('Missing original target');n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,hit:n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`)
    const mouseEvent = (type, x, y, button = 'left') => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, ...(type === 'mouseMoved' ? {} : { button, clickCount: 1 }), buttons: type === 'mousePressed' ? button === 'right' ? 2 : 1 : 0 })
    const click = async (selector, button = 'left') => { await settle(); const p = await point(selector); assert.equal(p.hit, true, 'Painted target center hit: ' + selector); for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await mouseEvent(type, p.x, p.y, button) }
    const clickLabel = async label => click(await namedButton(label))
    const key = async (value, code = value, modifiers = 0) => { const virtual = { ' ': 32, Tab: 9, Enter: 13, ArrowDown: 40, ArrowUp: 38, Escape: 27, F10: 121 }[value] ?? 0; for (const type of value === 'Enter' ? ['rawKeyDown', 'char', 'keyUp'] : ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: value, code, modifiers, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual, ...(type === 'char' ? { text: '\r', unmodifiedText: '\r' } : {}) }) }
    const filter = async value => { await click(`[aria-label="Filter Agents by state"] button[data-agent-filter="${value}"]`); await settle() }
    const shot = async (image, purpose) => {
      await settle()
      await until(`!document.querySelector('[role=menu]')||(()=>{const n=document.querySelector('[role=menu]');return Number(getComputedStyle(n).opacity)>=.999&&!n.getAnimations({subtree:true}).some(a=>a.playState==='running')})()`)
      const geometry = await read(`(()=>{const pane=document.querySelector('[data-space-list-pane]'),list=document.querySelector('.workspace-agents-tool'),header=list.querySelector('.workspace-agents-tool__header'),filters=list.querySelector('[aria-label="Filter Agents by state"]'),r=pane.getBoundingClientRect();return{pane:r.toJSON(),list:list.getBoundingClientRect().toJSON(),header:header.getBoundingClientRect().toJSON(),selecting:header.dataset.selecting,filters:filters.getBoundingClientRect().toJSON(),overlay:!!document.querySelector('[role=menu],.confirmation-dialog'),actions:[...header.querySelectorAll('button')].map(n=>{const r=n.getBoundingClientRect();return{label:n.getAttribute('aria-label'),title:n.title,disabled:n.disabled,rect:r.toJSON(),hit:n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}}),cards:[...document.querySelectorAll('.workspace-agent-list-item')].map(n=>({key:n.dataset.agentKey,rect:n.getBoundingClientRect().toJSON()}))}})()`)
      assert.ok(geometry.cards.length > 0)
      assert.ok(geometry.header.height <= 60, 'One compact header, including hidden selection scope')
      assert.ok(geometry.filters.top >= geometry.header.bottom, 'One filter layer follows the header')
      assert.equal(geometry.actions.length, geometry.selecting === 'true' ? 5 : 2, 'Original actions share the header')
      for (const action of geometry.actions) {
        assert.ok(action.label && action.title, 'Icon action retains its full accessible name and tooltip')
        assert.ok(action.rect.width >= 24 && action.rect.height >= 24, 'Desktop icon action has a usable hit area')
        assert.ok(action.rect.left >= geometry.pane.left && action.rect.right <= geometry.pane.right, 'Header action is not clipped')
        assert.ok(Math.abs(action.rect.y + action.rect.height / 2 - geometry.header.y - geometry.header.height / 2) <= 1, 'Header actions share one baseline')
        if (!geometry.overlay && !action.disabled) assert.equal(action.hit, true, 'Painted header action center is accessible')
      }
      await writeFile(join(evidence, image), (await win.webContents.capturePage()).toPNG())
      result.frames.push({ image, purpose, width: await read('innerWidth'), height: await read('innerHeight'), geometry, facts: await facts() })
    }
    await win.loadFile(html, { query: { phase } }); win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await until('window.spaceListScene?.ready && document.querySelectorAll(".workspace-agent-list-item button.focus-context").length===5')
    const symbols = await read(`([...document.querySelectorAll('.workspace-agents-tool svg use')]).map(n=>{const box=(n.closest('svg.semantic-icon')??n.closest('svg')).getBoundingClientRect();return{href:n.getAttribute('href'),found:!!document.getElementById(n.getAttribute('href').slice(1)),box:{width:box.width,height:box.height}}})`)
    assert.ok(symbols.length > 0, 'Original semantic sprite has visible consumers')
    for (const symbol of symbols) assert.equal(symbol.found, true, 'Original theme sprite target: ' + symbol.href)
    assert.ok(symbols.some(symbol => symbol.box.width > 0 && symbol.box.height > 0), 'Original theme sprite has painted visible consumers')
    result.semanticIcons = symbols
    result.initial = await facts(); result.seedCount = await read('spaceListScene.seedCount')
    if (phase === 'restore') {
      const expected = JSON.parse(await readFile(join(privateRoot, 'expected.json'), 'utf8'))
      assert.equal(result.seedCount, 0)
      assert.deepEqual(result.initial.order, expected.order, 'Real new Electron process consumes persisted manual list order')
      assert.deepEqual(result.initial.preference, expected.preference)
      assert.deepEqual(result.initial.sessions.map(session => session.id), expected.sessionIds)
      assert.deepEqual(result.initial.tabs, expected.tabs, 'Original Tab and Region restore without a second seed')
      assert.deepEqual(result.initial.layouts, expected.layouts, 'Original focus and split layout restore without a second seed')
      assert.deepEqual(result.initial.drafts, expected.drafts)
      assert.deepEqual(result.initial.controls, [])
      await shot('restored-order-384.png', 'New PID, same profile, original manual Space order without second preference seed')
    } else {
      assert.equal(result.seedCount, 1)
      assert.deepEqual(result.initial.order, ['alpha', 'beta', 'gamma', 'delta', 'offline'].map(keyFor))
      await shot('default-384.png', 'Creation-ordered list, shared Focus cards, visible state and recap')
      await read(`document.querySelector('[aria-label="Select Agents"]').focus()`)
      await key('Enter'); await settle()
      assert.equal(await read('document.activeElement?.getAttribute("aria-label")'), 'Done selecting', 'Keyboard activation retains the original toggle focus')
      await key('Tab'); await settle()
      assert.equal(await read('document.activeElement?.dataset.agentFilter'), 'all', 'First Tab reaches the retained filter layer')
      await key('Tab', 'Tab', 8); await key('Enter'); await settle()
      assert.equal(await read('document.activeElement?.getAttribute("aria-label")'), 'Select Agents', 'Keyboard exit retains the same toggle focus')
      await key('Tab'); await settle()
      assert.equal(await read('document.activeElement?.dataset.agentFilter'), 'all', 'Tab continues in place after leaving selection')
      result.operations.push({ kind: 'trusted-keyboard-selection-focus', enter: 'Done selecting', exit: 'Select Agents', next: 'all filter' })
      const nodes = await read('([...document.querySelectorAll(".workspace-agent-list-item")]).map(n=>n.dataset.agentKey)')
      await read('spaceListScene.churn()'); await settle()
      assert.deepEqual((await facts()).order, nodes, '100 actual Store activity publications do not reorder the list')
      const a = await point(handle('beta')), b = await point(handle('alpha'))
      await mouseEvent('mouseMoved', a.x, a.y); await mouseEvent('mousePressed', a.x, a.y)
      for (let step = 1; step <= 12; step++) { await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: a.x + (b.x - a.x) * step / 12, y: a.y + (b.y - a.y) * step / 12 }); await delay(20) }
      await mouseEvent('mouseReleased', b.x, b.y)
      await until('spaceListScene.facts().order[0]===JSON.stringify(["local","beta"])')
      result.operations.push({ kind: 'trusted-pointer-drag', order: (await facts()).order })
      await click(handle('beta')); await key(' ', 'Space')
      await until('!!document.querySelector(".workspace-agent-list-item.is-dragging")')
      await delay(120); await key('ArrowDown'); await delay(240); await key('ArrowDown'); await delay(240); await key(' ', 'Space')
      await until('spaceListScene.facts().order[0]===JSON.stringify(["local","alpha"]) && spaceListScene.facts().order[1]===JSON.stringify(["local","canonical-gamma"]) && spaceListScene.facts().order[2]===JSON.stringify(["local","beta"])')
      result.operations.push({ kind: 'trusted-keyboard-reorder', order: (await facts()).order })
      await click(row('gamma'), 'right')
      await until('!!document.querySelector(".focus-context-menu")')
      assert.equal(await read('document.querySelector(".focus-context-menu").dataset.agentSessionId'), 'gamma')
      assert.deepEqual(await read('[...document.querySelectorAll(".focus-context-menu [role=menuitem]")].map(n=>n.textContent.trim())'), ['Rename Agent', 'Copy Agent Link', 'Restart Session…', 'Stop Agent'])
      await shot('shared-menu-384.png', 'Space consumes the original Focus menu for the exact Agent')
      await key('Escape'); await until('!document.querySelector(".focus-context-menu")')
      await read('spaceListScene.addHostCollision()'); await settle()
      const selectMenu = async label => {
        await click(row('gamma'), 'right'); await until('!!document.querySelector(".focus-context-menu")')
        const selector = await read(`(()=>{const n=[...document.querySelectorAll('.focus-context-menu [role=menuitem]')].find(n=>n.textContent.trim()===${JSON.stringify(label)});if(!n)throw new Error('Missing original shared menu action');n.dataset.privateSingleAction='true';return '[data-private-single-action=true]'})()`)
        await click(selector); await settle()
      }
      await selectMenu('Copy Agent Link')
      assert.deepEqual((await facts()).clipboard, ['amux://agent/canonical-gamma'], 'Single alias Copy preserves its canonical Agent identity')
      await selectMenu('Stop Agent'); await until('!!document.querySelector(".confirmation-dialog")')
      assert.deepEqual((await facts()).controls, [], 'Original shared Stop still requires confirmation')
      assert.equal(await read(`spaceListScene.facts().sessions.find(session=>session.id==='gamma'&&session.control.hostId==='local').runUnobserved`), true, 'The exact original control remains available despite an observation gap')
      await click('[data-confirm-label="Stop Agent"]'); await until('!document.querySelector(".confirmation-dialog")')
      assert.deepEqual((await facts()).controls, [{ kind: 'agent', hostId: 'local', agentSessionId: 'canonical-gamma', run: { runId: 'private-original-gamma' } }], 'Single alias Stop never borrows the same-ID Agent on another Host')
      await selectMenu('Restart Session…'); await until('!!document.querySelector(".confirmation-dialog")')
      await click('[data-confirm-label="Restart Session"]'); await until(`!!document.querySelector('[data-confirm-label="Check restart"]')`)
      const originalRestart = (await facts()).restarts[0]
      assert.deepEqual(originalRestart.control, { kind: 'agent', hostId: 'local', agentSessionId: 'canonical-gamma', run: { runId: 'private-original-gamma' } })
      assert.equal(originalRestart.observeOnly, false)
      await click('[data-confirm-label="Check restart"]'); await settle()
      const singles = await facts()
      assert.deepEqual(singles.restarts, [originalRestart, { ...originalRestart, observeOnly: true }], 'Unknown restart keeps its original operation and exact target')
      assert.equal(singles.originalWorkface, true); assert.equal(singles.originalDrafts, true)
      result.operations.push({ kind: 'trusted-shared-single-actions', originalHostCollision: true, alias: 'gamma', canonical: 'canonical-gamma', controls: singles.controls, restarts: singles.restarts, originalWorkface: singles.originalWorkface, originalDrafts: singles.originalDrafts })
      await click('.confirmation-dialog__cancel'); await until('!document.querySelector(".confirmation-dialog")')
      await read('spaceListScene.clearSingleOperations()'); await settle()
      await clickLabel('Select Agents'); await click(checkbox('alpha')); await filter('attention')
      assert.deepEqual((await facts()).order, [keyFor('gamma')]); await clickLabel('Select visible Agents')
      await shot('filtered-multiselect-384.png', 'Filter and select visible cards retain the earlier hidden selection')
      await filter('all'); assert.deepEqual((await facts()).selection, [keyFor('alpha'), keyFor('gamma')])
      await clickLabel('Copy titles + Agent links')
      const copied = (await facts()).clipboard
      assert.equal(copied.length, 1); assert.ok(copied[0].includes('amux://agent/alpha')); assert.ok(copied[0].includes('amux://agent/canonical-gamma'))
      assert.ok(!copied[0].includes('amux://agent/gamma'), 'Presentation alias cannot replace the original Agent identity')
      assert.ok(copied[0].indexOf('amux://agent/alpha') < copied[0].indexOf('amux://agent/canonical-gamma'))
      await read('spaceListScene.failAgent("gamma")'); await clickLabel('Close Agents')
      await until('!!document.querySelector(".confirmation-dialog")')
      const confirmation = await read('document.querySelector(".confirmation-dialog").textContent')
      assert.ok(confirmation.includes('private-original-alpha')); assert.ok(confirmation.includes('private-original-gamma'))
      assert.deepEqual((await facts()).controls, [])
      await shot('bulk-close-confirmation.png', 'Product confirmation reviews selected names and exact Run targets')
      await click('[data-confirm-label="Close Agents"]'); await until(`!!document.querySelector('[aria-label="Agent close results"]')`)
      result.bulk = await facts(); assert.equal(result.bulk.controls.length, 2)
      assert.deepEqual(result.bulk.controls.map(control => [control.agentSessionId, control.run.runId]), [['alpha', 'private-original-alpha'], ['canonical-gamma', 'private-original-gamma']])
      assert.deepEqual(result.bulk.selection, [keyFor('gamma')]); assert.equal(result.bulk.originalWorkface, true); assert.equal(result.bulk.originalDrafts, true)
      await shot('partial-close-result-384.png', 'Unconfirmed target remains selected and visible; successful stop is not resent')
      await clickLabel('Clear selection'); await click(checkbox('beta')); await clickLabel('Close Agents')
      await read('spaceListScene.changeRun("beta")'); await click('[data-confirm-label="Close Agents"]')
      await until(`document.querySelector('[aria-label="Agent close results"]')?.textContent.includes('Run changed')`)
      assert.equal((await facts()).controls.length, 2, 'Changed Run is never stopped through old confirmation')
      await clickLabel('Done selecting')
      await read('document.querySelector("[data-space-list-pane]").style.width="288px"'); await shot('narrow-288.png', 'Narrow sidebar retains readable boundaries, states, shared cards and list controls')
      await clickLabel('Select Agents'); await click(checkbox('alpha')); await filter('attention')
      await shot('narrow-selection-288.png', 'Narrow selection reuses the header and retains hidden scope and all five named actions')
      await filter('all'); await clickLabel('Done selecting')
      await read('spaceListScene.retainedReply(true)'); await settle()
      const retainedReply = await read(`(()=>{const n=document.querySelector(${JSON.stringify(row('delta'))});return{recap:n.querySelector('.focus-context__recap')?.textContent,state:n.dataset.state,text:n.textContent}})()`)
      assert.equal(retainedReply.recap, '卡片、菜单和详情沿同一 Focus 入口，保留已有响应。')
      assert.equal(retainedReply.state, 'done'); assert.ok(retainedReply.text.includes('Idle'), 'Exited Run keeps its observed status beside the legitimate retained reply')
      await read('document.querySelector("[data-space-list-pane]").style.width="384px"')
      await shot('retained-reply-384.png', 'Exited original Run retains its legitimate response excerpt and observed Idle status')
      result.operations.push({ kind: 'retained-reply-exited-run', ...retainedReply })
      await read('spaceListScene.retainedReply(false)'); await settle()
      const final = await facts(); await writeFile(join(privateRoot, 'expected.json'), JSON.stringify({ order: final.order, preference: final.preference, sessionIds: final.sessions.map(session => session.id), tabs: final.tabs, layouts: final.layouts, drafts: final.drafts }))
      await clickLabel('去 Focus 中查看'); await until('!!document.querySelector(".global-focus-main .focus-context")')
      for (const width of [1200, 360]) {
        win.setContentSize(width, 880); await settle()
        const image = `shared-focus-${width}.png`
        await writeFile(join(evidence, image), (await win.webContents.capturePage()).toPNG())
        result.frames.push({ image, purpose: 'Actual Focus board regression for the shared Agent card state presentation', width, height: 880 })
      }
      await read('spaceListScene.showSpace()'); await until('!!document.querySelector(".workspace-agent-list-item")')
      await read('spaceListScene.flush()')
      await win.webContents.session.flushStorageData()
      result.final = final
    }
    result.passed = true
  } catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) { result.diagnostics = await win.webContents.executeJavaScript('({body:document.body.innerText,scene:window.spaceListScene?.facts()})').catch(() => null); await writeFile(join(evidence, `${phase}-failure.png`), (await win.webContents.capturePage()).toPNG()) } }
  finally { await writeFile(join(evidence, phase + '.json'), JSON.stringify(result, null, 2) + '\n'); if (win && !win.isDestroyed()) win.destroy(); app.exit(result.passed ? 0 : 1) }
})
