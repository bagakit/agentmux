import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { runProbeProcess, listProbeProcesses, signalOwnedProbeProcess } from './probe-process.mjs'
import { aliases, desktopRequire } from './fixtures/conversation-style-entry/environment.mjs'

const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const fixture = join(desktop, 'scripts/fixtures/capsule-address')
const require = createRequire(join(desktop, 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const { build: bundle, transform } = createRequire(require.resolve('vite/package.json'))('esbuild')
let output = '.bagakit/feature-tracker/plans/capsule-links-and-browser-address/native-address', receiptOnly = false, preflight = false
for (let index = 2; index < process.argv.length; index++) {
  const option = process.argv[index]
  if (option === '--receipt') receiptOnly = true
  else if (option === '--preflight') preflight = true
  else { assert.equal(option, '--output', 'Unknown native Capsule address argument'); output = process.argv[++index]; assert.ok(output && !output.startsWith('--')) }
}
const evidence = resolve(root, output), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const ownedSources = [
  'apps/desktop/src/main/browser-view-manager.ts', 'apps/desktop/src/main/browser-cold-descriptor.ts',
  'apps/desktop/src/main/capsule-presentation.ts', 'apps/desktop/src/main/spatial-link-ingress.ts',
  'apps/desktop/src/main/control-ipc-bridge.ts',
  'packages/core/src/spatial-state.ts',
  'apps/desktop/src/main/workspace-files.ts', 'apps/desktop/src/main/bookmark-file.ts',
  'apps/desktop/src/main/browser-input-history.ts', 'apps/desktop/resources/bin/agentmux-workspace-move',
  'apps/desktop/src/main/native-overlay-surfaces.ts', 'apps/desktop/src/shared/browser-object-link.ts',
  'apps/desktop/src/shared/bookmark-file.ts', 'apps/desktop/src/shared/contracts.ts',
  'apps/desktop/src/preload/index.ts', 'apps/desktop/src/preload/capsule.ts',
  'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/components/BrowserPane.tsx',
  'apps/desktop/src/renderer/src/components/BrowserWorkfaceBoundary.tsx', 'apps/desktop/src/renderer/src/components/BrowserRecoverySurface.tsx',
  'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx', 'apps/desktop/src/renderer/src/components/FileExplorer.tsx',
  'apps/desktop/src/renderer/src/lib/workbench-persistence.ts', 'apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts',
  'apps/desktop/src/renderer/src/lib/browser-state.ts',
  'apps/desktop/src/renderer/src/styles/index.css', 'apps/desktop/src/renderer/src/styles/browser.css',
  'packages/capsule/src/node.ts', 'packages/capsule/src/http.ts', 'packages/capsule/src/storage.ts',
  ...['capsule', 'relay', 'git', 'diagnostic-evidence', 'native-desktop'].map(name => 'packages/' + name + '/package.json'),
  'packages/core/src/sharing.ts', 'packages/core/src/browser-targets.ts', 'packages/core/src/control-browser-targets.ts',
  ...['entry.tsx', 'main.ts', 'preload.ts', 'bootstrap.cjs', 'index.html'].map(file => 'apps/desktop/scripts/fixtures/capsule-address/' + file),
  'apps/desktop/scripts/verify-capsule-address-native.mjs', 'apps/desktop/scripts/probe-process.mjs',
  'apps/desktop/scripts/fixtures/conversation-style-entry/environment.mjs', 'apps/desktop/scripts/fixtures/settings-resource-library/environment.mjs',
  ...['package.json', 'apps/desktop/package.json', 'apps/host/package.json', ...['core', 'client-ui', 'identity', 'layout', 'demand'].map(name => 'packages/' + name + '/package.json')], 'pnpm-lock.yaml'
]
const bindings = async () => Object.fromEntries(await Promise.all(ownedSources.map(async file => [file, hash(await readFile(join(root, file)))])))
const sources = await bindings(), sourceDigest = hash(JSON.stringify(sources))
const environmentIdentity = { node: process.version, platform: process.platform, arch: process.arch, nodeExecutable: process.execPath, electronExecutable: require('electron'),
  electron: require('electron/package.json').version, vite: require('vite/package.json').version,
  esbuild: createRequire(require.resolve('vite/package.json'))('esbuild/package.json').version }
if (preflight) {
  for (const file of ['entry.tsx', 'main.ts', 'preload.ts']) await transform(await readFile(join(fixture, file), 'utf8'), { loader: file.endsWith('tsx') ? 'tsx' : 'ts', jsx: 'automatic' })
  assert.ok(ownedSources.length > 0)
  console.log(JSON.stringify({ passed: true, scope: 'syntax-and-nonempty-inputs-only', sourceDigest, files: ownedSources.length }))
  process.exit(0)
}
if (receiptOnly) {
  const receipt = JSON.parse(await readFile(join(evidence, 'receipt.json'), 'utf8'))
  assert.equal(receipt.schema, 'agentmux.capsule-address-native.v1'); assert.equal(receipt.passed, true)
  assert.deepEqual(receipt.sources, sources); assert.equal(receipt.sourceDigest, sourceDigest)
  assert.deepEqual(receipt.environmentIdentity, environmentIdentity)
  assert.ok(Object.keys(receipt.actualInputs ?? {}).length > 0, 'A reusable receipt must retain its actual nonempty build and runtime input graph')
  for (const [path, digest] of Object.entries(receipt.actualInputs)) assert.equal(hash(await readFile(path)), digest, 'Actual consumed input changed: ' + path)
  for (const kind of ['renderer', 'native', 'preload', 'capsulePreload']) assert.ok(receipt.inputGraphs[kind]?.length > 0, 'A reusable receipt must retain the original ' + kind + ' module inputs')
  assert.equal(receipt.processes.length, 2); assert.notEqual(receipt.processes[0].native.pid, receipt.processes[1].native.pid)
  assert.equal(receipt.processes[1].native.durable.passed, true); assert.equal(receipt.processes[1].native.createdCapsules, 0)
  for (const process of receipt.processes) {
    assert.equal(process.native.passed, true); assert.equal(process.outcome.exitCode, 0)
    assert.equal(process.native.attemptId, receipt.attemptId); assert.equal(process.native.phase, process.phase)
    assert.equal(process.native.pid, process.outcome.originalPid); assert.equal(process.outcome.timedOut, false); assert.equal(process.outcome.interruption, null)
    const original = await readFile(join(evidence, process.report))
    assert.equal(hash(original), process.reportSha256); assert.deepEqual(JSON.parse(original), process.native)
    assert.equal(hash(await readFile(join(evidence, process.log))), process.logSha256)
  }
  assert.ok(receipt.frames.length >= 5)
  for (const frame of receipt.frames) {
    assert.equal(hash(await readFile(join(evidence, frame.file))), frame.sha256)
    assert.equal(hash(await readFile(join(evidence, frame.root.file))), frame.root.sha256)
    assert.ok(frame.method.includes('Not an OS screenshot'))
    for (const layer of frame.layers) assert.equal(hash(await readFile(join(evidence, layer.file))), layer.sha256)
  }
  assert.deepEqual(receipt.cleanup.remaining, []); assert.equal(receipt.cleanup.rootRemoved, true)
  console.log(JSON.stringify({ passed: true, reused: true, receipt: join(evidence, 'receipt.json'), attemptId: receipt.attemptId,
    scope: 'read-only-current-proof', sourceDigest, evidence, frames: receipt.frames.length }))
  process.exit(0)
}
await mkdir(evidence, { recursive: true }); await mkdir(join(root, '.tmp'), { recursive: true })
const temporary = await mkdtemp(join(root, '.tmp/capsule-address-private-')), profile = join(temporary, 'profile'), workspace = join(temporary, 'workspace'), out = join(temporary, 'renderer')
const attemptId = randomUUID()
const report = { schema: 'agentmux.capsule-address-native.v1', attemptId, passed: false, sourceDigest, sources, evidence,
  loaded: {}, styles: {}, processes: [], frames: [], userRunTouched: false, environmentIdentity,
  actualInputs: {}, inputGraphs: { renderer: [], native: [], preload: [], capsulePreload: [] },
  boundary: 'Two private ordinary Electron processes read one Capsule state directory, the same original AgentMuxSpatialStateStore document and actual Chromium workbench/storage records. Production Store.initialize/executeControl/openFile/saveBrowserBookmark, WorkspaceWorkbench/BrowserPane/FileExplorer, formal styles/preload, WorkspaceFiles, DesktopControlIpcBridge and its formal request/response channels, SpatialLinkIngress, capsulePresentation, BrowserViewManager and NodeCapsuleOwner HTTP are real. Config/provider/empty Notes discovery are private adapters. The private Shell installs the original App presentation reader/commit seam for its actual loading/overlay facts; presentation still comes from production DOM measurements. No focus/open receipts are synthesized. CDP mouse/keyboard drives actual controls and native page inputs in a hidden window. This does not prove OS first-press focus, installed App identity, remote Host routing or ctxmux service-Run recovery.' }
const inputPackageManifests = new Set()
async function bindInput(path, graph) {
  if (!path || path.includes('\0') || path.includes('?')) return
  path = resolve(root, path)
  let bytes
  try { bytes = await readFile(path) } catch (error) { if (error.code === 'ENOENT' || error.code === 'EISDIR') return; throw error }
  const digest = hash(bytes)
  if (Object.hasOwn(report.actualInputs, path)) assert.equal(report.actualInputs[path], digest, 'An actual input changed during build: ' + path)
  report.actualInputs[path] = digest
  if (graph && !report.inputGraphs[graph].includes(path)) report.inputGraphs[graph].push(path)
  const marker = path.lastIndexOf('/node_modules/')
  if (marker >= 0) {
    const parts = path.slice(marker + '/node_modules/'.length).split('/'), count = parts[0].startsWith('@') ? 2 : 1
    const manifest = path.slice(0, marker + '/node_modules/'.length) + parts.slice(0, count).join('/') + '/package.json'
    if (!inputPackageManifests.has(manifest)) { inputPackageManifests.add(manifest); await bindInput(manifest) }
  }
}
async function bindMetafile(result, graph) { assert.ok(Object.keys(result.metafile.inputs).length > 0); for (const path of Object.keys(result.metafile.inputs)) await bindInput(path, graph) }
const server = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end('<!doctype html><title>Independent external page</title><style>body{background:#eff3f8;color:#283d59;font:20px system-ui;padding:48px}</style><h1>An external page</h1><p>This document is not the Capsule, even inside its retained isolated container.</p>') })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const externalUrl = `http://127.0.0.1:${server.address().port}/external`
const nativeWorkspaceAliases = new Map()
for (const name of ['capsule', 'relay', 'git', 'diagnostic-evidence', 'native-desktop']) {
  const manifest = JSON.parse(await readFile(join(root, 'packages', name, 'package.json'), 'utf8'))
  for (const [key, value] of Object.entries(manifest.exports)) {
    const target = typeof value === 'string' ? value : value.import
    nativeWorkspaceAliases.set('@agentmux/' + name + (key === '.' ? '' : key.slice(1)), join(root, 'packages', name, target.replace('./dist/src/', './src/').replace('./dist/', './src/').replace(/\.js$/u, '.ts')))
  }
}
const resolveAlias = path => { const alias = aliases.find(alias => alias.find.test(path)); return alias ? path.replace(alias.find, alias.replacement) : nativeWorkspaceAliases.get(path) ?? null }
try {
  for (const path of ownedSources) await bindInput(path)
  for (const path of [process.execPath, require('electron'), require.resolve('electron'), require.resolve('electron/package.json'), require.resolve('vite/package.json'), createRequire(require.resolve('vite/package.json')).resolve('esbuild/package.json')]) await bindInput(path)
  await mkdir(profile); await mkdir(workspace); await mkdir(join(temporary, 'out/main'), { recursive: true }); await mkdir(join(temporary, 'out/preload'))
  await mkdir(join(temporary, 'resources/bin'), { recursive: true })
  await copyFile(join(desktop, 'resources/bin/agentmux-workspace-move'), join(temporary, 'resources/bin/agentmux-workspace-move'))
  await symlink(join(desktop, 'node_modules'), join(temporary, 'node_modules'), 'dir')
  // NodeCapsuleOwner's native lock library is loaded through its own createRequire.
  // Resolve that one exact production dependency without changing a shared install.
  await symlink(join(root, 'packages/capsule/node_modules'), join(temporary, 'out/main/node_modules'), 'dir')
  const rendererFiles = new Set()
  const buildRenderer = async () => {
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' },
    resolve: { alias: [{ find: /^jsonc-parser$/, replacement: join(dirname(desktopRequire.resolve('jsonc-parser/package.json')), 'lib/esm/main.js') }, ...aliases] },
    define: { 'process.env.NODE_ENV': '"production"', __AGENTMUX_WEB_PREVIEW__: 'false' }, esbuild: { jsx: 'automatic' },
    plugins: [{ name: 'exact-production-capsule-address-inputs', enforce: 'pre',
      transform(bytes, id) { if (id.includes('?')) return; const path = relative(root, id); if (Object.hasOwn(sources, path)) { assert.equal(hash(bytes), sources[path]); report.loaded[path] = hash(bytes); rendererFiles.add(path) } },
      async generateBundle() { for (const path of this.getWatchFiles()) { await bindInput(path, 'renderer'); if (path.endsWith('.css')) { const name = relative(root, path); if (Object.hasOwn(sources, name)) { const bytes = await readFile(path); assert.equal(hash(bytes), sources[name]); report.styles[name] = hash(bytes) } } } }
    }], build: { outDir: out, emptyOutDir: true, minify: false } })
    for (const file of ownedSources.filter(file => file.includes('/renderer/src/') && !file.endsWith('.css'))) assert.ok(rendererFiles.has(file), 'Actual Renderer build must consume ' + file)
    for (const file of ['apps/desktop/src/renderer/src/styles/index.css', 'apps/desktop/src/renderer/src/styles/browser.css']) assert.equal(report.styles[file], sources[file])
  }
  const native = join(temporary, 'out/main/native.mjs'), nativeLoaded = new Set()
  const nativeBuild = await bundle({ entryPoints: [join(fixture, 'main.ts')], outfile: native, bundle: true, metafile: true, platform: 'node', format: 'esm',
    banner: { js: "import {createRequire as nativeFixtureRequire} from 'node:module';const require=nativeFixtureRequire(import.meta.url);" }, external: ['electron'], logLevel: 'error',
    plugins: [{ name: 'exact-native-capsule-address-inputs', setup(builder) {
      builder.onResolve({ filter: /^@agentmux\// }, ({ path, importer }) => {
        const target = resolveAlias(path)
        assert.ok(target, 'The fixture must resolve the exact workspace export: ' + path + ' from ' + importer)
        return { path: target }
      })
      builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => { const file = relative(root, path); if (!Object.hasOwn(sources, file)) return; const contents = await readFile(path, 'utf8'); assert.equal(hash(contents), sources[file]); nativeLoaded.add(file); return { contents, loader: path.endsWith('tsx') ? 'tsx' : 'ts', resolveDir: dirname(path) } })
    } }] })
  await bindMetafile(nativeBuild, 'native')
  for (const file of ['apps/desktop/src/main/browser-view-manager.ts', 'apps/desktop/src/main/browser-cold-descriptor.ts', 'apps/desktop/src/main/capsule-presentation.ts', 'apps/desktop/src/main/spatial-link-ingress.ts', 'apps/desktop/src/main/workspace-files.ts', 'packages/capsule/src/node.ts']) assert.ok(nativeLoaded.has(file), 'Actual native build must consume ' + file)
  const preloadAliases = { name: 'portable-production-preload-exports', setup(builder) {
    builder.onResolve({ filter: /^@agentmux\// }, ({ path }) => { const target = resolveAlias(path); assert.ok(target, 'An exact preload workspace export is required: ' + path); return { path: target } })
  } }
  await bindMetafile(await bundle({ entryPoints: [join(fixture, 'preload.ts')], outfile: join(temporary, 'preload.cjs'), bundle: true, metafile: true, platform: 'browser', format: 'cjs', external: ['electron'], plugins: [preloadAliases], logLevel: 'error' }), 'preload')
  await bindMetafile(await bundle({ entryPoints: [join(desktop, 'src/preload/capsule.ts')], outfile: join(temporary, 'out/preload/capsule.cjs'), bundle: true, metafile: true, platform: 'browser', format: 'cjs', external: ['electron'], plugins: [preloadAliases], logLevel: 'error' }), 'capsulePreload')
  await buildRenderer()
  const compiled = {}
  for (const file of await readdir(out, { recursive: true, withFileTypes: true })) if (file.isFile()) { const path = join(file.parentPath, file.name); compiled['renderer/' + relative(out, path)] = hash(await readFile(path)) }
  Object.assign(compiled, { 'main/native.mjs': hash(await readFile(native)), 'preload.cjs': hash(await readFile(join(temporary, 'preload.cjs'))), 'preload/capsule.cjs': hash(await readFile(join(temporary, 'out/preload/capsule.cjs'))), 'resources/bin/agentmux-workspace-move': hash(await readFile(join(temporary, 'resources/bin/agentmux-workspace-move'))) })
  assert.ok(Object.keys(compiled).length > 0)
  report.compiled = compiled; report.nativeLoaded = [...nativeLoaded]
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('AGENTMUX_') && !name.startsWith('CTXMUX_') && !['ELECTRON_RUN_AS_NODE', 'CODEX_HOME', 'CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID'].includes(name)))
  environment.HOME = join(profile, 'home'); environment.TMPDIR = temporary
  for (const phase of ['capture', 'restart']) {
    await rm(join(evidence, phase + '-native.json'), { force: true })
    const lines = [], outcome = await runProbeProcess(require('electron'), [join(fixture, 'bootstrap.cjs'), native, join(out, 'index.html'), profile, evidence, phase, workspace, externalUrl, attemptId],
      { cwd: root, env: environment, temporaryRoot: temporary, timeoutMs: 180000, onLine: line => { lines.push(line); if (line.startsWith('CAPSULE_ADDRESS ')) console.log(line) } })
    const log = phase + '.log'; await writeFile(join(evidence, log), lines.join('\n'))
    const file = phase + '-native.json', bytes = await readFile(join(evidence, file), 'utf8').catch(() => null)
    const process = { phase, outcome, log, logSha256: hash(await readFile(join(evidence, log))), report: file }
    report.processes.push(process)
    assert.ok(bytes, 'The exact private Electron process must retain its complete result: ' + JSON.stringify(outcome))
    const nativeReport = JSON.parse(bytes); Object.assign(process, { native: nativeReport, reportSha256: hash(bytes) })
    assert.equal(nativeReport.attemptId, attemptId); assert.equal(nativeReport.phase, phase); assert.equal(nativeReport.pid, outcome.originalPid)
    assert.equal(outcome.timedOut, false); assert.equal(outcome.interruption, null)
    assert.equal(outcome.exitCode, 0, nativeReport.failure?.message); assert.equal(nativeReport.passed, true)
    assert.equal(nativeReport.loaded.mainSha256, compiled['main/native.mjs']); assert.equal(nativeReport.loaded.rendererHtmlSha256, compiled['renderer/index.html'])
    assert.equal(nativeReport.loaded.preloadSha256, compiled['preload.cjs'])
    assert.equal(nativeReport.remainingWindows, 0); assert.deepEqual(nativeReport.cleanup, [])
    assert.equal(nativeReport.executionEnvironment.electron, environmentIdentity.electron)
    assert.ok(Object.keys(nativeReport.externalInputs).some(path => path.includes('fs-native-extensions')))
    for (const [path, digest] of Object.entries(nativeReport.externalInputs)) { await bindInput(path); assert.equal(report.actualInputs[path], digest) }
    for (const frame of nativeReport.frames) report.frames.push({ ...frame, sha256: hash(await readFile(join(evidence, frame.file))), root: { ...frame.root, sha256: hash(await readFile(join(evidence, frame.root.file))) },
      layers: await Promise.all(frame.layers.map(async layer => ({ ...layer, sha256: hash(await readFile(join(evidence, layer.file))) }))) })
  }
  assert.notEqual(report.processes[0].native.pid, report.processes[1].native.pid)
  assert.equal(report.processes[1].native.createdCapsules, 0); assert.equal(report.processes[1].native.durable.passed, true)
  assert.ok(report.frames.some(frame => frame.name === 'normal-dark') && report.frames.some(frame => frame.name === 'normal-light') && report.frames.some(frame => frame.name === 'narrow-dark') && report.frames.some(frame => frame.name === 'narrow-light'))
  assert.deepEqual(await bindings(), sources, 'The candidate cannot change during the exact native proof')
  for (const [path, digest] of Object.entries(report.actualInputs)) assert.equal(hash(await readFile(path)), digest, 'An actual consumed input changed during native proof: ' + path)
  for (const path of ['apps/desktop/src/renderer/src/components/BrowserAddressInput.tsx', 'apps/desktop/src/renderer/src/hooks/useNativeOverlayChrome.ts', 'apps/desktop/src/renderer/src/lib/browser-state.ts']) assert.ok(report.inputGraphs.renderer.includes(join(root, path)))
  for (const path of ['apps/desktop/src/main/control-ipc-bridge.ts', 'apps/desktop/src/main/browser-input-history.ts']) assert.ok(report.inputGraphs.native.includes(join(root, path)))
  report.passed = true
} catch (error) { report.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  const errors = []
  try { for (const pid of await listProbeProcesses(-1, temporary)) try { await signalOwnedProbeProcess(pid, temporary, 'SIGKILL') } catch (error) { errors.push(String(error)) } } catch (error) { errors.push(String(error)) }
  report.cleanup = { remaining: await listProbeProcesses(-1, temporary).catch(error => { errors.push(String(error)); return ['unknown'] }), rootRemoved: false, errors }
  try { await rm(temporary, { recursive: true, force: true }); report.cleanup.rootRemoved = true } catch (error) { errors.push(String(error)) }
  try { await new Promise(resolve => server.close(resolve)) } catch (error) { errors.push(String(error)) }
  if (errors.length || report.cleanup.remaining.length) report.passed = false
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, evidence, sourceDigest, failure: report.failure ?? null, cleanup: report.cleanup }))
  process.exitCode = report.passed ? 0 : 1
}
