import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, readdir, symlink } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { desktopFixture, click } from '../../desktop/scripts/fixtures/settings-cli/desktop.mjs'
import { listProbeProcesses, signalOwnedProbeProcess } from '../../desktop/scripts/probe-process.mjs'
import ts from 'typescript'

const repository = resolve(import.meta.dirname, '../../..')
const output = join(repository, '.tmp/private-mobile-host')
await mkdir(output, { recursive: true })
const hash = value => createHash('sha256').update(value).digest('hex')
const execFileAsync = promisify(execFile)
const evidence = { schema: 'agentmux.host-desktop-adoption.v1', passed: false, attempts: [] }
const sourceFiles = ['packages/core/src/hosted-client-contract.ts', 'packages/core/src/hosted-client.ts',
  'packages/core/src/hosted-runtime-service.ts', 'packages/core/src/hosted-value.ts', 'packages/core/src/hosted.ts',
  'packages/core/src/hosted-output-observer.ts', 'packages/core/package.json',
  'apps/host/src/host.ts', 'apps/host/src/index.ts', 'apps/desktop/src/main/desktop-host.ts',
  'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/main/index.ts',
  'apps/desktop/src/main/ipc.ts', 'apps/desktop/electron.vite.config.ts',
  'apps/host/scripts/verify-host-desktop-adoption.mjs']
evidence.inputs = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, hash(await readFile(join(repository, file)))])))

