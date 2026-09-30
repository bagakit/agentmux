const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const { createHash } = require('node:crypto')
const { spawn } = require('node:child_process'), { pathToFileURL } = require('node:url')
const [html, privateRoot, preload, evidence, coreFile, binary] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const control = { kind: 'terminal', hostId: 'local', runId: '', run: { runId: '' } }
const session = { id: '', kind: 'terminal', hostId: 'local', workspacePath: privateRoot,
  providerId: null, label: 'Private terminal', createdAt: 1, updatedAt: 1, latestOutputBytes: 0,
  status: { state: 'running', source: 'run-process', observedAt: 1 }, processState: 'running', control }
const counts = { attach: 0, detach: 0, resize: 0, write: 0 }, writes = []
const result = { schema: 'agentmux.terminal-link-hover-native.v1', passed: false, pid: process.pid,
  captureOnly: true, aestheticReview: 'not-performed', userRunTouched: false,
  boundary: 'Private actual Electron/production TerminalView/preload/published xterm, public Core Client and manifest native CtxMux daemon/PTY. Main attachment/resize/write handlers are fixture adapters to public Core APIs; generic live Python producer, no model or user App interaction. Native Linkifier/compositor and trusted CDP pointer/click/wheel/key events; not full product Main bootstrap or a physical pointer test.',
  versions: process.versions, frames: [], scenes: [] }
