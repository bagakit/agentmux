#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { privatePackageSmokeEnvironment } from './package-smoke-context.mjs'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

const { values } = parseArgs({ options: { 'build-root': { type: 'string' }, 'core-root': { type: 'string' },
  cli: { type: 'string' }, 'source-root': { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' } } })
if (values.help) {
  process.stdout.write('Usage: node scripts/verify-bootstrap-capabilities.mjs --build-root OUT [--core-root PACKAGE] [--cli FILE] [--source-root REPOSITORY] [--output DIR]\nThe no-argument gate reads .local/bootstrap-capture/bootstrap-build.json. No product build or user App replacement is performed.\n')
  process.exit(0)
}
const repository = resolve(import.meta.dirname, '../../..'), desktop = join(repository, 'apps/desktop')
const require = createRequire(join(desktop, 'package.json')), execute = promisify(execFile)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const delay = ms => new Promise(done => setTimeout(done, ms))
let saved = {}
try { saved = JSON.parse(await readFile(join(repository, '.local/bootstrap-capture/bootstrap-build.json'), 'utf8')) }
catch (error) { if (error.code !== 'ENOENT') throw error }
assert.ok(values['build-root'] ?? saved.buildRoot, 'A completed private production build is required; provide --build-root or the local bootstrap-build.json')
const build = await realpath(resolve(values['build-root'] ?? saved.buildRoot))
const coreRoot = await realpath(resolve(values['core-root'] ?? saved.coreRoot ?? join(repository, 'packages/core')))
const sourceRoot = await realpath(resolve(values['source-root'] ?? saved.sourceRoot ?? resolve(coreRoot, '../..')))
const cliPath = await realpath(resolve(values.cli ?? saved.cli ?? join(coreRoot, 'dist/agentmux.js')))
const output = resolve(values.output ?? join(repository, '.local/bootstrap-capture/bootstrap-capabilities'))
await mkdir(output, { recursive: true })
const receipt = { schema: 'agentmux.bootstrap-capabilities.product-proof.v1', passed: false, build,
  boundary: 'Production Main/IPC/CoreServer, Headless Host, preload, Renderer and public CLI. A synthetic authenticated Codex protocol fixture supplies a real private ctxmux Run, without model/account acceptance claims.',
  checks: [], calls: [], sources: {}, artifacts: {}, mutations: [], cleanup: {}, limitations: [
    'This gate covers the T005 integration seam; T001–T004 own their detailed capture, recording, Settings and Provider evidence.',
    'Screenshots are private test evidence; independent aesthetic review and final installed-package identity are separate.' ] }
async function hashFile(key, path, collection = receipt.artifacts) { collection[key] = sha(await readFile(path)) }
for (const name of ['main/index.js', 'main/agentmux-host.js', 'preload/index.cjs', 'renderer/index.html'])
  await hashFile('out/' + name, join(build, name))
await hashFile('core/cli', cliPath)
const sourceConsumers = ['apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/app-capture.ts',
  'apps/desktop/src/main/app-capture-owner.ts', 'apps/desktop/src/main/desktop-host.ts', 'apps/host/src/host.ts',
  'apps/desktop/src/renderer/src/components/StableWorkbenchView.tsx', 'apps/desktop/src/renderer/src/App.tsx',
  'apps/desktop/src/renderer/src/components/SettingsPanel.tsx', 'packages/core/src/public-rpc-service.ts',
  'packages/core/src/app-capture.ts', 'packages/core/src/app-capture-cli.ts',
  'packages/core/src/agentmux-cli-commands.ts', 'packages/core/src/agentmux.ts']
for (const name of sourceConsumers) await hashFile(name, join(sourceRoot, name), receipt.sources)
receipt.commit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' })).stdout.trim()
for (const name of ['apps/desktop/scripts/verify-bootstrap-capabilities.mjs',
  'apps/desktop/scripts/fixtures/bootstrap-capabilities/bootstrap.cjs',
  'apps/desktop/scripts/fixtures/a2a-inbox-product/native-agent.mjs',
  'apps/desktop/scripts/package-smoke-context.mjs', 'apps/desktop/scripts/probe-process.mjs'])
  await hashFile(name, join(repository, name), receipt.sources)
// The build owner supplies complete source/artifact provenance. The integration
// gate binds that immutable receipt without inventing a successful build claim.
const buildReceiptPath = saved.buildReceipt ?? join(build, 'build-receipt.json')
try { await hashFile('build-receipt', buildReceiptPath); receipt.buildReceipt = buildReceiptPath }
catch (error) { if (error.code !== 'ENOENT') throw error; receipt.limitations.push('No build-owner receipt was supplied; artifact hashes identify consumed bytes but do not certify source compilation.') }
const root = await realpath(await mkdtemp('/tmp/amx-boot-'))
receipt.privateRoot = root
await appendFile(join(output, 'probe-roots.jsonl'), JSON.stringify({ root, build, sourceCommit: receipt.commit }) + '\n')
const profile = join(root, 'profile'), runtime = join(root, 'runtime'), workspace = join(root, 'workspace')
const appRoot = join(root, 'app'), controls = join(root, 'native-control')
const env = privatePackageSmokeEnvironment(process.env, { userData: profile, runtimeRoot: runtime })
delete env.AGENTMUX_DESKTOP_EXIT_AFTER_READY; delete env.AGENTMUX_DESKTOP_READY_FILE
Object.assign(env, { AGENTMUX_SPATIAL_STATE_STORE: join(runtime, 'state/spatial.json'),
  AGENTMUX_BOOTSTRAP_PRIVATE_ROOT: root, AGENTMUX_HOST_CONFIGURATION_PATH: join(profile, 'agentmux.config.json') })
for (const path of [profile, runtime, workspace, appRoot, controls, env.HOME, env.CODEX_HOME, env.TMPDIR,
  join(root, 'app-data'), join(root, 'session-data'), join(runtime, 'state/ctxmux')]) await mkdir(path, { recursive: true, mode: 0o700 })
// The gate process is a private client. Never import an executing Agent's caller,
// capability, Native session or credential context into this isolated namespace.
for (const name of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_|CODEX_)/u.test(name) ||
  ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'].includes(name)) delete process.env[name]
Object.assign(process.env, env)
const core = await import(pathToFileURL(join(coreRoot, 'dist/index.js')).href)
const { connectAgentMuxRpc } = await import(pathToFileURL(join(coreRoot, 'dist/public-rpc-client.js')).href)
const endpoint = { transport: 'unix', path: core.defaultAgentMuxControlSocketPath() }
const executable = join(root, 'native-agent')
await writeFile(executable, '#!' + process.execPath + '\nawait import(' + JSON.stringify(pathToFileURL(join(desktop, 'scripts/fixtures/a2a-inbox-product/native-agent.mjs')).href) + ');\n', { mode: 0o700 })
const configuration = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private bootstrap verification' }],
  executors: { proof: { label: 'Private authenticated native fixture', providerId: 'codex', command: executable, args: [],
    env: { HOME: env.HOME, CODEX_HOME: env.CODEX_HOME, AGENTMUX_A2A_PROOF_DIRECTORY: controls }, injectAgentMuxGuide: false } },
  workspaces: [{ id: 'bootstrap-proof', name: 'Bootstrap proof', hostId: 'local', path: workspace, kind: 'folder' }],
  appearance: { appAppearance: 'dark', terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
await writeFile(env.AGENTMUX_HOST_CONFIGURATION_PATH, JSON.stringify(configuration))
await writeFile(join(appRoot, 'package.json'), JSON.stringify({ name: 'agentmux-bootstrap-private-proof', version: '0.1.0', main: 'bootstrap.cjs' }))
await cp(join(desktop, 'scripts/fixtures/bootstrap-capabilities/bootstrap.cjs'), join(appRoot, 'bootstrap.cjs'))
for (const name of ['resources', 'browser-extension']) await symlink(join(sourceRoot, 'apps/desktop', name), join(appRoot, name), 'dir')
const children = new Set(), connections = new Set()
let rpc, client, session, first, second, failure
let baselineBuild
const ended = child => child.exitCode !== null || child.signalCode !== null
async function waitFor(label, read, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await delay(80) }
  throw new Error('Actual product observation timed out: ' + label)
}
function start(label, executable, args, environment = env, stdio) {
  const child = spawn(executable, args, { cwd: sourceRoot, env: environment, detached: true,
    stdio: stdio ?? ['ignore', 'pipe', 'pipe'] })
  children.add(child); child.logs = ''
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', bytes => { child.logs = (child.logs + bytes).slice(-128 * 1024) })
  child.on('error', error => { child.spawnError = error })
  child.on('close', () => { void writeFile(join(output, label + '.log'), child.logs) })
  return child
}
function alive(child) { if (child.spawnError) throw child.spawnError; if (ended(child)) throw Error('Private product exited: ' + child.logs) }
async function connectCdp(url) {
  const socket = new WebSocket(url), pending = new Map(); let serial = 0
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail })
  socket.onmessage = event => { const value = JSON.parse(event.data); const entry = pending.get(value.id); if (!entry) return
    pending.delete(value.id); clearTimeout(entry.timer); value.error ? entry.fail(Error(JSON.stringify(value.error))) : entry.done(value.result) }
  socket.onclose = () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.fail(Error('Private CDP document closed')) } pending.clear() }
  const call = (method, params = {}) => new Promise((done, fail) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); fail(Error('CDP observation timed out: ' + method)) }, 15_000)
    pending.set(id, { done, fail, timer }); socket.send(JSON.stringify({ id, method, params }))
  })
  const value = { call, close: () => socket.close(), async read(expression) {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  } }; connections.add(value); return value
}
async function launch(label, mainEntry, rendererDirectory = join(build, 'renderer')) {
  const child = start(label, require('electron'), ['--inspect=0', appRoot, '--remote-debugging-port=0'],
    { ...env, AGENTMUX_BOOTSTRAP_MAIN: mainEntry, AGENTMUX_BOOTSTRAP_RENDERER: join(rendererDirectory, 'index.html') })
  const startup = async () => { alive(child)
    try {
      const failures = (await readFile(join(profile, 'crash-log.ndjson'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
      const failure = failures.find(value => value.kind === 'startup-failure' && value.pid === child.pid)
      if (failure) throw Error('Production startup failure: ' + JSON.stringify(failure))
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const mainUrl = await waitFor('Main inspector', async () => { await startup(); return /Debugger listening on (ws:\/\/\S+)/u.exec(child.logs)?.[1] })
  const main = await connectCdp(mainUrl)
  const debugUrl = await waitFor('Renderer inspector', () => { alive(child); return /DevTools listening on (ws:\/\/\S+)/u.exec(child.logs)?.[1] })
  const host = new URL(debugUrl).host
  const page = await waitFor('production Renderer document', async () => {
    const pages = await (await fetch('http://' + host + '/json/list')).json()
    return pages.find(page => page.type === 'page' && page.url.startsWith(pathToFileURL(join(rendererDirectory, 'index.html')).href))
  })
  const cdp = await connectCdp(page.webSocketDebuggerUrl)
  await waitFor('production App hydration', () => cdp.read('Boolean(window.agentmux&&document.querySelector(".app-shell"))'))
  const loaded = await waitFor('original successful Renderer load owner', () => cdp.read('(async()=>{const identity=await window.agentmux.ui.readLoadedIdentity();return identity.renderer?identity:null})()'))
  const paths = await main.read('__bootstrapNative.paths()')
  assert.equal(paths.userData, profile); assert.equal(paths.home, env.HOME)
  const identity = await main.read('__bootstrapNative.identity()')
  assert.equal(identity.entry, mainEntry); assert.equal(identity.pid, child.pid)
  receipt[label] = { ...identity, rendererUrl: page.url, paths, loaded }
  return { child, main, cdp, page }
}
async function publicCli(args, input, expectedOk = true) {
  const inputPath = join(root, 'input-' + randomUUID() + '.json')
  if (input !== undefined) { await writeFile(inputPath, JSON.stringify(input)); args = [...args, '--input', inputPath] }
  const invocation = ['--endpoint', 'unix:' + endpoint.path, ...args]
  const response = await execute(process.execPath, [cliPath, ...invocation], { env, cwd: sourceRoot,
    timeout: 25_000, maxBuffer: 12 * 1024 * 1024 }).catch(error => {
    if (error.code === 1 && (error.stdout || error.stderr)) return error; throw error
  })
  const lines = (response.stdout || response.stderr).split('\n').filter(Boolean)
  const value = lines.map(line => { try { return JSON.parse(line) } catch { return null } }).findLast(value => typeof value?.ok === 'boolean')
  assert.ok(value, 'The actual CLI must return its machine JSON envelope')
  receipt.calls.push({ args, input, value })
  assert.equal(value.ok, expectedOk, JSON.stringify(value)); return value
}
async function runFact() {
  const original = (await client.listRuns()).find(run => run.runId === session.run.runId)
  assert.ok(original); assert.equal(original.state, 'running')
  assert.ok(Number.isSafeInteger(original.pid) && original.pid > 1)
  assert.equal(original.nativeService?.owner.type, 'serving')
  assert.equal(original.nativeService?.input.phase.type, 'open')
  assert.equal(original.nativeService?.input.writeBlocked, false)
  assert.equal(original.nativeService?.terminalFault, null)
  assert.ok(original.latestOutputBytes > 0, 'The actual original PTY has produced ordered output')
  assert.ok(Number.isSafeInteger(original.acceptedInputBytes), 'The original native owner confirms the accepted input byte count')
  const current = await client.refreshAgentSession(session.agentSessionId, session.run)
  assert.deepEqual(current.run, session.run); assert.ok(current.nativeHandle)
  return { agentSessionId: current.agentSessionId, run: current.run, nativeHandle: current.nativeHandle,
    pid: original.pid, state: original.state, acceptedInputBytes: original.acceptedInputBytes,
    nativeService: { owner: original.nativeService.owner.type, input: original.nativeService.input.phase.type,
      writeBlocked: original.nativeService.input.writeBlocked, terminalFault: original.nativeService.terminalFault } }
}
async function readSelection() {
  const observation = (await publicCli(['app', 'inspect'])).result.observation
  assert.equal(observation.schema, 'agentmux.desktop-client-observation.v1')
  return observation.workbench.desktop.selection
}
async function documentTarget() {
  const page = (await publicCli(['app', 'window', 'ls'])).result
  const window = page.windows.find(value => value.target === null && value.presentation === 'visible')
  assert.ok(window?.documentGeneration); return { windowId: window.windowId, documentGeneration: window.documentGeneration }
}
async function stopDesktop(app) {
  await app.main.read('__bootstrapNative.quit()'); app.main.close(); app.cdp.close()
  await waitFor('private Desktop quit', () => ended(app.child), 15_000)
}
async function assembleCandidate() {
  // electron-vite externalizes mature dependencies used by bundled Host
  // packages. Assemble their existing dependency links as a package would,
  // without changing the producer's out tree or any workspace dist.
  const target = join(root, 'candidate/out'), modules = join(target, 'node_modules')
  await mkdir(modules, { recursive: true })
  await cp(join(build, 'main'), join(target, 'main'), { recursive: true })
  for (const name of ['renderer', 'preload', 'mobile']) {
    try { await stat(join(build, name)); await symlink(join(build, name), join(target, name), 'dir') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  await writeFile(join(target, 'package.json'), '{"type":"module"}')
  for (const name of ['resources', 'browser-extension']) await symlink(join(sourceRoot, 'apps/desktop', name), join(root, 'candidate', name), 'dir')
  const workspaceDirectories = [join(sourceRoot, 'apps/host'), join(sourceRoot, 'apps/desktop')]
  for (const name of await readdir(join(sourceRoot, 'packages'))) {
    const directory = join(sourceRoot, 'packages', name)
    try { await stat(join(directory, 'package.json')); workspaceDirectories.push(directory) }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error }
  }
  const linked = new Set(), origins = new Map()
  async function link(name, path) {
    if (linked.has(name)) return
    const resolved = await realpath(path); await mkdir(dirname(join(modules, name)), { recursive: true })
    await symlink(resolved, join(modules, name), 'dir'); linked.add(name); origins.set(name, resolved)
  }
  for (const directory of [...workspaceDirectories.map(directory => join(directory, 'node_modules')), join(sourceRoot, 'node_modules')]) {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    for (const entry of entries) {
      if (entry.name === '@agentmux' || entry.name.startsWith('.')) continue
      if (entry.name.startsWith('@')) for (const child of await readdir(join(directory, entry.name))) await link(entry.name + '/' + child, join(directory, entry.name, child))
      else await link(entry.name, join(directory, entry.name))
    }
  }
  for (const directory of workspaceDirectories) {
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    if (manifest.name?.startsWith('@agentmux/')) await link(manifest.name, directory)
  }
  receipt.dependencyAssembly = Object.fromEntries(origins)
  assert.equal(sha(await readFile(join(target, 'main/index.js'))), receipt.artifacts['out/main/index.js'])
  assert.equal(sha(await readFile(join(target, 'main/agentmux-host.js'))), receipt.artifacts['out/main/agentmux-host.js'])
  return target
}
try {
  baselineBuild = await assembleCandidate()
  const daemon = start('ctxmux', join(coreRoot, 'vendor/ctxmux', process.platform + '-' + process.arch, 'bin/ctxmuxd'),
    ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(runtime, 'state/ctxmux'), '--readiness-fd', '3'], env, ['ignore', 'pipe', 'pipe', 'pipe'])
  let daemonReady = ''; daemon.stdio[3].on('data', bytes => { daemonReady += bytes })
  await waitFor('private ctxmux readiness', async () => { alive(daemon); return daemonReady.includes('\n') && (await stat(join(runtime, 'ctxmux.sock'))).isSocket() })
  const host = start('host', require('electron'), [join(baselineBuild, 'main/agentmux-host.js')],
    { ...env, ELECTRON_RUN_AS_NODE: '1', AGENTMUX_MOBILE_BUILD_DIRECTORY: join(build, 'mobile') })
  await waitFor('real Headless Host socket', async () => { alive(host)
    try { return (await stat(endpoint.path)).isSocket() } catch (error) { if (error.code !== 'ENOENT') throw error }
  })
  rpc = await connectAgentMuxRpc({ endpoint }); client = await core.connectHostedAgentMux({ rpc, expectedStorePath: env.AGENTMUX_AGENT_SESSION_STORE })
  receipt.owner = client.runtimeOwnerIdentity(); assert.equal(receipt.owner.processId, host.pid)
  first = await launch('baseline-desktop', join(baselineBuild, 'main/index.js'), join(baselineBuild, 'renderer'))
  assert.notEqual(host.pid, first.child.pid); receipt.checks.push('actual-production-Main-and-separate-Headless-Host')
  assert.ok((await stat(endpoint.path + '.desktop')).isSocket())
  receipt.forwarding = { publicEndpoint: endpoint, desktopBusinessEndpoint: endpoint.path + '.desktop',
    hostPid: host.pid, desktopPid: first.child.pid }
  receipt.discovery = []
  for (const [args, tokens] of [
    [['app', 'capture', '--help'], ['--input', '--output']],
    [['app', 'focus', '--help'], ['--settings-section', '--close-settings']],
    [['app', '--skill'], ['app capture', 'app record', '--settings-section']]
  ]) {
    const response = await execute(process.execPath, [cliPath, ...args], { env, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 })
    for (const token of tokens) assert.ok(response.stdout.includes(token), 'Actual CLI discovery contains ' + token)
    receipt.discovery.push({ args, sha256: sha(response.stdout), tokens })
  }
  receipt.checks.push('actual-CLI-help-and-generated-module-skill-discovery')
  session = await client.createAgent({ createOperationId: randomUUID(), executorId: 'proof', providerId: 'codex',
    commandOverride: executable, workspacePath: workspace, env: configuration.executors.proof.env,
    injectAgentMuxGuide: false, cols: 100, rows: 30 })
  await waitFor('authenticated native fixture on actual Run', async () => {
    const current = await client.refreshAgentSession(session.agentSessionId, session.run)
    return current.nativeHandle && current.semanticStatus?.state === 'done' && current
  })
  const zones = (await rpc.call('space.ls', { target: {} })).catalog.zones
  const zone = zones.find(value => value.workspaceId === 'bootstrap-proof'); assert.ok(zone)
  receipt.opened = await rpc.call('agent.open', { operationId: randomUUID(),
    content: { kind: 'agent-session', agentSessionId: session.agentSessionId }, destination: { zoneId: zone.zoneId, newTab: true }, focus: true })
  assert.equal(receipt.opened.save.diskDurability, 'confirmed', 'The original workface must have a real durable save receipt')
  const selection = await waitFor('original Agent workface selection', async () => {
    const selection = await readSelection(); return selection.space?.regionId === receipt.opened.to.regionId && selection
  })
  const space = selection.space, region = { kind: 'region', displayWorkspaceId: space.workspaceId, groupId: space.groupId, tabId: space.tabId, regionId: space.regionId }
  const reference = 'primary:' + JSON.stringify([region.displayWorkspaceId, region.groupId, region.tabId, region.regionId])
  const regionExpression = `[...document.querySelectorAll('[data-workbench-region-reference]')].find(e=>e.dataset.workbenchRegionReference===${JSON.stringify(reference)})`
  await waitFor('actual StableWorkbenchView published Region', () => first.cdp.read(`Boolean(${regionExpression})`))
  receipt.activation = await first.main.read('__bootstrapNative.activate()')
  const editorExpression = `${regionExpression}?.querySelector('.agent-input-stack [role="textbox"][contenteditable="true"]')`
  await waitFor('production Agent composer', () => first.cdp.read(`Boolean(${editorExpression})`))
  await first.cdp.read(`globalThis.__bootstrapOriginal={region:${regionExpression},editor:${editorExpression}};__bootstrapOriginal.editor.focus();true`)
  const draft = 'Original unsent bootstrap draft 保留'
  await first.cdp.call('Input.insertText', { text: draft })
  await waitFor('actual unsent composer draft', () => first.cdp.read(`__bootstrapOriginal.editor.textContent===${JSON.stringify(draft)}`))
  await first.cdp.read(`(()=>{const e=__bootstrapOriginal.editor,n=e.querySelector('p')?.firstChild??e.firstChild;const r=document.createRange();r.setStart(n,3);r.collapse(true);const s=document.getSelection();s.removeAllRanges();s.addRange(r);__bootstrapOriginal.anchor=n;return true})()`)
  const inputFacts = app => app.cdp.read(`(()=>{const p=globalThis.__bootstrapOriginal,s=document.getSelection();return{sameRegion:p.region===${regionExpression},regionConnected:p.region.isConnected,sameEditor:p.editor.isConnected,text:p.editor.textContent,active:p.editor===document.activeElement,documentFocused:document.hasFocus(),sameCaret:s.anchorNode===p.anchor&&s.anchorOffset===3}})()`)
  receipt.inputBefore = await inputFacts(first); assert.equal(receipt.inputBefore.active, true)
  if (!receipt.inputBefore.documentFocused) receipt.limitations.push('Native document focus was not observed. This integration proof establishes original DOM editor/draft/Range continuity; T003 owns the completed physically eligible input proof.')
  receipt.original = await runFact(); receipt.selection = selection; receipt.region = region
  const target = { ...await documentTarget(), region }
  const frame = join(output, 'production-region.png')
  const captured = await publicCli(['app', 'capture', '--output', frame], { target })
  const bytes = await readFile(frame); assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(captured.output.sha256, sha(bytes)); assert.deepEqual(captured.result.target, target)
  const bounds = await first.cdp.read(`(()=>{const r=(${regionExpression}).getBoundingClientRect();return{width:Math.round(r.width),height:Math.round(r.height)}})()`)
  assert.equal(bytes.readUInt32BE(16), bounds.width); assert.equal(bytes.readUInt32BE(20), bounds.height)
  receipt.frame = { file: frame, sha256: sha(bytes), bounds }; receipt.checks.push('public-CLI-to-Host-to-production-ipc-capture-owner-and-real-StableWorkbenchView-Region')
  const rejected = await publicCli(['app', 'capture'], { target: { ...target, documentGeneration: 'wrong-document-' + randomUUID() } }, false)
  assert.ok(rejected.error?.code); assert.deepEqual(await readSelection(), selection)
  receipt.inputAfterCapture = await inputFacts(first); assert.deepEqual(receipt.inputAfterCapture, receipt.inputBefore)
  const settings = await publicCli(['app', 'focus', '--settings-section', 'profile', '--input', 'preserve'])
  assert.equal(settings.result.navigation.state, 'applied'); assert.equal(settings.result.overlays.settingsPage.sectionId, 'profile')
  assert.equal(await first.cdp.read('document.querySelector("[data-settings-page]")?.dataset.settingsPage'), 'profile')
  const settingsInspect = await publicCli(['app', 'inspect']); assert.equal(settingsInspect.result.observation.workbench.desktop.overlays.settingsPage.visible, true)
  await publicCli(['app', 'focus', '--close-settings', '--input', 'preserve'])
  assert.deepEqual(await readSelection(), selection)
  receipt.inputAfterSettings = await inputFacts(first)
  for (const key of ['sameRegion', 'regionConnected', 'sameEditor', 'text'])
    assert.equal(receipt.inputAfterSettings[key], receipt.inputBefore[key], 'Settings retains the original input and draft: ' + key)
  // The main composer may become covered/inert while Settings is presented.
  // Its eligibility is observed by the product; focus retention is claimed only
  // above, for capture of the physically focused and eligible input.
  receipt.settingsInputOutcome = settings.result.input
  receipt.afterOperations = await runFact(); assert.deepEqual(receipt.afterOperations, receipt.original)
  receipt.checks.push('Settings-original-owner-observed-through-Host-and-keeps-original-input-draft', 'capture-failure-keeps-draft-caret-selection-and-original-healthy-Run')
  // Mutate only the immutable compiled production Main consumer. No fixture
  // constructs CoreServer or supplies a replacement capture implementation.
  const mutant = join(root, 'mutant/out'); await mkdir(mutant, { recursive: true })
  await cp(join(baselineBuild, 'main'), join(mutant, 'main'), { recursive: true })
  for (const name of ['renderer', 'preload']) await symlink(join(build, name), join(mutant, name), 'dir')
  let dependencies
  for (const candidate of [join(baselineBuild, 'node_modules'), join(build, 'node_modules'), join(dirname(build), 'node_modules'), join(sourceRoot, 'apps/desktop/node_modules')]) {
    try { dependencies = await realpath(candidate); break } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  assert.ok(dependencies, 'The mutant must reuse the original private candidate dependencies')
  await symlink(dependencies, join(mutant, 'node_modules'), 'dir')
  await writeFile(join(mutant, 'package.json'), '{"type":"module"}')
  for (const name of ['resources', 'browser-extension']) await symlink(join(sourceRoot, 'apps/desktop', name), join(root, 'mutant', name), 'dir')
  const paths = (await readdir(join(mutant, 'main'))).filter(name => /\.[cm]?js$/u.test(name))
  let changed = 0
  for (const name of paths) {
    const path = join(mutant, 'main', name), original = await readFile(path, 'utf8')
    const anchor = /captures:\s*createAppCapturePort(?:\$\w+)?\([^)]*\)/gu
    const matches = [...original.matchAll(anchor)]; if (!matches.length) continue
    changed += matches.length; assert.equal(matches.length, 1)
    const changedSource = original.replace(anchor, 'captures: undefined')
    await writeFile(path, changedSource); receipt.mutations.push({ name: 'production-ipc-capture-injection-removed', file: 'out/main/' + name,
      before: sha(original), after: sha(changedSource), branch: matches[0][0], killed: false })
  }
  assert.equal(changed, 1, 'Exactly one production capture injection must change')
  await stopDesktop(first)
  assert.deepEqual(await runFact(), receipt.original, 'Client quit cannot terminate the original healthy Run')
  second = await launch('mutated-desktop', join(mutant, 'main/index.js'), join(mutant, 'renderer'))
  await waitFor('original restored Region dataset', () => second.cdp.read(`Boolean(${regionExpression})`))
  assert.deepEqual(await readSelection(), selection)
  receipt.restoredDraft = await waitFor('original retained draft after actual Desktop restart', () => second.cdp.read(`${editorExpression}?.textContent===${JSON.stringify(draft)}`))
  const mutationTarget = { ...await documentTarget(), region }
  const negative = await publicCli(['app', 'capture'], { target: mutationTarget }, false)
  assert.equal(negative.error?.code, 'CONTROL_UNAVAILABLE'); receipt.mutations[0].killed = true; receipt.mutations[0].response = negative
  receipt.afterRestartAndMutation = await runFact(); assert.deepEqual(receipt.afterRestartAndMutation, receipt.original)
  receipt.checks.push('production-capture-owner-injection-mutation-killed', 'real-Desktop-restart-retains-Region-draft-and-same-Host-Run')
  for (const [name, digest] of Object.entries(receipt.sources)) {
    const base = sourceConsumers.includes(name) ? sourceRoot : repository
    assert.equal(sha(await readFile(join(base, name))), digest, 'The proved source remains unchanged: ' + name)
  }
  for (const name of ['main/index.js', 'main/agentmux-host.js', 'preload/index.cjs', 'renderer/index.html'])
    assert.equal(sha(await readFile(join(build, name))), receipt.artifacts['out/' + name], 'The original candidate remains unchanged: ' + name)
  assert.equal(sha(await readFile(cliPath)), receipt.artifacts['core/cli'])
  receipt.checks.push('source-and-consumed-artifact-hashes-remain-stable')
  receipt.passed = true
} catch (error) { failure = error; receipt.error = { message: error.message, stack: error.stack } }
finally {
  const errors = []
  if (session && client) try { await client.stopAgent(session.agentSessionId, session.run); receipt.cleanup.privateRunStopped = true } catch (error) { errors.push(String(error)) }
  for (const value of connections) value.close()
  try { await client?.dispose(); await rpc?.dispose() } catch (error) { errors.push(String(error)) }
  for (const child of [...children].reverse()) if (!ended(child)) try { await stopProbeProcesses(child.pid, root) } catch (error) { errors.push(String(error)) }
  try { await stopProbeProcesses(undefined, root); receipt.cleanup.remaining = await listProbeProcesses(undefined, root) } catch (error) { errors.push(String(error)) }
  receipt.cleanup.errors = errors
  if (errors.length || receipt.cleanup.remaining?.length) { receipt.passed = false; failure ??= Error('Private cleanup is unconfirmed') }
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2))
  if (receipt.passed) await rm(root, { recursive: true, force: true })
  else await writeFile(join(output, 'retained-private-root.txt'), root + '\n')
}
if (failure) { process.stderr.write(JSON.stringify(receipt.error ?? { message: failure.message }) + '\n'); process.exitCode = 1 }
else process.stdout.write(JSON.stringify({ passed: true, checks: receipt.checks, evidence: output, mutations: receipt.mutations.map(value => ({ name: value.name, killed: value.killed })) }) + '\n')
