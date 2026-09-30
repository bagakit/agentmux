import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const repository = resolve(import.meta.dirname, '../../..')
const desktop = join(repository, 'apps/desktop')
const requireDesktop = createRequire(join(desktop, 'package.json'))
const output = join(repository, '.tmp/renderer-crash-recovery', `attempt-${Date.now()}`)
await mkdir(output, { recursive: true })
const { build } = await import(pathToFileURL(requireDesktop.resolve('vite')).href)
const sources = {
  recovery: join(desktop, 'src/main/renderer-crash-recovery.ts'),
  persistence: join(desktop, 'src/main/window-state-persistence.ts'),
  menu: join(desktop, 'src/main/application-menu.ts')
}
const original = Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([name, file]) => [name, await readFile(file, 'utf8')])))
const main = await readFile(join(desktop, 'src/main/index.ts'), 'utf8')
// Non-definition product consumers: these are the actual Main and menu/quit entry points.
assert.match(main, /recoverInterface = registerRendererCrashRecovery\(window, dialog,/)
assert.match(main, /await prepareWindowWorkbenchForQuit\(window\)/)
assert.match(main, /void recoverInterface\?\.\(\)/)

const mutations = [
  { name: 'green' },
  { name: 'dead-renderer-save-mutant', file: sources.persistence, from: 'if (window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.isCrashed()) return', to: 'if (window.isDestroyed() || window.webContents.isDestroyed()) return' },
  { name: 'live-save-error-swallowed-mutant', file: sources.persistence, from: 'throw error', to: 'return' },
  { name: 'cancel-reloads-mutant', file: sources.recovery, from: 'if (response === 0) window.reload()', to: 'if (response === 0 || response === 2) window.reload()' },
  { name: 'closed-window-getter-mutant', file: sources.recovery, from: 'contents.removeListener(', to: 'window.webContents.removeListener(' }
]
for (const mutation of mutations) {
  let hits = 0
  await build({
    configFile: false, logLevel: 'error',
    plugins: mutation.file ? [{ name: mutation.name, transform(source, id) {
      if (id !== mutation.file) return
      assert.equal(source.split(mutation.from).length, 2, `${mutation.name}: mutation anchor must be unique`)
      hits++
      return source.replace(mutation.from, mutation.to)
    } }] : [],
    build: {
      target: 'node22', outDir: join(output, mutation.name, 'compiled'), emptyOutDir: true, minify: false,
      lib: { entry: sources, formats: ['cjs'] },
      rollupOptions: { external: ['electron', /^node:/], output: { entryFileNames: '[name].cjs' } }
    }
  })
  if (mutation.file) assert.equal(hits, 1)
}

const page = join(output, 'workbench.html')
await writeFile(page, `<!doctype html><html><body><h1>Private recovery verification</h1><p>This window does not connect to a Runtime or user Session.</p><pre id="workbench"></pre><script>
const storageKey = 'private-crash-recovery-workbench'
const persisted = localStorage.getItem(storageKey)
window.__restoredExistingWorkbench = !!persisted
if (!persisted) localStorage.setItem(storageKey, JSON.stringify({tabs:['tab-original'],groups:['group-original'],regions:['region-original'],focus:'region-original',split:[0.4,0.6],session:'session-original',draft:'retained draft'}))
document.querySelector('#workbench').textContent = localStorage.getItem(storageKey)
window.agentmuxPrepareRendererUpdate = async () => {}
</script></body></html>`)
const harness = join(output, 'harness.cjs')
await writeFile(harness, `
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')
const { app, BrowserWindow, dialog } = require('electron')
const [compiled, page, directory, stateDirectory, mode] = process.argv.slice(2)
const { registerRendererCrashRecovery } = require(join(compiled, 'recovery.cjs'))
const { prepareWindowWorkbenchForQuit } = require(join(compiled, 'persistence.cjs'))
const { applicationMenuTemplate } = require(join(compiled, 'menu.cjs'))
app.setPath('userData', stateDirectory)
app.setName('AgentMux Private Crash Verification')
const result = { mode, notices: [], quitRequests: 0, reloadRequests: 0 }
let complete = false
let allowingQuit = false
let completedCode = 0
let quitOwner = null
const writeResult = () => writeFileSync(join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\\n')
process.on('uncaughtException', error => { result.uncaughtException = String(error.stack || error); writeResult(); app.exit(1) })
app.on('before-quit', event => {
  if (allowingQuit) return
  event.preventDefault()
  result.exitTrace = ['before-quit']
  Promise.resolve().then(async () => {
    const window = quitOwner
    if (window) await prepareWindowWorkbenchForQuit(window)
    result.exitTrace.push('renderer-save-prepared')
    // Synthetic owner cleanup, matching the production order without any user Runtime.
    await Promise.resolve()
    result.exitTrace.push('owners-disposed')
    allowingQuit = true
    result.exitTrace.push('allowing-quit')
    writeResult()
    app.quit()
  }).catch(error => { result.error = String(error); writeResult(); app.exit(1) })
})
const finish = code => {
  if (complete) return
  complete = true
  completedCode = code
  if (code === 0) app.quit()
  else { allowingQuit = true; writeResult(); app.exit(code) }
}
app.on('will-quit', () => { result.exitTrace?.push('will-quit'); writeResult(); process.exitCode = completedCode })
setTimeout(() => { result.timeout = true; finish(2) }, 14000)
async function waitFor(predicate) {
  const deadline = Date.now() + 3500
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Expected private Renderer observation did not arrive')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: mode === 'native', width: 1050, height: 700, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  quitOwner = window
  await window.loadFile(page)
  const readWorkbench = () => window.webContents.executeJavaScript("localStorage.getItem('private-crash-recovery-workbench')")
  result.before = await readWorkbench()
  assert.ok(JSON.parse(result.before).tabs.length > 0)
  if (mode === 'restart') {
    result.restoredExistingWorkbench = await window.webContents.executeJavaScript('window.__restoredExistingWorkbench')
    assert.equal(result.restoredExistingWorkbench, true, 'Restart must read retained state, not recreate the seed')
    result.after = await readWorkbench(); finish(0); return
  }
  // Alive-but-unsaved must remain a rejected save, even in the gone recovery implementation.
  const alive = Object.assign(new EventEmitter(), { isDestroyed: () => false, isCrashed: () => false,
    executeJavaScript: async () => { throw new Error('private storage unavailable') } })
  await assert.rejects(prepareWindowWorkbenchForQuit({ isDestroyed: () => false, webContents: alive }), /private storage unavailable/)
  let action = 2
  let nativePending = mode === 'native'
  let quitting = false
  let completedNotices = 0
  const noticeDialog = { showMessageBox: async (parent, options) => {
    result.notices.push(options)
    if (nativePending) {
      nativePending = false
      const controller = new AbortController()
      setTimeout(() => {
        try {
          const windowId = parent.getMediaSourceId().split(':')[1]
          execFileSync('/usr/sbin/screencapture', ['-x', '-l', windowId, join(directory, 'native-notice.png')])
          result.nativeScreenshot = 'native-notice.png'
        } catch (error) { result.screenshotError = String(error) }
        controller.abort()
      }, 900)
      const choice = await dialog.showMessageBox(parent, { ...options, signal: controller.signal })
      completedNotices++
      return choice
    }
    completedNotices++
    return { response: action, checkboxChecked: false }
  } }
  const originalReload = window.reload.bind(window)
  window.reload = () => { result.reloadRequests++; originalReload() }
  result.saveRequests = 0
  const originalExecute = window.webContents.executeJavaScript.bind(window.webContents)
  window.webContents.executeJavaScript = (script, ...args) => {
    if (script === 'window.agentmuxPrepareRendererUpdate("quit")') result.saveRequests++
    return originalExecute(script, ...args)
  }
  let quitPreparation
  const recover = registerRendererCrashRecovery(window, noticeDialog, () => {
    result.quitRequests++
    quitPreparation = prepareWindowWorkbenchForQuit(window).then(() => { quitting = true; result.quitPrepared = true })
  }, () => quitting)
  window.webContents.forcefullyCrashRenderer()
  await waitFor(() => window.webContents.isCrashed())
  await waitFor(() => completedNotices > 0)
  assert.equal(result.notices.length, 1)
  assert.equal(result.reloadRequests, 0, 'Cancel must not reload the original workbench')
  assert.equal(result.quitRequests, 0)
  // Dead Renderer must no longer be a prerequisite for ordinary Quit.
  await prepareWindowWorkbenchForQuit(window)
  assert.equal(result.saveRequests, 0, 'A dead Renderer must not be asked for JavaScript persistence')
  action = 0
  const loaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve))
  const view = applicationMenuTemplate(true, undefined, () => { void recover() }).find(item => item.label === 'View')
  const recoveryItem = view.submenu.find(item => item.label === 'Recover interface')
  assert.ok(recoveryItem)
  recoveryItem.click()
  await loaded
  await recover()
  assert.equal(result.reloadRequests, 1)
  result.after = await readWorkbench()
  result.restoredExistingWorkbench = await window.webContents.executeJavaScript('window.__restoredExistingWorkbench')
  assert.equal(result.restoredExistingWorkbench, true, 'Reload must read retained state, not recreate the seed')
  assert.equal(result.after, result.before)
  action = 1
  window.webContents.forcefullyCrashRenderer()
  await waitFor(() => result.quitRequests === 1)
  await quitPreparation
  assert.equal(result.quitPrepared, true)
  finish(0)
}).catch(error => { result.error = String(error.stack || error); finish(1) })
`)

async function run(name, compiledName, stateName, mode) {
  const directory = join(output, name)
  await mkdir(directory, { recursive: true })
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(requireDesktop('electron'), [harness, join(output, compiledName, 'compiled'), page, directory, join(output, stateName), mode], {
    cwd: repository, env: environment, stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', data => { log += data })
  child.stderr.on('data', data => { log += data })
  const code = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      void writeFile(join(directory, 'electron.log'), log)
      child.kill('SIGKILL')
      reject(new Error('Private crash proof exceeded its bound; stdout/stderr saved in ' + directory))
    }, 20000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); resolveExit(code) })
  })
  await writeFile(join(directory, 'electron.log'), log)
  return { code, ...JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')) }
}

