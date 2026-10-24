#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { privatePackageSmokeEnvironment } from './package-smoke-context.mjs'
import { listProbeProcesses, signalOwnedProbeProcess, stopProbeProcesses } from './probe-process.mjs'

const { values } = parseArgs({ options: {
  'build-root': { type: 'string' }, output: { type: 'string' },
  'check-proof': { type: 'boolean' }, 'sdk-operation-only': { type: 'boolean' }, help: { type: 'boolean' },
} })
if (values.help) {
  process.stdout.write('Usage: node scripts/verify-capsule-integration.mjs [--build-root <compiled-root>] [--output <evidence-directory>] [--check-proof] [--sdk-operation-only]\n')
  process.exit(0)
}
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = resolve(desktop, '../..'), require = createRequire(join(desktop, 'package.json'))
const executeFile = promisify(execFile)
// The capture helper belongs to the original authorized desktop runtime. Its
// environment must not inherit the private Core/Electron home or Agent secrets.
const captureEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  ['HOME', 'PATH', 'LANG', 'TZ', 'TMPDIR'].includes(name) || name.startsWith('LC_') || name.startsWith('XDG_') || name.startsWith('ORCA_')))
const sdkOperationOnly = values['sdk-operation-only'] === true
const scope = sdkOperationOnly ? 'sdk-operation-boundary' : 'full-native-visual'
const output = resolve(values.output ?? join(repository, '.bagakit/capsule', sdkOperationOnly ? 'native-sdk-proof' : 'native-run-proof'))
if (!values['check-proof']) {
  await mkdir(output, { recursive: true, mode: 0o700 })
  await writeFile(join(output, 'facts.json'), JSON.stringify({ schema: 'agentmux.capsule.native-proof.v4', scope, result: 'starting' }) + '\n', { mode: 0o600 })
}
const build = await realpath(resolve(values['build-root'] ?? join(repository, '.tmp/capsule-native-build/out')))
for (const name of ['main/index.js', 'main/agentmux-host.js', 'preload/index.cjs', 'preload/capsule.cjs', 'renderer/index.html'])
  assert.ok((await stat(join(build, name))).isFile(), 'Actual compiled product is required: ' + name)
if (values['check-proof']) {
  await checkProof()
  process.stdout.write(sdkOperationOnly
    ? 'Current Capsule SDK Native boundary proof, input identities and private cleanup verified; no OS capture or new visual review claimed.\n'
    : 'Current Capsule product proof, input identities, frame bytes and private cleanup verified; aesthetic review remains independent.\n')
  process.exit(0)
}
// macOS sockaddr_un cannot address its longer per-user temporary directory.
const temporaryBase = process.platform === 'darwin' ? '/tmp' : tmpdir()
const root = await realpath(await mkdtemp(join(temporaryBase, 'amx-cap-')))
const userData = join(root, 'user-data'), runtime = join(root, 'runtime'), workspace = join(root, 'workspace')
const appRoot = join(root, 'app'), nativeHome = join(root, 'codex-home'), controls = join(root, 'native-control')
for (const path of [userData, runtime, workspace, appRoot, nativeHome, controls,
  join(runtime, 'state', 'ctxmux'), join(runtime, 'tmp'), join(output, 'frames')])
  await mkdir(path, { recursive: true, mode: 0o700 })
const env = privatePackageSmokeEnvironment(process.env, { userData, runtimeRoot: runtime })
delete env.AGENTMUX_DESKTOP_EXIT_AFTER_READY
delete env.AGENTMUX_DESKTOP_READY_FILE
Object.assign(env, { CODEX_HOME: nativeHome, AGENTMUX_SPATIAL_STATE_STORE: join(runtime, 'state', 'spatial-state.json') })
for (const path of [env.HOME, join(root, 'app-data'), join(root, 'session-data')])
  await mkdir(path, { recursive: true, mode: 0o700 })
