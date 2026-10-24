// Reuses the qualified endpoint-isolation native chain with task-local configuration and Map assertions.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'
import { prepareRemoteProofCandidate } from './remote-runtime-proof-candidate.mjs'

const desktop = path.resolve(import.meta.dirname, '..'), root = path.resolve(desktop, '../..')
const fixture = path.join(desktop, 'scripts/fixtures/remote-runtime-renderer')
const evidence = path.resolve(process.argv[2] ?? path.join(root, '.tmp/collaboration-map-restart', ("run-" + (globalThis.crypto.randomUUID()) + "")))
try { await fs.access(path.join(evidence, 'receipt.json')); throw Error('Restart evidence already exists; choose a new evidence directory: ' + evidence) }
catch (error) { if (error.code !== 'ENOENT') throw error }
const mapProfile = { boundary: 'polygon', levels: [
  { form: 'point', information: 'identity', from: .05, to: .05 },
  { form: 'compact', information: 'identity', from: .25, to: .46 },
  { form: 'compact', information: 'status', from: .48, to: .64 },
  { form: 'card', information: 'summary', from: .92, to: 1.12 },
] }
const require = createRequire(path.join(desktop, 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const electron = process.env.AGENTMUX_PROOF_ELECTRON_PATH ?? require('electron')
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmux-map-restart-'))
const hash = value => createHash('sha256').update(value).digest('hex')
const files = async directory => (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory()
  ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat()
const receipt = { schema: 'agentmux.collaboration-map-restart-native.v1', passed: false, phases: [], inputBefore: null, inputAfter: null,
  aestheticReview: 'not-performed', userAppRunTouched: false, mapProfileExpected: mapProfile, limitations: [] }
// Compile the existing native restart fixture with only private harness boundaries changed.
// Product App, Store, Map, Worker, Host, Core, PTY and configuration owners remain original.
const transforms = []
const replaceExactly = (source, before, after) => {
  assert.equal(source.split(before).length, 2, `The owned fixture anchor must remain unique: ${before.slice(0, 100)}`)
  return source.replace(before, after)
}
const extendFixture = { name: 'collaboration-restart-private-boundaries', enforce: 'pre', transform(source, id) {
  const file = id.split('?')[0]
  let next = source
  if (file === path.join(fixture, 'entry.mjs')) {
    next = replaceExactly(next, 'api.config.get = async () => setup.config', `api.config.get = async () => request('config-get')
api.config.save = async (next, expected) => request('config-save', next, expected)
api.config.onChange = listener => window.remoteProof.onConfigChange(listener)`)
    next += `\nwindow.remoteMapEnter = () => useAppStore.getState().openCollaborationMap()
window.remoteMapLeave = () => useAppStore.getState().setMainSurface('workbench')
window.remoteMapToggleMotion = () => document.querySelector('button[aria-label="Map animations"]').click()
window.remoteMapState = () => ({ mainSurface: useAppStore.getState().mainSurface, focusView: useAppStore.getState().focusView,
  preference: useAppStore.getState().config?.focus?.mapMotion, profile: useAppStore.getState().config?.focus?.map,
  canvas: Boolean(document.querySelector('.collaboration-canvas')),
  motion: document.querySelector('button[aria-label="Map animations"]')?.getAttribute('aria-pressed'),
  envelopes: [...document.querySelectorAll('.collaboration-area__envelope path')].map(node => node.getAttribute('d')),
  agents: [...document.querySelectorAll('[data-collaboration-agent]')].map(node => node.dataset.collaborationAgent) })
window.remoteMapSettingsState = () => {
  const page = document.querySelector('.settings-page[data-settings-page="focus"]:not([hidden])'), pane = page?.querySelector('.focus-settings')
  if (!pane) return null
  const field = label => pane.querySelector('[aria-label="' + label + '"]')
  return { targetFocused: document.activeElement === pane.querySelector('[data-settings-field="map"]'),
    boundary: pane.querySelector('input[name="focus-map-boundary"]:checked')?.closest('label')?.textContent.trim(),
    levels: [...pane.querySelectorAll('.focus-map-settings__levels > details')].map((_node, index) => ({
      form: field('Level ' + (index + 1) + ' form').value,
      information: field('Level ' + (index + 1) + ' information').value,
      from: index ? Number(field('Level ' + (index + 1) + ' start zoom').value) / 100 : .05,
      to: index ? Number(field('Level ' + (index + 1) + ' complete zoom').value) / 100 : .05,
    })), saveDisabled: pane.querySelector('[data-settings-save-bar] button').disabled,
    invalidDraft: Boolean(pane.querySelector('[role="alert"]')) }
}
window.remoteMapEdit = (label, value) => {
  const control = document.querySelector('.settings-page[data-settings-page="focus"]:not([hidden]) [aria-label="' + label + '"]')
  if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement)) throw Error('Missing original Map control: ' + label)
  const prototype = control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(control, value)
  control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  return true
}\n`
  }
  if (file === path.join(fixture, 'main.ts')) {
    next = replaceExactly(next, 'const config = recoveryInput?.config ?? defaultConfig', `const { ConfigStore } = await import('../../../src/main/config-store')
const { ConfigOwner } = await import('../../../src/main/config-owner')
const configStore = new ConfigStore(path.join(privateRoot, 'agentmux.config.json'))
// Only the first ordinary process seeds a new private profile. Restoration never replays it.
if (phase === 'seed') await configStore.save(defaultConfig as any)
let config = await configStore.get()
const configOwner = new ConfigOwner({ read: () => config, save: next => configStore.save(next), publish: saved => { config = saved; if (win && !win.isDestroyed()) win.webContents.send('agentmux:config-changed', saved) } })`)
    next = replaceExactly(next, "    case 'spatial-read': return spatial.read()", `    case 'config-get': return configOwner.current
    case 'config-save': return configOwner.edit(args[1], args[0])
    case 'spatial-read': return spatial.read()`)
    next = replaceExactly(next, "    await stage('prepare')", `    await stage('prepare')
    result.configLoaded = JSON.parse(JSON.stringify(config))
    result.calls = calls
    if (phase === 'restore') assert.deepEqual(result.configLoaded,
      JSON.parse(await fs.readFile(path.join(privateRoot, 'expected-config.json'), 'utf8')),
      'The original production ConfigStore must load the first generation publication without reseeding')`)
    // Notices and Hosts settings have their own original proof. This task is the exact restart + Map boundary.
    const begin = next.indexOf('    const beforeNotice = await state()')
    const end = next.indexOf('    const inputProbe =', begin)
    assert.ok(begin > 0 && end > begin)
    next = next.slice(0, begin) + next.slice(end)
    next = replaceExactly(next, '    result.saved = await state()', `    await stage('actual-focus-map')
    await win.webContents.executeJavaScript('window.remoteMapEnter(); true')
    await until('window.remoteMapState().canvas && window.remoteMapState().agents.length > 0 && window.remoteMapState().motion !== undefined', 30000)
    result.mapBefore = await win.webContents.executeJavaScript('window.remoteMapState()')
    if (phase === 'seed') {
      // Exercise the original Map control -> hook -> typed API -> ConfigOwner -> ConfigStore.
      if (result.mapBefore.motion === 'false') {
        await win.webContents.executeJavaScript('window.remoteMapToggleMotion(); true')
        await until('window.remoteMapState().preference === "on" && window.remoteMapState().motion === "true"')
      }
      await win.webContents.executeJavaScript('window.remoteMapToggleMotion(); true')
      await until('window.remoteMapState().preference === "off" && window.remoteMapState().motion === "false"')
    } else {
      assert.equal(result.mapBefore.preference, 'off', 'The second original Map consumes its saved motion preference')
      assert.equal(result.mapBefore.motion, 'false')
      assert.deepEqual(result.mapBefore.profile, ${JSON.stringify(mapProfile)}, 'The restored original Map consumes the exact custom profile')
      assert.equal(calls.filter(call => call.operation === 'config-save').length, 0, 'Restoration cannot reseed a preference')
    }
    // Use the original Map navigation, controls, Save action and publication.
    // The renderer helper only dispatches input events; it cannot write configuration.
    await win.webContents.executeJavaScript(${JSON.stringify('document.querySelector(\'button[aria-label="Map settings"]\').click(); true')})
    await until('window.remoteMapSettingsState()?.targetFocused')
    result.mapSettingsBefore = await win.webContents.executeJavaScript('window.remoteMapSettingsState()')
    const profileSaveCount = calls.filter(call => call.operation === 'config-save').length
    if (phase === 'seed') {
      await win.webContents.executeJavaScript('window.remoteMapEdit("LOD levels", "4")')
      await until('window.remoteMapSettingsState()?.levels.length === 4')
      await win.webContents.executeJavaScript(${JSON.stringify('[...document.querySelectorAll(\'.focus-settings input[name="focus-map-boundary"]\')].find(input => input.closest("label").textContent.trim() === "Polygon").click(); true')})
      await win.webContents.executeJavaScript('window.remoteMapEdit("Level 4 complete zoom", "112")')
      await until('window.remoteMapSettingsState()?.levels[3].to === 1.12')
      await win.webContents.executeJavaScript('window.remoteMapEdit("Level 4 start zoom", "92")')
      await until('window.remoteMapSettingsState()?.levels[3].from === .92 && window.remoteMapSettingsState()?.boundary === "Polygon" && !window.remoteMapSettingsState()?.saveDisabled')
      result.mapSettingsDraft = await win.webContents.executeJavaScript('window.remoteMapSettingsState()')
      assert.equal(result.mapSettingsDraft.invalidDraft, false)
      assert.deepEqual(result.mapSettingsDraft.levels, ${JSON.stringify(mapProfile.levels)})
      await win.webContents.executeJavaScript('document.querySelector(".focus-settings [data-settings-save-bar] button").click(); true')
      await until('window.remoteMapState().profile?.levels.length === 4 && window.remoteMapState().profile.levels[3].to === 1.12 && window.remoteMapSettingsState()?.saveDisabled')
      assert.equal(calls.filter(call => call.operation === 'config-save').length, profileSaveCount + 1, 'One original Save publishes the complete authored Map profile')
    } else {
      assert.equal(result.mapSettingsBefore.boundary, 'Polygon')
      assert.deepEqual(result.mapSettingsBefore.levels, ${JSON.stringify(mapProfile.levels)}, 'Restored settings read every original custom LOD field')
      assert.equal(result.mapSettingsBefore.saveDisabled, true, 'An unchanged deep Map profile is a clean draft')
      assert.equal(calls.filter(call => call.operation === 'config-save').length, 0)
    }
    result.mapSettings = await win.webContents.executeJavaScript('window.remoteMapSettingsState()')
    await capture(phase + '-map-settings.png')
    await win.webContents.executeJavaScript(${JSON.stringify('document.querySelector(\'button[aria-label="Close settings"]\').click(); true')})
    await until('document.querySelector(".settings-page")?.hidden === true && window.remoteMapState().canvas')
    await until('window.remoteMapState().envelopes.length > 0 && window.remoteMapState().envelopes.every(path => typeof path === "string" && /^M/.test(path) && /L/.test(path) && !/[CQ]/.test(path))')
    result.map = await win.webContents.executeJavaScript('window.remoteMapState()')
    assert.deepEqual(result.map.profile, ${JSON.stringify(mapProfile)})
    await capture(phase + '-map.png')
    await win.webContents.executeJavaScript('window.remoteMapLeave(); true')
    await until('window.remoteLiveReady() && window.remoteState().editor', 20000)
    result.configSaved = await configStore.get()
    await configStore.confirmSaved(result.configSaved)
    assert.deepEqual(result.configSaved.focus.map, ${JSON.stringify(mapProfile)}, 'The production ConfigStore confirms the entire custom Map profile')
    result.mapProfileSaveCalls = calls.filter(call => call.operation === 'config-save').slice(profileSaveCount)
    if (phase === 'seed') await fs.writeFile(path.join(privateRoot, 'expected-config.json'), JSON.stringify(result.configSaved))
    result.saved = await state()`)
  }
  if (next !== source) {
    transforms.push({ file: path.relative(root, file), originalSHA256: hash(source), effectiveSHA256: hash(next), boundary: 'Private fixture only; original product modules unmodified' })
    return next
  }
} }
const dependencySources = new Map()
const pinnedWorkspaceSources = { name: 'native-restart-pinned-workspace-sources', enforce: 'pre', async transform(code, id) {
  const file = id.split('?')[0]
  if (!file.includes('/node_modules/') && /\/(?:packages|apps)\/[^/]+\/(?:src|dist)\//.test(file) && !file.startsWith(root + '/'))
    throw Error('A shared dependency escaped the exact native candidate: ' + file)
  if (!file.startsWith(path.join(root, 'packages/connectors/src/'))) return
  const sourceSHA256 = hash(await fs.readFile(file)), previous = dependencySources.get(file)
  if (previous) assert.equal(previous.sourceSHA256, sourceSHA256, 'A consumed connector module changed during native compilation')
  dependencySources.set(file, { sourceSHA256, consumedCodeSHA256: hash(code), consumedVia: 'vite-transform-input' })
} }
const sourceAliases = [
  { find: /^@agentmux\/connectors$/, replacement: path.join(root, 'packages/connectors/src/index.ts') },
  { find: /^@agentmux\/connectors\/adapters\/(feishu|discord)$/, replacement: path.join(root, 'packages/connectors/src/adapters/$1/index.ts') },
  { find: /^@agentmux\/host\/host-configuration$/, replacement: path.join(root, 'apps/host/src/host-configuration.ts') },
  { find: /^@agentmux\/layout$/, replacement: path.join(root, 'packages/layout/src/index.ts') },
]
// The Desktop also consumes Host pure subpaths. Resolve its declared exports from
// this candidate rather than the independently changing shared workspace dist.
const hostManifest = JSON.parse(await fs.readFile(path.join(root, 'apps/host/package.json'), 'utf8'))
for (const [key, value] of Object.entries(hostManifest.exports)) {
  const target = typeof value === 'string' ? value : value.import
  const source = path.join(root, 'apps/host', target.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts'))
  assert.ok((await fs.stat(source)).isFile(), 'The declared Host export must have its exact candidate source: ' + key)
  const specifier = '@agentmux/host' + (key === '.' ? '' : key.slice(1))
  sourceAliases.push({ find: new RegExp('^' + specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), replacement: source })
}
const clientManifest = JSON.parse(await fs.readFile(path.join(root, 'packages/client-ui/package.json'), 'utf8'))
for (const [key, value] of Object.entries(clientManifest.exports).sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length)) {
  const target = typeof value === 'string' ? value : value.browser ?? value.types ?? value.import
  const specifier = '@agentmux/client-ui' + (key === '.' ? '' : key.slice(1))
  const pattern = specifier.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.*)')
  sourceAliases.push({ find: new RegExp('^' + pattern + '$'), replacement: path.join(root, 'packages/client-ui', target).replace('*', '$1') })
}
receipt.limitations = [
  'Current original App/Store/Map/Worker/SessionPane/TerminalView and production ConfigStore/ConfigOwner are compiled into an isolated native Electron profile.',
  'The Provider protocol is the repository CLI fixture; Session/Run/PTY, input, replay, Host and ctxmux survival are real public Core facts.',
  'The private workbench is seeded exactly once. The second real Electron PID loads Core spatial state, workbench localStorage and production configuration without reseeding.',
  'Actual Map motion and Map settings UI publish through the original typed API and production configuration owners. The second Map and original settings controls read the saved off motion and complete custom polygon/four-level profile; restoration performs zero config-save calls.',
  'Original Map polygon paths are checked after each generation. Public scalar discovery/setter behavior and full visual quality have separate owning gates.',
  'Host connector modules are compiled from the same worktree source; shared installed workspace dist cannot substitute another candidate.',
  'The transport IPC fixture replaces ordinary Desktop IPC registration. No user profile, existing Agent, active Run or current GUI is operated.',
  'This proves ordinary client process restart with a healthy independent Host/Run, not Host death, cold runtime loss, semantic Level B recovery, full package installation, aesthetics or terminal continuous-history performance.',
]
receipt.fixtureTransforms = transforms
receipt.candidate = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), scriptSHA256: hash(await fs.readFile(import.meta.filename)) }
let client, candidate, identities
await fs.mkdir(evidence, { recursive: true })
try {
  await fs.mkdir(path.join(privateRoot, 'workspace'), { recursive: true })
  await fs.mkdir(path.join(privateRoot, 'codex'), { recursive: true })
  await fs.mkdir(path.join(privateRoot, 'node_modules/@agentmux'), { recursive: true })
  candidate = await prepareRemoteProofCandidate({ root, privateRoot, proof: receipt })
  await fs.symlink(candidate.core, path.join(privateRoot, 'node_modules/@agentmux/core'))
  // Native Main's external npm imports borrow installed dependencies, without copying or installing them.
  receipt.borrowedNativeDependencies = {}
  for (const directory of [path.join(candidate.core, 'node_modules'), path.join(desktop, 'node_modules')]) {
    for (const entry of await fs.readdir(directory)) {
      if (entry.startsWith('.') || entry === '@agentmux') continue
      const target = path.join(privateRoot, 'node_modules', entry)
      try { await fs.lstat(target); continue } catch (error) { if (error.code !== 'ENOENT') throw error }
      const original = await fs.realpath(path.join(directory, entry))
      await fs.symlink(original, target); receipt.borrowedNativeDependencies[entry] = original
    }
  }
  await fs.copyFile(path.join(root, 'packages/core/test/fixtures/fake-codex-cli.mjs'), path.join(privateRoot, 'fake-codex-cli.mjs'))
  const preload = path.join(privateRoot, 'preload.cjs')
  const preloadSource = await fs.readFile(path.join(fixture, 'preload.cjs'), 'utf8')
  const privatePreload = replaceExactly(preloadSource, '  onSpatialChange: listener => {', `  onConfigChange: listener => {
    const receive = (_event, config) => listener(config)
    ipcRenderer.on('agentmux:config-changed', receive)
    return () => ipcRenderer.removeListener('agentmux:config-changed', receive)
  },
  onSpatialChange: listener => {`)
  await fs.writeFile(preload, privatePreload)
  transforms.push({ file: path.relative(root, path.join(fixture, 'preload.cjs')), originalSHA256: hash(preloadSource), effectiveSHA256: hash(privatePreload),
    boundary: 'Forward the original public configuration publication channel to the original App subscription' })
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error',
    plugins: [pinnedWorkspaceSources, extendFixture, candidate.capture],
    esbuild: { jsx: 'automatic' },
    worker: { format: 'es', plugins: () => [pinnedWorkspaceSources, candidate.capture] },
    css: { postcss: { plugins: [candidate.captureCss] } },
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"', __TERMINAL_WHEEL_UMD_URL__: '"unused"' },
    resolve: { alias: [...sourceAliases, { find: /^@xterm\/xterm$/, replacement: path.join(desktop, 'scripts/fixtures/terminal-wheel/xterm-instrumented.ts') }] },
    build: { target: 'esnext', outDir: path.join(privateRoot, 'renderer'), emptyOutDir: true } })
  await build({ configFile: false, root: fixture, logLevel: 'error',
    plugins: [pinnedWorkspaceSources, extendFixture, candidate.capture],
    resolve: { alias: sourceAliases },
    build: { ssr: path.join(fixture, 'main.ts'), target: 'node22', outDir: path.join(privateRoot, 'main'), emptyOutDir: true,
      rollupOptions: { external: ['electron', '@agentmux/core', /^@agentmux\/core\//], output: { format: 'es', entryFileNames: 'main.mjs', chunkFileNames: '[name]-[hash].js' } } } })
  await candidate.buildHost(options => {
    const external = options.build.rollupOptions.external
    // Discord's optional compression backend is absent here; preserve its optional import.
    return build({ ...options, plugins: [pinnedWorkspaceSources, ...options.plugins], resolve: { alias: sourceAliases },
      build: { ...options.build, rollupOptions: { ...options.build.rollupOptions,
        external: id => id === 'zlib-sync' || external(id) } } })
  })
  await candidate.seal()
  assert.ok(dependencySources.has(path.join(root, 'packages/connectors/src/index.ts')), 'The Host must consume its own worktree connector source')
  for (const [file, fact] of dependencySources) {
    assert.equal(hash(await fs.readFile(file)), fact.sourceSHA256, 'The compiled connector source remains the exact candidate')
    receipt.consumedModules[path.relative(root, file)] = fact
  }
  const requiredProductModules = [
    ...['App.tsx', 'store.ts',
      'components/AgentCollaborationGraph.tsx', 'components/AgentContextContent.tsx',
      'components/CollaborationCompactState.tsx', 'components/CollaborationRegionLabels.tsx',
      'components/FocusContextCardBody.tsx', 'components/FocusContextRow.tsx',
      'components/SettingsNavigation.tsx', 'components/SettingsPanel.tsx',
      'components/settings/FocusMapSettings.tsx', 'components/settings/FocusSettingsPane.tsx',
      'components/settings/FocusSettingsPreview.tsx', 'components/settings/use-setting-draft.ts',
      'lib/collaboration-layout.worker.ts', 'lib/collaboration-layout-engine.ts',
      'lib/collaboration-layout-refinement.ts', 'lib/use-collaboration-layout.ts',
      'lib/collaboration-map-transition.ts', 'lib/collaboration-map-preferences.ts',
      'lib/collaboration-map-lod.ts', 'lib/collaboration-map-camera.ts',
      'lib/collaboration-map-geometry.ts', 'lib/focus-preferences.ts',
      'styles/collaboration.css', 'styles/settings-focus.css',
    ].map(file => 'apps/desktop/src/renderer/src/' + file),
    ...['shared/focus-map-preferences.ts', 'shared/focus-preferences.ts', 'shared/config-edit.ts',
      'main/config-store.ts', 'main/config-owner.ts',
    ].map(file => 'apps/desktop/src/' + file),
  ]
  for (const file of requiredProductModules) assert.ok(receipt.consumedModules[file], 'The actual current product module must be compiled: ' + file)
  receipt.requiredProductModules = requiredProductModules
  identities = async () => ({ ...await candidate.identity(), ...Object.fromEntries(await Promise.all([
    ...await files(path.join(privateRoot, 'renderer')), ...await files(path.join(privateRoot, 'main')),
    preload, path.join(privateRoot, 'fake-codex-cli.mjs')
  ].map(async file => [path.relative(privateRoot, file), hash(await fs.readFile(file))]))) })
  receipt.compiledBytes = (await Promise.all([path.join(privateRoot, 'renderer'), path.join(privateRoot, 'main')].map(files))).flat()
  receipt.compiledBytes = (await Promise.all(receipt.compiledBytes.map(file => fs.stat(file)))).reduce((sum, item) => sum + item.size, 0)
  receipt.compiledInputs = await identities()
  receipt.inputBefore = receipt.compiledInputs
  const env = { ...process.env, HOME: path.join(privateRoot, 'home'), CODEX_HOME: path.join(privateRoot, 'codex'),
    XDG_CONFIG_HOME: path.join(privateRoot, 'xdg-config'), XDG_DATA_HOME: path.join(privateRoot, 'xdg-data'), XDG_CACHE_HOME: path.join(privateRoot, 'xdg-cache') }; delete env.ELECTRON_RUN_AS_NODE
  for (const phase of ['seed', 'restore']) {
    const phaseRoot = path.join(privateRoot, `phase-${phase}`); await fs.mkdir(phaseRoot)
    const stderr = []
    const exit = await runProbeProcess(electron, [path.join(privateRoot, 'main/main.mjs'), path.join(privateRoot, 'renderer/index.html'),
      privateRoot, phase, preload, evidence, process.execPath],
      { temporaryRoot: phaseRoot, cwd: root, env, timeoutMs: 60000, onLine: line => stderr.push(line) })
    await fs.writeFile(path.join(evidence, `${phase}-stderr.log`), stderr.join('\n'))
    receipt.launches ??= []; receipt.launches.push({ phase, exit })
    const native = JSON.parse(await fs.readFile(path.join(evidence, `${phase}.json`), 'utf8'))
    receipt.phases.push({ phase, exit, native })
    assert.equal(exit.timedOut, false); assert.equal(exit.exitCode, 0); assert.equal(native.passed, true, native.failure?.message)
    client ??= await candidate.connectLocalHost()
    const runs = (await client.listRuns()).filter(run => run.state === 'running')
    assert.equal(runs.length, 1, 'Exactly the owned healthy local Run remains')
    const current = runs.map(run => ({ runId: run.runId, pid: run.pid }))
    receipt.runObservations ??= []
    receipt.runObservations.push({ phase, facts: runs })
    if (phase === 'restore') assert.ok(runs[0].acceptedInputBytes > receipt.runObservations[0].facts[0].acceptedInputBytes, 'Original Run must accept fresh input from the restored process')
    const owner = client.runtimeOwnerIdentity()
    assert.ok(owner && Number.isSafeInteger(owner.processId) && owner.processId > 0)
    assert.notEqual(owner.processId, native.pid, 'The ordinary Electron generation is a client of the original Host')
    if (phase === 'seed') { receipt.originalRuns = current; receipt.originalHost = owner }
    else {
      assert.deepEqual(current, receipt.originalRuns); receipt.survivingRuns = current
      assert.deepEqual([owner.runtimeId, owner.ownerInstanceId, owner.processId],
        [receipt.originalHost.runtimeId, receipt.originalHost.ownerInstanceId, receipt.originalHost.processId],
        'The original semantic Host survives the ordinary Electron restart')
      receipt.survivingHost = owner
    }
  }
  assert.equal(new Set(receipt.phases.map(item => item.native.pid)).size, 2, 'Two real ordinary Electron process generations')
  receipt.inputAfter = await identities()
  assert.deepEqual(receipt.inputAfter, receipt.inputBefore, 'The consumed immutable Core/Host/Main/Renderer candidate changed')
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  const errors = []
  try { await fs.copyFile(path.join(privateRoot, 'agentmux-host.log'), path.join(evidence, 'owned-host.log')) }
  catch (error) { if (error.code !== 'ENOENT') errors.push(error.message) }
  try {
    if (!client && candidate && receipt.phases.length > 0) client = await candidate.connectLocalHost()
    if (client) {
      for (const run of await client.listRuns()) if (run.state === 'running') await client.stopTerminal({ runId: run.runId })
    }
  } catch (error) { errors.push(error.message) }
  try { await client?.dispose() } catch (error) { errors.push(error.message) }
  try { if (candidate) await candidate.stopHost() } catch (error) { errors.push(error.message) }
  try { await stopProbeProcesses(process.pid + 1_000_000_000, privateRoot) } catch (error) { errors.push(error.message) }
  receipt.cleanup = { errors, remaining: await listProbeProcesses(-1, privateRoot), temporaryRootRemoved: false }
  if (receipt.cleanup.remaining.length === 0) { await fs.rm(privateRoot, { recursive: true, force: true }); receipt.cleanup.temporaryRootRemoved = true }
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  const screenshots = receipt.phases.flatMap(({ phase }) => [`${phase}-workbench.png`, `${phase}-map-settings.png`, `${phase}-map.png`])
  await fs.writeFile(path.join(evidence, 'review.md'), `# Focus Map: original native process restart\n\nNative proof passed: ${receipt.passed}. Aesthetic review: not performed.\n\n` +
    receipt.limitations.map(item => `- ${item}`).join('\n') + '\n\n' + screenshots.map(file => `- [${file}](./${file})`).join('\n') + '\n')
}
assert.deepEqual(receipt.cleanup.errors, [])
assert.deepEqual(receipt.cleanup.remaining, [])
assert.equal(receipt.cleanup.temporaryRootRemoved, true)
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, receipt: path.join(evidence, 'receipt.json'), review: path.join(evidence, 'review.md'), survivingRuns: receipt.survivingRuns }))
