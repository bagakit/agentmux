const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createHash } = require('node:crypto')
const { app, BrowserWindow, ipcMain } = require('electron')
const [html, ownerBundle, privateRoot, evidence, phase, asset, cli] = process.argv.slice(2)
for (const key of ['home', 'userData', 'sessionData']) { const value = path.join(privateRoot, key); fs.mkdirSync(value, { recursive: true }); app.setPath(key, value) }
app.on('window-all-closed', () => {})
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const raw = { phase, qualified: false, frames: [], actions: [], errors: [], sessions: { attachments: [], writes: [], detaches: [] },
  boundary: 'Real App, terminal components, ConfigOwner, ToolkitOwner, registered Toolkit IPC, product preload and RuntimeController with two private Native TUI programs. A private local Core connector replaces the product Host process; other App services use preview data. No user Run or installation.' }
let win, toolkit, runtime, sampler, detachRuntime, detachToolkit, detachTheme, owner
const ids = ['tui-monitor', 'tui-output'], created = []
app.whenReady().then(async () => {
  try {
    const product = await import(pathToFileURL(ownerBundle).href)
    const { ConfigOwner, ConfigStore, ToolkitOwner, registerToolkitIpc, RuntimeController, ProcessResourceSampler, AgentMuxMemoryAgentSessionStore, sessionSnapshotPayload, sessionObservationResult, sessionInputWriteResult, tuiProgram, localRuntimeConnector, registerThemeBootstrap } = product
    const store = new ConfigStore(path.join(app.getPath('userData'), 'config.json'))
    let current = await store.get(), seeded = false
    const work = path.join(privateRoot, 'work'), program = path.join(work, 'tui-program.cjs')
    fs.mkdirSync(work, { recursive: true }); fs.writeFileSync(program, tuiProgram)
    owner = new ConfigOwner({ read: () => current, prepare: (before, next) => toolkit.prepareConfig(before, next), save: next => store.save(next),
      publish: next => { current = next; toolkit.configurationChanged(); if (win && !win.isDestroyed()) win.webContents.send('proof:tui:config:changed', next) } })
    sampler = new ProcessResourceSampler()
    runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), localRuntimeConnector, undefined, sampler)
    win = new BrowserWindow({ width: 1440, height: 940, show: false, webPreferences: { preload: process.env.AGENTMUX_PERFORMANCE_PRODUCT_PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    detachTheme = registerThemeBootstrap(ipcMain, win, () => owner.current.appearance, () => true)
    toolkit = new ToolkitOwner({ config: owner, receiptPath: path.join(app.getPath('userData'), 'toolkit-receipts.json'), openRunPort: () => runtime.toolkitRunPort(), enabled: () => false,
      launch: () => ({ runner: process.execPath, cli, script: asset, cwd: work, env: { ELECTRON_RUN_AS_NODE: '1' } }) })
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
        workspaces: [{ id: 'tui-work', hostId: 'local', name: 'TUI Toolkit', path: work, kind: 'folder' }],
        toolkit: { performance: { enabled: false, statusBar: 'icon' }, mobileConnection: { enabled: false, statusBar: 'icon' }, tools: [] } }))
      runtime.commit(await runtime.prepare({ ...owner.current, hosts: owner.current.hosts.filter(host => host.kind === 'local') }))
      for (const [index, id] of ids.entries()) { await toolkit.execute({ operation: 'toolkit.add', toolId: id, value: {
        name: index ? 'Live output' : 'Workspace monitor', icon: 'terminal', mode: 'tui', enabled: true, statusBar: 'label', workspacePath: work,
        script: index ? 'exec "$1" "$2"' : 'exec "$1" "$2" --alternate', args: [process.execPath, program]
      } }, new AbortController().signal)
        created.push(id)
      }
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
    await win.loadFile(html); win.show(); win.focus(); win.webContents.focus()
    await until('window.tuiScene?.ready && !!document.querySelector("[data-toolkit-id=tui-monitor]")')
    await waitFor(async () => (await Promise.all(ids.map(snapshot))).every(value => value.admission?.run && value.state === 'running'), 'Both private TUI Runs started on load')
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
    fs.writeFileSync(path.join(evidence, phase + '-render.json'), JSON.stringify(raw, null, 2) + '\n')
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(raw.qualified ? 0 : 1)
  }
})
