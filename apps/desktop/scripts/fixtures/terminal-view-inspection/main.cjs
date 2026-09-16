const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const execFileAsync = promisify(execFile)
const [html, privateRoot, bridgeFile, coreFile, fixturePreload, productPreload] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
process.env.AGENTMUX_PROBE_PRODUCT_PRELOAD = productPreload
const runtimeDirectory = path.join(privateRoot, 'control-owner')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const result = { schema: 'agentmux.native-terminal-view-inspection.v1', passed: false, cases: [],
  versions: { electron: process.versions.electron, node: process.versions.node },
  scope: 'Actual TerminalView, Desktop adapter/preload/Main bridge, Core Control socket and public CLI; synthetic replay only',
  userRunTouched: false, runtimeCreated: false, physicalDeviceTested: false }
const counters = { attach: 0, detach: 0, resize: 0, acknowledge: 0, write: 0 }
let current, win, bridge, server
const installedChannels = []
function handle(channel, fn) { ipcMain.handle(channel, fn); installedChannels.push(channel) }
app.whenReady().then(async () => {
  try {
    const { AgentMuxControlServer } = await import(pathToFileURL(coreFile).href)
    const { DesktopControlIpcBridge } = require(bridgeFile)
    handle('inspection-fixture:setup', (_event, input) => { current = input; return true })
    handle('sessions:attach', () => {
      counters.attach++
      let data = Array.from({ length: 600 }, (_, i) => `private-line-${i}\r\n`).join('')
      if (current.alternate) data += '\x1b[?1049hprivate-alternate'
      if (current.mouse) data += '\x1b[?1003h\x1b[?1006h'
      const dataBytes = new TextEncoder().encode(data)
      return { attachmentId: 'private-attachment', currentSize: { cols: 80, rows: 24 }, gap: null,
        replay: [{ startByte: 0, endByte: dataBytes.length, dataBytes, data }] }
    })
    handle('sessions:resize', (_event, _id, cols, rows) => { counters.resize++; return { cols, rows } })
    handle('sessions:acknowledge', () => { counters.acknowledge++; return true })
    handle('sessions:detach', () => { counters.detach++; return true })
    handle('sessions:write', () => { counters.write++; throw new Error('Inspection must never send input') })
    handle('ui:requestStorageFlush', () => {})
    handle('ui:setAgentAttentionCount', () => false)
    win = new BrowserWindow({ width: 1560, height: 580, show: false,
      webPreferences: { preload: fixturePreload, contextIsolation: true, nodeIntegration: false, sandbox: false } })
    bridge = new DesktopControlIpcBridge({ isAvailable: () => !win.isDestroyed(),
      sendRequest: (request) => win.webContents.send('agentmux:control-request', request),
      sendCancellation: (value) => win.webContents.send('agentmux:control-cancel', value) })
    const onResponse = (event, response) => { assert.equal(event.sender, win.webContents); bridge.accept(response) }
    ipcMain.on('control:response', onResponse)
    server = new AgentMuxControlServer({ execute: (request) => bridge.execute(request) }, path.join(runtimeDirectory, 'control.sock'))
    await server.start()
    await win.loadFile(html); win.showInactive()
    for (let i = 0; i < 100 && !await win.webContents.executeJavaScript('window.ready===true'); i++) await delay(25)
    assert.equal(await win.webContents.executeJavaScript('window.ready===true'), true)
    const env = { ...process.env }
    for (const name of Object.keys(env)) if (name.startsWith('AGENTMUX_')) delete env[name]
    env.AGENTMUX_RUNTIME_DIRECTORY = runtimeDirectory
    env.ELECTRON_RUN_AS_NODE = '1'
    const inspect = async () => {
      const { stdout } = await execFileAsync(process.execPath, [path.join(path.dirname(coreFile), 'agentmux.js'),
        'inspect', '--region', '5f3068aa-e07f-4fc5-a0cf-07cb70e68a31'], { env, timeout: 4000, maxBuffer: 262144 })
      return JSON.parse(stdout)
    }
    for (const input of [
      { alternate: false, mouse: false, readOnly: false, pending: false },
      { alternate: false, mouse: true, readOnly: false, pending: false },
      { alternate: true, mouse: true, readOnly: false, pending: false },
      { alternate: false, mouse: true, readOnly: true, pending: false },
      { alternate: false, mouse: true, readOnly: false, pending: true }
    ]) {
      const before = await win.webContents.executeJavaScript(`mountInspection(${JSON.stringify(input)})`)
      await delay(100)
      const beforeCounters = { ...counters }
      const receipt = await inspect()
      const after = await win.webContents.executeJavaScript('inspectionInfo()')
      assert.equal(receipt.ok, true)
      assert.equal(receipt.operation, 'inspect.region')
      const view = receipt.result.region.terminalView
      assert.ok(view, 'Actual public CLI must retain the TerminalView observation')
      assert.equal(view.runId, before.runId)
      assert.deepEqual(view.viewGrid, { cols: before.cols, rows: before.rows })
      assert.deepEqual(view.buffer, before.buffer)
      assert.equal(view.mouseTrackingMode, input.mouse ? 'any' : 'none')
      assert.equal(view.visible, true)
      assert.equal(view.readOnly, input.readOnly)
      assert.equal(view.liveReady, true)
      assert.equal(view.acceptsInput, !input.readOnly && !input.pending)
      assert.ok(Number.isFinite(view.sampledAt) && view.sampledAt > 0)
      assert.deepEqual(after, before)
      assert.deepEqual(counters, beforeCounters, 'Inspection may not mutate the synthetic runtime')
      assert.deepEqual(after.errors, [])
      result.cases.push({ input, before, receipt, after, counters: { ...counters } })
    }
    assert.equal(result.cases.length, 5)
    await win.webContents.executeJavaScript('unmountInspection()')
    const unmountedCounters = { ...counters }
    const unmounted = await inspect()
    assert.equal(unmounted.ok, true)
    assert.equal(unmounted.result.region.terminalView, undefined, 'Disposed TerminalView must leave no callable projection')
    assert.deepEqual(counters, unmountedCounters)
    result.unmounted = unmounted
    await win.webContents.executeJavaScript('finishInspection()')
    ipcMain.off('control:response', onResponse)
    result.passed = true
  } catch (error) { result.failure = error.stack }
  finally {
    try { await server?.stop(); bridge?.dispose(); if (win && !win.isDestroyed()) win.destroy() }
    catch (error) { result.cleanupFailure = error.stack; result.passed = false }
    for (const channel of installedChannels) ipcMain.removeHandler(channel)
    fs.writeFileSync(path.join(privateRoot, 'native.json'), JSON.stringify(result, null, 2))
    app.exit(result.passed ? 0 : 1)
  }
})
