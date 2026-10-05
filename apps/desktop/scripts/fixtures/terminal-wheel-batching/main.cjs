const { fixtureEpoch: _reshape_fixtureEpoch } = require("../../../../../test/fixture-epoch.cjs")
const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { performance } = require('node:perf_hooks')
const { verifyWheelDistance } = require('./distance-cases.cjs')
const [html, privateRoot, coreFile, nodeExecutable, phase = 'candidate', variant = 'candidate'] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
for (const key of Object.keys(process.env)) if (key.startsWith('AGENTMUX_') || key.startsWith('CTXMUX_')) delete process.env[key]
process.env.AGENTMUX_RUNTIME_DIRECTORY = path.join(privateRoot, 'runtime')
process.env.AGENTMUX_STATE_DIRECTORY = path.join(privateRoot, 'state')
process.env.AGENTMUX_MESSAGE_QUEUE_PATH = path.join(privateRoot, 'messages.ndjson')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const result = { schema: 'agentmux.native-wheel-batching.v1', phase, pid: process.pid, runtimeCreated: false,
  userRunTouched: false, physicalDeviceTested: false, cases: [], passed: false,
  boundary: 'Actual SessionPane/TerminalView/xterm and byte-preserving Electron IPC to public Core writeAgent and official ctxmux PTY. A private fixture Provider and raw TUI replace the upstream CLI; explicit 4ms service control is not natural incident evidence.' }
