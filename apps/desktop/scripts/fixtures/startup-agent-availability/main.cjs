const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const [html, ownerFile, privateRoot, evidence, stage] = process.argv.slice(2)
const connectionProgress = process.env.AGENTMUX_CONNECTION_PROGRESS_PROOF === '1' && stage === 'restart'
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const receipt = { schema: 'agentmux.startup-agent-product-scene.v1', stage, pid: process.pid, completed: false, frames: [], inputs: [], consoleErrors: [], userRuntimeTouched: false,
  boundary: 'Production complete App, initialize, Workbench, settings, ConfigStore/ConfigOwner and Core spatial filesystem owner. Private IPC transports. Controlled Executor detection promises and empty Runtime snapshot; no real Agent process or user Runtime. Configuration reload reads and validates the original JSON directly, avoiding unrelated Notes/Scratch bootstrap.' }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let win, unsubscribeSpatial
app.whenReady().then(async () => {
  try {
    const { ConfigStore, ConfigOwner, DEFAULT_CONFIG, AgentMuxSpatialStateStore } = await import(pathToFileURL(ownerFile).href)
    const configFile = path.join(privateRoot, 'config.json'), configStore = new ConfigStore(configFile)
    if (stage === 'control') {
      const workspace = path.join(privateRoot, 'workspace'); await fs.mkdir(workspace)
      await configStore.save({ ...DEFAULT_CONFIG, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
        executors: Object.fromEntries(['codex', 'claude'].map(id => [id, DEFAULT_CONFIG.executors[id]])),
        workspaces: [{ id: 'startup-proof-workspace', name: 'Startup proof', hostId: 'local', path: workspace, kind: 'folder' }],
        appearance: { ...DEFAULT_CONFIG.appearance, appAppearance: 'dark' } })
    }
    let current = configStore.validate(JSON.parse(await fs.readFile(configFile, 'utf8')))
    const owner = new ConfigOwner({ read: () => current, save: next => configStore.save(next), publish: next => { current = next; win?.webContents.send('startup-proof:config:changed', next) } })
    const spatial = new AgentMuxSpatialStateStore(path.join(privateRoot, 'spatial.json'))
    receipt.initialConfig = owner.current
    receipt.initialSpatial = await spatial.readForLayout()
    ipcMain.handle('startup-proof:config:get', () => owner.current)
    ipcMain.handle('startup-proof:config:save', (_event, next, expected) => owner.edit(expected, next))
    let releaseSpatial
    const spatialGate = connectionProgress ? new Promise(resolve => { releaseSpatial = resolve }) : Promise.resolve()
    let spatialRequested = false
    ipcMain.handle('startup-proof:spatial:read', async () => { spatialRequested = true; await spatialGate; return spatial.readForLayout() })
    ipcMain.handle('startup-proof:spatial:commit', (_event, input) => spatial.commit(input))
    ipcMain.handle('startup-proof:spatial:retain', (_event, values) => spatial.retainDisplayLabels(values))
    ipcMain.handle('startup-proof:flush', async () => { await win.webContents.session.flushStorageData() })
    win = new BrowserWindow({ width: 1280, height: 900, minWidth: 980, minHeight: 660, show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true,
        backgroundThrottling: false, additionalArguments: ['--startup-proof-stage=' + stage, ...(connectionProgress ? ['--startup-proof-connection-progress'] : [])] } })
    unsubscribeSpatial = spatial.subscribe(value => { if (!win.isDestroyed()) win.webContents.send('startup-proof:spatial:changed', value) })
    win.webContents.on('console-message', details => { if (details.level === 'error') receipt.consoleErrors.push(details.message) })
    await win.loadFile(html)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    const read = expression => win.webContents.executeJavaScript(expression)
    const until = async expression => {
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) { if (await read(expression)) return; await delay(30) }
      throw Error('Product condition timed out: ' + expression + '\n' + JSON.stringify(await read('window.startupScene?.state()')))
    }
    const settle = async () => { await read('document.fonts.ready'); await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))') }
    const click = async expression => {
      const point = await read(`(()=>{const node=${expression};if(!node?.checkVisibility())throw Error('Missing real visible control');node.scrollIntoView({block:'nearest'});const b=node.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2,label:node.textContent.trim(),width:b.width,height:b.height}})()`)
      assert.ok(point.width > 0 && point.height > 0)
      assert.equal(await read(`(()=>{const n=${expression},hit=document.elementFromPoint(${point.x},${point.y});return n===hit||n.contains(hit)})()`), true, 'Native input hits the actual product control')
      receipt.inputs.push({ type: 'native-pointer', ...point })
      for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 })
      await settle()
    }
    const picture = async (name, width) => {
      win.setContentSize(width, 900); await until('innerWidth===' + width); await settle()
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0, buttons: 0 })
      const actualCSS = await read('({width:innerWidth,height:innerHeight,pixelRatio:devicePixelRatio,scrollWidth:document.documentElement.scrollWidth})')
      assert.ok(actualCSS.scrollWidth <= actualCSS.width, 'Actual product has no page horizontal overflow')
      const geometry = await read(`(()=>{const box=n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};return{shell:box(document.querySelector('.app-shell')||document.querySelector('[data-loading-scope="app"]')),regions:[...document.querySelectorAll('[data-workbench-region-id]')].filter(n=>n.checkVisibility()).map(box)}})()`)
      assert.equal(geometry.shell.width, actualCSS.width, 'The real App fills its viewport; fixture CSS must not shrink it')
      if (name === 'workface-pending') {
        assert.equal(geometry.regions.length, 2)
        for (const r of geometry.regions) assert.ok(r.width > 80 && r.height > 80 && r.x >= 0 && r.x + r.width <= actualCSS.width + 1, 'Both original Regions are painted within the actual viewport')
      }
      const png = (await win.webContents.capturePage()).toPNG(), file = `${stage}-${name}-${width}.png`
      assert.ok(png.length > 0); await fs.writeFile(path.join(evidence, file), png)
      receipt.frames.push({ file, sha256: sha(png), requested: { width, height: 900 }, actualCSS, geometry, contentSize: win.getContentSize(), pngPixels: { width: png.readUInt32BE(16), height: png.readUInt32BE(20) } })
    }
    const node = selector => `document.querySelector(${JSON.stringify(selector)})`
    const button = label => `Array.from(document.querySelectorAll('button')).find(n=>n.textContent.trim()===${JSON.stringify(label)})`
    const startup = node('[data-loading-scope="app"]')
    const connectionStep = 'Core to ctxmux connection'
    const sendConnection = warning => win.webContents.send('startup-proof:runtime', {
      type: 'core', hostId: 'local', endpointObservation: { step: connectionStep, warning },
      event: { type: 'connection-state', state: 'restored', observationOrigin: { kind: 'runtime-connection', boundary: 'core-ctxmux' },
        ...(warning ? { diagnostic: { code: warning.code, message: warning.message } } : {}), evidence: { source: 'run-process', observedAt: 1 } }
    })
    if (connectionProgress) {
      await until('window.startupScene?.ready && window.startupScene.state().progress.step === "saved-workspace"')
      assert.equal(spatialRequested, true)
      sendConnection({ hostId: 'local', step: connectionStep, scope: 'observation', availability: 'unverified',
        code: 'CTXMUX_STARTUP_PENDING', message: 'The original Runtime is awaiting readiness. Its daemon and readiness observation have been retained.',
        recovery: 'The same Runtime connection will complete when readiness arrives.',
        observationOrigin: { kind: 'runtime-connection', boundary: 'core-ctxmux' } })
      await until(`${node('[aria-label="Runtime startup observations"]')}?.textContent.includes('awaiting readiness')`)
      for (const width of [1280, 980]) await picture('connection-startup', width)
      releaseSpatial()
    }
    await until('window.startupScene?.ready && window.startupScene.calls.length===2 && !window.startupScene.state().loading')
    const initial = await read('window.startupScene.state()')
    assert.equal(initial.agents.pending, true, 'Detection remains deliberately unresolved')
    assert.equal(initial.agents.total, 2)
    assert.equal(initial.agents.current, 0)
    if (stage === 'failure-restart') {
      assert.equal(await read(`Boolean(${startup})`), false, 'Pending checks do not cover the restored workface')
      const original = JSON.parse(await fs.readFile(path.join(evidence, 'original-workface.json'), 'utf8'))
      await read('window.startupScene.fail()')
      await until(`!window.startupScene.state().agents.pending && !${startup}`)
      const failed = await read('window.startupScene.state()')
      assert.equal(Object.keys(failed.detections).length, 2, 'Both real store detection results are present')
      assert.deepEqual(Object.values(failed.detections).map(check => check.state), ['error', 'error'])
      assert.deepEqual(await read('window.startupScene.surface()'), original, 'Failed executable observations preserve the original workface')
      const trigger = node('.global-system-notices__trigger')
      const inbox = node('.global-system-notices__details')
      const item = `Array.from(document.querySelectorAll('.global-system-notices__details .notification-item')).find(n=>n.querySelector('.notification-item__title')?.textContent==='Agent availability check needs attention')`
      const originalCode = 'PROOF_CHECK_FAILED'
      const originalMessage = 'The original executable check could not finish.'
      const rejectionCode = 'PROOF_OWNER_UNAVAILABLE'
      const rejectionMessage = 'The original Host observation is unavailable.'
      async function openFailures() {
        await click(trigger)
        await until(`${inbox}?.matches(':popover-open') && ${inbox}.dataset.state==='open' && ${item}?.checkVisibility()`)
        if (!await read(`${item}.querySelector('details').open`)) await click(`${item}.querySelector('summary')`)
        await until(`${item}.querySelector('.service-window')?.checkVisibility()`)
      }
      async function retainedCause(label) {
        const text = await read(`${item}.querySelector('.service-window').textContent`)
        for (const exact of [originalCode, originalMessage, rejectionCode, rejectionMessage]) assert.ok(text.includes(exact), label + ': original source detail is retained: ' + exact)
        return text
      }
      await openFailures()
      const originalText = await retainedCause('Initial failed observation')
      await picture('agent-check-failure', 1280)
      await click(`${item}.querySelector('.notification-item__action')`)
      await until('window.startupScene.calls.length===4')
      await until(`!${inbox}.matches(':popover-open')`)
      const retry = await read('({calls:window.startupScene.calls,state:window.startupScene.state()})')
      assert.deepEqual(retry.calls.slice(2).map(call => ({ executorId: call.executorId, hostId: call.hostId, input: call.input })),
        retry.calls.slice(0, 2).map(call => ({ executorId: call.executorId, hostId: call.hostId, input: call.input })), 'The actual retry action rechecks the same original Executor and Host inputs')
      assert.equal(Object.keys(retry.state.detections).length, 2)
      assert.deepEqual(Object.values(retry.state.detections).map(check => check.state), ['checking', 'checking'])
      assert.equal(await read(`Boolean(${startup})`), false, 'A retry does not replace a usable workface with startup')
      await openFailures()
      const pendingText = await retainedCause('Retry awaiting its original results')
      assert.equal(pendingText, originalText, 'Pending retry does not erase or rewrite the original cause')
      assert.deepEqual(await read('window.startupScene.surface()'), original, 'Retry pending preserves the exact original Tab, Regions, layout, focus and drafts')
      await read('window.startupScene.release()')
      await until('Object.values(window.startupScene.state().detections).length===2 && Object.values(window.startupScene.state().detections).every(check=>check.state==="ready")')
      await until(`!${item}`)
      assert.deepEqual(await read('window.startupScene.surface()'), original, 'Successful retry retains the exact original workface')
      receipt.failureRecovery = { workfaceAvailableBeforeFailure: true, originalCode, originalMessage, rejectionCode, rejectionMessage,
        originalText, pendingText, retryInputs: retry.calls.slice(2), pendingCauseRetained: true, clearedAfterSuccessfulChecks: true, originalWorkfaceRetained: true, noReseed: true }
    } else {
      assert.equal(await read(`Boolean(${startup})`), false, 'Usable workface is visible before detection completes')
      receipt.background = { pending: true, workfaceReleased: true }
      win.setContentSize(1280, 900); await until('innerWidth===1280')
      if (stage === 'control') {
        const original = await read('window.startupScene.seed()')
        assert.equal(Object.keys(original.tabs).length, 1)
        assert.equal(Object.keys(Object.values(original.tabs)[0].regions).length, 2)
        assert.equal(Object.keys(original.agentComposerDrafts).length, 2)
        await fs.writeFile(path.join(evidence, 'original-workface.json'), JSON.stringify(original, null, 2) + '\n')
      } else {
        const original = JSON.parse(await fs.readFile(path.join(evidence, 'original-workface.json'), 'utf8'))
        assert.deepEqual(await read('window.startupScene.surface()'), original, 'Second independent Electron process restores exact original Tab, Region, layouts, focus and drafts without reseeding')
        const regions = await read('Array.from(document.querySelectorAll("[data-workbench-region-id]")).filter(n=>n.checkVisibility()).map(n=>n.dataset.workbenchRegionId)')
        assert.equal(regions.length, 2, 'The original workface is visibly mounted while checks remain pending')
        receipt.restart = { sameIdentityAndContent: true, originalWorkfaceVisible: true, regions, noReseed: true }
      }
      if (stage === 'restart') for (const width of [1280, 980]) await picture('workface-pending', width)
      win.setContentSize(1280, 900); await until('innerWidth===1280')
      if (connectionProgress) {
        const indicator = node('.global-system-notices__connection')
        const inbox = node('.global-system-notices__details')
        assert.equal(await read(`${indicator}?.checkVisibility()`), true, 'Pending connection is visible without opening notifications')
        const retained = await read('window.startupScene.surface()')
        await click(indicator)
        await until(`${inbox}?.matches(':popover-open') && ${inbox}.dataset.state==='open'`)
        await click(`${inbox}.querySelector('.notification-item summary')`)
        await picture('connection-details', 1280)
        await click(node('.global-system-notices__trigger'))
        await until(`!${inbox}.matches(':popover-open')`)
        assert.equal(await read(`${indicator}?.checkVisibility()`), true, 'Reading does not dismiss the unresolved connection')
        assert.deepEqual(await read('window.startupScene.surface()'), retained)
        sendConnection(null)
        await until(`!${indicator}`)
        assert.deepEqual(await read('window.startupScene.surface()'), retained)
        receipt.connectionProgress = { loadingVisible: true, workfaceVisible: true, readKeptVisible: true, resolvedCleared: true }
      }
      await read('window.startupScene.release()'); await until('!window.startupScene.state().agents.pending')
      if (!connectionProgress) {
      await click(node('.window-status-bar [aria-label="Settings"]'))
      await until('!!document.querySelector(".settings-page")')
      await click(node('[data-settings-target="general"]'))
      await until('!!document.querySelector("[data-settings-pane=general]")')
      assert.equal(await read('Boolean(document.querySelector("[data-settings-field=startup-checks]"))'), false, 'Obsolete wait preference is absent')
      const checkbox = `document.querySelector('[data-settings-field="copy-paths"] input')`
      if (stage === 'restart') {
        for (const width of [1280, 980]) await picture('general', width)
        win.setContentSize(1280, 900); await until('innerWidth===1280')
        await click(checkbox)
        await click(`Array.from(document.querySelectorAll('[data-settings-pane=general] [data-settings-save-bar] button')).find(n=>n.textContent.trim()==='Save')`)
        await until('window.startupScene.state().paths===true')
        assert.equal(owner.current.copyPathsAsAbsolute, true)
        const reloaded = configStore.validate(JSON.parse(await fs.readFile(configFile, 'utf8')))
        assert.equal(reloaded.copyPathsAsAbsolute, true)
        receipt.actualSettingsSaveReadback = true
      }
      }
    }
    receipt.checkpoint = await read('window.startupScene.checkpoint()')
    receipt.events = await read('window.startupScene.events')
    assert.ok(receipt.events.some(event => event.type === 'click' && event.trusted), 'Actual Renderer receives trusted pointer events')
    receipt.completed = true
  } catch (error) {
    receipt.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) {
      try { await fs.writeFile(path.join(evidence, stage + '-failure.png'), (await win.webContents.capturePage()).toPNG()) } catch {}
    }
  } finally {
    unsubscribeSpatial?.()
    await fs.writeFile(path.join(evidence, stage + '-scene.json'), JSON.stringify(receipt, null, 2) + '\n')
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(receipt.completed ? 0 : 1)
  }
})
