const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createHash } = require('node:crypto')
const { app, BrowserWindow, ipcMain } = require('electron')
const [html, ownerBundle, privateRoot, evidence, phase, asset, cli, scene = 'terminal'] = process.argv.slice(2)
assert.ok(['terminal', 'working-directory'].includes(scene), 'Explicit Toolkit scene')
const directoryScene = scene === 'working-directory'
for (const key of ['home', 'userData', 'sessionData']) { const value = path.join(privateRoot, key); fs.mkdirSync(value, { recursive: true }); app.setPath(key, value) }
app.on('window-all-closed', () => {})
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const raw = { phase, scene, qualified: false, frames: [], actions: [], errors: [], sessions: { attachments: [], writes: [], detaches: [] },
  boundary: 'Real App, terminal components, ConfigOwner, ToolkitOwner, registered Toolkit IPC, product preload and RuntimeController with two private Native TUI programs. A private local Core connector replaces the product Host process; other App services use preview data. No user Run or installation.' }
if (directoryScene) raw.boundary = 'Real App Toolkit Settings, ConfigOwner/ConfigStore/ToolkitOwner, registered Toolkit IPC and product preload. Actual native input saves to the isolated authoritative owner and disk; a private local Core connector supplies empty Runtime facts. Other App services use preview data. No terminal interaction or OS folder-dialog qualification.'
let win, toolkit, runtime, sampler, detachRuntime, detachToolkit, detachTheme, owner, native
const ids = directoryScene ? [] : ['tui-monitor', 'tui-output'], created = []
const checkpoint = step => { (raw.checkpoints ??= []).push(step); fs.writeFileSync(path.join(evidence, 'progress.json'), JSON.stringify({ steps: raw.checkpoints }) + '\n'); process.stderr.write('TUI_SCENE=' + step + '\n') }
checkpoint('created')
app.whenReady().then(async () => {
  checkpoint('app-ready')
  try {
    const product = await import(pathToFileURL(ownerBundle).href)
    checkpoint('owner-imported')
    const { ConfigOwner, ConfigStore, ToolkitOwner, registerToolkitIpc, RuntimeController, ProcessResourceSampler, AgentMuxMemoryAgentSessionStore, sessionSnapshotPayload, sessionObservationResult, sessionInputWriteResult, tuiProgram, localRuntimeConnector, registerThemeBootstrap, activateRuntime } = product
    const runtimeDirectory = path.join(privateRoot, 'runtime'), stateDir = path.join(runtimeDirectory, 'state', 'ctxmux')
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    native = await activateRuntime({ executable: path.resolve(path.dirname(cli), '../vendor/ctxmux', process.platform + '-' + process.arch, 'bin/ctxmuxd'),
      socketPath: path.join(runtimeDirectory, 'ctxmux.sock'), stateDir, timeoutMs: 5000,
      childDisposition: { mode: 'detached', stdout: 'ignore', stderr: 'pipe' } })
    assert.equal(native.spawned, true, 'The fixture owns its newly created private Runtime')
    checkpoint('native-started')
    raw.native = { childPid: native.childPid, socketPath: native.socketPath, shutdown: false }
    const store = new ConfigStore(path.join(app.getPath('userData'), 'config.json'))
    let current = await store.get(), seeded = false
    const work = path.join(privateRoot, 'work'), program = path.join(work, 'tui-program.cjs')
    fs.mkdirSync(work, { recursive: true }); if (!directoryScene) fs.writeFileSync(program, tuiProgram)
    owner = new ConfigOwner({ read: () => current, prepare: (before, next) => toolkit.prepareConfig(before, next), save: next => store.save(next),
      publish: next => { current = next; toolkit.configurationChanged(); if (win && !win.isDestroyed()) win.webContents.send('proof:tui:config:changed', next) } })
    sampler = new ProcessResourceSampler()
    runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), localRuntimeConnector, undefined, sampler)
    win = new BrowserWindow({ width: 1440, height: 940, show: false, webPreferences: { preload: process.env.AGENTMUX_PERFORMANCE_PRODUCT_PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    ipcMain.on('ui:nativeOverlayFocus', event => { event.returnValue = false })
    detachTheme = registerThemeBootstrap(ipcMain, win, () => owner.current.appearance, () => true)
    toolkit = new ToolkitOwner({ config: owner, receiptPath: path.join(app.getPath('userData'), 'toolkit-receipts.json'), openRunPort: () => runtime.toolkitRunPort(), enabled: () => false,
      launch: () => ({ runner: process.execPath, cli, script: asset, cwd: work, env: { ELECTRON_RUN_AS_NODE: '1', HOME: app.getPath('home') } }) })
    detachToolkit = registerToolkitIpc(toolkit, (channel, handler) => ipcMain.handle(channel, handler))
    detachRuntime = runtime.attach(win.webContents)
    ipcMain.handle('sessions:snapshot', async () => sessionSnapshotPayload(await runtime.snapshot(owner.current), undefined, app.getPath('home')))
    ipcMain.handle('sessions:attach', (event, control, afterByte = 0) => sessionObservationResult(async () => {
      const result = await runtime.attachSession(event.sender.id, control, afterByte, owner.current)
      raw.sessions.attachments.push({ control, attachmentId: result.attachmentId, session: result.session }); return result
    }))
    ipcMain.handle('sessions:refreshAttachment', (event, control, attachmentId, afterByte) => sessionObservationResult(() => runtime.refreshSessionAttachment(event.sender.id, control, attachmentId, afterByte, owner.current)))
    ipcMain.handle('sessions:replay', (event, attachmentId, afterByte) => sessionObservationResult(() => runtime.readSessionReplay(event.sender.id, attachmentId, afterByte)))
    ipcMain.handle('sessions:refresh', (_event, control) => runtime.refresh(control, owner.current))
    ipcMain.handle('sessions:detach', async (event, attachmentId) => { await runtime.detachSession(event.sender.id, attachmentId); raw.sessions.detaches.push(attachmentId) })
    ipcMain.handle('sessions:resize', (event, attachmentId, cols, rows) => runtime.resizeSessionAttachment(event.sender.id, attachmentId, cols, rows))
    ipcMain.handle('sessions:write', (_event, control, data, source, observation) => sessionInputWriteResult(async () => { const result = await runtime.write(control, data, source, observation); raw.sessions.writes.push({ control, data, source }); return result }))
    ipcMain.handle('sessions:paste', (_event, control, text, terminalData, observation) => sessionInputWriteResult(() => runtime.paste(control, text, terminalData, observation)))
    ipcMain.handle('proof:tui:config:get', () => owner.current)
    ipcMain.handle('proof:tui:config:save', (_event, next, expected) => owner.edit(expected, next))
    ipcMain.handle('proof:tui:seed', async (_event, preview) => {
      assert.equal(seeded, false)
      await owner.update(() => ({ ...preview, appearance: { ...preview.appearance, appAppearance: 'dark', terminalTheme: 'graphite' },
        workspaces: [{ id: 'tui-work', hostId: 'local', name: directoryScene ? 'Toolkit directory' : 'TUI Toolkit', path: work, kind: 'folder' }],
        toolkit: { performance: { enabled: false, statusBar: 'icon' }, mobileConnection: { enabled: false, statusBar: 'icon' }, tools: [] } }))
      runtime.commit(await runtime.prepare({ ...owner.current, hosts: owner.current.hosts.filter(host => host.kind === 'local') }))
      for (const [index, id] of ids.entries()) { await toolkit.execute({ operation: 'toolkit.add', toolId: id, value: {
        name: index ? 'Live output' : 'Workspace monitor', icon: 'terminal', mode: 'tui', enabled: true, statusBar: 'label', workspacePath: work,
        script: index ? 'exec env ELECTRON_RUN_AS_NODE=1 "$1" "$2"' : 'exec env ELECTRON_RUN_AS_NODE=1 "$1" "$2" --alternate', args: [process.execPath, program]
      } }, new AbortController().signal)
        created.push(id)
      }
      checkpoint('config-seeded')
      seeded = true
      return { workspaceId: 'tui-work' }
    })
    win.webContents.on('console-message', details => { if (details.level === 'error') raw.errors.push(details.message) })
    const read = expression => win.webContents.executeJavaScript(expression)
    const until = async expression => { const end = Date.now() + 15000; while (!await read(expression)) { assert.ok(Date.now() < end, 'Real scene checkpoint: ' + expression); await pause(25) } }
    const waitFor = async (predicate, label) => { const end = Date.now() + 15000; while (!await predicate()) { assert.ok(Date.now() < end, label); await pause(30) } }
    const settle = () => read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const click = async selector => {
      const point = await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n?.isConnected||!n.checkVisibility())throw Error('Missing actual control: '+${JSON.stringify(selector)});n.scrollIntoView({block:'nearest',inline:'nearest'});const r=n.getBoundingClientRect();const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);const hit=document.elementFromPoint(x,y);if(!(hit===n||n.contains(hit)))throw Error('Control is covered');return{x,y}})()`)
      raw.actions.push({ type: 'native-click', selector, point })
      for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point })
      await pause(40); await settle()
    }
    const key = async keyCode => { raw.actions.push({ type: 'native-key', keyCode }); for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode }); await settle() }
    const snapshot = async id => (await toolkit.execute({ operation: 'toolkit.get', toolId: id }, new AbortController().signal)).snapshot
    const bytes = async run => (await (await runtime.toolkitRunPort()).replay({ runId: run.runId }, 0)).replay.map(item => new TextDecoder().decode(item.dataBytes)).join('')
    const frame = async name => {
      await settle()
      const image = await win.webContents.capturePage(), buffer = image.toPNG(), file = name + '.png'
      fs.writeFileSync(path.join(evidence, file), buffer)
      raw.frames.push({ file, sha256: createHash('sha256').update(buffer).digest('hex'), width: image.getSize().width, height: image.getSize().height })
    }
    checkpoint('loading-document')
    await win.loadFile(html); checkpoint('document-loaded'); win.show(); win.focus(); win.webContents.focus()
    if (directoryScene) {
      await until('window.tuiScene?.ready')
      await require('./working-directory.cjs')({ win, read, until, waitFor, settle, click, frame, owner, store, created, raw, home: app.getPath('home') })
      assert.equal(raw.sessions.attachments.length, 0, 'Directory editing does not attach a terminal')
      raw.qualified = true
      return
    }
    await until('window.tuiScene?.ready && !!document.querySelector("[data-toolkit-id=tui-monitor]")')
    await waitFor(async () => (await Promise.all(ids.map(snapshot))).every(value => value.admission?.run && value.state === 'running'), 'Both private TUI Runs started on load')
    checkpoint('runs-started')
    raw.original = await Promise.all(ids.map(snapshot))
    const originalRun = raw.original[0].admission.run, streamRun = raw.original[1].admission.run
    await click('[data-toolkit-id="tui-monitor"]')
    await until('!!document.querySelector(".toolkit-tui .xterm-screen") && !document.querySelector(".toolkit-tui .terminal-view__xterm--hydrating")')
    await click('.toolkit-tui .xterm-screen')
    await key('Down')
    await waitFor(async () => (await bytes(originalRun)).includes('Keyboard input received'), 'Real TUI consumes arrow key')
    await key('Escape')
    await waitFor(async () => (await bytes(originalRun)).includes('Escape received by the TUI'), 'Real TUI consumes Escape')
    assert.equal(await read('!!document.querySelector(".toolkit-tui .xterm-screen")'), true)
    await frame('terminal-wide')
    const attachments = raw.sessions.attachments.length
    await click('.toolkit-tui [data-toolkit-close]')
    await until('!document.querySelector(".toolkit-tui .xterm-screen")')
    assert.deepEqual((await snapshot(ids[0])).admission.run, originalRun)
    await click('[data-toolkit-id="tui-monitor"]')
    await until('!!document.querySelector(".toolkit-tui .xterm-screen") && !document.querySelector(".toolkit-tui .terminal-view__xterm--hydrating")')
    await waitFor(async () => raw.sessions.attachments.length > attachments, 'Reopen owns a new view attachment')
    assert.equal(raw.sessions.attachments.at(-1).control.run.runId, originalRun.runId)
    raw.reopen = { sameRun: true, original: originalRun, nextAttachment: raw.sessions.attachments.at(-1).attachmentId }
    await frame('terminal-reopened')
    win.setSize(680, 700)
    await until('innerWidth <= 680')
    await settle(); await frame('terminal-narrow')
    await click('.toolkit-tui__actions button:last-child')
    win.setSize(1440, 940)
    await until('document.querySelector("[data-tool-editor=tui-monitor]") && !!document.querySelector(".monaco-editor")')
    await frame('settings-wide')
    win.setSize(720, 860)
    await settle(); await frame('settings-narrow')
    await click('[data-toolkit-id="tui-output"]')
    await until('!!document.querySelector(".toolkit-tui .xterm-screen") && !document.querySelector(".toolkit-tui .terminal-view__xterm--hydrating")')
    await waitFor(async () => (await bytes(streamRun)).length > 70000, 'Continuous ordinary output crosses the finite script budget')
    await click('.toolkit-tui .xterm-screen'); await key('X')
    await waitFor(async () => (await bytes(streamRun)).includes('INPUT RECEIVED'), 'Ordinary terminal keeps interactive input while output grows')
    const scrollGeometry = () => read(`(()=>{const screen=document.querySelector('.toolkit-tui .xterm-screen').getBoundingClientRect(),slider=document.querySelector('.toolkit-tui .xterm-scrollbar.xterm-vertical .xterm-slider').getBoundingClientRect();return {screen:{x:Math.ceil(screen.x),y:Math.ceil(screen.y),width:Math.floor(screen.width),height:Math.floor(screen.height)},thumbTop:slider.top,thumbHeight:slider.height}})()`)
    const bottom = await scrollGeometry()
    win.webContents.debugger.attach('1.3')
    const wheel = { type: 'mouseWheel', x: bottom.screen.x + bottom.screen.width / 2, y: bottom.screen.y + bottom.screen.height / 2, deltaX: 0, deltaY: -1800 }
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', wheel)
    raw.actions.push({ type: 'native-wheel', channel: 'CDP Input.dispatchMouseEvent', ...wheel })
    await pause(350); await settle()
    const history = await scrollGeometry()
    assert.ok(history.thumbTop < bottom.thumbTop - 5, 'Native wheel moves the real terminal away from its live tail')
    const screenHash = async () => createHash('sha256').update((await win.webContents.capturePage(history.screen)).toPNG()).digest('hex')
    const beforeBytes = (await bytes(streamRun)).length, beforeScreen = await screenHash()
    await waitFor(async () => (await bytes(streamRun)).length > beforeBytes + 700, 'Original Run continues output while reading history')
    await pause(250); await settle()
    const afterScreen = await screenHash(), retained = await scrollGeometry()
    assert.equal(afterScreen, beforeScreen, 'Live output must not pull the original history screen back to the tail')
    assert.ok(retained.thumbTop < bottom.thumbTop - 5)
    raw.upwardReading = { bottom, history, retained, beforeBytes, afterBytes: (await bytes(streamRun)).length, beforeScreen, afterScreen, sameRun: (await snapshot(ids[1])).admission.run.runId === streamRun.runId }
    assert.equal(raw.upwardReading.sameRun, true)
    win.webContents.debugger.detach()
    await frame('output-narrow')
    await click('.toolkit-tui [data-toolkit-close]')
    raw.final = await Promise.all(ids.map(snapshot))
    assert.deepEqual(raw.final.map(value => value.admission.run), raw.original.map(value => value.admission.run))
    assert.ok(raw.sessions.writes.some(item => item.data === '\x1b'))
    raw.renderer = await read('({attachments:window.tuiScene.attachments,writes:window.tuiScene.writes,keys:window.tuiScene.keys})')
    assert.ok(raw.renderer.keys.some(item => item.key === 'Escape' && item.trusted && item.terminal))
    raw.qualified = true
  } catch (error) { raw.failure = { name: error.name, message: error.message, stack: error.stack } }
  finally {
    try {
      if (win && !win.isDestroyed()) win.close()
      for (const id of created) {
        if (!toolkit) break
        const state = (await toolkit.execute({ operation: 'toolkit.get', toolId: id }, new AbortController().signal)).snapshot
        if (state.admission?.run) await toolkit.execute({ operation: 'toolkit.stop', toolId: id, executionId: state.admission.executionId }, new AbortController().signal)
      }
      detachToolkit?.(); await toolkit?.dispose()
      raw.afterDisposalLeases = 0
      for (const id of created) if (toolkit) raw.afterDisposalLeases += (await toolkit.execute({ operation: 'toolkit.get', toolId: id }, new AbortController().signal)).snapshot.consumerCount
      assert.equal(raw.afterDisposalLeases, 0)
      detachTheme?.(); detachRuntime?.(); await runtime?.dispose(); sampler?.dispose()
    } catch (error) { raw.cleanupError = String(error); raw.qualified = false }
    try { if (native?.spawned) { await native.shutdown(); raw.native.shutdown = true; await native.dispose() } }
    catch (error) { raw.nativeCleanupError = String(error); raw.qualified = false }
    fs.writeFileSync(path.join(evidence, phase + '-render.json'), JSON.stringify(raw, null, 2) + '\n')
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(raw.qualified ? 0 : 1)
  }
})