let win, client, session, control, snapshot, generation = 0, serviceDelay = 0, requests = [], kernelCalls = [], inFlight = new Set()
app.on('window-all-closed', () => {})
const keepAlive = setInterval(() => {}, 1000)
const stage = value => fs.writeFileSync(path.join(privateRoot,'progress.json'), JSON.stringify({value,at:Date.now()}))
const configPath = path.join(privateRoot, 'program-config.json')
const programState = () => JSON.parse(fs.readFileSync(path.join(privateRoot, 'program-state.json'), 'utf8'))
const info = () => win.webContents.executeJavaScript('info()')
async function until(read, predicate, message) {
  for (let i = 0; i < 200; i++) { const value = await read(); if (predicate(value)) return value; await delay(15) }
  throw Error(message)
}
function handle(channel, handler) { ipcMain.handle(channel, handler) }
function write(value, data, source, kind = 'write', text) {
  assert.deepEqual(value, control)
  const entry = { ordinal: requests.length, kind, source, bytes: Array.from(typeof data === 'string' ? Buffer.from(data) : data),
    binary: typeof data !== 'string', text: typeof data === 'string' ? data : '', receivedAt: performance.now() }
  requests.push(entry)
  const promise = (kind === 'paste' ? client.pasteAgent({ agentSessionId: session.agentSessionId, expectedRun: session.run, text,
    terminalData: data, source: 'user' }) : client.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: session.run, data, source }))
    .then(ack => { entry.ack = ack; entry.ackAt = performance.now(); return { ok: true, ack } })
    .finally(() => inFlight.delete(promise))
  inFlight.add(promise); return promise
}
async function drain() {
  await Promise.all([...inFlight])
  const all = requests.flatMap(entry => entry.bytes)
  const state = await until(programState, value => value.bytes.length === all.length, 'Actual PTY program has not consumed all acknowledged bytes')
  assert.deepEqual(state.bytes, all, 'Raw native PTY received the exact ordered IPC bytes')
  assert.equal(kernelCalls.length, requests.length, 'Each public Core write owns exactly one native input operation')
  assert.equal(new Set(kernelCalls.map(entry => entry.operationId)).size, kernelCalls.length, 'Distinct input writes retain distinct operation identity')
  let cursor = kernelCalls[0]?.expectedByte ?? 0
  for (let i = 0; i < kernelCalls.length; i++) {
    const call = kernelCalls[i], request = requests[i]
    assert.equal(call.expectedByte, cursor); assert.deepEqual(call.bytes, request.bytes)
    assert.deepEqual(call.ack.appliedByteRange, { startByte: cursor, endByte: cursor + call.bytes.length })
    cursor += call.bytes.length
    assert.deepEqual(request.ack, { runId: session.run.runId, appliedByteRange: call.ack.appliedByteRange, acceptedThroughByte: cursor })
  }
  return { requests, kernelCalls, program: state }
}
async function mount(c) {
  await win.webContents.executeJavaScript(`mount(${JSON.stringify(c.mode)},${!!c.readOnly},${!!c.pending},${!!c.applicationCursor})`)
  // Retaining the product View cannot leak a preceding independent case's wheel filter or residue.
  await win.webContents.executeJavaScript('terminals.at(-1).attachCustomWheelEventHandler(()=>true);terminals.at(-1)._core._mouseService._wheelPartialScroll=0')
  let before = await info(), stable = 0
  for (let i = 0; i < 50 && stable < 3; i++) { await delay(20); const next = await info(); stable = next.cols === before.cols && next.rows === before.rows && next.baseY === before.baseY ? stable + 1 : 0; before = next }
  assert.equal(stable, 3); assert.equal(before.terminalCount, 1); assert.deepEqual(before.errors, [])
  assert.ok(before.point && before.cellHeight > 0)
  if (c.mode === 'normal') { await win.webContents.executeJavaScript('terminals.at(-1).scrollToLine(300)'); await delay(20); before = await info(); assert.equal(before.viewportY, 300) }
  else assert.equal(before.type, 'alternate')
  if(c.filtered) await win.webContents.executeJavaScript('terminals.at(-1).attachCustomWheelEventHandler(()=>false)')
  return before
}
async function wheel(c, before) {
  if(c.unit && c.immediate) {
    await win.webContents.executeJavaScript(`(() => {const p=info().point; for(let i=0;i<${c.events};i++) document.elementFromPoint(p.x,p.y).dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:p.x,clientY:p.y,deltaY:${-c.delta},deltaMode:${c.unit}}))})()`); return
  }
  for (let i = 0; i < (c.events ?? 1); i++) {
    // CDP dispatch is actual trusted Chromium input; DOM_DELTA_LINE/PAGE has no CDP representation.
    if (c.unit || c.fractionalLine) await win.webContents.executeJavaScript(`(() => {const p=info().point; document.elementFromPoint(p.x,p.y).dispatchEvent(new WheelEvent('wheel', {bubbles:true,cancelable:true,clientX:p.x,clientY:p.y,deltaY:${-c.delta},deltaMode:${c.unit ?? 1},ctrlKey:${!!c.ctrl},shiftKey:${!!c.shift}}))})()`)
    else await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: before.point.x, y: before.point.y, deltaX: c.horizontal ? 50 : 0, deltaY: -c.delta, modifiers: c.ctrl ? 2 : c.shift ? 8 : 0 })
    if (!c.immediate) await delay(20)
  }
}
function verify(c, before, after, native) {
  assert.equal(after.wheels.length, c.events ?? 1); assert.deepEqual(after.errors, [])
  assert.equal(after.cols, before.cols); assert.equal(after.rows, before.rows); assert.equal(after.baseY, before.baseY)
  const noReports = c.readOnly || c.shift || c.delta === 0 || c.filtered || c.fractionalLine
  const distance = Math.abs(c.delta) * (c.events ?? 1) * before.scrollSensitivity * (c.ctrl ? before.fastScrollSensitivity : 1)
  const reports = noReports || c.mode === 'normal' ? 0 : Math.trunc(c.unit === 1 ? distance : c.unit === 2 ? distance * before.rows : distance / before.cellHeight)
  assert.equal(native.program.reports, reports, 'Exact wheel report distance reaches the real PTY program')
  const expectedWrites = reports ? phase === 'baseline' ? reports : c.events ?? 1 : 0
  assert.equal(native.requests.length, expectedWrites, 'One admitted wheel must produce one request, not one per report')
  assert.equal(native.program.top, 500 + (c.delta > 0 ? -3 : 3) * reports)
  if (c.mode === 'normal') { assert.ok(c.delta > 0 ? after.viewportY < before.viewportY : after.viewportY > before.viewportY); return }
  assert.ok(after.firstLine.includes(`private-TUI-row-${native.program.top}`), 'The real Native TUI output must repaint the actual TerminalView')
  if (!reports) return
  const bytes = native.requests.flatMap(request => request.bytes)
  if (c.mode === 'alternate-binary') {
    assert.equal(bytes.length, reports * 6); assert.ok(bytes[4] >= 128)
    const report = bytes.slice(0, 6)
    assert.deepEqual(bytes, Array.from({ length: reports }, () => report).flat(), 'Legacy binary repeats exact original coordinates')
    assert.equal(report[3], (c.delta > 0 ? 64 : 65) + (c.ctrl ? 16 : 0) + 32)
    assert.ok(native.requests.length > 0 && native.requests.every(request => request.binary))
  } else if (c.mode === 'alternate-mouse') {
    const text = Buffer.from(bytes).toString(), matches = [...text.matchAll(/\x1b\[<(\d+);(\d+);(\d+)M/g)]
    assert.equal(matches.length, reports); assert.equal(matches.map(m => m[0]).join(''), text)
    assert.ok(matches.length > 0 && matches.every(m => m[0] === matches[0][0]))
    assert.equal(Number(matches[0][1]), (c.delta > 0 ? 64 : 65) + (c.ctrl ? 16 : 0))
    // Exact xterm coordinates derive from the actual event point and current public grid.
    assert.equal(Number(matches[0][2]), Math.floor((before.point.x - before.screen.left) / (before.screen.width / before.cols)) + 1)
    assert.equal(Number(matches[0][3]), Math.floor((before.point.y - before.screen.top) / (before.screen.height / before.rows)) + 1)
  } else assert.equal(Buffer.from(bytes).toString(), `\x1b${c.applicationCursor ? 'O' : '['}${c.delta > 0 ? 'A' : 'B'}`.repeat(reports))
}
const cases = [
  { name: 'sgr-up', mode: 'alternate-mouse', delta: 350 },
  { name: 'sgr-down-two-events', mode: 'alternate-mouse', delta: -350, events: 2 },
  { name: 'sgr-line-two-events', mode: 'alternate-mouse', delta: 3, unit: 1, events: 2, immediate: true },
  { name: 'sgr-line', mode: 'alternate-mouse', delta: 3, unit: 1 },
  { name: 'sgr-page', mode: 'alternate-mouse', delta: 1, unit: 2 },
  { name: 'sgr-ctrl', mode: 'alternate-mouse', delta: 3, unit: 1, ctrl: true },
  { name: 'binary-coordinates', mode: 'alternate-binary', delta: 350 },
  { name: 'binary-two-events', mode: 'alternate-binary', delta: -350, events: 2 },
  { name: 'keys', mode: 'alternate-keys', delta: 350 },
  { name: 'application-keys', mode: 'alternate-keys', delta: -350, applicationCursor: true },
  { name: 'fractional-no-report', mode: 'alternate-mouse', delta: .1, fractionalLine: true },
  { name: 'zero-horizontal', mode: 'alternate-mouse', delta: 0, horizontal: true },
  { name: 'shift-local', mode: 'alternate-mouse', delta: 350, shift: true },
  { name: 'filtered-custom-wheel', mode: 'alternate-mouse', delta: 350, filtered: true },
  { name: 'readonly', mode: 'alternate-mouse', delta: 350, readOnly: true },
  { name: 'pending', mode: 'alternate-mouse', delta: 350, pending: true },
  { name: 'normal-up', mode: 'normal', delta: 350 },
  { name: 'normal-down', mode: 'normal', delta: -350 }
]
app.whenReady().then(async () => {
  try {
    fs.writeFileSync(configPath, JSON.stringify({ generation: 0, mode: 'alternate-mouse' }))
    stage('import-core')
    const core = await import(pathToFileURL(coreFile).href)
    const template = new core.AgentProviderRegistry().get('codex')
    const { providerFork: _fork, promptExecution: _promptExecution, ...capabilities } = template.catalog.capabilities
    const provider = core.defineAgentProvider({ catalog: { ...template.catalog, capabilities, id: 'wheel-fixture', hookStrategy: { kind: 'none' } }, hook: { rules: [] }, buildArgs: (_prompt, args) => [...args] })
    stage('connect-core')
    client = await core.connectLocalAgentMux({ providers: [provider], store: new core.AgentMuxMemoryAgentSessionStore() })
    stage('create-agent')
    session = await client.createAgent({ providerId: 'wheel-fixture', executorId: 'wheel-fixture', workspacePath: privateRoot,
      commandOverride: nodeExecutable, args: [path.join(__dirname, 'program.mjs'), privateRoot], injectAgentMuxGuide: false, cols: 180, rows: 24 })
    stage('agent-created')
    result.runtimeCreated = true; result.identity = { sessionId: session.agentSessionId, runId: session.run.runId }
    control = { kind: 'agent', hostId: 'local', agentSessionId: session.agentSessionId, run: session.run }
    snapshot = { id: session.agentSessionId, kind: 'agent', providerId: session.providerId, executorId: session.executorId,
      hostId: 'local', workspacePath: privateRoot, label: 'Private real wheel TUI', createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: _reshape_fixtureEpoch(0, 0, 1),
      processState: 'running', latestOutputBytes: 0, status: { state: 'working', source: 'native-hook', observedAt: _reshape_fixtureEpoch(0, 0, 1) },
      control, capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: false, replyCorrelation: 'none' } }
    const nativeInput = client.kernel.input.bind(client.kernel)
    client.kernel.input = async (runId, input) => {
      const entry = { operationId: input.operationId, expectedByte: input.expectedByte,
        bytes: Array.from(typeof input.data === 'string' ? Buffer.from(input.data) : input.data), enteredAt: performance.now() }
      kernelCalls.push(entry)
      if (serviceDelay) await delay(serviceDelay)
      const ack = await nativeInput(runId, input); entry.ack = ack; entry.ackAt = performance.now(); return ack
    }
    client.onEvent(event => { if (win && !win.isDestroyed()) win.webContents.send('agentmux:session-event', { type: 'core', hostId: 'local', event }) })
    handle('wheel-proof:setup', () => snapshot)
    handle('wheel-proof:configure', async (_event, options) => {
      await Promise.all([...inFlight]); requests = []; kernelCalls = []
      fs.writeFileSync(configPath, JSON.stringify({ ...options, generation: ++generation }))
      await until(programState, state => state.generation === generation, 'Private TUI configuration did not repaint')
    })
    handle('wheel-proof:drain', drain)
    handle('sessions:attach', async (_event, value, afterByte) => {
      assert.deepEqual(value, control); const { attachment } = await client.reattachAgent(session.agentSessionId, afterByte, 'terminal')
      result.lastAttach={terminalType:attachment.terminal.type,runId:attachment.run.runId,latestOutputBytes:attachment.run.latestOutputBytes,replayChunks:attachment.replay.length}
      return { ...attachment, attachmentId: 'private-attachment', session: { ...snapshot, latestOutputBytes: attachment.run.latestOutputBytes },
        currentSize: { cols: attachment.run.cols, rows: attachment.run.rows } }
    })
    handle('sessions:detach', async () => { await client.releaseRunAttachment(session.run); return true })
    handle('sessions:resize', async (_event, _id, cols, rows) => client.resizeAgent(session.agentSessionId, session.run, cols, rows))
    handle('sessions:replay', async (_event, _id, afterByte) => client.readRunReplay(session.run, afterByte, 'terminal'))
    handle('sessions:write', (_event, value, data, source) => write(value, data, source))
    handle('sessions:paste', (_event, value, text, terminalData) => write(value, terminalData, 'user', 'paste', text))
    stage('create-window')
    win = new BrowserWindow({ width: 1560, height: 580, show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: false, contextIsolation: true, backgroundThrottling: false, offscreen: true } })
    win.webContents.on('console-message', (_event, level, message) => { if(level >= 2) process.stderr.write(message + '\n') })
    stage('load-window')
    await win.loadFile(html); win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await until(() => win.webContents.executeJavaScript('window.ready===true'), x => x, 'Native Renderer did not load')
    for (const distribution of [variant]) {
      await win.webContents.executeJavaScript(`setDistribution(${JSON.stringify(distribution)})`)
      if (phase !== 'old-distance') for (const c of cases) {
        stage(distribution + ':' + c.name)
        const before = await mount(c); await wheel(c, before)
        await delay(60); const native = await drain(); const after = c.mode === 'normal' ? await info() : await until(info, value => value.firstLine?.includes(`private-TUI-row-${native.program.top}`), 'Actual xterm must repaint the final native TUI position')
        result.cases.push({ distribution, ...c, before, after, native }); verify(c, before, after, native)
      }
      if (phase !== 'old-distance') for (const latency of [0, 4]) {
        const c = { name: latency ? 'controlled-service-latency' : 'unmodified-service-latency', mode: 'alternate-mouse', delta: 350, immediate: true }
        const before = await mount(c); serviceDelay = latency
        await wheel(c, before)
        // A keyboard input immediately follows the DOM wheel in the same actual terminal.
        await win.webContents.executeJavaScript('terminals.at(-1).focus()')
        await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: 'z' })
        await until(() => requests, values => values.some(entry => entry.text === 'z'), 'Native following key did not dispatch')
        const native = await drain(); serviceDelay = 0
        const keyboard = native.requests.at(-1), first = native.requests[0], reports = native.program.reports
        assert.ok(reports > 1); assert.equal(keyboard.text, 'z')
        assert.equal(native.requests.length, phase === 'baseline' ? reports + 1 : 2)
        assert.equal(native.program.keys, 'z')
        const keyCall = native.kernelCalls.at(-1)
        if (latency) assert.ok(keyCall.enteredAt - keyboard.receivedAt >= latency * (phase === 'baseline' ? reports * .7 : .5), 'Following key waits for the actual Core FIFO service control')
        result.cases.push({ distribution, ...c, reports, serviceControlMs: latency, naturalIncidentEvidence: false,
          keyboardQueueMs: keyCall.enteredAt - keyboard.receivedAt, keyboardAckMs: keyboard.ackAt - keyboard.receivedAt,
          wholeGestureAckMs: keyboard.ackAt - first.receivedAt, native })
      }
      if (phase !== 'old-distance') {
      const mouseBefore = await mount({ mode: 'alternate-mouse' })
      await win.webContents.executeJavaScript('terminals.at(-1).options.mouseEventsRequireAlt=false')
      const mousePoint = { x: mouseBefore.point.x, y: mouseBefore.point.y, modifiers: 0 }
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { ...mousePoint, type: 'mouseMoved', button: 'none', buttons: 0 })
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { ...mousePoint, type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1 })
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { ...mousePoint, type: 'mouseMoved', button: 'left', buttons: 1 })
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { ...mousePoint, type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1 })
      const mouseNative = await drain()
      const col = Math.floor((mouseBefore.point.x - mouseBefore.screen.left) / (mouseBefore.screen.width / mouseBefore.cols)) + 1
      const row = Math.floor((mouseBefore.point.y - mouseBefore.screen.top) / (mouseBefore.screen.height / mouseBefore.rows)) + 1
      assert.deepEqual(mouseNative.requests.map(entry => entry.text), [
        `\x1b[<35;${col};${row}M`, `\x1b[<0;${col};${row}M`, `\x1b[<32;${col};${row}M`, `\x1b[<0;${col};${row}m`
      ], 'Non-wheel hover, press, drag and release keep their original one-report behavior')
      result.cases.push({ distribution, name: 'non-wheel-mouse', native: mouseNative })
      const ordered = { name: 'wheel-key-paste-protocol-order', mode: 'alternate-mouse', delta: 3, unit: 1 }
      const before = await mount(ordered); await wheel(ordered, before)
      await win.webContents.executeJavaScript('terminals.at(-1).focus()')
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: 'k' })
      await win.webContents.executeJavaScript(`(() => {const clipboardData = new DataTransfer(); clipboardData.setData('text/plain','paste-body'); document.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData})); terminals.at(-1).write('\\x1b[5n')})()`)
      await until(() => requests, values => values.some(entry => entry.source === 'terminal-protocol'), 'Actual xterm parser reply did not reach its independent protocol write')
      const native = await drain()
      const wheelWrites = phase === 'baseline' ? 3 : 1
      assert.equal(native.requests.length, wheelWrites + 3)
      assert.deepEqual(native.requests.slice(wheelWrites).map(entry => [entry.kind, entry.source, entry.text]), [
        ['write', 'user', 'k'], ['paste', 'user', '\x1b[200~paste-body\x1b[201~'], ['write', 'terminal-protocol', '\x1b[0n']
      ], 'Wheel, keyboard, paste and parser reply retain separate FIFO input identities')
      result.cases.push({ distribution, ...ordered, native })
      }
      await verifyWheelDistance({ win, mount, drain, info, until, phase, distribution, cases: result.cases })
    }
    stage('passed')
    result.passed = true
  } catch (error) { result.failure = error.stack; if(win&&!win.isDestroyed())result.body=await win.webContents.executeJavaScript('document.body.innerText').catch(()=>null) }
  finally {
    if (win && !win.isDestroyed()) win.destroy()
    if (client) { if (session) { try { await client.stopAgent(session.agentSessionId, session.run) } catch (error) { result.cleanupFailure = String(error); result.passed = false } }; await client.dispose() }
    clearInterval(keepAlive); fs.writeFileSync(path.join(privateRoot, 'browser.json'), JSON.stringify(result, null, 2)); app.exit(result.passed ? 0 : 1)
  }
})