// Core imports happen only after dropping this Agent's execution credentials.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('AGENTMUX_') || name.startsWith('CTXMUX_') || name.startsWith('CODEX_') ||
    ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'].includes(name)) delete process.env[name]
}
Object.assign(process.env, env)
const core = await import(pathToFileURL(join(repository, 'packages/core/dist/index.js')).href)
const { connectAgentMuxRpc } = await import(pathToFileURL(join(repository, 'packages/core/dist/public-rpc-client.js')).href)
const endpoint = { transport: 'unix', path: core.defaultAgentMuxControlSocketPath() }
const executable = join(root, 'native-agent')
const providerFixture = join(desktop, 'scripts/fixtures/a2a-inbox-product/native-agent.mjs')
await writeFile(executable, '#!' + process.execPath + '\nawait import(' + JSON.stringify(pathToFileURL(providerFixture).href) + ');\n', { mode: 0o700 })
const configuration = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private Capsule verification' }],
  executors: { proof: { label: 'Private native protocol fixture', providerId: 'codex', command: executable, args: [],
    env: { HOME: env.HOME, CODEX_HOME: nativeHome, AGENTMUX_A2A_PROOF_DIRECTORY: controls }, injectAgentMuxGuide: false } },
  workspaces: [{ id: 'capsule-proof', name: 'Capsule workspace', hostId: 'local', path: workspace, kind: 'folder' }],
  appearance: { appAppearance: 'dark', terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
await writeFile(join(userData, 'agentmux.config.json'), JSON.stringify(configuration), { mode: 0o600 })
// The manifest supplies the real product resources. Its private bootstrap observes
// the original IPC registration; it never substitutes a business owner or Renderer.
for (const name of ['resources', 'browser-extension']) await symlink(join(desktop, name), join(appRoot, name), 'dir')
const desktopPackage = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'))
await writeFile(join(appRoot, 'package.json'), JSON.stringify({ name: 'agentmux-capsule-private-proof',
  version: desktopPackage.version, main: 'bootstrap.cjs' }))
const paths = { home: env.HOME, appData: join(root, 'app-data'), userData, sessionData: join(root, 'session-data') }
// Serialized into the private bootstrap before production Main registers its handler.
// Only one exact acknowledgment may be lost, after the actual handler returns success.
function nativeSdkReceiptLoss(ipcMain) {
  const register = ipcMain.handle.bind(ipcMain), calls = [], faults = []
  const copy = value => JSON.parse(JSON.stringify(value))
  let armed = null
  ipcMain.handle = (channel, handler) => {
    if (channel !== 'capsule:document') return register(channel, handler)
    return register(channel, async (event, action, params) => {
      const call = { sequence: calls.length + 1, action, params: copy(params), senderId: event.sender.id,
        mainFrame: event.senderFrame === event.sender.mainFrame, phase: 'entered' }
      calls.push(call)
      const selected = armed && action === armed.action && params?.operationId === armed.operationId && event.sender.id === armed.senderId
      if (selected) armed = null
      const original = await handler(event, action, params)
      call.phase = 'returned'; call.result = copy(original)
      if (!selected) return original
      if (original?.ok !== true) throw new Error('The original armed Capsule handler did not confirm an effect; no receipt-loss proof is possible.')
      const returned = { ok: false, error: { code: 'CAPSULE_OPERATION_UNKNOWN',
        message: 'The private proof discarded one acknowledgment after the original Capsule handler returned. Inspect the page-held original operation.' } }
      faults.push({ sequence: call.sequence, action, operationId: params.operationId, senderId: event.sender.id,
        mainFrame: call.mainFrame, phase: 'post-effect', original: copy(original), returned: copy(returned) })
      return returned
    })
  }
  return {
    arm(value) {
      if (armed || faults.length || !['request', 'saveDraft'].includes(value?.action) ||
        typeof value.operationId !== 'string' || !value.operationId || !Number.isSafeInteger(value.senderId) || value.senderId < 1)
        throw new Error('Arm one exact original Capsule mutation on its native document.')
      armed = copy(value)
      return copy(armed)
    },
    snapshot() { return copy({ armed, calls, faults }) }
  }
}
await writeFile(join(appRoot, 'bootstrap.cjs'), `const {app,BrowserWindow,webContents,session,ipcMain}=require('electron');
const fs=require('node:fs');const paths=${JSON.stringify(paths)};
for(const [name,value]of Object.entries(paths)){app.setPath(name,value);if(app.getPath(name)!==value)throw Error('Private Electron path mismatch: '+name)}
const sdkReceipts=(${nativeSdkReceiptLoss.toString()})(ipcMain);
globalThis.__capsuleNative={paths:()=>Object.fromEntries(Object.keys(paths).map(k=>[k,app.getPath(k)])),
armReceiptLoss:value=>sdkReceipts.arm(value),documentReceipts:()=>sdkReceipts.snapshot(),
documents(){const seen=[];return webContents.getAllWebContents().map(w=>{let index=seen.indexOf(w.session);if(index<0){index=seen.length;seen.push(w.session)}return{id:w.id,url:w.getURL(),sessionClass:index,defaultSession:w.session===session.defaultSession}})},
minimum(){const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('file:'));if(!w)throw Error('Original App window unavailable');return w.getMinimumSize()},
capture(){const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('file:'));if(!w)throw Error('Original App window unavailable');return{mediaSourceId:w.getMediaSourceId(),size:w.getContentSize(),url:w.webContents.getURL()}},
resize(width,height){const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('file:'));if(!w)throw Error('Original App window unavailable');w.setContentSize(width,height);return w.getContentSize()}};
import(${JSON.stringify(pathToFileURL(join(build, 'main/index.js')).href)}).catch(e=>{process.stderr.write(e.stack+'\\n');app.exit(1)});
`, { mode: 0o600 })

const facts = { schema: 'agentmux.capsule.native-proof.v4', scope, build, privateRoot: root,
  boundary: 'Actual compiled Desktop/Main/preload/Renderer, detached product Core Host, independent ctxmux Capsule service Run and private HTTP, native Browser documents and authenticated synthetic Provider. No model acceptance claim.',
  visual: { captureOnly: !sdkOperationOnly, captureStatus: sdkOperationOnly ? 'not-requested' : 'requested', aestheticReview: 'not-performed',
    states: ['managed and configured path documents', 'pending draft', 'confirmed answer',
      'restored unsent draft', 'existing Settings pages and long content root', 'page details', 'original Toolkit result'],
    notCaptured: ['empty page registry', 'unknown input delivery', 'unavailable source and port-conflict service window'] },
  phases: [], frames: [], cleanup: {}, calls: [] }
const children = new Set(), hosts = new Set(), sockets = new Set()
let client, rpc, session, first, second, failure
const delay = ms => new Promise(done => setTimeout(done, ms))
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex') }
const ended = child => child.exitCode !== null || child.signalCode !== null
async function verifyBuildReceipt(record) {
  const buildReceipt = JSON.parse(await readFile(join(build, 'build-receipt.json'), 'utf8'))
  assert.equal(buildReceipt.schema, 'agentmux.capsule.native-build.v1')
  assert.equal(buildReceipt.passed, true, 'The candidate must come from a completed current-source build')
  assert.equal(buildReceipt.dependencyLayout?.nodeModules, 'apps/desktop/node_modules')
  assert.equal(await realpath(join(build, 'node_modules')),
    await realpath(join(repository, buildReceipt.dependencyLayout.nodeModules)), 'Original product external dependency layout')
  assert.deepEqual(buildReceipt.dependencyLayout.assets, {
    resources: 'apps/desktop/resources', 'browser-extension': 'apps/desktop/browser-extension',
  })
  for (const [name, path] of Object.entries(buildReceipt.dependencyLayout.assets))
    assert.equal(await realpath(join(build, '..', name)), await realpath(join(repository, path)), 'Original product asset layout: ' + name)
  const viteConsumers = [
    'apps/desktop/src/main/index.ts', 'apps/desktop/src/main/browser-view-manager.ts',
    'apps/desktop/src/main/capsule-document-ipc.ts', 'apps/desktop/src/main/capsule-reply-authority.ts',
    'apps/desktop/src/preload/capsule.ts', 'apps/desktop/src/renderer/src/components/BrowserPane.tsx',
    'apps/host/src/capsules.ts',
  ]
  const dependencyConsumers = ['packages/capsule/src/node.ts', 'packages/capsule/src/http.ts',
    'packages/capsule/src/runtime.ts', 'packages/capsule/src/runtime-cli.ts', 'packages/capsule/src/runtime-client.ts',
    'packages/capsule/src/runtime-server.ts', 'packages/capsule/src/runtime-wire.ts',
    'packages/core/src/public-rpc-service.ts', 'packages/core/src/headless-runtime.ts',
    'packages/core/src/capsule-run-manager.ts', 'packages/core/src/terminal-preparation.ts', 'packages/core/src/ctxmux-run-adapter.ts']
  for (const field of ['sourceFiles', 'compiledFiles', 'loadedSourceFiles', 'dependencySourceFiles', 'dependencyFiles']) {
    assert.ok(buildReceipt[field] && Object.keys(buildReceipt[field]).length > 0, 'Nonempty build identity: ' + field)
  }
  for (const path of viteConsumers) {
    assert.ok(buildReceipt.sourceFiles[path], 'Original consumer in candidate build: ' + path)
    assert.equal(buildReceipt.loadedSourceFiles[path], buildReceipt.sourceFiles[path], 'Actual loaded consumer: ' + path)
  }
  for (const path of dependencyConsumers) {
    assert.ok(buildReceipt.sourceFiles[path], 'Original dependency source: ' + path)
    assert.equal(buildReceipt.dependencySourceFiles[path], buildReceipt.sourceFiles[path], 'Actual tsc dependency input: ' + path)
  }
  for (const path of dependencyConsumers) {
    const compiled = path.replace('/src/', '/dist/').replace(/\.ts$/u, '.js')
    assert.ok(buildReceipt.dependencyFiles[compiled], 'Actual standalone runtime dependency artifact: ' + compiled)
  }
  assert.ok(buildReceipt.sourceFiles['apps/desktop/scripts/build-capsule-proof.mjs'], 'Original builder source identity')
  for (const [path, expected] of Object.entries(buildReceipt.sourceFiles)) {
    assert.ok(!path.startsWith('/') && !path.split('/').includes('..'), 'Repository-relative source identity')
    assert.match(expected, /^[a-f0-9]{64}$/u)
    assert.equal(sha(await readFile(join(repository, path))), expected, 'Source identity: ' + path)
  }
  for (const [path, expected] of Object.entries(buildReceipt.compiledFiles)) {
    assert.ok(!path.startsWith('/') && !path.split('/').includes('..'), 'Build-relative compiled identity')
    assert.match(expected, /^[a-f0-9]{64}$/u)
    assert.equal(sha(await readFile(join(build, path))), expected, 'Consumed compiled identity: ' + path)
  }
  for (const [path, expected] of Object.entries(buildReceipt.dependencyFiles)) {
    assert.ok(!path.startsWith('/') && !path.split('/').includes('..'), 'Repository-relative external dependency identity')
    assert.match(expected, /^[a-f0-9]{64}$/u)
    assert.equal(sha(await readFile(join(repository, path))), expected, 'Consumed external dependency: ' + path)
  }
  assert.ok(buildReceipt.commit && buildReceipt.tree && buildReceipt.diffHash, 'Source commit, tree and diff association are required')
  if (record) record.buildReceipt = buildReceipt
  return buildReceipt
}
async function checkProof() {
  const receipt = await verifyBuildReceipt()
  const proof = JSON.parse(await readFile(join(output, 'facts.json'), 'utf8'))
  assert.equal(proof.schema, 'agentmux.capsule.native-proof.v4')
  assert.equal(proof.result, 'passed', 'The original Native scenario did not complete: ' + (proof.error?.message ?? 'unknown stage'))
  assert.equal(proof.error, undefined)
  assert.deepEqual(proof.buildReceipt, receipt, 'The Native proof consumed this exact candidate')
  assert.equal(proof.scope, scope, 'Proof scope must match the explicit invocation')
  assert.equal(proof.visual.captureOnly, !sdkOperationOnly)
  assert.equal(proof.visual.captureStatus, sdkOperationOnly ? 'not-requested' : 'requested')
  assert.equal(proof.visual.aestheticReview, 'not-performed')
  for (const name of ['ordinary private Desktop launch', 'SIGKILL original Host and Desktop; retain ctxmux Run', 'original Native workface restored'])
    assert.ok(proof.phases.some(phase => phase.name === name), 'Completed Native phase: ' + name)
  const content = proof.content, recovery = proof.recovery, original = proof.originalAgent
  assert.equal(proof.initialServiceStart.before.desired, 'unconfigured')
  assert.equal(proof.initialServiceStart.params.expectedRevision, proof.initialServiceStart.before.revision)
  assert.equal(proof.initialServiceStart.receipt.desired, 'running')
  assert.equal(proof.initialServiceStart.receipt.operation.operationId, proof.initialServiceStart.params.operationId)
  assert.equal(proof.initialServiceStart.confirmed.desired, 'running')
  assert.equal(proof.initialServiceStart.confirmed.phase, 'running')
  assert.equal(proof.initialServiceStart.confirmed.operation.kind, 'start')
  assert.equal(proof.initialServiceStart.confirmed.operation.phase, 'confirmed')
  assert.equal(proof.initialServiceStart.confirmed.operation.operationId, proof.initialServiceStart.params.operationId)
  assert.deepEqual(proof.initialServiceStart.confirmed.run, proof.service.before.observation.run)
  assert.equal(content.managedSourceRemoved, true)
  assert.equal(content.pathSourceObservedLive, true)
  assert.equal(content.managed.record.capsuleId, recovery.recovered.record.capsuleId)
  assert.equal(content.opened.capsuleId, content.managed.record.capsuleId)
  assert.equal(recovery.recovered.endpoint.url, content.managed.endpoint.url)
  assert.equal(recovery.recovered.endpoint.instanceId, content.managed.endpoint.instanceId, 'Core/App exit must retain the original HTTP instance')
  const originalRegion = recovery.graph.state.graph.regions.find(region => region.regionId === content.opened.rendering.regionId)
  assert.deepEqual(originalRegion, proof.beforeRegion)
  assert.equal(originalRegion.browserId, content.opened.rendering.browserId)
  assert.equal(recovery.originalRun.runId, original.run.runId)
  assert.equal(recovery.originalRun.state, 'running')
  assert.equal(recovery.recoveredPending.interactionId, content.pending.interactionId)
  assert.equal(recovery.recoveredPending.draft, content.pending.draft)
  assert.deepEqual(recovery.recoveredPending.target, content.pending.target)
  assert.equal(content.inputKey.agentSessionId, original.agentSessionId)
  assert.deepEqual(content.inputKey.expectedRun, original.run)
  assert.equal(content.answer.reply.delivery.inputOperationId, content.inputKey.submissionId)
  assert.equal(recovery.recoveredAnswer.interaction.reply.delivery.inputOperationId, content.inputKey.submissionId)
  assert.deepEqual(content.originalInput.input.key, content.inputKey)
  assert.ok(['terminal-confirmed', 'admitted'].includes(content.originalInput.input.status))
  assert.equal(content.originalInput.record.admission.intent.message.authorHuman, true)
  assert.equal(content.originalInput.record.admission.intent.message.sourceChannel, 'question-reply')
  assert.equal(recovery.originalOpen.operation.operationId, content.opened.operationId)
  assert.equal(recovery.originalOpen.operation.status, 'committed')
  assert.deepEqual(recovery.originalOpen.operation.result.rendering, content.opened.rendering)
  assert.equal(proof.toolkit.toolkitOpen.capsuleId, content.managed.record.capsuleId)
  assert.equal(proof.toolkit.toolkitOpen.result.rendering.browserId, content.opened.rendering.browserId)
  assert.equal(proof.toolkit.toolkitAfter.latestConfirmed.executionId, proof.toolkit.toolkitResult.latestConfirmed.executionId)
  assert.ok(proof.resizes?.length > 0 && proof.clicks?.length > 0, 'Native allocation and original input observations are required')
  for (const resize of proof.resizes) {
    assert.equal(resize.status, 'ready'); assert.equal(resize.samples.length, 3)
    assert.ok(resize.samples.every(sample => sample.width === resize.actual[0] && sample.height === resize.actual[1]))
    assert.ok(resize.samples.every(sample => JSON.stringify(sample) === JSON.stringify(resize.samples[0])))
  }
  for (const click of proof.clicks) { assert.equal(click.status, 'observed'); assertClickReceipt(click.receipt) }
  assert.ok(proof.clicks.some(click => click.id === proof.toolkit.clickId), 'The Toolkit result retains its one observed original click')
  assert.equal(recovery.restoredSession.agentSessionId, original.agentSessionId)
  assert.deepEqual(recovery.restoredSession.run, original.run)
  assert.ok(proof.themeTransitions.some(value => value.theme.mode === 'light'))
  assert.ok(proof.themeTransitions.some(value => value.theme.mode === 'dark'))
  assert.ok(proof.harnessSourceFiles && Object.keys(proof.harnessSourceFiles).length >= 4)
  for (const path of [relative(repository, fileURLToPath(import.meta.url)),
    'apps/desktop/scripts/fixtures/a2a-inbox-product/native-agent.mjs',
    'apps/desktop/scripts/package-smoke-context.mjs', 'apps/desktop/scripts/probe-process.mjs'])
    assert.ok(proof.harnessSourceFiles[path], 'Original fixture source association: ' + path)
  for (const [path, expected] of Object.entries(proof.harnessSourceFiles)) {
    assert.ok(!path.startsWith('/') && !path.split('/').includes('..'))
    assert.equal(sha(await readFile(join(repository, path))), expected, 'Actual fixture source remains current: ' + path)
  }
  const requiredFrames = ['isolated-native', 'managed-question-normal', 'managed-question-narrow',
    'capsule-hitl-light-normal', 'capsule-hitl-light-narrow', 'capsule-hitl-dark-normal', 'capsule-hitl-dark-narrow',
    'capsule-settings-normal', 'capsule-settings-narrow', 'capsule-settings-page-detail-normal',
    'capsule-settings-page-detail-narrow', 'capsule-toolkit-normal', 'capsule-toolkit-narrow',
    'capsule-restored-normal', 'capsule-restored-narrow']
  for (const name of requiredFrames) assert.ok(proof.resizes.some(value => value.label === name + ' native allocation'), 'Actual named native allocation: ' + name)
  if (sdkOperationOnly) assert.deepEqual(proof.frames, [], 'SDK-only proof must not claim OS capture')
  else for (const name of requiredFrames) assert.ok(proof.frames.some(frame => frame.name === name), 'Actual Native frame: ' + name)
  for (const frame of proof.frames) {
    assert.equal(frame.capturePort, 'orca-computer-get-app-state')
    assert.match(frame.nativeWindowId, /^\d+$/u)
    const windowId = Number(frame.nativeWindowId)
    assert.ok(Number.isSafeInteger(windowId) && windowId > 0)
    assert.ok(Number.isSafeInteger(frame.pid) && frame.pid > 1)
    assert.equal(frame.path, join(output, 'frames', frame.name + '.png'))
    const bytes = await readFile(frame.path)
    assert.equal(sha(bytes), frame.sha256, 'Original Native screenshot bytes: ' + frame.name)
    assert.equal(frame.metadata, join(output, 'frames', frame.name + '.window.json'))
    const metadataBytes = await readFile(frame.metadata)
    assert.equal(sha(metadataBytes), frame.metadataSha256, 'Original window capture receipt: ' + frame.name)
    const metadata = JSON.parse(metadataBytes)
    assert.equal(metadata.api, 'orca computer get-app-state')
    assert.equal(metadata.pid, frame.pid)
    assert.equal(metadata.nativeWindow.mediaSourceId.split(':')[1], frame.nativeWindowId)
    const selected = metadata.listed.result.windows.find(window => window.app.pid === frame.pid && window.id === windowId)
    assert.ok(selected, 'The original CG window belongs to its exact private Electron PID')
    assert.equal(selected.isMinimized, false); assert.equal(selected.isOffscreen, false)
    const capture = metadata.captured.result, image = capture.screenshot
    assert.equal(capture.snapshot.app.pid, frame.pid); assert.equal(capture.snapshot.window.id, windowId)
    assert.equal(capture.screenshotStatus.state, 'captured')
    assert.equal(capture.screenshotStatus.metadata.windowId, windowId)
    assert.equal(image.format, 'png'); assert.ok(Number.isFinite(image.scale) && image.scale > 0)
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    assert.equal(bytes.readUInt32BE(16), image.width); assert.equal(bytes.readUInt32BE(20), image.height)
    assert.equal(image.width, selected.width * image.scale); assert.equal(image.height, selected.height * image.scale)
  }
  assertSdkOperationRecovery(proof)
  assertServiceContinuity(proof)
  assert.equal(proof.cleanup.originalRunStopped, true)
  assert.equal(proof.cleanup.serviceRunStopped, true)
  assert.equal(proof.cleanup.serviceStop.params.expectedRun.runId, proof.service.after.observation.run.runId)
  assert.equal(proof.cleanup.serviceStop.confirmed.desired, 'stopped')
  assert.equal(proof.cleanup.serviceStop.confirmed.phase, 'stopped')
  assert.equal(proof.cleanup.serviceStop.confirmed.operation.operationId, proof.cleanup.serviceStop.params.operationId)
  assert.equal(proof.cleanup.serviceStop.confirmed.operation.phase, 'confirmed')
  assert.equal(proof.cleanup.privateProcessesExited, true)
  assert.deepEqual(proof.cleanup.remainingOwnedProcesses, [])
  const privateBase = await realpath(process.platform === 'darwin' ? '/tmp' : tmpdir())
  assert.equal(dirname(proof.privateRoot), privateBase)
  assert.ok(proof.privateRoot.slice(privateBase.length + 1).startsWith('amx-cap-'))
  assert.deepEqual(await listProbeProcesses(undefined, proof.privateRoot), [], 'No private original process remains')
}
function assertSdkOperationRecovery(proof) {
  const value = proof.sdkOperationRecovery
  assert.equal(value?.schema, 'agentmux.capsule.sdk-operation-recovery.v1', 'Actual ContextBridge lost-receipt evidence is required')
  assert.equal(value.action, 'request')
  assert.ok(typeof value.operationId === 'string' && value.operationId.length > 0)
  assert.equal(value.before.operationId, value.operationId, 'The page holds the ID before crossing the bridge')
  assert.equal(value.before.mutationCount, 0)
  assert.equal(value.after.operationId, value.operationId)
  assert.equal(value.after.status, 'unknown', 'The actual bridged mutation must reject after the effect')
  assert.equal(value.after.action, 'request')
  assert.equal(value.missingIdentity.page.request.rejected, true)
  assert.equal(value.missingIdentity.page.saveDraft.rejected, true)
  assert.deepEqual(value.missingIdentity.after, value.missingIdentity.before, 'Missing IDs fail before either mutator reaches the original IPC handler')
  assert.ok(typeof value.clickId === 'string' && proof.clicks.some(click => click.id === value.clickId), 'The mutation follows its one original native click')
  assert.equal(value.receipts.armed, null)
  assert.equal(value.receipts.faults.length, 1, 'Only one post-effect acknowledgment is lost')
  const fault = value.receipts.faults[0]
  assert.equal(fault.phase, 'post-effect')
  assert.equal(fault.action, value.action)
  assert.equal(fault.operationId, value.operationId)
  assert.equal(fault.senderId, value.senderId)
  assert.equal(fault.mainFrame, true)
  assert.equal(fault.original.ok, true)
  assert.equal(fault.returned.ok, false)
  assert.equal(fault.returned.error.code, 'CAPSULE_OPERATION_UNKNOWN')
  const mutations = value.receipts.calls.filter(call => ['request', 'saveDraft'].includes(call.action))
  const original = mutations.filter(call => call.params.operationId === value.operationId)
  assert.equal(original.length, 1, 'A lost receipt must not repeat the original mutation')
  assert.equal(original[0].phase, 'returned')
  assert.equal(original[0].sequence, fault.sequence)
  assert.equal(original[0].senderId, value.senderId)
  assert.equal(original[0].mainFrame, true)
  assert.deepEqual(original[0].result, fault.original)
  assert.equal(value.operation.operationId, value.operationId)
  assert.equal(value.operation.capsuleId, proof.content.managed.record.capsuleId)
  assert.equal(value.operation.method, 'capsule.interaction.request')
  assert.equal(value.operation.status, 'committed')
  assert.equal(value.operation.result.operationId, value.operationId)
  assert.deepEqual(value.operation.result.interaction, fault.original.value)
  assert.deepEqual(value.publicOperation.operation, value.operation, 'The page SDK and original Core inspect agree')
  assert.equal(value.operation.result.interaction.interactionId, proof.content.question.interactionId)
  assert.deepEqual(value.operation.result.interaction.target, proof.content.question.target)
  assert.deepEqual(value.after.params, { question: value.operation.result.interaction.question, draft: value.operation.result.interaction.draft })
  assert.equal(value.interactions.filter(item => item.operationId === value.operationId).length, 1)
  assert.equal(value.interactions.find(item => item.operationId === value.operationId).interactionId, proof.content.question.interactionId)
  assert.ok(value.receipts.calls.some(call => call.action === 'inspectOperation' && call.params.operationId === value.operationId && call.sequence > fault.sequence),
    'Recovery crosses the real page SDK using only the retained original ID')
  assert.deepEqual(proof.recovery.sdkOriginalOperation.operation, value.operation, 'The original effect survives Core/App death without another request')
  for (const [action, saved, interaction] of [
    ['saveDraft', value.draft, proof.content.draft], ['request', value.pending, proof.content.pending]
  ]) {
    assert.ok(typeof saved.operationId === 'string' && saved.operationId.length > 0)
    assert.notEqual(saved.operationId, value.operationId)
    const calls = mutations.filter(call => call.action === action && call.params.operationId === saved.operationId)
    assert.equal(calls.length, 1, 'Each explicit SDK mutation crosses once: ' + action)
    assert.equal(calls[0].senderId, value.senderId)
    assert.equal(calls[0].result.ok, true)
    assert.deepEqual(calls[0].result.value, interaction)
    assert.equal(saved.operation.operationId, saved.operationId)
    assert.equal(saved.operation.status, 'committed')
    assert.equal(saved.operation.result.operationId, saved.operationId)
    assert.deepEqual(saved.operation.result.interaction, interaction)
  }
  assert.notEqual(value.draft.operationId, value.pending.operationId)
  assert.equal(mutations.length, 3, 'The original document has exactly the three intended SDK mutations')
}
function assertServiceContinuity(proof) {
  const { before, after, httpBefore, whileCoreDetached, httpAfter } = proof.service
  for (const value of [before, after]) {
    assert.equal(value.observation.phase, 'running')
    assert.equal(value.observation.desired, 'running')
    assert.equal(value.observation.run.hostId, 'local')
    assert.equal(value.native.run.runId, value.observation.run.runId)
    assert.equal(value.native.run.kind, 'terminal')
    assert.equal(value.native.run.agentSessionId, null)
    assert.equal(value.native.run.state, 'running')
    assert.equal(value.native.run.pid, value.observation.runtime.pid)
    assert.notEqual(value.native.run.runId, proof.originalAgent.run.runId)
    assert.notEqual(value.observation.runtime.pid, proof.firstOwner.processId)
    assert.notEqual(value.observation.runtime.pid, proof.secondOwner.processId)
  }
  assert.deepEqual(after.observation.run, before.observation.run, 'The same service Run survives Core/App restart')
  assert.deepEqual(after.observation.runtime, before.observation.runtime, 'The same service process and owner survive')
  assert.equal(after.observation.stateDirectory, before.observation.stateDirectory)
  assert.equal(after.observation.socketPath, before.observation.socketPath)
  assert.deepEqual(whileCoreDetached, httpBefore, 'Original HTTP bytes and instance during Core/App absence')
  assert.deepEqual(httpAfter, httpBefore, 'Reconnection does not replace the independently serving document')
  assert.equal(proof.service.originalCoreExited, true)
  assert.equal(httpBefore.url, proof.content.managed.endpoint.url)
  assert.equal(httpBefore.instanceId, proof.content.managed.endpoint.instanceId)
  assert.ok(httpBefore.bytes > 0)
  assert.equal(proof.secondOwner.runtimeId, proof.firstOwner.runtimeId)
  assert.notEqual(proof.secondOwner.ownerInstanceId, proof.firstOwner.ownerInstanceId)
  const chrome = proof.chromeReceipt
  assert.equal(chrome.operation.operation.operationId, proof.content.answer.reply.operationId)
  assert.equal(chrome.operation.operation.capsuleId, proof.content.managed.record.capsuleId)
  assert.equal(chrome.operation.operation.method, 'capsule.interaction.reply')
  assert.equal(chrome.operation.operation.result.delivery.inputOperationId, proof.content.inputKey.submissionId)
  assert.deepEqual(chrome.operation.operation.result.delivery.expectedRun, proof.originalAgent.run)
  assert.ok(['terminal-confirmed', 'admitted'].includes(chrome.operation.operation.result.delivery.inputStatus))
  assert.equal(chrome.view.open, false)
  assert.equal(chrome.view.summaryHidden, false)
  assert.equal(chrome.view.answer, proof.content.answer.answer)
  assert.ok(chrome.view.summary.includes(proof.content.question.question))
}
async function waitFor(label, read, budget = 45_000) {
  const start = Date.now()
  let announced = 0, last
  for (;;) {
    const value = await read()
    if (value) return value
    const elapsed = Date.now() - start
    if (elapsed > budget) throw new Error(`Observation unconfirmed: ${label}; last=${JSON.stringify(last)}`)
    if (elapsed > announced + 10_000) {
      announced = elapsed
      process.stderr.write('capsule-native: observing ' + label + '\n')
    }
    last = value
    await delay(80)
  }
}
async function phase(name, action) {
  process.stdout.write('capsule-native: ' + name + '\n')
  const result = await action()
  facts.phases.push({ name, result })
  await writeFile(join(output, 'facts.json'), JSON.stringify(facts, null, 2) + '\n', { mode: 0o600 })
  return result
}
async function productHashes() {
  const hashes = {}
  for (const name of ['main', 'preload', 'renderer']) {
    for (const entry of await readdir(join(build, name), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      const path = join(entry.parentPath, entry.name)
      hashes[relative(build, path)] = sha(await readFile(path))
    }
  }
  assert.ok(Object.keys(hashes).length > 5, 'The compiled product closure must be nonempty')
  return hashes
}
async function cdpConnect(url) {
  const ws = new WebSocket(url), pending = new Map(), events = new Map()
  let serial = 0
  await new Promise((done, fail) => {
    const timer = setTimeout(() => { ws.close(); fail(new Error('Private CDP connection unconfirmed')) }, 10_000)
    ws.addEventListener('open', () => { clearTimeout(timer); done() }, { once: true })
    ws.addEventListener('error', error => { clearTimeout(timer); fail(error) }, { once: true })
  })
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (message.method) {
      for (const listener of events.get(message.method) ?? []) listener(message.params)
      return
    }
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id); clearTimeout(request.timer)
    if (message.error) request.fail(new Error(message.error.message))
    else request.done(message.result)
  })
  ws.addEventListener('close', () => {
    sockets.delete(ws)
    for (const request of pending.values()) { clearTimeout(request.timer); request.fail(new Error('Original private CDP disconnected')) }
    pending.clear()
  })
  sockets.add(ws)
  const call = (method, params = {}) => new Promise((done, fail) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); fail(new Error('CDP observation unconfirmed: ' + method)) }, 20_000)
    pending.set(id, { done, fail, timer }); ws.send(JSON.stringify({ id, method, params }))
  })
  const once = method => new Promise((done, fail) => {
    const listeners = events.get(method) ?? new Set()
    events.set(method, listeners)
    const timer = setTimeout(() => { listeners.delete(listener); fail(new Error('CDP event observation unconfirmed: ' + method)) }, 20_000)
    timer.unref()
    const listener = params => { clearTimeout(timer); listeners.delete(listener); done(params) }
    listeners.add(listener)
  })
  return { call, once, close: () => ws.close(), async evaluate(expression) {
    const value = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text)
    return value.result.value
  } }
}
async function launch(label) {
  const ready = join(root, 'ready-' + label + '.json')
  const child = spawn(require('electron'), ['--inspect=0', appRoot, '--remote-debugging-port=0'], {
    cwd: desktop, detached: true, env: { ...env, AGENTMUX_DESKTOP_READY_FILE: ready }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  let logs = '', debuggerUrl, mainUrl
  const log = bytes => {
    logs = (logs + bytes).slice(-64 * 1024)
    debuggerUrl ??= /DevTools listening on (ws:\/\/\S+)/.exec(logs)?.[1]
    mainUrl ??= /Debugger listening on (ws:\/\/\S+)/.exec(logs)?.[1]
  }
  child.stdout.on('data', log); child.stderr.on('data', log)
  child.on('close', () => { void writeFile(join(output, label + '-desktop.log'), logs, { mode: 0o600 }) })
  const alive = () => { if (ended(child)) throw new Error('Private Desktop exited before observation: ' + logs) }
  await waitFor(label + ' actual Desktop ready', async () => {
    alive()
    try {
      const log = await readFile(join(userData, 'crash-log.ndjson'), 'utf8')
      const lines = log.split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line))
      const startup = lines.find(record => record.kind === 'startup-failure' && record.pid === child.pid)
      if (startup) throw new Error('Original private Desktop startup failed: ' + JSON.stringify(startup))
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    try { return JSON.parse(await readFile(ready, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }, 90_000)
  const main = await cdpConnect(await waitFor(label + ' Main inspector', () => { alive(); return mainUrl }))
  assert.deepEqual(await main.evaluate('__capsuleNative.paths()'), paths, 'Paths are set before actual Main imports')
  const debuggerAddress = new URL(await waitFor(label + ' native debugger', () => { alive(); return debuggerUrl }))
  const targets = async () => await (await fetch('http://' + debuggerAddress.host + '/json/list', { signal: AbortSignal.timeout(5000) })).json()
  const renderer = await waitFor(label + ' actual product Renderer', async () =>
    (await targets()).find(target => target.type === 'page' && target.url.startsWith(pathToFileURL(join(build, 'renderer/index.html')).href)))
  const cdp = await cdpConnect(renderer.webSocketDebuggerUrl)
  await cdp.call('Runtime.enable')
  await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true })
  await waitFor(label + ' App hydration', () => cdp.evaluate('Boolean(window.agentmux&&document.querySelector(".app-shell"))'))
  assert.equal(await cdp.evaluate('(async()=>(await window.agentmux.sessions.snapshot()).localHome)()'), env.HOME)
  return { child, main, cdp, targets, label }
}
async function connectOwner() {
  rpc = await connectAgentMuxRpc({ endpoint })
  client = await core.connectHostedAgentMux({ rpc, expectedStorePath: join(userData, 'agent-sessions.json') })
  const owner = client.runtimeOwnerIdentity()
  assert.equal(owner.availability, 'connected')
  assert.notEqual(owner.processId, process.pid)
  assert.ok(Number.isSafeInteger(owner.processId) && owner.processId > 1)
  hosts.add(owner.processId)
  return owner
}
async function call(method, params) {
  const result = await rpc.call(method, params)
  facts.calls.push({ method, params, result })
  return result
}
async function serviceObservation() {
  const observation = await waitFor('original independently serving Capsule Run', async () => {
    const current = await call('capsule.runtime.inspect', {})
    return current.phase === 'running' && current.run && current.runtime ? current : null
  })
  const native = await client.runtimeSubject({ kind: 'terminal-run', runId: observation.run.runId })
  assert.equal(native.run.runId, observation.run.runId)
  assert.equal(native.run.pid, observation.runtime.pid)
  assert.equal(native.run.kind, 'terminal')
  assert.equal(native.run.agentSessionId, null)
  assert.equal(native.run.state, 'running')
  assert.equal(await realpath(native.run.workspacePath), await realpath(observation.stateDirectory), 'Original execution Host namespace')
  return { observation, native }
}
async function readOriginalHttp(endpoint) {
  assert.equal(endpoint.status, 'available')
  const url = new URL(endpoint.url)
  assert.equal(url.protocol, 'http:')
  assert.equal(url.hostname, '127.0.0.1', 'This proof only reaches its original local execution Host')
  const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error', cache: 'no-store' })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-agentmux-capsule-instance'), endpoint.instanceId)
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.ok(bytes.includes(Buffer.from('data-proof="capsule-native"')), 'Original generated HTML bytes')
  return { url: url.href, status: response.status, instanceId: endpoint.instanceId, bytes: bytes.length, sha256: sha(bytes) }
}
async function resizeNative(app, width, height, label = 'native allocation') {
  const observation = { pid: app.child.pid, label, requested: [width, height], status: 'pending' }
  facts.resizes ??= []; facts.resizes.push(observation)
  try {
    observation.actual = await app.main.evaluate(`__capsuleNative.resize(${width},${height})`)
    observation.samples = await waitFor(label, async () => {
      const samples = await app.cdp.evaluate(`new Promise(resolve=>{const samples=[];const sample=()=>{
        samples.push({width:innerWidth,height:innerHeight,clientWidth:document.documentElement.clientWidth,clientHeight:document.documentElement.clientHeight});
        if(samples.length===3)resolve(samples);else requestAnimationFrame(sample)};requestAnimationFrame(sample)})`)
      observation.lastSamples = samples
      return samples.every(sample => sample.width === observation.actual[0] && sample.height === observation.actual[1]) &&
        samples.every(sample => JSON.stringify(sample) === JSON.stringify(samples[0])) ? samples : null
    })
    observation.status = 'ready'
    return observation.actual
  } catch (error) { observation.status = 'failed'; observation.error = error.message; throw error }
}
function assertClickReceipt(receipt) {
  for (const type of ['pointerdown', 'pointerup', 'click']) {
    const events = receipt.events.filter(event => event.type === type)
    assert.equal(events.length, 1, 'One original input event is required: ' + type)
    assert.equal(events[0].isTrusted, true, 'The original Chromium input must be trusted: ' + type)
    assert.equal(events[0].targetMatched, true, 'The original target must receive the input: ' + type)
    assert.equal(events[0].button, 0)
  }
}
async function activate(cdp, expression) {
  const id = randomUUID(), key = JSON.stringify(id), observation = { id, expression, status: 'preparing' }
  facts.clicks ??= []; facts.clicks.push(observation)
  const read = `globalThis.__capsuleClickObservers?.get(${key})?.snapshot()??null`
  try {
    observation.prepared = await cdp.evaluate(`(async()=>{
      const e=${expression};if(!e||e.disabled)return{ready:false,reason:'Original visible action unavailable'};
      e.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
      const describe=n=>n?{tag:n.tagName,id:n.id,className:String(n.className),text:n.textContent?.slice(0,160)}:null;
      const inspect=()=>{const r=e.getBoundingClientRect(),point={x:r.x+r.width/2,y:r.y+r.height/2},hit=document.elementFromPoint(point.x,point.y);
        return{ready:e.isConnected&&!e.disabled&&r.width>0&&r.height>0&&point.x>=0&&point.y>=0&&point.x<innerWidth&&point.y<innerHeight&&(hit===e||e.contains(hit)),
          point,rect:{x:r.x,y:r.y,width:r.width,height:r.height},viewport:{width:innerWidth,height:innerHeight},target:describe(e),hit:describe(hit)}};
      const samples=[];let frames=0;const stable=()=>samples.length===3&&samples.every(value=>value.ready&&JSON.stringify(value.rect)===JSON.stringify(samples.at(-1).rect)&&JSON.stringify(value.viewport)===JSON.stringify(samples.at(-1).viewport));
      while(frames<60){await new Promise(requestAnimationFrame);frames++;samples.push(inspect());if(samples.length>3)samples.shift();if(stable())break}
      const prepared={...samples.at(-1),frames};if(!stable())return{...prepared,ready:false,reason:'Original target allocation or hit-test is unconfirmed',samples};
      const events=[],types=['pointerdown','pointerup','click'];
      const listener=event=>events.push({type:event.type,isTrusted:event.isTrusted,targetMatched:event.composedPath().includes(e),button:event.button,x:event.clientX,y:event.clientY,target:describe(event.target)});
      for(const type of types)document.addEventListener(type,listener,true);
      globalThis.__capsuleClickObservers??=new Map();globalThis.__capsuleClickObservers.set(${key},{snapshot:()=>({...inspect(),events:[...events]}),cleanup:()=>{for(const type of types)document.removeEventListener(type,listener,true)}});
      return prepared
    })()`)
    assert.equal(observation.prepared.ready, true, JSON.stringify(observation.prepared))
    const before = await cdp.evaluate(read)
    observation.before = before
    assert.equal(before?.ready, true, 'The original target must still be reachable before the one click')
    assert.deepEqual(before.rect, observation.prepared.rect, 'The original target moved before dispatch')
    assert.deepEqual(before.viewport, observation.prepared.viewport, 'The original viewport changed before dispatch')
    const point = observation.prepared.point
    observation.status = 'press-requested'
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...point })
    observation.status = 'release-requested'
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...point })
    observation.receipt = await waitFor('original trusted click observation', async () => {
      const receipt = await cdp.evaluate(read)
      observation.lastReceipt = receipt
      return receipt?.events.some(event => event.type === 'click') ? receipt : null
    }, 2000)
    assertClickReceipt(observation.receipt)
    // A trusted input receipt is not a business acknowledgement. The original
    // Core operation and its consumer-specific result are still checked below.
    observation.status = 'observed'
    return observation
  } catch (error) {
    observation.status = 'failed'; observation.error = error.message
    observation.lastReceipt = await cdp.evaluate(read).catch(failure => ({ observationError: failure.message }))
    throw error
  } finally {
    await cdp.evaluate(`(()=>{const observers=globalThis.__capsuleClickObservers,observer=observers?.get(${key});observer?.cleanup();observers?.delete(${key})})()`)
      .catch(error => { observation.observerCleanupError = error.message })
  }
}
async function observeSurface(app, name, width = 1440, height = 900) {
  await resizeNative(app, width, height, name + ' native allocation')
  await delay(250)
  const readSurface = () => app.cdp.evaluate('({url:location.href,width:innerWidth,height:innerHeight,appearance:document.documentElement.dataset.appearance,regions:[...document.querySelectorAll("[data-workbench-region-id]")].filter(n=>n.getClientRects().length).map(n=>n.dataset.workbenchRegionId)})')
  if (sdkOperationOnly) return await readSurface()
  const captured = await app.main.evaluate('__capsuleNative.capture()')
  assert.equal(process.platform, 'darwin', 'This Native product fixture currently qualifies macOS window capture')
  const match = /^window:(\d+):/u.exec(captured.mediaSourceId)
  assert.ok(match, 'Exact original native window identity is required for capture')
  assert.ok(Number.isSafeInteger(Number(match[1])) && Number(match[1]) > 0, 'The private native window has a concrete OS identity')
  const pid = app.child.pid, windowId = Number(match[1]), appSelector = 'pid:' + pid
  const computer = async args => {
    let stdout, stderr, response
    try {
      ({ stdout, stderr } = await executeFile('orca', ['computer', ...args, '--json'],
        { env: captureEnvironment, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }))
      response = JSON.parse(stdout); assert.equal(response.ok, true, stdout); return response
    } catch (error) {
      const diagnostic = { frame: name, pid, nativeWindowId: match[1], command: ['orca', 'computer', ...args, '--json'],
        error: { name: error.name, message: error.message, code: error.code, signal: error.signal },
        stdout: error.stdout ?? stdout, stderr: error.stderr ?? stderr }
      try { diagnostic.response = response ?? JSON.parse(diagnostic.stdout); diagnostic.operationId = diagnostic.response.id } catch {}
      facts.captureFailures ??= []; facts.captureFailures.push(diagnostic)
      throw error
    }
  }
  const listed = await computer(['list-windows', '--app', appSelector])
  const selected = listed.result.windows.find(window => window.app.pid === pid && window.id === windowId)
  assert.ok(selected, 'The original CG window must belong to the exact private Electron PID')
  assert.equal(selected.isMinimized, false); assert.equal(selected.isOffscreen, false)
  const osCapture = await computer(['get-app-state', '--app', appSelector, '--window-id', match[1]])
  assert.equal(osCapture.result.snapshot.app.pid, pid); assert.equal(osCapture.result.snapshot.window.id, windowId)
  assert.equal(osCapture.result.screenshotStatus.state, 'captured')
  assert.equal(osCapture.result.screenshotStatus.metadata.windowId, windowId)
  const image = osCapture.result.screenshot
  const bytes = image.path ? await readFile(image.path) : Buffer.from(image.data, 'base64')
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'OS capture returns actual PNG bytes')
  assert.equal(image.format, 'png'); assert.ok(Number.isFinite(image.scale) && image.scale > 0)
  assert.equal(bytes.readUInt32BE(16), image.width); assert.equal(bytes.readUInt32BE(20), image.height)
  assert.equal(image.width, selected.width * image.scale); assert.equal(image.height, selected.height * image.scale)
  const path = join(output, 'frames', name + '.png'), metadata = join(output, 'frames', name + '.window.json')
  await writeFile(path, bytes)
  const metadataBytes = Buffer.from(JSON.stringify({ api: 'orca computer get-app-state', pid, nativeWindow: captured, listed,
    captured: { ...osCapture, result: { ...osCapture.result, screenshot: { ...image, data: undefined } } } }, null, 2) + '\n')
  await writeFile(metadata, metadataBytes)
  const reading = await readSurface()
  facts.frames.push({ name, path, sha256: sha(bytes), nativeSize: captured.size, pid, metadata, metadataSha256: sha(metadataBytes),
    capturePort: 'orca-computer-get-app-state', nativeWindowId: match[1], reading })
  return reading
}
async function pageDocument(app, endpoint) {
  assert.equal(endpoint.status, 'available')
  const target = await waitFor('actual Capsule native document', async () =>
    (await app.targets()).find(value => value.type === 'page' && value.url.startsWith(endpoint.url)))
  const document = await cdpConnect(target.webSocketDebuggerUrl)
  await document.call('Runtime.enable')
  await document.call('Emulation.setFocusEmulationEnabled', { enabled: true })
  await waitFor('original fixture content', () => document.evaluate('document.querySelector("h1")?.dataset.proof==="capsule-native"'))
  return document
}
async function writePage(source, mode) {
  await mkdir(source)
  await writeFile(join(source, 'index.html'), `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Capsule review</title><style>
*{box-sizing:border-box}body{margin:0;background:var(--bg,#f4f3ed);color:var(--text,#203329);font:16px/1.6 system-ui}main{max-width:820px;margin:auto;padding:48px 32px}header{border-bottom:1px solid #95a697;padding-bottom:24px}.eyebrow{font-size:11px;letter-spacing:.14em;text-transform:uppercase}h1{font-size:42px;line-height:1.15;font-weight:550;letter-spacing:-.04em}p{max-width:58ch}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin:28px 0}.card{border:1px solid #8da491;border-radius:12px;padding:20px}.card strong{display:block;font-size:20px}button{border:0;border-radius:8px;background:#315b43;color:#fff;padding:11px 18px;font:inherit;cursor:pointer}output{display:block;margin-top:18px;overflow-wrap:anywhere}code{font-size:12px}@media(max-width:600px){main{padding:28px 20px}h1{font-size:32px}}
</style><main><header><div class="eyebrow">Saved workspace · ${mode}</div><h1 data-proof="capsule-native">A page with a place to return to.</h1><p>The original page, its questions and the Agent recipient remain together across an App restart.</p></header><section class="cards"><div class="card"><strong>Durable identity</strong>Same page and workface.</div><div class="card"><strong>${mode === 'injected' ? 'App connection' : 'Independent container'}</strong>${mode === 'injected' ? 'Explicit theme and request capabilities.' : 'Original styling and website storage.'}</div></section><button id="request">Review this result</button><output id="status">Ready for review.</output></main><script>
globalThis.proof={themes:[],requests:[],mutations:[],nextRequestOperationId:null};document.querySelector('#request').onclick=async()=>{if(!window.capsule){document.querySelector('#status').textContent='No App channel in isolated mode';return}const operationId=proof.nextRequestOperationId??capsule.createOperationId();proof.nextRequestOperationId=null;const attempt={action:'request',operationId,params:{question:'Keep this result?',draft:'Draft from the generated page'},status:'prepared'};proof.mutations.push(attempt);try{const q=await capsule.request(attempt.params.question,attempt.params.draft,operationId);attempt.status='returned';proof.requests.push(q);document.querySelector('#status').textContent='Saved question '+q.interactionId}catch(e){attempt.status='unknown';attempt.error=String(e);document.querySelector('#status').textContent='Question result unconfirmed; inspect the original operation.'}};if(window.capsule){capsule.onThemeChanged(t=>proof.themes.push(t));capsule.theme().then(t=>proof.initialTheme=t).catch(e=>proof.themeError=String(e))}
</script></html>`)
}
async function stop(child, signal = 'SIGKILL') {
  if (ended(child)) return
  process.kill(-child.pid, signal)
  await waitFor('exact private process exit', () => ended(child), 10_000)
}