async function run(desktopRoot, coreRoot) {
  const root = await mkdtemp(join(tmpdir(), 'amx-host-adoption-')), privateHome = join(root, 'home')
  const userData = join(root, 'user-data'), runtime = join(root, 'runtime'), workspace = join(root, 'workspace')
  const storePath = join(userData, 'agent-sessions.json'), hostLog = join(userData, 'agentmux-host.log')
  const environment = { HOME: privateHome, CODEX_HOME: join(privateHome, 'codex'),
    AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: join(root, 'state'),
    AGENTMUX_DESKTOP_USER_DATA: userData, AGENTMUX_MESSAGE_QUEUE_PATH: join(userData, 'messages.ndjson') }
  const previous = new Map(Object.keys(environment).map(key => [key, process.env[key]]))
  const children = new Set(), connections = new Set(), consumers = new Set(), rpcConnections = new Set()
  const attempt = { passed: false, desktopRoot, coreRoot, phases: [], cleanup: {} }
  const artifactFiles = [join(desktopRoot, 'out/main/index.js'), join(desktopRoot, 'out/main/agentmux-host.js'),
    join(desktopRoot, 'out/preload/index.cjs'), join(desktopRoot, 'out/renderer/index.html'),
    ...['index.js', 'hosted.js', 'hosted-client.js', 'hosted-runtime-service.js', 'hosted-output-observer.js',
      'public-rpc-service.js', 'public-rpc-server.js', 'public-rpc-wire.js'].map(file => join(coreRoot, 'dist', file))]
  const artifactHashes = async () => Object.fromEntries(await Promise.all(artifactFiles.map(async file => [file, hash(await readFile(file))])))
  attempt.artifacts = await artifactHashes()
  let core, hostedSdk, original, firstClient, oldControl, failure
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
  const ownProcesses = () => listProbeProcesses(process.pid + 1_000_000_000, root)
  async function stopOwnProcesses() {
    // A previous detached child can have exited and its numeric PID can be reused.
    // The unique private namespace, rechecked for each PID, is the cleanup authority.
    for (const pid of await ownProcesses()) await signalOwnedProbeProcess(pid, root, 'SIGTERM')
    const gracefulDeadline = Date.now() + 1000
    while ((await ownProcesses()).length && Date.now() < gracefulDeadline) await delay(50)
    for (const pid of await ownProcesses()) await signalOwnedProbeProcess(pid, root, 'SIGKILL')
    const killedDeadline = Date.now() + 2000
    while ((await ownProcesses()).length && Date.now() < killedDeadline) await delay(50)
    attempt.cleanup.remaining = await ownProcesses()
    assert.deepEqual(attempt.cleanup.remaining, [], 'All and only this proof namespace has exited')
  }
  async function waitFor(label, read, budget = 25_000) {
    const end = Date.now() + budget
    while (Date.now() < end) { const value = await read(); if (value) return value; await delay(50) }
    assert.fail(`Private Host proof: ${label} was not observed`)
  }
  const phase = name => attempt.phases.push(name)
  async function connect() {
    const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(runtime, 'control.sock') } })
    rpcConnections.add(rpc)
    const sdk = await hostedSdk.connectHostedAgentMux({ rpc, expectedStorePath: storePath })
    consumers.add(sdk)
    return { sdk, rpc }
  }
  async function runFact(client) {
    const run = (await client.listRuns()).find(value => value.runId === original.run.runId)
    assert.equal(run?.state, 'running', 'The original healthy Run must remain alive')
    assert.equal(run.pid, attempt.originalRun.pid, 'The original process must not be replaced')
    assert.equal(client.agentSession(original.agentSessionId).run.runId, original.run.runId)
    return run
  }
  async function quit(probe) {
    try { await probe.main.evaluate(`process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot, 'package.json'))})('electron').app.quit()`) }
    catch { /* An ordinary quit may close its inspector before the reply. */ }
    probe.main.close(); probe.cdp.close()
    await waitFor('ordinary Desktop process exit', () => probe.child.exitCode !== null || probe.child.signalCode !== null)
    assert.equal(probe.child.exitCode, 0); assert.equal(probe.child.signalCode, null)
    children.delete(probe.child)
    return probe.child.pid
  }
  async function durableSurface(probe, seed) {
    const regions = await waitFor('actual nonempty original Regions', async () => {
      const regions = await probe.cdp.evaluate(`Array.from(document.querySelectorAll('[data-workbench-region-id]')).filter(e=>e.getClientRects().length).map(e=>e.dataset.workbenchRegionId).sort()`)
      return regions.includes('host-agent-region') && regions.includes('host-file-region') ? regions : null
    })
    assert.deepEqual(regions, ['host-agent-region', 'host-file-region'])
    const value = await probe.cdp.evaluate(`(() => { const s=JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state;return { workbench:s.restoredWorkbench,focus:s.agentFocus,draft:s.agentComposerDrafts[${JSON.stringify(original.agentSessionId)}] } })()`)
    assert.deepEqual(value.workbench, seed.state.restoredWorkbench, 'Exact nonempty Tab/Group/Region/focus/split survives restart')
    assert.deepEqual(value.focus, seed.state.agentFocus)
    assert.equal(value.draft, seed.state.agentComposerDrafts[original.agentSessionId])
    return value
  }
  async function surface(probe, seed, transientOwnerFailure) {
    const value = await durableSurface(probe, seed)
    const snapshot = await waitFor('Desktop reads original Host Session', async () => {
      let snapshot
      try { snapshot = await probe.cdp.evaluate('window.agentmux.sessions.snapshot()') }
      catch (error) {
        if (!transientOwnerFailure || !(error.message === transientOwnerFailure.message || error.message.endsWith(`: ${transientOwnerFailure.message}`))) throw error
        return null
      }
      return snapshot.sessions.some(value => value.id === original.agentSessionId) ? snapshot : null
    })
    await waitFor('actual original Agent Composer and sibling Region', () => probe.cdp.evaluate(`Boolean(document.querySelector('[data-workbench-region-id="host-agent-region"] .composer [role="textbox"]') && document.querySelector('[data-workbench-region-id="host-file-region"]'))`))
    const session = snapshot.sessions.find(value => value.id === original.agentSessionId)
    assert.equal(session.processState, 'running'); assert.equal(session.control.run.runId, original.run.runId)
    return { value, session }
  }
  try {
    Object.assign(process.env, environment)
    for (const path of [privateHome, environment.CODEX_HOME, userData, workspace, join(root, 'topics')]) await mkdir(path, { recursive: true })
    core = await import(pathToFileURL(join(coreRoot, 'dist/index.js')).href)
    hostedSdk = await import(pathToFileURL(join(coreRoot, 'dist/hosted.js')).href)
    phase('original-private-Core-Session')
    const worker = join(workspace, 'worker.py')
    await writeFile(worker, '#!/usr/bin/python3\nimport os,sys\nif "--version" in sys.argv:\n print("Private Host worker 1"); sys.exit(0)\nos.write(1,b"Private Host ready\\r\\n")\nwhile True:\n data=os.read(0,4096)\n if not data: break\n os.write(1,b"Private Host echo:"+data)\n', { mode: 0o700 })
    firstClient = await core.connectLocalAgentMux({ store: new core.AgentMuxFileAgentSessionStore(storePath) })
    original = await firstClient.createAgent({ createOperationId: randomUUID(), providerId: 'codex', executorId: 'private-host-proof',
      commandOverride: worker, workspacePath: workspace, injectAgentMuxGuide: false, env: { CODEX_HOME: environment.CODEX_HOME }, cols: 100, rows: 30 })
    attempt.originalRun = (await firstClient.listRuns()).find(value => value.runId === original.run.runId)
    assert.equal(attempt.originalRun.state, 'running'); assert.ok(attempt.originalRun.pid > 1)
    attempt.originalIdentity = firstClient.runtimeIdentity(); attempt.sessionId = original.agentSessionId
    await firstClient.dispose(); firstClient = undefined
    await writeFile(join(workspace, 'sibling.txt'), 'Original sibling remains visible\n')
    await writeFile(join(userData, 'agentmux.config.json'), JSON.stringify({ version: 9,
      hosts: [{ id: 'local', kind: 'local', label: 'Private original Host' }],
      executors: { 'private-host-proof': { label: 'Private Host PTY', providerId: 'codex', command: worker, args: [], env: { CODEX_HOME: environment.CODEX_HOME }, injectAgentMuxGuide: false } },
      workspaces: [{ id: '__scratch__', name: 'Private scratch', hostId: 'local', path: join(root, 'topics'), kind: 'folder' },
        { id: 'host-workspace', name: 'Original Host workspace', hostId: 'local', path: workspace, kind: 'folder' }],
      appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }, notifications: { mode: 'off' } }))
    const seed = { version: 1, state: { activeWorkspaceId: 'host-workspace', mainSurface: 'workbench',
      agentFocus: { execution: { sessionId: original.agentSessionId, history: [{ sessionId: original.agentSessionId, focusedAt: 1 }] }, pmo: { sessionId: null } },
      agentComposerDrafts: { [original.agentSessionId]: 'Original unsent draft survives Desktop and Host restart' }, restoredWorkbench: {
        tabs: { 'host-tab': { id: 'host-tab', workspaceId: 'host-workspace', titleRegionId: 'host-agent-region',
          layout: { root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: { type: 'leaf', regionId: 'host-agent-region' }, second: { type: 'leaf', regionId: 'host-file-region' } }, activeRegionId: 'host-agent-region' },
          regions: { 'host-agent-region': { regionId: 'host-agent-region', kind: 'agent', phase: 'attached', workspaceId: 'host-workspace', sessionId: original.agentSessionId },
            'host-file-region': { regionId: 'host-file-region', kind: 'file', workspaceId: 'host-workspace', path: join(workspace, 'sibling.txt') } } } },
        layouts: { 'host-workspace': { root: { type: 'leaf', groupId: 'host-group' }, groups: [{ id: 'host-group', tabOrder: ['host-tab'], activeTabId: 'host-tab', recentTabIds: ['host-tab'] }], activeGroupId: 'host-group' },
          __scratch__: { root: { type: 'leaf', groupId: 'host-scratch-group' }, groups: [{ id: 'host-scratch-group', tabOrder: [], activeTabId: null, recentTabIds: [] }], activeGroupId: 'host-scratch-group' } }
      } } }
    const launch = desktopFixture({ desktopRoot, root, privateHome, environment, children, connections, waitFor })
    phase('product-Desktop-adopts-original-Store')
    const seeded = await launch('seed', seed)
    // A Tab button and its live projection slot carry the same identity. Durable facts
    // below still pin the one exact Tab, Group and split, independently of DOM mounts.
    attempt.seededRenderedWorkbench = seeded.report.renderedWorkbench
    assert.deepEqual([...new Set(seeded.report.renderedWorkbench.tabIds)], ['host-tab'])
    assert.deepEqual(seeded.report.renderedWorkbench.regionIds, ['host-agent-region', 'host-file-region'])
    const first = await connect(), second = await connect()
    const bootstrap = await first.rpc.call('runtime.bootstrap', { consumerId: randomUUID() })
    assert.equal(bootstrap.storePath, storePath); assert.ok(bootstrap.hostProcessId > 1)
    assert.equal(bootstrap.messageQueuePath, environment.AGENTMUX_MESSAGE_QUEUE_PATH, 'Host and consumers use the original single durable message authority')
    attempt.hostBefore = bootstrap.hostProcessId
    assert.equal(first.sdk.runtimeIdentity().instanceId, attempt.originalIdentity.instanceId)
    await runFact(first.sdk)
    phase('Desktop-Terminal-and-public-output-and-Hosted-consumers-share-original-Run')
    const sharedDesktop = await launch('shared-consumers')
    await surface(sharedDesktop, seed)
    const desktopTerminal = async () => {
      const value = await first.rpc.call('space.inspect', { target: { regionId: 'host-agent-region' } })
      return value.presentation?.region?.terminalView?.liveReady === true ? value.presentation.region.terminalView : null
    }
    const terminalAction = await waitFor('real original Desktop Terminal or its exact switch control', async () => {
      const live = await desktopTerminal()
      if (live) return { alreadyLive: true, terminalView: live }
      const controls = await sharedDesktop.cdp.evaluate('document.querySelectorAll(\'[data-workbench-region-id="host-agent-region"] button[aria-label="Show Terminal"]\').length')
      assert.ok(controls <= 1, 'One exact original Region owns its Terminal switch')
      return controls === 1 ? { alreadyLive: false } : null
    })
    if (!terminalAction.alreadyLive) await click(sharedDesktop.cdp, '[data-workbench-region-id="host-agent-region"] button[aria-label="Show Terminal"]')
    attempt.desktopTerminal = await waitFor('real original Desktop Terminal View is live', desktopTerminal)
    await sharedDesktop.cdp.evaluate(`(() => { window.__hostProofOutput=[]; window.__hostProofOff=window.agentmux.sessions.onEvent(event=>{
      if(event.type==='core' && event.event.type==='terminal-output' && event.event.run.runId===${JSON.stringify(original.run.runId)}) window.__hostProofOutput.push(event.event.data)
    }); })()`)
    const initial = await runFact(first.sdk)
    await first.sdk.reattachAgent(original.agentSessionId, initial.latestOutputBytes, 'raw')
    await second.sdk.reattachAgent(original.agentSessionId, initial.latestOutputBytes, 'raw')
    const outputEvents = []
    const off = second.sdk.onEvent(event => { if (event.type === 'terminal-output' && event.run.runId === original.run.runId) outputEvents.push(event) })
    const nativeOutput = []
    const beforeNative = await runFact(first.sdk)
    const nativeReader = await second.rpc.subscribe('agent.output', { agentSessionId: original.agentSessionId, afterByte: beforeNative.latestOutputBytes, follow: true }, {
      onInitial: value => { assert.equal(value.run.runId, original.run.runId); assert.equal(value.run.pid, attempt.originalRun.pid) },
      onEvent: value => { if (value.type === 'output') nativeOutput.push(value.data) }
    })
    const afterNative = await runFact(first.sdk)
    assert.deepEqual({ pid: afterNative.pid, cols: afterNative.cols, rows: afterNative.rows, input: afterNative.acceptedInputBytes },
      { pid: beforeNative.pid, cols: beforeNative.cols, rows: beforeNative.rows, input: beforeNative.acceptedInputBytes },
      'A public output reader causes no resize, input or terminal query side effect')
    async function actualInput(sdk, label) {
      const marker = `${label}-${randomUUID()}`
      const ack = await sdk.writeAgent({ agentSessionId: original.agentSessionId, expectedRun: original.run, data: marker + '\r', source: 'user' })
      assert.ok(ack.appliedByteRange)
      return { marker: `Private Host echo:${marker}`, ack }
    }
    const desktopHas = marker => sharedDesktop.cdp.evaluate(`window.__hostProofOutput.join('').includes(${JSON.stringify(marker)})`)
    const hostedHas = marker => outputEvents.map(event => event.data).join('').includes(marker)
    const nativeHas = marker => Buffer.concat(nativeOutput.map(event => Buffer.from(event.dataBase64, 'base64'))).toString('utf8').includes(marker)
    await first.sdk.releaseRunAttachment(original.run)
    const { marker, ack } = await actualInput(first.sdk, 'after-hosted-release')
    await waitFor('remaining public consumer receives actual original bytes after other releases', () => hostedHas(marker))
    await waitFor('independent public output reader receives original bytes', () => nativeHas(marker))
    await waitFor('Desktop Terminal still receives original bytes', () => desktopHas(marker))
    assert.ok(outputEvents.length > 0); assert.ok(outputEvents.every(event => event.dataBytes instanceof Uint8Array))
    attempt.inputAck = ack
    const beforeNativeClose = await runFact(second.sdk)
    await nativeReader.dispose()
    const afterNativeClose = await runFact(second.sdk)
    assert.deepEqual({ pid: afterNativeClose.pid, cols: afterNativeClose.cols, rows: afterNativeClose.rows, input: afterNativeClose.acceptedInputBytes },
      { pid: beforeNativeClose.pid, cols: beforeNativeClose.cols, rows: beforeNativeClose.rows, input: beforeNativeClose.acceptedInputBytes })
    const withoutNative = await actualInput(second.sdk, 'after-public-output-release')
    await waitFor('Hosted viewer remains live after public output release', () => hostedHas(withoutNative.marker))
    await waitFor('Desktop Terminal remains live after public output release', () => desktopHas(withoutNative.marker))
    await second.sdk.releaseRunAttachment(original.run)
    const desktopOnly = await actualInput(second.sdk, 'after-last-hosted-attachment-release')
    await waitFor('Desktop owns its original view after all other output leases release', () => desktopHas(desktopOnly.marker))
    const observed = await runFact(second.sdk)
    await second.sdk.reattachAgent(original.agentSessionId, observed.latestOutputBytes, 'raw')
    attempt.independentLeases = { nativeOutputChunks: nativeOutput.length, desktopAfterAllOtherReleases: desktopOnly.ack,
      publicReleasePreserved: withoutNative.ack, noReaderSideEffects: true }
    assert.ok(nativeOutput.length > 0)
    await first.sdk.dispose(); consumers.delete(first.sdk)
    phase('ordinary-Desktop-quit-and-reopen')
    const desktopPids = []
    for (const label of ['first', 'second']) {
      const probe = label === 'first' ? sharedDesktop : await launch(label)
      await surface(probe, seed)
      desktopPids.push(await quit(probe))
      await runFact(second.sdk)
      const remaining = await actualInput(second.sdk, `after-${label}-Desktop-quit`)
      await waitFor('Hosted viewer continues original new bytes after ordinary Desktop quit', () => hostedHas(remaining.marker))
      const current = await second.rpc.call('runtime.bootstrap', { consumerId: randomUUID() })
      assert.equal(current.hostProcessId, attempt.hostBefore, 'Desktop normal quit must leave the same long-lived semantic Host')
    }
    assert.notEqual(desktopPids[0], desktopPids[1]); attempt.desktopPids = desktopPids
    phase('live-original-owner-is-not-displaced-by-unconfirmed-Desktop')
    await signalOwnedProbeProcess(attempt.hostBefore, root, 'SIGTERM')
    await waitFor('initial Host process exits', async () => !(await listProbeProcesses(attempt.hostBefore, root)).includes(attempt.hostBefore))
    firstClient = await core.connectLocalAgentMux({ store: new core.AgentMuxFileAgentSessionStore(storePath) })
    await runFact(firstClient)
    const oldRun = await runFact(firstClient)
    await firstClient.reattachAgent(original.agentSessionId, oldRun.latestOutputBytes, 'raw')
    const hookListeners = (await execFileAsync('/usr/sbin/lsof', ['-nP', `-iTCP:${core.defaultAgentMuxHookPort()}`, '-sTCP:LISTEN', '-t'], { timeout: 5000 })).stdout
      .trim().split(/\s+/).map(Number)
    assert.deepEqual([...new Set(hookListeners)], [process.pid], 'The original private Core really holds its Hook ingress')
    oldControl = new core.AgentMuxControlServer({ coreClients: () => [{ hostId: 'local', client: firstClient }] })
    await oldControl.start()
    const oldRpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(runtime, 'control.sock') } })
    rpcConnections.add(oldRpc)
    let unconfirmed
    try {
      const unexpected = await oldRpc.subscribe('runtime.events', { consumerId: randomUUID() }, { onInitial() {}, onEvent() {} })
      await unexpected.dispose(); assert.fail('The owner without a hosted service cannot confirm a Hosted consumer')
    } catch (error) {
      assert.ok(['CONTROL_UNAVAILABLE', 'RPC_METHOD_NOT_FOUND'].includes(error.code), 'Only the explicit unavailable/unsupported Host workflow is expected')
      unconfirmed = { code: error.code, message: error.message }
    }
    const logBeforeBlocked = await readFile(hostLog, 'utf8')
    const blocked = await launch('live-owner-unconfirmed', undefined, { expectRuntimeUnavailable: unconfirmed })
    await durableSurface(blocked, seed)
    const oldOutput = []
    const offOld = firstClient.onEvent(event => { if (event.type === 'terminal-output' && event.run.runId === original.run.runId) oldOutput.push(event) })
    const oldInput = await actualInput(firstClient, 'old-owner-healthy')
    const originalOwnerAck = oldInput.ack
    await waitFor('old healthy owner still accepts real input during failed Hosted handshake', () => oldOutput.map(event => event.data).join('').includes(oldInput.marker))
    assert.ok(oldOutput.length > 0); offOld()
    await runFact(firstClient)
    assert.equal(await readFile(hostLog, 'utf8'), logBeforeBlocked, 'Desktop does not launch a speculative Host while the endpoint owner is alive')
    attempt.liveOwner = { processId: process.pid, hookListeners: [...new Set(hookListeners)], failure: unconfirmed,
      rendererFailure: blocked.runtimeFailure, originalOwnerAck, visibleRegionIds: ['host-agent-region', 'host-file-region'] }
    phase('explicit-owner-release-adopts-same-Run-in-current-Desktop')
    await oldControl.stop(); oldControl = undefined
    await firstClient.dispose(); firstClient = undefined
    await surface(blocked, seed, unconfirmed)
    await runFact(second.sdk)
    const handoff = await second.rpc.call('runtime.bootstrap', { consumerId: randomUUID() })
    assert.notEqual(handoff.hostProcessId, attempt.hostBefore)
    assert.equal(second.sdk.runtimeIdentity().instanceId, attempt.originalIdentity.instanceId)
    attempt.hostAfterHandoff = handoff.hostProcessId
    await quit(blocked)
    phase('Host-process-restart-retains-original-Run-and-workbench')
    await signalOwnedProbeProcess(attempt.hostAfterHandoff, root, 'SIGTERM')
    await waitFor('adopted Host process exits', async () => !(await listProbeProcesses(attempt.hostAfterHandoff, root)).includes(attempt.hostAfterHandoff))
    const reopened = await launch('after-host-restart')
    await surface(reopened, seed)
    const restored = await waitFor('public SDK reattaches original Session after Host process restart', async () => {
      try { return await runFact(second.sdk) } catch { return null }
    })
    assert.equal(restored.pid, attempt.originalRun.pid)
    assert.equal(second.sdk.runtimeIdentity().instanceId, attempt.originalIdentity.instanceId)
    const afterBootstrap = await second.rpc.call('runtime.bootstrap', { consumerId: randomUUID() })
    assert.notEqual(afterBootstrap.hostProcessId, attempt.hostAfterHandoff); attempt.hostAfter = afterBootstrap.hostProcessId
    outputEvents.length = 0
    const restartedInput = await actualInput(second.sdk, 'after-host-restart')
    await waitFor('restored original live byte stream', () => hostedHas(restartedInput.marker))
    off(); await quit(reopened)
    assert.deepEqual(await artifactHashes(), attempt.artifacts, 'Actual loaded Node/Host/renderer entry artifacts remain unchanged throughout the private proof')
    attempt.passed = true
  } catch (error) {
    failure = error; attempt.failure = { name: error.name, message: error.message, stack: error.stack }
    try { attempt.hostLog = await readFile(hostLog, 'utf8') } catch {}
  } finally {
    const cleanupErrors = [], clean = async operation => { try { await operation() } catch (error) { cleanupErrors.push(String(error)) } }
    for (const connection of connections) connection.close()
    await clean(async () => { if (original) for (const consumer of consumers) {
      try { await consumer.stopAgent(original.agentSessionId, original.run); break } catch {}
    } })
    for (const consumer of consumers) await clean(() => consumer.dispose())
    for (const rpc of rpcConnections) await clean(() => rpc.dispose())
    await clean(async () => { await oldControl?.stop() })
    await clean(async () => { await firstClient?.dispose() })
    await clean(stopOwnProcesses)
    await clean(async () => { assert.deepEqual(await ownProcesses(), []); await rm(root, { recursive: true }); attempt.cleanup.rootRemoved = true })
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    if (cleanupErrors.length) { attempt.cleanup.errors = cleanupErrors; attempt.passed = false; failure ??= new Error(cleanupErrors.join('; ')) }
  }
  evidence.attempts.push(attempt)
  return { passed: attempt.passed, failure }
}

