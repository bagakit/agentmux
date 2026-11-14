const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const { app, BrowserWindow } = require('electron'), { fork } = require('node:child_process')
const [url, privateRoot, evidence] = process.argv.slice(2)
for (const name of ['home', 'appData', 'userData', 'sessionData']) app.setPath(name, path.join(privateRoot, name))
const result = { schema: 'agentmux.dispatch-navigation-native.v1', passed: false, steps: [], frames: [], rendererErrors: [], electron: process.versions.electron, chromium: process.versions.chrome }
let win, host, hostExit, pending
app.whenReady().then(async () => {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  try {
    win = new BrowserWindow({ width: 1440, height: 900, x: -10000, y: -10000, show: false, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    win.webContents.on('console-message', event => { if (event.level === 'error') result.rendererErrors.push(event.message) })
    const read = code => win.webContents.executeJavaScript(code)
    const until = async predicate => { const end = Date.now() + 12000; do { if (await predicate()) return; await pause(40) } while (Date.now() < end); throw Error('Original public navigation did not settle') }
    await win.loadURL(url)
    await until(() => read('window.graphCapture?.ready&&!window.graphCapture.facts().loading&&window.graphCapture.facts().publicAdmissionReady'))
    await read('window.graphCapture.prepare();window.graphCapture.remember()'); result.before = await read('window.graphCapture.facts()')
    const nodeEnv = { ...process.env, AGENTMUX_DESKTOP_MAP_LOADED: path.join(evidence, 'control-loaded.jsonl') }; delete nodeEnv.ELECTRON_RUN_AS_NODE
    host = fork(path.join(__dirname, 'server-host.mjs'), [privateRoot], { execPath: process.env.COLLABORATION_CAPTURE_NODE, execArgv: [], env: nodeEnv, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    result.publicControl = { pid: host.pid, originalAdmission: true, stderr: '', exitConfirmed: false }
    host.stderr.setEncoding('utf8'); host.stderr.on('data', text => { result.publicControl.stderr += text })
    hostExit = new Promise(resolve => host.once('exit', (code, signal) => { Object.assign(result.publicControl, { exitConfirmed: true, exitCode: code, exitSignal: signal }); resolve() }))
    host.on('message', message => {
      if (message?.kind === 'ready') result.publicControl.ready = true
      else if (message?.kind === 'execute') read(`window.graphCapture.publicControl(${JSON.stringify(message.request)})`).then(value => host.connected && host.send({ kind: 'execute-result', id: message.request.requestId, result: value }), error => host.connected && host.send({ kind: 'execute-result', id: message.request.requestId, error: { message: error.message, code: error.code } }))
      else if (message?.kind === 'cancel') void read(`window.graphCapture.cancelPublicControl(${JSON.stringify(message.id)})`)
      else if (message?.kind === 'cli-result' && pending) { const receive = pending; pending = undefined; receive(message) }
    })
    await until(() => result.publicControl.ready)
    const cli = async step => {
      const output = await new Promise((resolve, reject) => { const timeout = setTimeout(() => { pending = undefined; reject(Error('Source CLI response exceeded observation boundary')) }, 12000); pending = message => { clearTimeout(timeout); message.error ? reject(Error(message.error)) : resolve(message.result) }; host.send({ kind: 'run', step }) })
      const recorded = { step, ...output }; result.steps.push(recorded)
      assert.ok(output.stdout.trim(), 'Original source CLI returned no JSON: ' + JSON.stringify(output))
      const parsed = JSON.parse(output.stdout); recorded.output = parsed; assert.equal(parsed.ok, true, output.stderr)
      return parsed.result
    }
    for (const [index, view] of ['map', 'list', 'map'].entries()) {
      const navigation = await cli(view)
      assert.equal(navigation.navigation.selection.surface, 'focus'); assert.equal(navigation.navigation.selection.focusView, view)
      await until(() => read(`window.graphCapture.facts().focusView===${JSON.stringify(view)}&&window.graphCapture.facts().mainSurface==='agents'`))
      if (view === 'map') await until(() => read('globalThis.__collaborationCaptureLayout?.busy===false&&globalThis.__collaborationCaptureCamera?.initialized.current'))
      const inspected = await cli('inspect')
      assert.equal(inspected.observation.desktop.selection.focusView, view); assert.equal(inspected.observation.desktop.presentation.state, 'main-visible')
      assert.equal(inspected.observation.desktop.presentation.regionId, null); assert.equal(inspected.observation.desktop.presentation.tabId, null)
      const facts = await read('window.graphCapture.facts()')
      for (const field of ['sameTabs', 'layoutsPreserved', 'sameDrafts', 'sameFocus', 'selectionPreserved', 'draftMounted', 'sameDraft']) assert.equal(facts[field], true, field)
      assert.deepEqual(facts.controls, [])
      const file = 'public-' + index + '-' + view + '.png'; await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); result.frames.push({ file, label: 'public-' + index + '-' + view, viewport: win.getContentSize() })
    }
    result.after = await read('window.graphCapture.facts()'); assert.equal(result.after.publicRequests.length, 6); assert.deepEqual(result.rendererErrors, [])
    assert.equal(result.after.draft, result.before.draft); assert.deepEqual(result.after.range, result.before.range); result.passed = true
  } catch (error) { result.failure = { message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) await fs.writeFile(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) }
  finally {
    if (host && !result.publicControl.exitConfirmed) {
      if (host.connected) host.send({ kind: 'stop' })
      await Promise.race([hostExit, pause(1500)])
      if (!result.publicControl.exitConfirmed) { host.kill('SIGTERM'); await Promise.race([hostExit, pause(1500)]) }
      if (!result.publicControl.exitConfirmed || result.publicControl.exitCode !== 0) { result.passed = false; result.hostCleanupUnknown = true }
    }
    await fs.writeFile(path.join(evidence, 'actual.json'), JSON.stringify(result, null, 2) + '\n')
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
