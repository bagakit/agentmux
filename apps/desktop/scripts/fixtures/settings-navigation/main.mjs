import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { app, BrowserWindow, ipcMain } from 'electron'
void (async () => {
const [html, privateRoot, preload, evidence, nodeExecutable, cli] = process.argv.slice(2)
assert.ok(path.isAbsolute(privateRoot))
for (const name of ['home', 'appData', 'userData', 'sessionData']) { const directory = path.join(privateRoot, name); mkdirSync(directory, { recursive: true }); app.setPath(name, directory) }
Object.assign(process.env, { AGENTMUX_RUNTIME_DIRECTORY: privateRoot, AGENTMUX_STATE_DIRECTORY: path.join(privateRoot, 'state'),
  AGENTMUX_AGENT_SESSION_STORE: path.join(privateRoot, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: path.join(privateRoot, 'messages.jsonl') })
const { AgentMuxControlServer } = await import('@agentmux/core')
const { DesktopControlIpcBridge } = await import('../../../src/main/control-ipc-bridge')
const execFile = promisify(execFileCallback)
const receipt = { schema: 'agentmux.settings-navigation.native.v1', passed: false, pid: process.pid, steps: [], screenshots: [], rendererErrors: [], nativeFocus: { events: [] } }
let win, server
const bridge = new DesktopControlIpcBridge({ isAvailable: () => Boolean(win && !win.isDestroyed()),
  sendRequest: request => win.webContents.send('agentmux:control-request', request),
  sendCancellation: cancellation => win.webContents.send('agentmux:control-cancel', cancellation) })
ipcMain.on('control:response', (_event, response) => bridge.accept(response))
ipcMain.handle('settings-navigation:setup', () => ({ workspace: path.join(privateRoot, 'workspace') }))
const invoke = async (...args) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_') && key !== 'ELECTRON_RUN_AS_NODE'))
  Object.assign(env, { AGENTMUX_RUNTIME_DIRECTORY: privateRoot, AGENTMUX_STATE_DIRECTORY: path.join(privateRoot, 'state') })
  const response = await execFile(nodeExecutable, [cli, ...args], { env, timeout: 10000, maxBuffer: 2 * 1024 * 1024 }).catch(error => {
    if (error.code === 1 && error.stdout) return error
    throw error
  })
  const value = JSON.parse(response.stdout || response.stderr)
  assert.equal(value.ok, true, JSON.stringify(value))
  receipt.steps.push({ args, value })
  return value.result
}
app.on('window-all-closed', () => {})
if (process.platform === 'darwin') app.setActivationPolicy('regular')
await app.whenReady()
try {
  win = new BrowserWindow({ width: 1280, height: 800, useContentSize: true, show: false, focusable: true,
    webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  for (const type of ['focus', 'blur']) win.on(type, () => receipt.nativeFocus.events.push({ type, observedAt: Date.now() }))
  win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') receipt.rendererErrors.push(details.message) })
  server = new AgentMuxControlServer({ socketPath: path.join(privateRoot, 'control.sock'), coreClients: () => [], execute: (request, _names, context) => bridge.execute(request, context?.signal) })
  await server.start()
  await win.loadFile(html); win.show(); win.focus(); app.focus({ steal: true })
  const read = code => win.webContents.executeJavaScript(code)
  const until = async expression => {
    const deadline = Date.now() + 12000
    while (Date.now() < deadline) { if (await read(expression)) return; await new Promise(resolve => setTimeout(resolve, 30)) }
    throw new Error('Original Settings proof did not settle: ' + expression)
  }
  await until('Boolean(window.settingsNavigationProof)')
  await read('window.settingsNavigationProof.openMote()')
  await until('window.settingsNavigationProof.facts().inputMounted')
  // Native activation is asynchronous on macOS. Follow the product's original
  // document-focus contract, without replacing hasFocus or input observation.
  // The product consumes document.hasFocus(); native key-window/WebContents
  // queries remain separate observations rather than extra input gates.
  receipt.nativeFocus.requestedAt = Date.now(); receipt.nativeFocus.windowId = win.id
  console.log(`settings-navigation native focus acquiring pid=${process.pid} windowId=${win.id}`)
  if (process.platform === 'darwin') await app.dock.show()
  win.show(); app.focus({ steal: true }); win.focus(); win.webContents.focus()
  const focusDeadline = Date.now() + 12000
  while (Date.now() < focusDeadline) {
    const sample = { observedAt: Date.now(), focusable: win.isFocusable(), visible: win.isVisible(),
      windowFocused: win.isFocused(), contentsFocused: win.webContents.isFocused(), documentFocused: await read('document.hasFocus()') }
    receipt.nativeFocus.lastObservation = sample
    if (sample.documentFocused) { receipt.nativeFocus.acquired = sample; break }
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  assert.ok(receipt.nativeFocus.acquired, 'The original real document must acquire focus before testing preserve')
  const before = await read('window.settingsNavigationProof.prepareInput()')
  assert.equal(await read('document.hasFocus()'), true, 'The original composing document is physically focused')
  assert.equal(before.sameInput, true); assert.equal(before.sameSelection, true)
  assert.equal(before.draft, 'Original Mote draft remains'); assert.equal(before.tabs.length, 1)
  const observed = await invoke('app', 'inspect')
  assert.ok(observed.observation.desktop.overlays.settingsPage.sectionIds.includes('appearance'))
  assert.equal(observed.observation.desktop.input.provenance, 'observed', 'The product confirms the original physical input owner')
  const opened = await invoke('app', 'focus', '--settings-section', 'appearance')
  assert.equal(opened.navigation.state, 'applied'); assert.equal(opened.overlays.settingsPage.sectionId, 'appearance')
  assert.equal(opened.overlays.settingsPage.visible, true); assert.equal(opened.input.outcome, 'preserved')
  const held = await read('window.settingsNavigationProof.facts()')
  assert.equal(held.sameInput, true); assert.equal(held.sameSelection, true)
  assert.deepEqual(held.focusEvents, []); assert.deepEqual(held.compositionEvents, ['compositionstart'])
  assert.deepEqual(held.tabs, before.tabs); assert.equal(held.mainSurface, before.mainSurface); assert.equal(held.draft, before.draft); assert.deepEqual(held.forbidden, [])
  await fs.writeFile(path.join(evidence, 'appearance-mote-input.png'), (await win.webContents.capturePage()).toPNG()); receipt.screenshots.push('appearance-mote-input.png')
  await read('window.settingsNavigationProof.manualProfile()')
  await until('window.settingsNavigationProof.facts().actualSection === "profile"')
  const manual = await invoke('app', 'inspect')
  assert.equal(manual.observation.desktop.overlays.settingsPage.sectionId, 'profile')
  await read('window.settingsNavigationProof.focusProfile()'); await win.webContents.insertText('Private unsaved profile')
  const draft = await read('window.settingsNavigationProof.profileDraft()')
  assert.ok(draft.includes('Private unsaved profile'), 'Native text insertion produced a nonempty unsaved draft')
  const refused = await invoke('app', 'focus', '--settings-section', 'not-registered')
  assert.equal(refused.navigation.state, 'rejected'); assert.equal(refused.overlays.settingsPage.sectionId, 'profile')
  assert.equal(await read('window.settingsNavigationProof.profileDraft()'), draft)
  assert.deepEqual((await read('window.settingsNavigationProof.facts()')).forbidden, [])
  await fs.writeFile(path.join(evidence, 'profile-original-draft.png'), (await win.webContents.capturePage()).toPNG()); receipt.screenshots.push('profile-original-draft.png')
  const closed = await invoke('app', 'focus', '--close-settings')
  assert.equal(closed.overlays.settings, false)
  assert.equal(closed.overlays.settingsPage.visible, false)
  assert.equal(await read('window.settingsNavigationProof.profileDraft()'), draft)
  assert.deepEqual(receipt.rendererErrors, [])
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack }; console.error(error) }
finally {
  const errors = []
  try { bridge.dispose() } catch (error) { errors.push(error.message) }
  try { await server?.stop() } catch (error) { errors.push(error.message) }
  try { if (win && !win.isDestroyed()) win.destroy() } catch (error) { errors.push(error.message) }
  receipt.nativeFocus.releasedAt = Date.now(); receipt.nativeFocus.windowDestroyed = !win || win.isDestroyed()
  console.log(`settings-navigation native focus released pid=${process.pid} windowDestroyed=${receipt.nativeFocus.windowDestroyed}`)
  receipt.cleanupErrors = errors
  await fs.writeFile(path.join(evidence, 'native.json'), JSON.stringify(receipt, null, 2))
  app.exit(receipt.passed && !errors.length ? 0 : 1)
}

})().catch(error => { console.error(error); app.exit(1) })