try {
  await verifyBuildReceipt(facts)
  facts.harnessSourceFiles = {}
  for (const path of [fileURLToPath(import.meta.url), providerFixture,
    join(desktop, 'scripts/package-smoke-context.mjs'), join(desktop, 'scripts/probe-process.mjs')])
    facts.harnessSourceFiles[relative(repository, path)] = sha(await readFile(path))
  facts.product = await productHashes()
  const daemon = spawn(join(repository, 'packages/core/vendor/ctxmux', process.platform + '-' + process.arch, 'bin/ctxmuxd'),
    ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(runtime, 'state', 'ctxmux'), '--readiness-fd', '3'],
    { detached: true, env, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  children.add(daemon)
  let daemonReady = '', daemonLog = ''
  daemon.stdio[3].on('data', bytes => { daemonReady += bytes })
  daemon.stderr.on('data', bytes => { daemonLog = (daemonLog + bytes).slice(-64 * 1024) })
  await waitFor('private original ctxmux', async () => {
    if (ended(daemon)) throw new Error('The original private ctxmux exited before readiness: ' + daemonLog)
    return daemonReady.includes('\n') && (await stat(join(runtime, 'ctxmux.sock'))).isSocket()
  })
  await phase('ordinary private Desktop launch', async () => {
    first = await launch('first')
    facts.firstOwner = await connectOwner()
    assert.notEqual(facts.firstOwner.processId, first.child.pid, 'The App is a client of its original Core process')
    return { pid: first.child.pid, owner: facts.firstOwner }
  })
  const nativeMinimum = await first.main.evaluate('__capsuleNative.minimum()')
  const narrowWidth = Math.max(nativeMinimum[0], 720)
  facts.nativeAllocation = { minimum: nativeMinimum, normalWidth: 1440, narrowWidth }
  session = await client.createAgent({ createOperationId: randomUUID(), executorId: 'proof', providerId: 'codex',
    commandOverride: executable, workspacePath: workspace,
    env: configuration.executors.proof.env, injectAgentMuxGuide: false, cols: 100, rows: 30 })
  await waitFor('original authenticated Provider Session', async () => {
    const current = await client.refreshAgentSession(session.agentSessionId, session.run)
    return current.nativeHandle && current.semanticStatus?.state === 'done' ? current : null
  })
  facts.originalAgent = { agentSessionId: session.agentSessionId, run: session.run }
  const catalog = (await call('space.ls', { target: {} })).catalog
  const zone = catalog.zones.find(value => value.workspaceId === 'capsule-proof')
  assert.ok(zone, 'The original private workspace has a public spatial Zone')
  const agentPlace = await call('agent.open', { operationId: randomUUID(),
    content: { kind: 'agent-session', agentSessionId: session.agentSessionId },
    destination: { zoneId: zone.zoneId, newTab: true }, focus: true })
  assert.equal(agentPlace.to?.regionId !== undefined, true)
  facts.agentPlace = agentPlace
  const initialRuntime = await call('capsule.runtime.inspect', {})
  assert.equal(initialRuntime.desired, 'unconfigured')
  const startParams = { operationId: randomUUID(), expectedRevision: initialRuntime.revision }
  const startReceipt = await call('capsule.runtime.start', startParams)
  assert.equal(startReceipt.desired, 'running')
  assert.equal(startReceipt.operation?.operationId, startParams.operationId)
  const startConfirmed = await waitFor('original explicit Capsule Start', async () => {
    const current = await call('capsule.runtime.inspect', {})
    assert.equal(current.operation?.operationId, startParams.operationId)
    assert.equal(current.operation?.kind, 'start')
    return current.desired === 'running' && current.phase === 'running' &&
      current.operation.phase === 'confirmed' && current.run && current.runtime ? current : null
  })
  facts.initialServiceStart = { before: initialRuntime, params: startParams, receipt: startReceipt, confirmed: startConfirmed }
  const initialConfig = await call('capsule.config.inspect', {})
  const longRoot = join(workspace, 'published-agent-pages', 'quarterly-research-and-decision-records',
    'original-project-review-surfaces', 'managed-artifacts-retained-across-desktop-restarts')
  await call('capsule.config.update', { operationId: randomUUID(), expectedRevision: initialConfig.config.revision,
    changes: { contentRoot: longRoot } })
  facts.longRoot = longRoot
  const managedSource = join(workspace, 'managed-source'), pathSource = join(workspace, 'path-source')
  await writePage(managedSource, 'injected'); await writePage(pathSource, 'isolated')
  const target = { hostId: 'local', agentSessionId: session.agentSessionId }
  const managed = await call('capsule.create', { operationId: randomUUID(), sourcePath: managedSource, title: 'Saved review', storageMode: 'managed', mode: 'injected', theme: 'follow', target })
  const isolated = await call('capsule.create', { operationId: randomUUID(), sourcePath: pathSource, title: 'Independent reference', storageMode: 'path', mode: 'isolated', theme: 'none', target })
  const serviceBefore = await serviceObservation()
  assert.notEqual(serviceBefore.native.run.runId, session.run.runId, 'The page service is a separate ordinary Run')
  assert.notEqual(serviceBefore.observation.runtime.pid, first.child.pid)
  assert.notEqual(serviceBefore.observation.runtime.pid, facts.firstOwner.processId)
  facts.service = { before: serviceBefore, httpBefore: await readOriginalHttp(managed.endpoint) }
  await rm(managedSource, { recursive: true })
  const isolatedOpen = await call('capsule.open', { capsuleId: isolated.record.capsuleId, operationId: randomUUID() })
  assert.equal(isolatedOpen.rendering.status, 'available')
  const isolatedDocument = await pageDocument(first, isolatedOpen.endpoint)
  const pathEntry = join(pathSource, 'index.html')
  await writeFile(pathEntry, (await readFile(pathEntry, 'utf8')).replace('</main>', '<p id="path-live">The original configured directory is live.</p></main>'))
  await isolatedDocument.call('Page.enable')
  const pathReloaded = isolatedDocument.once('Page.loadEventFired')
  void pathReloaded.catch(() => {})
  await isolatedDocument.call('Page.reload', { ignoreCache: true })
  await pathReloaded
  await waitFor('configured path source is the actual Native document', () => isolatedDocument.evaluate('Boolean(document.querySelector("#path-live"))'))
  const isolatedFacts = await isolatedDocument.evaluate('({sdk:typeof window.capsule,bg:getComputedStyle(document.body).backgroundColor,token:document.documentElement.style.getPropertyValue("--bg")})')
  assert.equal(isolatedFacts.sdk, 'undefined')
  assert.equal(isolatedFacts.token, '')
  await isolatedDocument.evaluate('localStorage.setItem("capsule-proof-isolation","isolated-only")')
  await observeSurface(first, 'isolated-native')
  const openParams = { capsuleId: managed.record.capsuleId, operationId: randomUUID() }
  const opened = await call('capsule.open', openParams)
  assert.equal(opened.rendering.status, 'available')
  const browserRegion = `document.querySelector('[data-workbench-region-id="${opened.rendering.regionId}"]')`
  const document = await pageDocument(first, opened.endpoint)
  const capabilities = await document.evaluate('capsule.capabilities()')
  assert.deepEqual(capabilities, { version: 1, theme: true, interaction: true, humanReply: false })
  const containers = await first.main.evaluate('__capsuleNative.documents()')
  const nativeIsolated = containers.find(value => value.url.startsWith(isolated.endpoint.url))
  const nativeInjected = containers.find(value => value.url.startsWith(managed.endpoint.url))
  assert.ok(nativeIsolated && nativeInjected, 'Both original native documents must exist')
  assert.notEqual(nativeIsolated.sessionClass, nativeInjected.sessionClass, 'Capsules use independent native website containers')
  assert.equal(nativeIsolated.defaultSession, false)
  assert.equal(nativeInjected.defaultSession, false)
  assert.equal(await document.evaluate('localStorage.getItem("capsule-proof-isolation")'), null)
  const requestBefore = await document.evaluate('(()=>{proof.nextRequestOperationId=capsule.createOperationId();return{operationId:proof.nextRequestOperationId,mutationCount:proof.mutations.length}})()')
  const requestOperationId = requestBefore.operationId
  facts.sdkOperationRecovery = { schema: 'agentmux.capsule.sdk-operation-recovery.v1', action: 'request',
    operationId: requestOperationId, senderId: nativeInjected.id, before: requestBefore }
  await first.main.evaluate(`__capsuleNative.armReceiptLoss(${JSON.stringify({ action: 'request', operationId: requestOperationId, senderId: nativeInjected.id })})`)
  const requestClick = await activate(document, 'document.querySelector("#request")')
  facts.sdkOperationRecovery.clickId = requestClick.id
  const requestAfter = await waitFor('actual ContextBridge loses one original post-effect receipt', () => document.evaluate('proof.mutations[0]?.status==="unknown"?proof.mutations[0]:null'))
  facts.sdkOperationRecovery.after = requestAfter
  facts.sdkOperationRecovery.receipts = await first.main.evaluate('__capsuleNative.documentReceipts()')
  assert.equal(requestAfter.operationId, requestOperationId, 'The page keeps the same ID without reading Error properties')
  assert.equal(await document.evaluate('proof.requests.length'), 0, 'The real bridge did not return a successful mutation result')
  const requestObserved = await document.evaluate('(async()=>{const operation=await capsule.inspectOperation(proof.mutations[0].operationId);if(operation?.status==="committed"){proof.requests.push(operation.result.interaction);document.querySelector("#status").textContent="Recovered saved question "+operation.result.interaction.interactionId}return operation})()')
  assert.equal(requestObserved.status, 'committed')
  assert.equal(requestObserved.operationId, requestOperationId)
  const question = requestObserved.result.interaction
  assert.deepEqual(question.target, target)
  Object.assign(facts.sdkOperationRecovery, { operation: requestObserved,
    publicOperation: await call('capsule.operation.inspect', { operationId: requestOperationId }),
    interactions: (await call('capsule.interaction.ls', { capsuleId: managed.record.capsuleId })).interactions })
  const missingIdentityBefore = await first.main.evaluate('__capsuleNative.documentReceipts().calls.filter(call=>["request","saveDraft"].includes(call.action))')
  const missingIdentityPage = await document.evaluate(`(async()=>{const observed={};for(const [action,invoke]of [
    ['request',()=>capsule.request('Missing original ID','Never applied')],
    ['saveDraft',()=>capsule.saveDraft(${JSON.stringify(question.interactionId)},${question.revision},'Never applied')]
  ]){try{await invoke();observed[action]={rejected:false}}catch(error){observed[action]={rejected:true,error:String(error)}}}return observed})()`)
  const missingIdentityAfter = await first.main.evaluate('__capsuleNative.documentReceipts().calls.filter(call=>["request","saveDraft"].includes(call.action))')
  facts.sdkOperationRecovery.missingIdentity = { before: missingIdentityBefore, page: missingIdentityPage, after: missingIdentityAfter }
  assert.equal(missingIdentityPage.request.rejected, true)
  assert.equal(missingIdentityPage.saveDraft.rejected, true)
  assert.deepEqual(missingIdentityAfter, missingIdentityBefore, 'Missing operation IDs never reach the original Main handler')
  const draftAttempt = await document.evaluate(`(async()=>{const operationId=capsule.createOperationId();proof.draftOperationId=operationId;const interaction=await capsule.saveDraft(${JSON.stringify(question.interactionId)},${question.revision},'Preserved page draft',operationId);return{operationId,interaction}})()`)
  const draft = draftAttempt.interaction
  facts.sdkOperationRecovery.draft = { operationId: draftAttempt.operationId,
    operation: await document.evaluate(`capsule.inspectOperation(${JSON.stringify(draftAttempt.operationId)})`) }
  assert.equal(draft.draft, 'Preserved page draft')
  assert.equal((await document.evaluate(`capsule.inspectOperation(${JSON.stringify(question.operationId)})`)).capsuleId, managed.record.capsuleId)
  await activate(first.cdp, `${browserRegion}.querySelector('[aria-label="Page questions"]')`)
  await waitFor('App chrome original saved draft', () => first.cdp.evaluate(`${browserRegion}.querySelector('.capsule-question textarea')?.value==='Preserved page draft'`))
  const normal = await observeSurface(first, 'managed-question-normal')
  const narrow = await observeSurface(first, 'managed-question-narrow', narrowWidth, 900)
  assert.ok(narrow.width < normal.width, 'Narrow screenshot must consume a smaller real native allocation')
  await resizeNative(first, 1440, 900)
  await activate(first.cdp, `${browserRegion}.querySelector('.capsule-question__confirm')`)
  const answer = await waitFor('original Core input delivery', async () => {
    const value = await call('capsule.interaction.inspect', { capsuleId: managed.record.capsuleId, interactionId: question.interactionId })
    return value.interaction.reply?.delivery.status === 'submitted' ? value.interaction : null
  })
  assert.equal(answer.answer, 'Preserved page draft')
  assert.deepEqual(answer.reply.delivery.expectedRun, session.run)
  const inputKey = { kind: 'prompt', agentSessionId: session.agentSessionId, expectedRun: session.run, submissionId: answer.reply.delivery.inputOperationId }
  const originalInput = await waitFor('original Core confirmed input', async () => {
    const value = await call('agent.input.inspect', { key: inputKey })
    return ['terminal-confirmed', 'admitted'].includes(value.input?.status) && value.record?.admission ? value : null
  })
  assert.deepEqual(originalInput.input.key, inputKey)
  assert.equal(originalInput.input.persistence, 'confirmed')
  const intent = originalInput.record?.admission?.intent
  assert.ok(intent && intent.message?.authorHuman === true, 'Human attribution must come from the original Core input receipt')
  assert.equal(intent.message.sourceChannel, 'question-reply')
  assert.ok(intent.prompt.includes('Preserved page draft'))
  const providerBytes = await waitFor('original Provider receives the confirmed manual bytes', async () => {
    try {
      const rows = (await readFile(join(controls, session.agentSessionId + '.requests.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
      const bytes = rows.filter(row => typeof row.manualInput === 'string').map(row => row.manualInput).join('')
      return bytes.includes('Preserved page draft') ? bytes : null
    } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  })
  // Read the original operation through actual App chrome, then inspect its native
  // presentation. A registered input is not automatically a completed Agent task.
  const answerChrome = `[...${browserRegion}.querySelectorAll('.capsule-question')].find(e=>e.querySelector('textarea')?.getAttribute('aria-label')===${JSON.stringify('Answer to ' + question.question)})`
  if (!await first.cdp.evaluate(`${answerChrome}.querySelector('.capsule-question__history').open`))
    await activate(first.cdp, `${answerChrome}.querySelector('.capsule-question__history > summary')`)
  await activate(first.cdp, `[...${answerChrome}.querySelectorAll('button')].find(e=>e.textContent==='Inspect original operation')`)
  const answerView = await waitFor('native App shows the original confirmed input as folded history', async () => {
    const view = await first.cdp.evaluate(`(()=>{const article=${answerChrome},history=article.querySelector('.capsule-question__history'),summary=history.querySelector('summary');return{open:history.open,summary:summary.textContent,summaryHidden:summary.hidden,answer:article.querySelector('textarea').value}})()`)
    return !view.open && !view.summaryHidden && ['terminal input confirmed', 'input admitted by Provider'].some(label => view.summary.includes(label)) ? view : null
  })
  assert.equal(answerView.answer, answer.answer)
  const answerOperation = await call('capsule.operation.inspect', { operationId: answer.reply.operationId })
  assert.equal(answerOperation.operation.operationId, answer.reply.operationId)
  assert.equal(answerOperation.operation.result.delivery.inputOperationId, inputKey.submissionId)
  facts.chromeReceipt = { operation: answerOperation, view: answerView }
  // A second pending request supplies a distinct unsent durable draft across death.
  const pendingAttempt = await document.evaluate('(async()=>{const operationId=capsule.createOperationId();proof.pendingOperationId=operationId;const interaction=await capsule.request("Continue after restart?","Unsent draft retained",operationId);return{operationId,interaction}})()')
  const pending = pendingAttempt.interaction
  facts.sdkOperationRecovery.pending = { operationId: pendingAttempt.operationId,
    operation: await document.evaluate(`capsule.inspectOperation(${JSON.stringify(pendingAttempt.operationId)})`) }
  await activate(first.cdp, `${browserRegion}.querySelector('.capsule-chrome__heading button')`)
  await waitFor('App chrome preserves the second pending question', () => first.cdp.evaluate(`[...${browserRegion}.querySelectorAll('.capsule-question textarea')].some(n=>n.value===${JSON.stringify(pending.draft)})`))
  facts.themeTransitions = []
  for (const appearance of ['light', 'dark']) {
    await first.cdp.evaluate(`(async()=>{const c=await window.agentmux.config.get();return window.agentmux.config.save({...c,appearance:{...c.appearance,appAppearance:${JSON.stringify(appearance)}}},c)})()`)
    const projected = await waitFor('injected theme projection ' + appearance, () => document.evaluate(`(()=>{
      const theme=proof.themes.at(-1),root=document.documentElement
      if(theme?.mode!==${JSON.stringify(appearance)})return null
      const tokens=Object.fromEntries(Object.keys(theme.tokens).map(name=>[name,root.style.getPropertyValue(name)]))
      const projection={theme,tokens,background:root.style.getPropertyValue("--bg"),colorScheme:root.style.getPropertyValue("color-scheme")}
      return Object.keys(tokens).length>0&&projection.colorScheme===${JSON.stringify(appearance)}&&Object.entries(theme.tokens).every(([name,value])=>tokens[name]===value)?projection:null
    })()`))
    assert.equal(projected.theme.mode, appearance)
    assert.deepEqual(projected.tokens, projected.theme.tokens)
    assert.equal(projected.background, projected.theme.tokens['--bg'])
    assert.equal(projected.colorScheme, appearance)
    facts.themeTransitions.push(projected)
    assert.deepEqual(await isolatedDocument.evaluate('({sdk:typeof window.capsule,bg:getComputedStyle(document.body).backgroundColor,token:document.documentElement.style.getPropertyValue("--bg")})'), isolatedFacts)
    await observeSurface(first, 'capsule-hitl-' + appearance + '-normal')
    await observeSurface(first, 'capsule-hitl-' + appearance + '-narrow', narrowWidth, 900)
    await resizeNative(first, 1440, 900)
  }
  facts.content = { managed, managedSourceRemoved: true, isolated, pathSourceObservedLive: true,
    opened, isolatedOpen, question, draft, pending, answer, inputKey, originalInput, providerBytes, capabilities, containers }
  const beforeGraph = await call('space.state', {})
  const originalRegion = beforeGraph.state.graph.regions.find(region => region.regionId === opened.rendering.regionId)
  assert.equal(originalRegion.browserId, opened.rendering.browserId)
  assert.equal(beforeGraph.state.graph.resources['region:' + originalRegion.regionId].capsuleId, managed.record.capsuleId)
  facts.beforeRegion = originalRegion
  // Capture the actual Settings and Toolkit consumers, rather than mounting components.
  await activate(first.cdp, 'document.querySelector("button[aria-label=Settings]")')
  await waitFor('Settings navigation', () => first.cdp.evaluate('Boolean(document.querySelector("button[data-settings-target=capsule]"))'))
  await activate(first.cdp, 'document.querySelector("button[data-settings-target=capsule]")')
  await waitFor('real Capsule Settings owner result', () => first.cdp.evaluate('document.querySelector(".capsule-settings__pages")?.innerText.includes("Saved review")&&document.querySelector(".capsule-settings__pages")?.innerText.includes("Independent reference")'))
  await observeSurface(first, 'capsule-settings-normal')
  await observeSurface(first, 'capsule-settings-narrow', narrowWidth, 900)
  await resizeNative(first, 1440, 900)
  await activate(first.cdp, '[...document.querySelectorAll(".capsule-settings__pages button")].find(n=>n.textContent.includes("Saved review"))')
  await activate(first.cdp, 'document.querySelector(".capsule-settings__detail details > summary")')
  await observeSurface(first, 'capsule-settings-page-detail-normal')
  await observeSurface(first, 'capsule-settings-page-detail-narrow', narrowWidth, 900)
  await resizeNative(first, 1440, 900)
  await activate(first.cdp, 'document.querySelector("button[aria-label=\\"Close settings\\"]")')
  const toolkitId = 'capsule-proof-tool', channelModule = pathToFileURL(join(repository, 'packages/core/dist/toolkit-result-channel.js')).href
  const toolDocument = { schema: 'agentmux.toolkit.result.v1', summary: 'Saved review', items: [], links: [], notice: '', capsules: [{ label: 'Review page', capsuleId: managed.record.capsuleId }] }
  const script = `const {connectToolkitResultChannel}=await import(${JSON.stringify(channelModule)});const c=await connectToolkitResultChannel();const closed=new Promise((resolve,reject)=>{c.once('close',resolve);c.once('error',reject)});c.end(${JSON.stringify(JSON.stringify(toolDocument) + '\n')});await closed;`
  const tool = await first.cdp.evaluate(`window.agentmux.toolkit.add(${JSON.stringify(toolkitId)},${JSON.stringify({ name: 'Capsule proof', icon: 'terminal', enabled: true, statusBar: 'label', workspacePath: workspace, script, args: [] })})`)
  assert.equal(tool.ok, true, JSON.stringify(tool))
  await first.cdp.evaluate(`(async()=>{const s=await window.agentmux.toolkit.get(${JSON.stringify(toolkitId)});return window.agentmux.toolkit.run(${JSON.stringify(toolkitId)},{invocationId:${JSON.stringify(randomUUID())},expectedRevision:s.definition.revision,expectedLatestExecutionId:null})})()`)
  const toolkitResult = await waitFor('original Toolkit confirmed result', () => first.cdp.evaluate(`(async()=>{const s=await window.agentmux.toolkit.get(${JSON.stringify(toolkitId)});return s.latestConfirmed?.document?.capsules?.[0]?.capsuleId===${JSON.stringify(managed.record.capsuleId)}?s:null})()`))
  await activate(first.cdp, '[...document.querySelectorAll("button")].find(n=>n.getAttribute("title")==="Capsule proof"||n.getAttribute("aria-label")==="Capsule proof")')
  await waitFor('actual Toolkit Capsule consumer', () => first.cdp.evaluate(`Boolean(document.querySelector('[data-toolkit-capsule="${managed.record.capsuleId}"]'))`))
  await observeSurface(first, 'capsule-toolkit-normal')
  await observeSurface(first, 'capsule-toolkit-narrow', narrowWidth, 900)
  await resizeNative(first, 1440, 900)
  const toolkitClick = await activate(first.cdp, `document.querySelector('[data-toolkit-capsule="${managed.record.capsuleId}"] .toolkit-capsules__main button')`)
  const toolkitOpen = await waitFor('Toolkit opens the exact original Capsule without rerunning', async () => {
    const { state } = await call('space.state', {})
    const resource = state.graph.resources['region:' + originalRegion.regionId]
    const before = beforeGraph.state.graph.resources['region:' + originalRegion.regionId].capsuleOpenOperationIds
    const added = resource.capsuleOpenOperationIds.filter(id => !before.includes(id))
    if (added.length !== 1) return null
    const { operation } = await call('capsule.operation.inspect', { operationId: added[0] })
    return operation?.status === 'committed' ? operation : null
  })
  assert.equal(toolkitOpen.capsuleId, managed.record.capsuleId)
  assert.equal(toolkitOpen.result.rendering.browserId, opened.rendering.browserId)
  const toolkitAfter = await first.cdp.evaluate(`window.agentmux.toolkit.get(${JSON.stringify(toolkitId)})`)
  assert.equal(toolkitAfter.latestConfirmed.executionId, toolkitResult.latestConfirmed.executionId)
  facts.toolkit = { tool, toolkitResult, toolkitOpen, toolkitAfter, clickId: toolkitClick.id }
  facts.sdkOperationRecovery.receipts = await first.main.evaluate('__capsuleNative.documentReceipts()')
  await first.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await first.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await phase('SIGKILL original Host and Desktop; retain ctxmux Run', async () => {
    await client.dispose(); client = null; await rpc.dispose(); rpc = null
    // Close the App first so it cannot start another Core while we prove the
    // original Core's absence. Neither operation owns the independent service.
    await stop(first.child)
    const hostSignalApplied = await signalOwnedProbeProcess(facts.firstOwner.processId, root, 'SIGKILL')
    facts.service.originalCoreExited = await waitFor('original private Core process actually exited', () => {
      try { process.kill(facts.firstOwner.processId, 0); return false }
      catch (error) { if (error.code === 'ESRCH') return true; throw error }
    }, 10_000)
    facts.service.whileCoreDetached = await readOriginalHttp(managed.endpoint)
    assert.deepEqual(facts.service.whileCoreDetached, facts.service.httpBefore, 'The exact independent HTTP document survives Core/App death')
    return { hostPid: facts.firstOwner.processId, desktopPid: first.child.pid, hostSignalApplied,
      originalCoreExited: facts.service.originalCoreExited, service: facts.service.before.observation,
      http: facts.service.whileCoreDetached, signal: 'SIGKILL' }
  })
  second = await launch('second')
  facts.secondOwner = await connectOwner()
  assert.notEqual(facts.secondOwner.processId, second.child.pid)
  assert.notEqual(facts.secondOwner.processId, facts.firstOwner.processId)
  assert.equal(facts.secondOwner.runtimeId, facts.firstOwner.runtimeId)
  assert.notEqual(facts.secondOwner.ownerInstanceId, facts.firstOwner.ownerInstanceId)
  facts.service.after = await serviceObservation()
  assert.deepEqual(facts.service.after.observation.run, facts.service.before.observation.run)
  assert.deepEqual(facts.service.after.observation.runtime, facts.service.before.observation.runtime)
  assert.equal(facts.service.after.native.run.runId, facts.service.before.native.run.runId)
  assert.equal(facts.service.after.native.run.pid, facts.service.before.native.run.pid)
  facts.service.httpAfter = await readOriginalHttp(managed.endpoint)
  assert.deepEqual(facts.service.httpAfter, facts.service.httpBefore)
  const recovered = await call('capsule.inspect', { capsuleId: managed.record.capsuleId })
  assert.equal(recovered.endpoint.url, managed.endpoint.url)
  assert.equal(recovered.endpoint.instanceId, managed.endpoint.instanceId, 'Reconnecting Core cannot restart the independent service')
  const graph = await waitFor('original durable Browser Region after process death', async () => {
    const current = await call('space.state', {})
    return current.state?.graph.regions.find(region => region.regionId === opened.rendering.regionId) ? current : null
  })
  assert.deepEqual(graph.state.graph.regions.find(region => region.regionId === opened.rendering.regionId), originalRegion)
  assert.equal(graph.state.graph.regions.find(region => region.regionId === isolatedOpen.rendering.regionId)?.browserId, isolatedOpen.rendering.browserId)
  assert.equal(graph.state.graph.regions.find(region => region.regionId === agentPlace.to.regionId)?.agentSessionId, session.agentSessionId)
  await waitFor('original native Browser workface automatically restored', () => second.cdp.evaluate(`Boolean(document.querySelector('[data-workbench-region-id="${opened.rendering.regionId}"] .capsule-chrome'))`))
  const recoveredDocument = await pageDocument(second, recovered.endpoint)
  const recoveredPending = await recoveredDocument.evaluate(`capsule.read(${JSON.stringify(pending.interactionId)})`)
  assert.equal(recoveredPending.draft, pending.draft)
  assert.deepEqual(recoveredPending.target, target)
  const recoveredAnswer = await call('capsule.interaction.inspect', { capsuleId: managed.record.capsuleId, interactionId: question.interactionId })
  assert.equal(recoveredAnswer.interaction.reply.delivery.inputOperationId, inputKey.submissionId)
  assert.deepEqual((await call('agent.input.inspect', { key: inputKey })).input.key, inputKey)
  const originalRun = (await client.listRuns()).find(run => run.runId === session.run.runId)
  assert.equal(originalRun.state, 'running')
  const restoredSession = await client.refreshAgentSession(session.agentSessionId, session.run)
  assert.equal(restoredSession.agentSessionId, session.agentSessionId)
  assert.deepEqual(restoredSession.run, session.run)
  const originalOpen = await call('capsule.operation.inspect', { operationId: openParams.operationId })
  assert.equal(originalOpen.operation.status, 'committed')
  assert.deepEqual(originalOpen.operation.result.rendering, opened.rendering)
  await activate(second.cdp, `${browserRegion}.querySelector('[aria-label="Page questions"]')`)
  await waitFor('restored original unsent draft in App chrome', () => second.cdp.evaluate(`[...${browserRegion}.querySelectorAll('.capsule-question textarea')].some(n=>n.value===${JSON.stringify(pending.draft)})`))
  await observeSurface(second, 'capsule-restored-normal')
  await observeSurface(second, 'capsule-restored-narrow', narrowWidth, 900)
  const sdkOriginalOperation = await call('capsule.operation.inspect', { operationId: requestOperationId })
  facts.recovery = { recovered, graph, recoveredPending, recoveredAnswer, originalOpen, originalRun, restoredSession, sdkOriginalOperation }
  assert.deepEqual(await productHashes(), facts.product, 'The consumed compiled product remained unchanged')
  assert.deepEqual(await verifyBuildReceipt(), facts.buildReceipt, 'The full consumed source, dependency and compiler receipt stayed unchanged')
  for (const [path, expected] of Object.entries(facts.harnessSourceFiles))
    assert.equal(sha(await readFile(join(repository, path))), expected, 'Actual fixture stayed unchanged during Native verification')
  facts.phases.push({ name: 'original Native workface restored', result: { capsuleId: recovered.record.capsuleId,
    browserId: opened.rendering.browserId, regionId: opened.rendering.regionId,
    interactionId: pending.interactionId, run: session.run, originalOpenOperationId: openParams.operationId } })
  assertSdkOperationRecovery(facts)
  assertServiceContinuity(facts)
  facts.result = 'passed'
} catch (error) {
  failure = error
  facts.result = 'failed'
  facts.error = { message: error.message, stack: error.stack }
} finally {
  if (session && client) {
    try { await client.stopAgent(session.agentSessionId, session.run); facts.cleanup.originalRunStopped = true }
    catch (error) { facts.cleanup.stopError = error.message }
  }
  try {
    if (!rpc) rpc = await connectAgentMuxRpc({ endpoint })
    const observation = await rpc.call('capsule.runtime.inspect', {})
    if (observation.desired === 'unconfigured') {
      assert.equal(facts.service, undefined, 'An observed service binding cannot disappear during cleanup')
      facts.cleanup.serviceNeverConfigured = true
    }
    else {
      if (facts.service?.before) {
        assert.equal(observation.stateDirectory, facts.service.before.observation.stateDirectory)
        if (observation.runtime) assert.equal(observation.runtime.runtimeId, facts.service.before.observation.runtime.runtimeId)
      }
      if (facts.service?.after) assert.deepEqual(observation.run, facts.service.after.observation.run, 'Cleanup retains the observed service Run fence')
      const params = { operationId: randomUUID(), expectedRevision: observation.revision, expectedRun: observation.run ? { runId: observation.run.runId } : null }
      facts.cleanup.serviceStop = { params }
      // Dispatch once. Lost acknowledgement only permits inspecting the same
      // retained stopped intent; cleanup must not mint a replacement Stop.
      try { facts.cleanup.serviceStop.receipt = await rpc.call('capsule.runtime.stop', params) }
      catch (error) { facts.cleanup.serviceStop.observationError = error.message }
      const confirmed = await waitFor('original private Capsule service Stop', async () => {
        const current = await rpc.call('capsule.runtime.inspect', {})
        if (current.operation?.operationId !== params.operationId) throw new Error('The private service Stop no longer observes its original operation')
        return current.desired === 'stopped' && current.phase === 'stopped' && current.operation.phase === 'confirmed' ? current : null
      }, 15_000)
      facts.cleanup.serviceStop.confirmed = confirmed
      facts.cleanup.serviceRunStopped = true
    }
  } catch (error) { facts.cleanup.serviceStopError = error.message }
  await client?.dispose().catch(() => {})
  await rpc?.dispose().catch(() => {})
  for (const socket of sockets) socket.close()
  for (const pid of hosts) {
    try { await signalOwnedProbeProcess(pid, root, 'SIGKILL') }
    catch (error) { if (error.code !== 'ESRCH') facts.cleanup.hostError = error.message }
  }
  for (const child of [...children].reverse()) {
    try { await stop(child) }
    catch (error) { facts.cleanup.processError = error.message }
  }
  try {
    // This inventory is cleanup-only. Runtime state and input conclusions above
    // come exclusively from the public original Core/ctxmux owners.
    await stopProbeProcesses(undefined, root)
    facts.cleanup.remainingOwnedProcesses = await listProbeProcesses(undefined, root)
  } catch (error) { facts.cleanup.processError = error.message }
  facts.cleanup.privateProcessesExited = [...children].every(ended)
  facts.cleanup.evidenceRetained = true
  if (facts.cleanup.stopError || facts.cleanup.serviceStopError || facts.cleanup.hostError || facts.cleanup.processError) {
    failure ??= new Error('Exact private process cleanup was not confirmed')
    facts.result = 'failed'
  }
  await writeFile(join(output, 'facts.json'), JSON.stringify(facts, null, 2) + '\n', { mode: 0o600 })
}
if (failure) {
  process.stderr.write(failure.stack + '\n')
  process.exitCode = 1
} else process.stdout.write(sdkOperationOnly
  ? 'Capsule SDK Native boundary proof passed; OS capture and new visual review were not requested.\n'
  : 'Capsule native product proof passed; screenshots await independent visual review.\n')
