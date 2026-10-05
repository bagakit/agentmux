import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const repository = resolve(import.meta.dirname, '../../..')
const desktop = join(repository, 'apps/desktop')
const requireDesktop = createRequire(join(desktop, 'package.json'))
const renderer = resolve(process.argv[2] ?? join(desktop, 'out/renderer/index.html'))
const output = join(repository, '.tmp/sandboxed-preload-proof', ("attempt-" + (globalThis.crypto.randomUUID()) + ""))
const digest = value => createHash('sha256').update(value).digest('hex')
const source = await readFile(join(desktop, 'src/preload/index.ts'), 'utf8')
const productionConfig = join(desktop, 'electron.vite.config.ts')
const configSource = await readFile(productionConfig, 'utf8')
const mainSourcePath = join(desktop, 'src/main/index.ts')
const mainSource = await readFile(mainSourcePath, 'utf8')
await mkdir(output, { recursive: true })
process.chdir(desktop)
const { build } = await import(pathToFileURL(requireDesktop.resolve('vite')).href)
const { resolveConfig } = await import(pathToFileURL(requireDesktop.resolve('electron-vite')).href)
const ts = requireDesktop('typescript')
const mainAst = ts.createSourceFile(mainSourcePath, mainSource, ts.ScriptTarget.Latest, true)
let loaderBody, readyBody
function findLoader(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(mainAst) === 'loadPackagedRenderer') loaderBody = node.initializer?.getText(mainAst)
  if (ts.isPropertyAssignment(node) && node.name.getText(mainAst) === 'onRendererUpdateReady') readyBody = node.initializer.getText(mainAst)
  ts.forEachChild(node, findLoader)
}
findLoader(mainAst)
assert.ok(loaderBody && readyBody, 'Main must wire the actual shared Renderer-ready loader and receipt consumer')
assert.ok(mainSource.includes('load: loadPackagedRenderer') && mainSource.includes('await loadPackagedRenderer(packagedRendererPath)'),
  'Normal startup and package smoke must consume the same loader')
const loaderSource = join(output, 'renderer-loader.ts')
await writeFile(loaderSource, `import { randomUUID } from 'node:crypto'
import { topFrameOrigin } from ${JSON.stringify(join(desktop, 'src/main/top-frame-navigation.ts'))}
export function rendererLoader(window: any) {
  let updateReady: { token: string; resolve: () => void } | null = null
  let appOrigin: unknown
  const probeQuery = undefined
  const loadPackagedRenderer = ${loaderBody}
  return { load: loadPackagedRenderer, onReady: ${readyBody} }
}\n`)
const consumed = new Map()
async function buildPreload(configFile, name) {
  // Use the presets and automatic dependency plugins used by electron-vite build.
  const resolved = await resolveConfig({ root: desktop, configFile, logLevel: 'error' }, 'build', 'production')
  assert.ok(resolved.config?.preload, 'Production preload target must exist')
  const result = await build({ ...resolved.config.preload,
    build: { ...resolved.config.preload.build, outDir: join(output, name), emptyOutDir: true } })
  const outputs = Array.isArray(result) ? result : [result]
  for (const item of outputs) for (const chunk of item.output ?? []) {
    if (chunk.type !== 'chunk') continue
    for (const id of Object.keys(chunk.modules)) {
      if (id.startsWith('\0') || id.includes('?')) continue
      consumed.set(id, digest(await readFile(id)))
    }
  }
  for (const id of resolved.configFileDependencies ?? []) consumed.set(id, digest(await readFile(id)))
  return join(output, name, 'index.cjs')
}
const candidatePreload = await buildPreload(productionConfig, 'compiled')
const mutantDirectory = join(output, 'mutant-config')
await mkdir(mutantDirectory)
for (const name of ['scripts', 'src', 'node_modules'])
  await symlink(join(desktop, name), join(mutantDirectory, name), 'dir')
assert.equal((configSource.match(/externalizeDeps: false/g) ?? []).length, 1,
  'Production sandbox preload must explicitly disable automatic dependency externalization')