async function mutatedArtifacts() {
  const root = await mkdtemp(join(tmpdir(), 'amx-host-mutant-')), desktop = join(root, 'desktop'), core = join(root, 'core')
  await mkdir(desktop, { recursive: true }); await mkdir(core, { recursive: true })
  // Only Node entry modules need a private resolution root. Renderer/preload and native
  // resources are unchanged read-only inputs, so a mutation never duplicates the whole App.
  await mkdir(join(desktop, 'out'), { recursive: true })
  await cp(join(repository, 'apps/desktop/out/main'), join(desktop, 'out/main'), { recursive: true })
  for (const name of ['renderer', 'preload']) await symlink(join(repository, 'apps/desktop/out', name), join(desktop, 'out', name))
  await symlink(join(repository, 'apps/desktop/resources'), join(desktop, 'resources'))
  await cp(join(repository, 'apps/desktop/package.json'), join(desktop, 'package.json'))
  await cp(join(repository, 'packages/core/dist'), join(core, 'dist'), { recursive: true })
  await cp(join(repository, 'packages/core/package.json'), join(core, 'package.json'))
  for (const name of ['vendor', 'bin']) await symlink(join(repository, 'packages/core', name), join(core, name))
  await symlink(join(repository, 'packages/core/node_modules'), join(core, 'node_modules'))
  const modules = join(desktop, 'node_modules'); await mkdir(join(modules, '@agentmux'), { recursive: true })
  for (const entry of await readdir(join(repository, 'apps/desktop/node_modules'), { withFileTypes: true })) {
    if (entry.name === '@agentmux') {
      for (const scoped of await readdir(join(repository, 'apps/desktop/node_modules/@agentmux'))) {
        await symlink(scoped === 'core' ? core : join(repository, 'apps/desktop/node_modules/@agentmux', scoped), join(modules, '@agentmux', scoped))
      }
    } else await symlink(join(repository, 'apps/desktop/node_modules', entry.name), join(modules, entry.name))
  }
  const path = join(core, 'dist/hosted-runtime-service.js')
  const source = await readFile(join(repository, 'packages/core/src/hosted-runtime-service.ts'), 'utf8')
  const start = source.indexOf('private async releaseRun('), end = source.indexOf('async releaseConsumer(', start)
  assert.ok(start >= 0 && end > start, 'The real Run-release block exists')
  const block = source.slice(start, end)
  assert.equal(block.split('if (owners.size === 0)').length - 1, 1, 'Mutate the actual consumer-count guard once')
  const mutant = source.slice(0, start) + block.replace('if (owners.size === 0)', 'if (owners.size >= 0)') + source.slice(end)
  await writeFile(path, ts.transpileModule(mutant, { compilerOptions: { module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022, isolatedModules: true } }).outputText)
  evidence.mutantSource = { path: 'packages/core/src/hosted-runtime-service.ts', sourceSha256: hash(source),
    mutantSha256: hash(mutant), block: 'releaseRun final observation-owner guard', isolatedSourceTransform: true }
  return { root, desktop, core }
}

