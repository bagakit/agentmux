const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const [html, privateRoot, coreFile, productPreload] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const control = { kind: 'agent', hostId: 'local', agentSessionId: '01a09b41-9e29-4197-ab97-9b81afc29ac4',
  run: { runId: '83cc279a-84e4-40d1-8479-d864682530a9' } }
const counts = { attach: 0, detach: 0, resize: 0, acknowledge: 0, write: 0, history: 0 }
const writes = [], historyPages = []
const result = { schema: 'agentmux.terminal-live-scroll-native.v1', passed: false, pid: process.pid,
  runtimeCreated: false, userRunTouched: false, physicalDeviceTested: false,
  boundary: 'Actual SessionPane/Store/product preload/xterm/Provider reader; synthetic Main replay and private stdio native protocol. Public page Session identity is fixture-wrapped; CoreClient durable metadata binding is not executed.',
  versions: { electron: process.versions.electron, node: process.versions.node } }
let win
const channels = []
function handle(channel, fn) { ipcMain.handle(channel, fn); channels.push(channel) }
const info = () => win.webContents.executeJavaScript('scrollInfo()')
async function waitFor(read, predicate, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read()
    if (predicate(value)) return value
    await delay(25)
  }
  throw new Error(message)
}
async function renderedFrame() {
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const image = await win.webContents.capturePage()
  assert.equal(image.isEmpty(), false, 'The actual compositor must provide a rendered frame')
  return { size: image.getSize(), sha256: createHash('sha256').update(image.toPNG()).digest('hex') }
}
function wheel(point, deltaY) {
  assert.ok(point, 'The actual target must have positive visible geometry')
  win.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.floor(point.x), y: Math.floor(point.y),
    deltaX: 0, deltaY, wheelTicksY: deltaY / 40, hasPreciseScrollingDeltas: true, canScroll: true })
}
function click(point) {
  assert.ok(point, 'The actual return action must have positive visible geometry')
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({
    type, x: Math.floor(point.x), y: Math.floor(point.y), button: 'left', clickCount: 1 })
}
app.whenReady().then(async () => {
  try {
    const { BUILT_IN_AGENT_PROVIDERS } = await import(pathToFileURL(coreFile).href)
    const provider = BUILT_IN_AGENT_PROVIDERS.find(item => item.id === 'codex')
    assert.ok(provider, 'The public Core provider registry must contain the configured Provider')
    assert.equal(typeof provider.readSessionHistoryPage, 'function')
    const assertControl = value => assert.deepEqual(value, control)
    handle('sessions:attach', (_event, value) => {
      assertControl(value); counts.attach++
      // Pure absolute-position repaint: no LF/SU/alternate history fabrication.
      const data = Array.from({ length: 24 }, (_, row) => `\x1b[${row + 1};1Hprivate-live-screen-${row}\x1b[K`).join('')
      const dataBytes = new TextEncoder().encode(data)
      return { attachmentId: 'private-attachment', currentSize: { cols: 160, rows: 40 }, gap: null,
        replay: [{ startByte: 0, endByte: dataBytes.length, dataBytes, data }] }
    })
    handle('sessions:resize', (_event, id, cols, rows) => {
      assert.equal(id, 'private-attachment'); counts.resize++; return { cols, rows }
    })
    handle('sessions:acknowledge', (_event, value) => { assertControl(value); counts.acknowledge++; return true })
    handle('sessions:detach', (_event, id) => { assert.equal(id, 'private-attachment'); counts.detach++; return true })
    handle('sessions:write', (_event, value, data) => {
      assertControl(value); counts.write++
      writes.push({ control: value, bytes: Array.from(typeof data === 'string' ? new TextEncoder().encode(data) : data) })
    })
    handle('sessions:historyPage', async (event, value, options) => {
      assert.equal(event.sender, win.webContents); assertControl(value); counts.history++
      const page = await provider.readSessionHistoryPage({
        source: { providerId: 'codex', nativeSessionId: 'private-native-thread' },
        command: process.execPath, args: [path.join(privateRoot, 'native-reader.mjs')],
        env: { ELECTRON_RUN_AS_NODE: '1', CODEX_HOME: path.join(privateRoot, 'codex-home') },
        workspacePath: privateRoot, limit: 30, signal: new AbortController().signal,
        ...(options?.cursor === undefined ? {} : { cursor: options.cursor })
      })
      historyPages.push({ source: page.source, itemIds: page.items.map(item => item.id), nextCursor: page.nextCursor })
      return { agentSessionId: control.agentSessionId, ...page }
    })
    handle('ui:requestStorageFlush', () => {})
    handle('ui:setAgentAttentionCount', () => false)
    win = new BrowserWindow({ width: 1560, height: 780, show: false,
      webPreferences: { preload: productPreload, nodeIntegration: false, contextIsolation: true, sandbox: false } })
    await win.loadFile(html); win.showInactive()
    await waitFor(() => win.webContents.executeJavaScript('window.ready===true'), x => x === true, 'Fixture Renderer did not mount')
    let before = await waitFor(info, x => x.terminalCount === 1 && x.buffer?.type === 'normal' &&
      x.buffer.baseY === 0 && x.firstLine?.includes('private-live-screen-0'), 'Actual TerminalView replay did not produce the nonempty zero-history screen')
    let stable = 0
    for (let i = 0; i < 40 && stable < 3; i++) {
      await delay(25); const current = await info()
      stable = JSON.stringify(current.grid) === JSON.stringify(before.grid) &&
        JSON.stringify(current.buffer) === JSON.stringify(before.buffer) ? stable + 1 : 0
      before = current
    }
    assert.equal(stable, 3); assert.equal(before.mouse, 'none'); assert.equal(before.buffer.length, before.grid.rows)
    assert.equal(before.history, null); assert.deepEqual(before.errors, [])
    const beforeCounts = { ...counts }; result.before = { snapshot: before, counts: beforeCounts }
    result.terminalFrame = await renderedFrame()
    wheel(before.terminalPoint, -180); await delay(100)
    assert.equal((await info()).history, null, 'Downward input stays on the existing xterm path')
    assert.equal(counts.history, 0)
    wheel(before.terminalPoint, 240)
    const opened = await waitFor(info, x => x.history?.itemIds.length === 30 && !x.history.source?.startsWith('Reading') &&
      x.history.scrollHeight > x.history.clientHeight && x.history.scrollTop > 0,
      'One real upward wheel did not enter nonempty Provider history')
    result.historyFrame = await renderedFrame()
    assert.notEqual(result.historyFrame.sha256, result.terminalFrame.sha256, 'History must be present in the actual rendered surface before its next gesture')
    result.opened = { snapshot: opened, counts: { ...counts } }
    assert.match(opened.history.source, /Persisted native conversation/)
    assert.equal(counts.history, 1, 'One upward gesture invokes the existing reader once')
    assert.deepEqual(opened.history.itemIds, Array.from({ length: 30 }, (_, i) => `private-native-item-${33 + i}`))
    assert.ok(opened.history.scrollHeight > opened.history.clientHeight, 'Nonempty history must exceed its real viewport')
    assert.equal(opened.terminalCount, 1); assert.deepEqual(opened.grid, before.grid); assert.deepEqual(opened.buffer, before.buffer)
    assert.equal(counts.attach, beforeCounts.attach); assert.equal(counts.detach, beforeCounts.detach); assert.equal(counts.write, beforeCounts.write)
    assert.equal(counts.resize, beforeCounts.resize, 'Entering the history reader must not resize the retained terminal')
    wheel(opened.history.point, 240)
    const up = await waitFor(info, x => x.history?.scrollTop < opened.history.scrollTop, 'Actual history viewport did not scroll upward')
    wheel(up.history.point, -120)
    const down = await waitFor(info, x => x.history?.scrollTop > up.history.scrollTop, 'Actual history viewport did not scroll downward')
    assert.equal(counts.history, 1, 'Reading nearby visible rows does not create another helper')
    const nativeHistoryWheels = down.wheels.filter(event => event.deltaY !== 0 && event.targetHistory)
    assert.deepEqual(nativeHistoryWheels.map(event => ({ deltaY: event.deltaY, trusted: event.isTrusted, prevented: event.defaultPrevented, hitHistory: event.hitHistory })), [
      { deltaY: -240, trusted: true, prevented: false, hitHistory: true },
      { deltaY: 120, trusted: true, prevented: false, hitHistory: true }
    ], 'Both actual history gestures must target its rendered scroll owner and retain native default scrolling')
    assert.equal(counts.resize, beforeCounts.resize, 'Scrolling history must not resize the retained terminal')
    result.reading = { up, down, counts: { ...counts } }
    click(down.history.returnPoint)
    const returned = await waitFor(info, x => x.history === null && x.terminalPoint !== null, 'The actual return action did not restore the terminal')
    await delay(150)
    const final = await info()
    assert.equal(final.terminalCount, 1); assert.equal(final.sameTerminal, true)
    assert.deepEqual(final.grid, before.grid); assert.deepEqual(final.buffer, before.buffer)
    assert.equal(counts.attach, beforeCounts.attach); assert.equal(counts.detach, beforeCounts.detach); assert.equal(counts.write, beforeCounts.write)
    assert.equal(final.focusInTerminal, true, 'Returning focuses the existing terminal input owner')
    for (const input of [{ type: 'keyDown', keyCode: 'Z' }, { type: 'char', keyCode: 'z' }, { type: 'keyUp', keyCode: 'Z' }]) win.webContents.sendInputEvent(input)
    await waitFor(async () => writes, values => values.length === 1, 'Real typed input did not reach the same synthetic control')
    assert.deepEqual(writes, [{ control, bytes: [122] }]); assert.deepEqual((await info()).errors, [])
    result.observed = { before, opened, up, down, returned, final, beforeCounts, counts: { ...counts }, writes, historyPages }
    await win.webContents.executeJavaScript('finishScroll()')
    await waitFor(async () => counts.detach, x => x === 1, 'Unmount did not release its one Attachment')
    result.afterUnmount = { ...counts }; result.passed = true
  } catch (error) { result.failure = error.stack; try { result.failureSnapshot = await info() } catch {} }
  finally {
    try { if (win && !win.isDestroyed()) win.destroy() } catch (error) { result.cleanupFailure = error.stack; result.passed = false }
    for (const channel of channels) ipcMain.removeHandler(channel)
    fs.writeFileSync(path.join(privateRoot, 'browser.json'), JSON.stringify(result, null, 2))
    app.exit(result.passed ? 0 : 1)
  }
})
