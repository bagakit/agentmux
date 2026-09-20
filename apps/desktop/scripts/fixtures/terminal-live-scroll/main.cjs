const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const [html, privateRoot, coreFile, productPreload, phase, captureDirectory] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const control = { kind: 'agent', hostId: 'local', agentSessionId: '01a09b41-9e29-4197-ab97-9b81afc29ac4',
  run: { runId: '83cc279a-84e4-40d1-8479-d864682530a9' } }
const counts = { attach: 0, detach: 0, resize: 0, write: 0, history: 0, recover: 0 }
const writes = [], historyPages = []
const result = { schema: 'agentmux.terminal-live-scroll-native.v1', passed: false, pid: process.pid,
  runtimeCreated: false, userRunTouched: false, physicalDeviceTested: false,
  boundary: 'Actual SessionPane/Store/product preload/xterm/Provider reader; synthetic Main replay and private stdio native protocol. Public page Session identity is fixture-wrapped; CoreClient durable metadata binding is not executed.',
  phase, versions: { electron: process.versions.electron, node: process.versions.node } }
let win
const stage = name => fs.writeFileSync(path.join(privateRoot, `stage-${phase}.json`), JSON.stringify({ name, counts, at: new Date().toISOString() }))
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
async function renderedFrame(label) {
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const image = await win.webContents.capturePage()
  assert.equal(image.isEmpty(), false, 'The actual compositor must provide a rendered frame')
  const png = image.toPNG()
  const file = path.join(captureDirectory, `${phase}-${label}.png`)
  fs.writeFileSync(file, png)
  return { file, size: image.getSize(), sha256: createHash('sha256').update(png).digest('hex') }
}
async function wheel(point, deltaY) {
  assert.ok(point, 'The actual target must have positive visible geometry')
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel',
    x: Math.floor(point.x), y: Math.floor(point.y), deltaX: 0, deltaY })
}
async function click(point) {
  assert.ok(point, 'The actual input owner must have positive visible geometry')
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type, x: Math.floor(point.x), y: Math.floor(point.y), button: 'left', clickCount: 1 })
}
app.whenReady().then(async () => {
  try {
    stage('ready')
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
      return { attachmentId: 'private-attachment', session: fixtureSession, currentSize: { cols: 160, rows: 40 }, gap: null,
        terminal: { type: 'unknown', reason: 'origin_unknown' }, resizeRevision: 0,
        replay: [{ startByte: 0, endByte: dataBytes.length, dataBytes, data }] }
    })
    handle('sessions:resize', (_event, id, cols, rows) => {
      assert.equal(id, 'private-attachment'); counts.resize++; return { cols, rows }
    })
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
    const semantic = { state: 'done', source: 'native-hook', observedAt: Date.now(), stateEnteredAt: Date.now() - 86401000 }
    const fixtureSession = { id: control.agentSessionId, kind: 'agent', providerId: 'codex', executorId: 'codex',
      hostId: 'local', workspacePath: '/private-synthetic', label: 'Private native records', createdAt: 1, updatedAt: 1,
      processState: phase === 'restore' ? 'exited' : 'running', latestOutputBytes: 0,
      status: phase === 'restore' ? semantic : { state: 'working', source: 'native-hook', observedAt: 1 },
      ...(phase === 'restore' ? { semanticStatus: semantic } : {}), control,
      capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' } }
    handle('config:get', () => ({ version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }], executors: {},
      workspaces: [{ id: 'private', name: 'Private', hostId: 'local', path: '/private-synthetic', kind: 'folder' }],
      appearance: { terminalTheme: 'graphite', terminalFontSize: 17 },
      browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }))
    handle('sessions:snapshot', () => ({ sessions: [fixtureSession], timelines: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [] }))
    handle('providers:list', () => [])
    handle('demands:list', () => [])
    handle('sessions:recover', () => { counts.recover++; throw new Error('Reading must never restore an Agent') })
    handle('ui:requestStorageFlush', async () => { await win.webContents.session.flushStorageData() })
    handle('ui:setAgentAttentionCount', () => false)
    win = new BrowserWindow({ width: 1560, height: 780, show: false,
      webPreferences: { preload: productPreload, nodeIntegration: false, contextIsolation: true, sandbox: false,
        // The private probe has no OS focus. Keep its real compositor/input tasks scheduled.
        backgroundThrottling: false } })
    stage('loading')
    await win.loadFile(html, { query: { phase } }); win.showInactive()
    stage('loaded')
    win.webContents.debugger.attach('1.3')
    await waitFor(() => win.webContents.executeJavaScript('window.ready===true'), x => x === true, 'Fixture Renderer did not mount')
    stage('mounted')
    if (phase === 'capture') {
      let before = await waitFor(info, x => x.terminalCount === 1 && x.buffer?.type === 'normal' &&
        x.buffer.baseY === 0 && x.firstLine?.includes('private-live-screen-0'), 'Actual replay did not produce the nonempty zero-history screen')
      let stable = 0
      for (let i = 0; i < 40 && stable < 3; i++) {
        await delay(25); const current = await info()
        stable = JSON.stringify(current.grid) === JSON.stringify(before.grid) &&
          JSON.stringify(current.buffer) === JSON.stringify(before.buffer) ? stable + 1 : 0
        before = current
      }
      assert.equal(stable, 3); assert.equal(before.mouse, 'none'); assert.equal(before.buffer.length, before.grid.rows)
      assert.equal(before.history, null); assert.deepEqual(before.errors, [])
      result.before = { snapshot: before, counts: { ...counts } }; result.terminalFrame = await renderedFrame('terminal')
      await wheel(before.terminalPoint, -240)
      const zero = await waitFor(info, x => x.wheels.length === 1, 'Actual zero-history wheel did not dispatch')
      assert.equal(zero.history, null, 'Active local top must never navigate to Provider records')
      assert.equal(counts.history, 0); assert.equal(counts.write, 0); assert.equal(counts.recover, 0)
      assert.deepEqual(zero.buffer, before.buffer); assert.equal(zero.sameTerminal, true)
      result.zeroHistory = zero
      const replay = Array.from({ length: 24 }, (_, row) => `\x1b[${row + 1};1Hprivate-live-screen-${row}\x1b[K`).join('')
      const data = Array.from({ length: 300 }, (_, row) => `private-local-history-${row}\r\n`).join('')
      const startByte = Buffer.byteLength(replay), dataBytes = new TextEncoder().encode(data)
      win.webContents.send('agentmux:session-event', { type: 'core', hostId: 'local', event: { type: 'terminal-output', run: control.run,
        data, dataBytes, evidence: { source: 'terminal-output', observedAt: Date.now(), run: control.run,
          outputByteRange: { startByte, endByte: startByte + dataBytes.length } } } })
      const bottom = await waitFor(info, x => x.buffer?.baseY > 200 && x.buffer.viewportY === x.buffer.baseY,
        'Nonempty local terminal history was not delivered through the actual scoped API')
      const countsBeforeWheel = { ...counts }
      await wheel(bottom.terminalPoint, -240)
      const up = await waitFor(info, x => x.wheels.length === 2 && x.buffer.viewportY < bottom.buffer.viewportY, 'Actual normal terminal did not scroll upward')
      await wheel(up.terminalPoint, 120)
      const down = await waitFor(info, x => x.wheels.length === 3 && x.buffer.viewportY > up.buffer.viewportY, 'Actual normal terminal did not scroll downward')
      assert.equal(down.history, null); assert.equal(down.sameTerminal, true)
      assert.deepEqual(down.wheels.map(event => [event.deltaY, event.isTrusted, event.targetTerminal, event.hitTerminal]),
        [[-240, true, true, true], [-240, true, true, true], [120, true, true, true]], 'All three active gestures must actually dispatch to the retained terminal')
      assert.deepEqual(counts, countsBeforeWheel, 'Reading retained terminal rows cannot invoke lifecycle, records or input')
      await click(down.terminalPoint)
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: 'z' })
      await waitFor(async () => writes, values => values.length === 1, 'Actual typed input did not reach the same synthetic control')
      assert.deepEqual(writes, [{ control, bytes: [122] }])
      result.localReading = { bottom, up, down, counts: { ...counts }, writes }
      await win.webContents.executeJavaScript('showCold()')
    }
    const opened = await waitFor(info, x => x.history?.itemIds.length === 30 &&
      x.history.scrollHeight > x.history.clientHeight && x.history.scrollTop > 0,
      'Qualified dormant Session did not show nonempty inline records')
    assert.match(opened.history.source, /Persisted native conversation/)
    assert.equal(opened.history.returnPoint, null)
    assert.ok(opened.history.buttonLabels.includes('Latest'), 'The compact inline reading actions must actually be present')
    assert.equal(opened.history.buttonLabels.some(label => label === 'Terminal' || label === 'Session'), false, 'Default inline reader has no return navigation action')
    assert.deepEqual(opened.history.itemIds, Array.from({ length: 30 }, (_, i) => `private-native-item-${33 + i}`))
    assert.deepEqual(opened.history.appearance, opened.expectedAppearance, 'Actual records use the existing terminal appearance owner')
    stage('inline-opened')
    assert.equal(opened.history.bodyAppearance.fontSize, opened.expectedAppearance.fontSize)
    assert.equal(opened.history.bodyAppearance.fontFamily, opened.history.appearance.fontFamily)
    assert.equal(opened.history.bodyAppearance.lineHeight, opened.expectedAppearance.lineHeight)
    assert.equal(opened.history.bodyAppearance.foreground, opened.expectedAppearance.foreground)
    assert.equal(opened.projection.draft, 'Private inline draft survives process restart')
    assert.match(opened.composerText, /Private inline draft survives process restart/)
    assert.equal(counts.recover, 0); assert.equal(counts.history, 1)
    if (phase === 'restore') {
      assert.equal(counts.attach, 0); assert.equal(counts.write, 0); assert.equal(counts.resize, 0)
      const previous = JSON.parse(fs.readFileSync(path.join(privateRoot, 'browser-capture.json'), 'utf8'))
      assert.deepEqual(opened.projection, previous.cold.projection, 'Actual new process must restore the exact durable Tab/Region/layout/draft')
      assert.notEqual(process.pid, previous.pid)
    } else {
      assert.equal(counts.attach, 1); assert.equal(counts.detach, 1); assert.equal(counts.write, 1)
      assert.equal(result.before.snapshot.terminalAppearance.fontSize, Number.parseFloat(opened.expectedAppearance.fontSize))
    }
    result.historyFrame = await renderedFrame('history')
    const coldCounts = { ...counts }
    await wheel(opened.history.point, -240)
    const up = await waitFor(info, x => x.history?.scrollTop < opened.history.scrollTop, 'Actual inline records did not scroll upward')
    await wheel(up.history.point, 120)
    const down = await waitFor(info, x => x.history?.scrollTop > up.history.scrollTop, 'Actual inline records did not scroll downward')
    assert.deepEqual(counts, coldCounts, 'Nearby record reading must not invoke another helper or execution')
    const nativeWheels = down.wheels.filter(event => event.targetHistory)
    assert.deepEqual(nativeWheels.map(event => ({ deltaY: event.deltaY, trusted: event.isTrusted, prevented: event.defaultPrevented, hitHistory: event.hitHistory })), [
      { deltaY: -240, trusted: true, prevented: false, hitHistory: true },
      { deltaY: 120, trusted: true, prevented: false, hitHistory: true }
    ])
    assert.deepEqual(down.errors, [])
    result.cold = { ...down, counts: { ...counts }, historyPages }
    // Additional visual review consumes the exact production trace rendered from native source.
    // It follows the original wheel proof so no extra gestures substitute for that acceptance.
    const toolCounts = { ...counts }
    const observeTools = () => win.webContents.executeJavaScript(`(() => {
      const rows = Array.from(document.querySelectorAll('.conversation-tool-trace'));
      const viewport = document.querySelector('.session-history__viewport');
      return { rows: rows.map(row => ({kind:row.dataset.traceKind,callId:row.dataset.callId,status:row.dataset.status??null,
        expanded:row.querySelector('button').getAttribute('aria-expanded'),text:row.querySelector('button').textContent})),
        payloadCount:document.querySelectorAll('.conversation-tool-trace__payload').length,
        window:{width:innerWidth,height:innerHeight},
        viewport: viewport && {width:viewport.clientWidth,scrollWidth:viewport.scrollWidth,left:viewport.getBoundingClientRect().left,right:viewport.getBoundingClientRect().right},
        focused:document.activeElement?.getAttribute('aria-expanded'),
        focusVisible:document.activeElement?.matches(':focus-visible')??false };
    })()`)
    const tools = await waitFor(observeTools, x => x.rows.length === 4, 'Real native tool parts must reach the production trace')
    assert.deepEqual(tools.rows.map(row => [row.kind,row.callId,row.status]), [
      ['tool-call','private-native-item-60',null], ['tool-result','private-native-item-60',null],
      ['tool-call','private-native-item-62',null], ['tool-result','private-native-item-62','failed'] ])
    assert.equal(tools.payloadCount,0)
    await win.webContents.executeJavaScript(`document.querySelector('[data-call-id="private-native-item-62"]').scrollIntoView({block:'center'})`)
    result.toolVisual = { collapsed: { observation: tools, frame: await renderedFrame('tools-normal-collapsed') } }
    await win.webContents.executeJavaScript(`document.querySelector('[data-call-id="private-native-item-60"]').scrollIntoView({block:'center'})`)
    result.toolVisual.success = { observation: await observeTools(), frame: await renderedFrame('tools-normal-success-collapsed') }
    win.setSize(720,640)
    await waitFor(() => win.webContents.executeJavaScript('innerWidth'), x => x === 720, 'The narrow real Renderer must resize')
    await win.webContents.executeJavaScript(`document.querySelector('[data-call-id="private-native-item-62"]').scrollIntoView({block:'center'})`)
    const narrow = await observeTools()
    assert.equal(narrow.payloadCount,0); assert.equal(narrow.viewport.scrollWidth,narrow.viewport.width)
    assert.ok(narrow.viewport.width<tools.viewport.width,'The production reader must actually shrink in the narrow window')
    assert.ok(narrow.viewport.left>=0&&narrow.viewport.right<=narrow.window.width,'Narrow capture cannot crop an oversized fixture container')
    result.toolVisual.narrow = { observation: narrow, frame: await renderedFrame('tools-narrow-collapsed') }
    const failedPoint = await win.webContents.executeJavaScript(`(() => { const e=document.querySelector('[data-call-id="private-native-item-62"][data-status="failed"] button');
      e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2} })()`)
    await click(failedPoint)
    const expanded = await waitFor(observeTools, x => x.payloadCount === 1, 'Trusted click must mount only the failed result payload')
    await win.webContents.executeJavaScript(`document.querySelector('[data-call-id="private-native-item-62"][data-status="failed"] button').scrollIntoView({block:'start'})`)
    result.toolVisual.failedExpanded = { observation: expanded, frame: await renderedFrame('tools-narrow-failed-expanded') }
    // Shift+Tab returns to the preceding actual tool call; Space must toggle it as a native button.
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,modifiers:8})
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,modifiers:8})
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32})
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32})
    const keyboard = await waitFor(observeTools, x => x.focusVisible && x.focused === 'true' && x.payloadCount === 2, 'Native keyboard must open the preceding tool call with visible focus')
    await win.webContents.executeJavaScript(`document.activeElement.scrollIntoView({block:'start'})`)
    result.toolVisual.keyboard = { observation: keyboard, frame: await renderedFrame('tools-narrow-keyboard') }
    assert.deepEqual(counts,toolCounts,'Inspecting native tool details cannot invoke lifecycle, history or input')
    await win.webContents.executeJavaScript('finishScroll()')
    await win.webContents.session.flushStorageData()
    result.afterUnmount = { ...counts }; result.passed = true
  } catch (error) { result.failure = error.stack; try { result.failureSnapshot = await info() } catch {} }
  finally {
    try { if (win && !win.isDestroyed()) win.destroy() } catch (error) { result.cleanupFailure = error.stack; result.passed = false }
    for (const channel of channels) ipcMain.removeHandler(channel)
    fs.writeFileSync(path.join(privateRoot, `browser-${phase}.json`), JSON.stringify(result, null, 2))
    app.exit(result.passed ? 0 : 1)
  }
})
