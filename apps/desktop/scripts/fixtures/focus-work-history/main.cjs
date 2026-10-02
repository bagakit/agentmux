const { fixtureData: _hygiene_fixtureData } = require("../../lib/fixture-values.mjs")
const assert = require('node:assert/strict')
const { readFile, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { createHash } = require('node:crypto')
const { app, BrowserWindow, ipcMain } = require('electron')
const [html, privateRoot, phase, publicInputPath] = process.argv.slice(2)
assert.ok(['seed', 'restore'].includes(phase) && resolve(privateRoot).includes('amux-focus-work-history-'))
app.setPath('userData', join(privateRoot, 'profile')); app.setPath('sessionData', join(privateRoot, 'session'))
const result = { passed: false, phase, pid: process.pid, images: [], operations: [], seedCount: phase === 'seed' ? 1 : 0 }
const delay = ms => new Promise(done => setTimeout(done, ms))
const durable = value => Object.fromEntries(['tabs', 'layouts', 'drafts', 'focus', 'activeWorkspaceId', 'mainSurface', 'height'].map(key => [key, value[key]]))
app.whenReady().then(async () => {
  let win, client
  try {
    const Core = await import('@agentmux/core')
    const { projectAgentWorkHistory } = await import('@agentmux/core/timeline')
    const original = await readFile(publicInputPath), accepted = _hygiene_fixtureData(JSON.parse(original))
    const sha256 = createHash('sha256').update(original).digest('hex'), last = Math.max(...accepted.history.items.map(item => item.createdAt)), now = last + 3600000
    const store = new Core.AgentMuxFileAgentSessionStore(join(privateRoot, 'public-sessions.json'))
    const controlledId = 'controlled-layout-history', runId = 'controlled-layout-run'
    const item = (id, at, state, previous, run = runId) => ({ id, agentSessionId: controlledId, kind: 'lifecycle', source: 'acp', status: 'complete', title: 'Controlled UI qualification observation', createdAt: at, updatedAt: at,
      activityState: { run: { runId: run }, state, stateEnteredAt: at, ...(previous ? { previousObservationId: previous } : {}) } })
    const controlled = [item('layout-round-one', now - 7200000, 'working'), item('layout-done-one', now - 5400000, 'done', 'layout-round-one'),
      item('layout-round-two', now - 3600000, 'working', 'layout-done-one'), item('layout-done-two', now - 1800000, 'done', 'layout-round-two'),
      item('layout-unknown-end', now - 900000, 'working', 'not-observed', 'controlled-other-run')]
    if (phase === 'seed') {
      for (const [sid, run, items] of [[accepted.history.agentSessionId, 'ordinary-second-run', accepted.history.items], [controlledId, runId, controlled], ['original-workface', 'original-workface-run', []]]) {
        const session = { kind: 'agent', agentSessionId: sid, providerId: 'claude', executorId: 'private-read-only', hostId: 'local', workspacePath: join(privateRoot, 'workspace'),
          run: { runId: run }, retiredRuns: [], createdAt: 1, updatedAt: last, hookBindingId: 'private-binding-' + sid, hookToken: 'private-unused-token' }
        await store.compareAndSwap(null, session)
        for (const record of items) await store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item: record })
        const reservation = { kind: 'stop', reservationId: 'read-only-retire-' + sid, ownerId: 'private-fixture', ownerPid: process.pid, agentSessionId: sid, expectedRun: session.run, operationId: 'retire-' + sid,
          expiresAt: Date.now() + 60000, stopOperation: { daemonInstance: 'no-runtime', operationKey: 'no-stop-' + sid, runId: run } }
        await store.reserveLifecycle(reservation); await store.commitLifecycle(reservation, null)
      }
    }
    client = new Core.AgentMuxClient({ store })
    result.kernelControls = []
    for (const name of ['start', 'input', 'resize', 'stop', 'attach', 'status']) client.kernel[name] = async () => { result.kernelControls.push(name); throw new Error('Unexpected private Runtime control ' + name) }
    const publicRaw = await client.sessionTimeline(accepted.history.agentSessionId)
    assert.deepEqual(publicRaw.items, accepted.history.items, 'Real FileStore/public Client preserves original accepted IDs, times and typed facts')
    const controlledRaw = await client.sessionTimeline(controlledId)
    const controlledProjection = projectAgentWorkHistory(controlledRaw.items)
    assert.equal(controlledProjection.segments.length, 3)
    result.publicRead = { publicInputSHA256: sha256, acceptedProducerSHA256: accepted.provenance.producerSHA256, raw: publicRaw, controlled: controlledRaw, states: await client.sessionHistorySources() }
    ipcMain.handle('focus-work-proof:facts', () => ({ now, controlledId, originalId: accepted.history.agentSessionId, publicInputSHA256: sha256, acceptedProducerSHA256: accepted.provenance.producerSHA256 }))
    result.publicRequests = []
    const allowed = (method, id) => { result.publicRequests.push({ method, id }); assert.ok([controlledId, accepted.history.agentSessionId, 'original-workface'].includes(id), 'Exact private source required: ' + id); return id }
    ipcMain.handle('focus-work-proof:timeline', (_event, id) => client.sessionTimeline(allowed('timeline', id)))
    ipcMain.handle('focus-work-proof:sources', () => { result.publicRequests.push({ method: 'sources' }); return client.sessionHistorySources() })
    ipcMain.handle('focus-work-proof:history-page', (_event, id) => client.sessionHistoryPage(allowed('history-page', id), { limit: 30 }))
    win = new BrowserWindow({ width: 1200, height: 760, show: false, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, preload: join(__dirname, 'preload.cjs') } })
    result.consoleMessages = []; win.webContents.on('console-message', (_event, ...details) => result.consoleMessages.push(details))
    await win.loadFile(html, { query: { phase } }); win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    const evaluate = code => win.webContents.executeJavaScript(code)
    const until = async code => { for (let n = 0; n < 200; n++) { if (await evaluate(code)) return; await delay(25) }; throw new Error('Actual mounted condition did not settle: ' + code) }
    const paint = () => evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
    const facts = () => evaluate('focusWorkHistoryProbe.facts()'), geometry = () => evaluate('focusWorkHistoryProbe.geometry()')
    const click = async selector => {
      const target = await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw new Error('Missing target');const r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,rect:r.toJSON(),hit:node.contains(document.elementFromPoint(x,y)),disabled:node.disabled}})()`)
      assert.ok(target.rect.width > 0 && target.rect.height > 0 && target.hit && !target.disabled, 'Actual visible enabled center hit')
      for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: target.x, y: target.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 })
      await paint(); return target
    }
    const select = async id => {
      if (!await evaluate(`!!document.querySelector('[aria-label="Input records Context"]')`)) await click('[aria-label="View input records"]')
      await until(`!!document.querySelector('[aria-label="Input records Context"] option[value="${id}"]')`)
      await evaluate(`(()=>{const node=document.querySelector('[aria-label="Input records Context"]');node.value=${JSON.stringify(id)};node.dispatchEvent(new Event('change',{bubbles:true}))})()`)
      await until('!document.querySelector(".recent-focus__input-reader").textContent.includes("Reading")')
      await paint()
    }
    const closeReader = async () => { if (await evaluate(`!!document.querySelector('[aria-label="Close message"]')`)) await click('[aria-label="Close message"]') }
    const shot = async (name, width) => { win.setContentSize(width, 760); await until(`innerWidth===${width}`); await paint(); await delay(150); await paint();
      const actual = await geometry(); assert.equal(actual.horizontalOverflow, false); assert.ok(actual.trackHeights.length && actual.trackHeights.every(height => height === 24))
      await writeFile(join(privateRoot, name), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); result.images.push(name); result.operations.push({ name, width, actual }) }
    await until('window.focusWorkHistoryProbe?.ready && !!document.querySelector(".recent-focus")')
    result.start = await facts(); assert.equal(result.start.errors.length, 0)
    assert.equal(Object.keys(result.start.tabs['history-retained-tab'].regions).length, 2)
    if (phase === 'seed') {
      await until('document.querySelectorAll("[data-work-end]").length===3')
      result.beforeClose = await geometry()
      await select(accepted.history.agentSessionId)
      await until('document.querySelectorAll("[data-work-end]").length===8')
      await closeReader(); await shot('working-history-wide.png', 1200)
      await evaluate('focusWorkHistoryProbe.closeObserved()'); await paint()
      const closed = await geometry(); assert.equal(closed.work.length, 8); assert.equal(closed.live, 0)
      assert.ok(closed.work.some(record => record.end === 'unknown' && record.start === record.through), 'Unknown end is a point, never invented through Now')
      result.closed = closed
      await shot('working-history-closed-narrow.png', 480)
      await evaluate('focusWorkHistoryProbe.flush()'); await delay(150); await win.webContents.session.flushStorageData()
      const end = await facts(); await writeFile(join(privateRoot, 'expected.json'), JSON.stringify(durable(end)))
      await writeFile(join(privateRoot, 'expected-work.json'), JSON.stringify(closed.work.map(({ run, start, through, end }) => ({ run, start, through, end }))))
    } else {
      assert.deepEqual(durable(result.start), _hygiene_fixtureData(JSON.parse(await readFile(join(privateRoot, 'expected.json'), 'utf8'))), 'Actual original Store.initialize restores workface/layout/draft with zero second seed')
      await select(controlledId); await until('document.querySelectorAll("[data-work-end]").length===3')
      await select(accepted.history.agentSessionId); await until('document.querySelectorAll("[data-work-end]").length===8')
      await closeReader(); const actual = await geometry()
      assert.deepEqual(actual.work.map(({ run, start, through, end }) => ({ run, start, through, end })), _hygiene_fixtureData(JSON.parse(await readFile(join(privateRoot, 'expected-work.json'), 'utf8'))))
      assert.ok(actual.workface?.width > 0 && actual.workface.height > 0 && actual.regions.includes('history-retained-region'))
      result.restartPreserved = true; result.workHistoryPreserved = true
      await shot('working-history-restored-wide.png', 1200)
    }
    result.end = await facts(); assert.equal(result.end.errors.length, 0); assert.deepEqual(result.end.controls, { launchAgent: 0, stop: 0, resume: 0, recover: 0, write: 0 }); assert.deepEqual(result.kernelControls, [])
    result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win) result.actualAtFailure = await win.webContents.executeJavaScript('({facts:window.focusWorkHistoryProbe?.facts(),geometry:window.focusWorkHistoryProbe?.geometry(),errors:window.sceneErrors,html:document.body.innerHTML.slice(0,12000)})').catch(() => null)
  } finally {
    await writeFile(join(privateRoot, phase + '-result.json'), JSON.stringify(result, null, 2) + '\n'); win?.destroy(); await client?.dispose(); app.exit(result.passed ? 0 : 1)
  }
})