const mutantConfig = configSource.replace('externalizeDeps: false', 'externalizeDeps: true')
const mutantConfigFile = join(mutantDirectory, 'electron.vite.config.ts')
await writeFile(mutantConfigFile, mutantConfig)
const mutantPreload = await buildPreload(mutantConfigFile, 'externalized')
await build({
  configFile: false,
  logLevel: 'error',
  build: {
    target: 'node22', outDir: join(output, 'security'), emptyOutDir: true, minify: false,
    lib: {
      entry: {
        security: join(desktop, 'src/main/window-security.ts'),
        loader: loaderSource
      },
      formats: ['cjs']
    },
    rollupOptions: { external: ['electron', /^node:/], output: { entryFileNames: '[name].cjs' } }
  }
})
const compiled = await readFile(candidatePreload, 'utf8')
const externalized = await readFile(mutantPreload, 'utf8')
const requires = text => [...text.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1])
assert.deepEqual([...new Set(requires(compiled))], ['electron'], 'Sandbox preload dependency closure must be bundled')
assert.ok(requires(externalized).includes('@agentmux/core/object-id'), 'Counterfactual must reproduce the actual externalized dependency')
const harness = join(output, 'harness.cjs')
await writeFile(harness, `
const { app, BrowserWindow, ipcMain } = require('electron')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { windowSecurityWebPreferences } = require(${JSON.stringify(join(output, 'security/security.cjs'))})
const { rendererLoader } = require(${JSON.stringify(join(output, 'security/loader.cjs'))})
const [preload, renderer, directory] = process.argv.slice(2)
app.setPath('userData', join(directory, 'user-data'))
app.setName('AgentMux Sandbox Verification')
const result = { readyTokens: [], preloadErrors: [], consoleErrors: [], observerIds: [], releasedIds: [] }
let settled = false
let loader
const finish = code => {
  if (settled) return
  settled = true
  writeFileSync(join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\\n')
  app.exit(code)
}
setTimeout(() => { result.timeout = true; finish(2) }, 12000)
ipcMain.handle('ui:rendererUpdateReady', (_event, token) => { result.readyTokens.push(token); loader.onReady(token) })
// Workspace recovery stays pending. The mounted interface must be ready independently of it.
for (const channel of ['config:get', 'sessions:snapshot', 'providers:list', 'demands:list'])
  ipcMain.handle(channel, () => new Promise(() => {}))
ipcMain.handle('ui:setAgentAttentionCount', () => {})
ipcMain.handle('ui:publishNativeOverlays', () => ({ warnings: [] }))
ipcMain.handle('toolkit:observe', (_event, toolId, id) => { result.observedToolId = toolId; result.observerIds.push(id) })
ipcMain.handle('toolkit:release', (_event, id) => { result.releasedIds.push(id) })
app.whenReady().then(async () => {
  const preferences = windowSecurityWebPreferences(preload)
  result.preferences = preferences
  const window = new BrowserWindow({ show: false, width: 1480, height: 940, webPreferences: preferences })
  window.webContents.on('preload-error', (_event, path, error) => result.preloadErrors.push({ path, message: String(error) }))
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) result.consoleErrors.push(message) })
  window.webContents.on('did-fail-load', (_event, code, description) => { result.loadError = { code, description } })
  loader = rendererLoader(window)
  const loading = loader.load(renderer).then(() => { result.readyPublished = true })
  loading.catch(error => { result.readyError = String(error) })
  for (let attempt = 0; attempt < 200 && !result.readyTokens.length && !result.preloadErrors.length; attempt++)
    await new Promise(resolve => setTimeout(resolve, 25))
  if (!result.preloadErrors.length) await loading
  result.dom = await window.webContents.executeJavaScript(
    "({bridge:typeof window.agentmux,rootChildren:document.getElementById('root')?.children.length,loading:!!document.querySelector('[data-loading-scope=app]')})")
  if (result.dom.bridge === 'object') {
    await window.webContents.executeJavaScript("window.__sandboxObserver=window.agentmux.toolkit.observe('sandbox-verification-tool', () => {}); true")
    for (let attempt = 0; attempt < 40 && !result.observerIds.length; attempt++)
      await new Promise(resolve => setTimeout(resolve, 25))
    await window.webContents.executeJavaScript('window.__sandboxObserver.dispose(); true')
    for (let attempt = 0; attempt < 40 && !result.releasedIds.length; attempt++)
      await new Promise(resolve => setTimeout(resolve, 25))
    const image = await window.webContents.capturePage()
    writeFileSync(join(directory, 'startup.png'), image.toPNG())
  }
  finish(result.readyPublished ? 0 : 1)
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

const green = await run('green', candidatePreload)
assert.equal(green.code, 0, JSON.stringify(green))
assert.equal(green.preferences.sandbox, true)
assert.equal(green.preferences.contextIsolation, true)
assert.equal(green.preferences.nodeIntegration, false)
assert.deepEqual(green.preloadErrors, [])
assert.equal(green.readyTokens.length, 1)
assert.equal(green.readyPublished, true)
assert.match(green.readyTokens[0], /^[0-9a-f-]{36}$/)
assert.equal(green.dom.bridge, 'object')
assert.ok(green.dom.rootChildren > 0)
assert.equal(green.dom.loading, true)
assert.equal(green.observerIds.length, 1)
assert.equal(green.observedToolId, 'sandbox-verification-tool')
assert.match(green.observerIds[0], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
assert.deepEqual(green.releasedIds, green.observerIds)
const mutant = await run('externalized-dependency-mutant', mutantPreload)
assert.equal(mutant.code, 1, JSON.stringify(mutant))
assert.deepEqual(mutant.readyTokens, [])
assert.notEqual(mutant.readyPublished, true, 'Broken preload must not publish package smoke readiness')
assert.equal(mutant.dom.bridge, 'undefined')
assert.equal(mutant.dom.rootChildren, 0)
assert.ok(mutant.preloadErrors.length > 0)
assert.match(mutant.preloadErrors[0].message, /module not found: @agentmux\/core\/object-id/)
assert.equal(await readFile(join(desktop, 'src/preload/index.ts'), 'utf8'), source, 'Product source changed during verification')
assert.equal(await readFile(productionConfig, 'utf8'), configSource, 'Production config changed during verification')
assert.equal(await readFile(mainSourcePath, 'utf8'), mainSource, 'Main ready producer changed during verification')
for (const [path, sha256] of consumed) assert.equal(digest(await readFile(path)), sha256, `Consumed source changed: ${path}`)
await writeFile(join(output, 'receipt.json'), JSON.stringify({
  schema: 'agentmux.sandboxed-preload-proof.v1', passed: true,
  sourceSHA256: digest(source), configSHA256: digest(configSource),
  mainSHA256: digest(mainSource), loaderSHA256: digest(await readFile(loaderSource)),
  mutantConfigSHA256: digest(mutantConfig), preloadSHA256: digest(compiled),
  mutantPreloadSHA256: digest(externalized), renderer,
  consumedSources: [...consumed].map(([path, sha256]) => ({ path, sha256 })),
  green, mutant,
  boundary: 'Actual sandboxed Electron and bundled Renderer; isolated userData, pending recovery, no Runtime or real Session access.'
}, null, 2) + '\n')
console.log(`Production sandboxed preload passed; externalized dependency mutation rejected. Evidence: ${join(output, 'receipt.json')}`)