let failure
try {
  if (process.argv.includes('--mutation-and-callers')) {
    const callers = [
      ['apps/desktop/src/main/index.ts', 'connectDesktopAgentMuxHost'],
      ['apps/desktop/src/main/desktop-host.ts', 'connectHostedAgentMux'],
      ['apps/desktop/src/main/runtime-controller.ts', 'this.connectRuntimeClient'],
      ['apps/host/src/host.ts', 'AgentMuxHostedRuntimeService']
    ]
    for (const [file, expression] of callers) {
      const source = await readFile(join(repository, file), 'utf8')
      const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
      const invocations = []
      const visit = node => {
        if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.expression.getText(tree) === expression) invocations.push(node.getStart(tree))
        if (expression === 'connectDesktopAgentMuxHost' && ts.isNewExpression(node) && node.expression.getText(tree) === 'RuntimeController' && node.arguments?.[1]?.getText(tree) === expression) invocations.push(node.getStart(tree))
        ts.forEachChild(node, visit)
      }
      visit(tree)
      assert.ok(invocations.length > 0, `${file} must invoke the delivered capability outside its definition, tests and imports`)
    }
    evidence.callers = callers
    const mutant = await mutatedArtifacts()
    try {
      const red = await run(mutant.desktop, mutant.core)
      assert.equal(red.passed, false, 'Cross-consumer detach mutation must fail the product proof')
      assert.equal(red.failure?.name, 'AssertionError', 'Only the intended behavioral assertion RED qualifies')
      assert.match(red.failure.message, /remaining public consumer receives actual original bytes/, 'Mutation must fail because the other real consumer lost its stream')
      evidence.mutation = 'last-observation-owner guard removed: intended real-consumer assertion RED'
    } finally { await rm(mutant.root, { recursive: true, force: true }) }
  }
  const green = await run(join(repository, 'apps/desktop'), join(repository, 'packages/core'))
  assert.equal(green.passed, true, green.failure?.stack ?? 'Host/Desktop adoption was not verified')
  evidence.passed = true
} catch (error) { failure = error; evidence.failure = { name: error.name, message: error.message, stack: error.stack } }
const receipt = join(output, process.argv.includes('--mutation-and-callers') ? 'mutation-and-callers.json' : 'adoption.json')
await writeFile(receipt, JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify({ passed: evidence.passed, receipt, failure: evidence.failure?.message ?? null }))
if (failure || !evidence.passed) process.exitCode = 1