let win, client, daemon, run, unsubscribe
const outputQueue = []
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const evaluate = source => win.webContents.executeJavaScript(source)
const facts = () => evaluate('hoverFacts()')
async function wait(read, predicate, message) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await delay(35) }
  throw Error(message)
}
async function paint() { await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))') }
async function pointer(point) { await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }); await paint() }
async function click(point) {
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await paint()
}
function output(data) {
  outputQueue.push(data)
  const temporary = path.join(privateRoot, 'output.pending')
  fs.writeFileSync(temporary, JSON.stringify(outputQueue)); fs.renameSync(temporary, path.join(privateRoot, 'output.json'))
}
async function frame(name) {
  await paint(); const image = await win.webContents.capturePage(); assert.equal(image.isEmpty(), false)
  const png = image.toPNG(), file = name + '.png'; fs.writeFileSync(path.join(evidence, file), png)
  result.frames.push({ file, sha256: createHash('sha256').update(png).digest('hex'), size: image.getSize() })
}
async function hoverFile(name, row, firstText, fullPath, expectedStart, suffixLength = 0) {
  await pointer({ x: 2, y: 2 })
  const before = await facts(), point = await evaluate(`cellPoint(${row},${JSON.stringify(firstText)})`)
  if (expectedStart !== undefined) assert.equal(point.column, expectedStart, 'Independent expected first character cell')
  const beforeCounts = { ...counts }
  await pointer(point)
  await wait(facts, x => x.pathHovers.length > before.pathHovers.length && x.pathHovers.at(-1).text === fullPath,
    'Native Linkifier hover did not reach expected full path: ' + name)
  await delay(420); await paint()
  const hovered = await facts()
  assert.equal(hovered.pathHovers.at(-1).trusted, true, 'The native callback follows a trusted pointer')
  assert.ok(hovered.readout === null || hovered.readout === fullPath + ':3:2', 'Passive readout can hide while the native link remains usable')
  assert.deepEqual(hovered.readoutGlyphOverlap, [], 'Measured passive readout does not cover visible glyph cells')
  const matches = hovered.queries.flatMap(query => query.links).filter(link => link.text === fullPath)
  assert.ok(matches.length > 0, 'Actual product path provider returned populated expected links')
  const range = hovered.pathHovers.at(-1).range
  if (!['scrollback', 'narrow-wrapped'].includes(name)) assert.equal(hovered.readout, fullPath + ':3:2', 'Unoccupied baseline corner keeps its useful passive readout')
  const span = fullPath.length + suffixLength, last = point.column - 1 + span - 1
  assert.deepEqual(range, { start: { x: point.column, y: row + 1 },
    end: { x: last % hovered.cols + 1, y: row + 1 + Math.floor(last / hovered.cols) } }, 'Native provider range covers the exact visible ASCII path token and suffix')
  assert.deepEqual(counts, beforeCounts, 'Hover makes no IPC calls, resize or input')
  assert.equal(hovered.sameTerminal, true); assert.equal(hovered.terminalCount, 1)
  assert.deepEqual(hovered.buffer, before.buffer); assert.deepEqual(hovered.lines, before.lines)
  assert.equal(hovered.selection, before.selection); assert.equal(hovered.unicode, '11'); assert.deepEqual(hovered.errors, [])
  await frame(name)
  await click(point)
  const opened = await wait(facts, x => x.opens.length === before.opens.length + 1, 'Actual file click missed original opener')
  assert.deepEqual(opened.opens.at(-1), { kind: 'file', args: [fullPath, 'hover-private-group', { line: 3, column: 2 }, 'hover-private-workspace'] })
  await pointer({ x: 2, y: 2 })
  await wait(facts, x => x.readout === null, 'Native leave did not clear passive readout')
  result.scenes.push({ name, point, range, readout: hovered.readout, readoutGlyphOverlap: hovered.readoutGlyphOverlap, buffer: hovered.buffer, grid: { cols: hovered.cols, rows: hovered.rows }, ipcBefore: beforeCounts, ipcAfter: { ...counts }, originalTerminalPreserved: true })
}
app.whenReady().then(async () => {
  try {
    const initial = ['', 'ASCII src/example.ts:3:2', '说明 src/example.ts:3:2', 'e\u0301 src/example.ts:3:2', '😀 src/example.ts:3:2',
      '说明 https://example.test/path', 'e\u0301 \x1b]8;;https://example.test/declared\x07declared link\x1b]8;;\x07'].join('\r\n')
    fs.writeFileSync(path.join(privateRoot, 'initial.json'), JSON.stringify(initial)); fs.writeFileSync(path.join(privateRoot, 'output.json'), '[]')
    daemon = spawn(binary, ['--socket', path.join(privateRoot, 'runtime/ctxmux.sock'), '--state-dir', path.join(privateRoot, 'runtime/state/ctxmux')], { stdio: ['ignore', 'ignore', 'pipe'] })
    daemon.stderr.on('data', data => { result.daemonDiagnostics = ((result.daemonDiagnostics ?? '') + data).slice(-3000) })
    await wait(() => Promise.resolve(fs.existsSync(path.join(privateRoot, 'runtime/ctxmux.sock'))), Boolean, 'Private native daemon did not create its socket')
    const core = await import(pathToFileURL(coreFile).href)
    client = new core.AgentMuxClient({ store: new core.AgentMuxMemoryAgentSessionStore(), providers: [] }); await client.connect()
    result.runtime = client.runtimeIdentity()
    run = await client.createTerminal({ workspacePath: privateRoot, command: '/usr/bin/python3', args: [path.join(__dirname, 'program.py'), privateRoot], cols: 80, rows: 24 })
    control.runId = run.runId; control.run.runId = run.runId; session.id = run.runId
    await wait(() => client.listRuns(), runs => runs.some(item => item.runId === run.runId && item.latestOutputBytes > 50), 'Private actual PTY did not emit initial bytes')
    result.runBefore = (await client.listRuns()).find(item => item.runId === run.runId)
    ipcMain.handle('sessions:snapshot', () => ({ sessions: [session], timelines: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [] }))
    ipcMain.handle('sessions:attach', async (_event, value) => {
      assert.deepEqual(value, control); counts.attach++
      const attached = await client.attachTerminal(run.runId, 0, 'terminal')
      return { attachmentId: 'hover-private-attachment', session: { ...session, latestOutputBytes: attached.run.latestOutputBytes },
        terminal: attached.terminal, replay: attached.replay, resizeRevision: attached.resizeRevision,
        currentSize: { cols: attached.run.cols, rows: attached.run.rows }, gap: attached.gap }
    })
    ipcMain.handle('sessions:resize', async (_event, id, cols, rows) => { assert.equal(id, 'hover-private-attachment'); counts.resize++; return await client.resizeTerminal(control.run, cols, rows) })
    ipcMain.handle('sessions:detach', async (_event, id) => { assert.equal(id, 'hover-private-attachment'); counts.detach++; await client.releaseRunAttachment(control.run); return true })
    ipcMain.handle('sessions:write', async (_event, value, data) => {
      assert.deepEqual(value, control); counts.write++; writes.push({ control: value, data })
      const current = (await client.listRuns()).find(item => item.runId === run.runId)
      result.inputAck = await client.writeTerminal(control.run, { ownerInstanceId: client.runtimeIdentity().instanceId,
        operationId: require('node:crypto').randomUUID(), expectedByte: current.acceptedInputBytes, data })
    })
    win = new BrowserWindow({ width: 1000, height: 490, show: false, webPreferences: { preload, nodeIntegration: false, contextIsolation: true, sandbox: false, backgroundThrottling: false } })
    result.console = []
    win.webContents.on('console-message', event => { if (event.level === 'error') result.console.push(event.message) })
    unsubscribe = client.onEvent(event => { if (!win.isDestroyed()) win.webContents.send('agentmux:session-event', { type: 'core', hostId: 'local', event }) })
    await win.loadFile(html); win.showInactive(); win.webContents.debugger.attach('1.3')
    await wait(() => evaluate('window.ready === true'), value => value, 'Native fixture module did not mount')
    const boot = await wait(facts, x => x.terminalCount === 1 && !x.hydrating && x.lines?.[1]?.startsWith('ASCII '), 'Actual production terminal failed to replay')
    await delay(400); result.boot = await facts(); assert.deepEqual(result.boot.errors, [])
    for (const [name, row, start] of [['ascii', 1, 7], ['cjk', 2, 6], ['combining', 3, 3], ['emoji', 4, 4]])
      await hoverFile(name, row, 'src/', 'src/example.ts', start, ':3:2'.length)
    // This control proves the existing live OSC 8 owner. Initial checkpoint restoration
    // of hyperlink metadata is a separately recorded follow-up, not this range closure.
    result.osc8ControlBoundary = 'Fresh declared link emitted through the actual live PTY after attach; does not claim OSC 8 checkpoint restoration.'
    const beforeDeclared = (await client.listRuns()).find(item => item.runId === run.runId).latestOutputBytes
    output('\x1b[7;1He\u0301 \x1b]8;;https://example.test/declared\x07declared link\x1b]8;;\x07\x1b[K')
    await wait(() => client.listRuns(), runs => runs.some(item => item.runId === run.runId && item.latestOutputBytes > beforeDeclared), 'Actual live OSC 8 bytes were not observed')
    // Existing native bare-URL and OSC 8 providers must still enter their common destination owner.
    for (const [name, row, text, url] of [['bare-url', 5, 'https://', 'https://example.test/path'], ['osc8', 6, 'declared', 'https://example.test/declared']]) {
      await pointer({ x: 2, y: 2 }); const point = await evaluate(`cellPoint(${row},${JSON.stringify(text)})`), before = { ...counts }
      await pointer(point); await wait(facts, x => x.readout === url, 'Existing native HTTP hover owner was lost')
      const httpHover = await facts(); assert.deepEqual(httpHover.readoutGlyphOverlap, [])
      await frame(name); await click(point)
      await wait(() => evaluate('document.querySelectorAll("[data-destination=tab]").length'), x => x === 1, 'HTTP native click did not show original destination menu')
      const menu = await evaluate('(()=>{const r=document.querySelector("[data-destination=tab]").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()')
      await click(menu)
      const after = await facts(); assert.deepEqual(after.opens.at(-1), { kind: 'http', args: [{ workspaceId: 'hover-private-workspace', tabGroupId: 'hover-private-group', tabId: 'hover-private-tab', regionId: 'hover-private-region' }, url, 'tab'] })
      assert.deepEqual(counts, before); result.scenes.push({ name, url, commonDestinationOwner: true })
    }
    // Real scrollback, trusted wheel, selection and healthy input through the retained product view.
    output('\r\n' + Array.from({ length: 120 }, (_, i) => `history-${String(i).padStart(3, '0')} 说明 src/example.ts:3:2`).join('\r\n'))
    const bottom = await wait(facts, x => x.buffer.baseY > 80 && x.buffer.viewportY === x.buffer.baseY, 'Synthetic live output did not produce actual retained history')
    await pointer({ x: 2, y: 2 }); const wheelPoint = { x: bottom.screen.x + 15, y: bottom.screen.y + 60 }, beforeWheel = { ...counts }
    result.continuousReading = []
    let scrolled = bottom
    for (let step = 0; step < 3; step++) {
      const previous = scrolled
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...wheelPoint, deltaX: 0, deltaY: -180 })
      scrolled = await wait(facts, x => x.buffer.viewportY < previous.buffer.viewportY, 'Native continuous wheel did not reveal earlier retained rows')
      assert.deepEqual(scrolled.lines, bottom.lines); assert.deepEqual(counts, beforeWheel); assert.equal(scrolled.sameTerminal, true)
      const observedRun = (await client.listRuns()).find(item => item.runId === run.runId)
      assert.equal(observedRun.pid, result.runBefore.pid); assert.equal(observedRun.state, 'running'); assert.equal(observedRun.acceptedInputBytes, 0)
      result.continuousReading.push({ step, from: previous.buffer.viewportY, to: scrolled.buffer.viewportY,
        firstVisibleLine: scrolled.lines[scrolled.buffer.viewportY], runId: observedRun.runId, pid: observedRun.pid, noReadingIpc: true })
    }
    const row = scrolled.buffer.viewportY + 2
    await hoverFile('scrollback', row, 'src/', 'src/example.ts', undefined, ':3:2'.length)
    await click(wheelPoint); await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: 'z' })
    await wait(() => Promise.resolve(writes), x => x.length === 1, 'Retained terminal input did not use original control')
    assert.deepEqual(writes, [{ control, data: 'z' }])
    await wait(() => Promise.resolve(JSON.parse(fs.readFileSync(path.join(privateRoot, 'program-state.json')))), state => state.received.length === 1, 'Live PTY did not receive retained view input')
    const preResize = await facts()
    await pointer({ x: 2, y: 2 }); win.setContentSize(430, 420)
    result.viewportTransition = 'Real private BrowserWindow content resize; OS device pixel ratio stays unchanged.'
    const narrow = await wait(facts, x => x.cols < 45 && x.cols !== preResize.cols, 'Actual narrow Region did not settle its real terminal grid')
    let latest = narrow
    for (let step = 0; step < 8 && latest.buffer.viewportY !== latest.buffer.baseY; step++) {
      const previous = latest
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: latest.screen.x + 10, y: latest.screen.y + 50, deltaX: 0, deltaY: 180 })
      latest = await wait(facts, x => x.buffer.viewportY > previous.buffer.viewportY || x.buffer.viewportY === x.buffer.baseY, 'Native downward wheel did not advance retained reading')
    }
    assert.equal(latest.buffer.viewportY, latest.buffer.baseY, 'Bounded ordinary wheel sequence returns to latest retained output')
    // A private synthetic producer writes one long path; all pre-existing retained bytes remain.
    const longPath = 'src/' + 'deep/'.repeat(8) + 'example.ts'
    output('\r\n说明 ' + longPath + ':3:2')
    const wrapped = await wait(facts, x => x.lines.join('').includes(longPath) && x.buffer.viewportY === x.buffer.baseY, 'Actual wide-to-narrow wrapped token not delivered')
    const first = wrapped.lines.findLastIndex(line => line.startsWith('说明 src/'))
    await hoverFile('narrow-wrapped', first, 'src/', longPath, 6, ':3:2'.length)
    // Hovering the continuation is equally connected to the full original target.
    const continuation = await evaluate(`cellPoint(${first + 1},${JSON.stringify(wrapped.lines[first + 1].slice(0, 4))})`)
    const beforeContinuation = await facts()
    await pointer(continuation); await wait(facts, x => x.pathHovers.length > beforeContinuation.pathHovers.length && x.pathHovers.at(-1).text === longPath, 'Wrapped continuation native hover lost full target')
    await delay(420); await paint()
    const continuationHover = await facts(); assert.deepEqual(continuationHover.readoutGlyphOverlap, [])
    assert.equal(continuationHover.pathHovers.at(-1).trusted, true)
    await frame('narrow-wrapped-continuation'); await click(continuation)
    const end = await facts(); assert.deepEqual(end.opens.at(-1), { kind: 'file', args: [longPath, 'hover-private-group', { line: 3, column: 2 }, 'hover-private-workspace'] })
    assert.equal(end.sameTerminal, true); assert.equal(end.terminalCount, 1); assert.equal(counts.attach, 1); assert.equal(counts.detach, 0)
    assert.deepEqual(end.errors, []); assert.ok(end.lines.some(line => line.includes('history-000')), 'Earlier history retained after genuine reflow')
    result.runAfter = (await client.listRuns()).find(item => item.runId === run.runId)
    assert.equal(result.runAfter.pid, result.runBefore.pid); assert.equal(result.runAfter.runId, result.runBefore.runId); assert.equal(result.runAfter.state, 'running')
    assert.equal(result.runAfter.acceptedInputBytes, result.runBefore.acceptedInputBytes + 1)
    result.program = JSON.parse(fs.readFileSync(path.join(privateRoot, 'program-state.json')))
    assert.deepEqual(result.program.received, [122]); assert.equal(result.program.pid, result.runAfter.pid)
    result.end = end; result.counts = counts; result.writes = writes; result.passed = true
  } catch (error) { result.failure = error.stack; try { result.last = await facts(); await frame('failure') } catch {} }
  finally {
    result.cleanup = { errors: [] }; unsubscribe?.()
    if (client && run) try { await client.stopTerminal({ runId: run.runId }) } catch (error) { result.cleanup.errors.push(String(error)) }
    if (client) try { await client.dispose() } catch (error) { result.cleanup.errors.push(String(error)) }
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) { daemon.kill('SIGTERM'); await Promise.race([new Promise(resolve => daemon.once('exit', resolve)), delay(1500)]); if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL') }
    fs.writeFileSync(path.join(evidence, 'native.json'), JSON.stringify(result, null, 2)); app.exit(result.passed && result.cleanup.errors.length === 0 ? 0 : 1)
  }
})
