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
const renderer = resolve(process.argv[2] ?? join(desktop, 'out/renderer/index.html'))
const output = join(repository, '.tmp/sandboxed-preload-proof', `attempt-${Date.now()}`)
const digest = value => createHash('sha256').update(value).digest('hex')
const source = await readFile(join(desktop, 'src/preload/index.ts'), 'utf8')
await mkdir(output, { recursive: true })
const { build } = await import(pathToFileURL(requireDesktop.resolve('vite')).href)
await build({
  configFile: false,
  logLevel: 'error',
  build: {
    target: 'node22', outDir: join(output, 'compiled'), emptyOutDir: true, minify: false,
    lib: {
      entry: {
        preload: join(desktop, 'src/preload/index.ts'),
        security: join(desktop, 'src/main/window-security.ts')
      },
      formats: ['cjs']
    },
    rollupOptions: { external: ['electron', /^node:/], output: { entryFileNames: '[name].cjs' } }
  }
})
const compiled = await readFile(join(output, 'compiled/preload.cjs'), 'utf8')
// Mutate the compiled artifact, never the shared source or a user installation.
await writeFile(join(output, 'mutant.cjs'), `require('node:crypto');\n${compiled}`)
const harness = join(output, 'harness.cjs')
await writeFile(harness, `
const { app, BrowserWindow, ipcMain } = require('electron')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { windowSecurityWebPreferences } = require(${JSON.stringify(join(output, 'compiled/security.cjs'))})
const [preload, renderer, directory] = process.argv.slice(2)
app.setPath('userData', join(directory, 'user-data'))
app.setName('AgentMux Sandbox Verification')
const result = { readyTokens: [], preloadErrors: [], consoleErrors: [], observerIds: [], releasedIds: [] }
let settled = false
const finish = code => {
  if (settled) return
  settled = true
  writeFileSync(join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\\n')
  app.exit(code)
}
setTimeout(() => { result.timeout = true; finish(2) }, 12000)
ipcMain.handle('ui:rendererUpdateReady', (_event, token) => { result.readyTokens.push(token) })
// Workspace recovery stays pending. The mounted interface must be ready independently of it.
for (const channel of ['config:get', 'sessions:snapshot', 'providers:list', 'demands:list'])
  ipcMain.handle(channel, () => new Promise(() => {}))
ipcMain.handle('ui:setAgentAttentionCount', () => {})
ipcMain.handle('ui:publishNativeOverlays', () => ({ warnings: [] }))
ipcMain.handle('toolkit:observe', (_event, id) => { result.observerIds.push(id) })
ipcMain.handle('toolkit:release', (_event, id) => { result.releasedIds.push(id) })
app.whenReady().then(async () => {
  const preferences = windowSecurityWebPreferences(preload)
  result.preferences = preferences
  const window = new BrowserWindow({ show: false, width: 1480, height: 940, webPreferences: preferences })
  window.webContents.on('preload-error', (_event, path, error) => result.preloadErrors.push({ path, message: String(error) }))
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) result.consoleErrors.push(message) })
  window.webContents.on('did-fail-load', (_event, code, description) => { result.loadError = { code, description } })
  await window.loadFile(renderer, { query: { 'renderer-update': 'sandbox-verification' } })
  for (let attempt = 0; attempt < 200 && !result.readyTokens.length && !result.preloadErrors.length; attempt++)
    await new Promise(resolve => setTimeout(resolve, 25))
  result.dom = await window.webContents.executeJavaScript(
    "({bridge:typeof window.agentmux,rootChildren:document.getElementById('root')?.children.length,loading:!!document.querySelector('[data-loading-scope=app]')})")
  if (result.dom.bridge === 'object') {
    await window.webContents.executeJavaScript('window.__sandboxObserver=window.agentmux.toolkit.observe(() => {}); true')
    for (let attempt = 0; attempt < 40 && !result.observerIds.length; attempt++)
      await new Promise(resolve => setTimeout(resolve, 25))
    await window.webContents.executeJavaScript('window.__sandboxObserver.dispose(); true')
    for (let attempt = 0; attempt < 40 && !result.releasedIds.length; attempt++)
      await new Promise(resolve => setTimeout(resolve, 25))
    const image = await window.webContents.capturePage()
    writeFileSync(join(directory, 'startup.png'), image.toPNG())
  }
  finish(result.readyTokens.length ? 0 : 1)
}).catch(error => { result.error = String(error); finish(3) })
`)

async function run(name, preload) {
  const directory = join(output, name)
  await mkdir(directory)
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(requireDesktop('electron'), [harness, preload, renderer, directory], {
    cwd: repository, env: environment, stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', data => { log += data })
  child.stderr.on('data', data => { log += data })
  const code = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Isolated Electron verification did not finish')) }, 20000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', exitCode => { clearTimeout(timer); resolveExit(exitCode) })
  })
  await writeFile(join(directory, 'electron.log'), log)
  return { code, ...JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')) }
}

const green = await run('green', join(output, 'compiled/preload.cjs'))
assert.equal(green.code, 0, JSON.stringify(green))
assert.equal(green.preferences.sandbox, true)
assert.equal(green.preferences.contextIsolation, true)
assert.equal(green.preferences.nodeIntegration, false)
assert.deepEqual(green.preloadErrors, [])
assert.deepEqual(green.readyTokens, ['sandbox-verification'])
assert.equal(green.dom.bridge, 'object')
assert.ok(green.dom.rootChildren > 0)
assert.equal(green.dom.loading, true)
assert.equal(green.observerIds.length, 1)
assert.match(green.observerIds[0], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
assert.deepEqual(green.releasedIds, green.observerIds)
const mutant = await run('node-crypto-mutant', join(output, 'mutant.cjs'))
assert.equal(mutant.code, 1, JSON.stringify(mutant))
assert.deepEqual(mutant.readyTokens, [])
assert.equal(mutant.dom.bridge, 'undefined')
assert.equal(mutant.dom.rootChildren, 0)
assert.ok(mutant.preloadErrors.length > 0)
assert.match(mutant.preloadErrors[0].message, /module not found: node:crypto/)
assert.equal(await readFile(join(desktop, 'src/preload/index.ts'), 'utf8'), source, 'Product source changed during verification')
await writeFile(join(output, 'receipt.json'), JSON.stringify({
  schema: 'agentmux.sandboxed-preload-proof.v1', passed: true,
  sourceSHA256: digest(source), preloadSHA256: digest(compiled), renderer,
  green, mutant,
  boundary: 'Actual sandboxed Electron and bundled Renderer; isolated userData, pending recovery, no Runtime or real Session access.'
}, null, 2) + '\n')
console.log(`Sandboxed preload passed; Node-only dependency mutation rejected. Evidence: ${join(output, 'receipt.json')}`)