const green = await run('green', 'green', 'retained-user-data', process.argv.includes('--native') ? 'native' : 'mutation')
assert.equal(green.code, 0, JSON.stringify(green))
assert.equal(green.before, green.after)
const restart = await run('new-process-restart', 'green', 'retained-user-data', 'restart')
assert.equal(restart.code, 0, JSON.stringify(restart))
assert.equal(restart.before, green.before)
const red = []
for (const mutation of mutations.slice(1)) {
  const result = await run(mutation.name, mutation.name, mutation.name + '-state', 'mutation')
  assert.equal(result.code, 1, `${mutation.name} must reject the broken behavior: ${JSON.stringify(result)}`)
  red.push({ mutation: mutation.name, result })
}
const restored = await run('exact-restore-green', 'green', 'retained-user-data', 'mutation')
assert.equal(restored.code, 0, JSON.stringify(restored))
for (const [name, file] of Object.entries(sources)) assert.equal(await readFile(file, 'utf8'), original[name], `${file} was changed during proof`)
await writeFile(join(output, 'receipt.json'), JSON.stringify({
  schema: 'agentmux.renderer-crash-recovery-proof.v1', passed: true,
  sourceSHA256: Object.fromEntries(Object.entries(original).map(([name, text]) => [name, createHash('sha256').update(text).digest('hex')])),
  productCallers: ['apps/desktop/src/main/index.ts'], green, restart, red, restored,
  boundary: 'Real isolated Electron Renderer crashes, Main/native recovery notice, reload and a new process retaining nonempty localStorage. No user Runtime or Session is contacted. Real AgentMux workbench recovery and healthy Run preservation are consumed separately by Root; native screenshot requires independent review.'
}, null, 2) + '\n')
console.log(`Renderer crash recovery passed with four rejected mutations. Evidence: ${join(output, 'receipt.json')}`)
