import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { AgentMuxFileAgentSessionStore } from '@agentmux/core'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { RuntimeController } from '../../../src/main/runtime-controller'
import { connectDesktopAgentMuxHost } from '../../../src/main/desktop-host'
import { runRemoteTerminalReadingProof } from '../../remote-terminal-reading-proof.mjs'

const [html, privateRoot, phase, preload, evidence, nodeExecutable, recoveryInputPath] = process.argv.slice(2)
const recoveryInput = recoveryInputPath ? JSON.parse(readFileSync(recoveryInputPath, 'utf8')) : null
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
process.env.AGENTMUX_RUNTIME_DIRECTORY = path.join(privateRoot, 'runtime')
process.env.AGENTMUX_STATE_DIRECTORY = path.join(privateRoot, 'runtime', 'state')
process.env.AGENTMUX_MESSAGE_QUEUE_PATH = path.join(privateRoot, 'messages.ndjson')
const local = { id: 'local', kind: 'local' as const, label: 'Private local Runtime' }
const remote = { id: 'controlled-remote', kind: 'ssh' as const, label: 'Build host', hostname: 'unreachable.invalid',
  remoteCommand: _hygiene_fixturePath("opt/agentmux/bin/agentmux-rpc"), remoteSocketPath: _hygiene_fixturePath("run/user/1000/agentmux/public.sock"), runtimeId: 'fixture-bound-runtime' }
const defaultConfig = { version: 9, hosts: [local, remote], executors: { codex: {
  label: 'Private CLI fixture', providerId: 'codex', command: nodeExecutable,
  args: [path.join(privateRoot, 'fake-codex-cli.mjs')], env: { CODEX_HOME: path.join(privateRoot, 'codex'), AGENTMUX_FAKE_READY_MODE: 'before' }, injectAgentMuxGuide: false
} }, workspaces: [
  { id: 'local-proof-workspace', hostId: local.id, name: 'Local workbench', path: path.join(privateRoot, 'workspace'), kind: 'folder' as const },
  { id: 'remote-proof-workspace', hostId: remote.id, name: 'Remote workbench', path: _hygiene_fixturePath("remote/project"), kind: 'folder' as const }
], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const config = recoveryInput?.config ?? defaultConfig
// Only this exact remote observation is controlled. The local Provider/Session/Run is real.
const localConfig = { ...config, hosts: [local], workspaces: config.workspaces.filter(item => item.hostId === local.id) }
const runtimeConfig = recoveryInput ? config : localConfig
const warning = { hostId: remote.id, step: 'Reading Runtime sessions', code: 'CONTROLLED_REMOTE_OFFLINE',
  message: 'This endpoint is unavailable. Its last observation and original workbench are kept; current status is unconfirmed.',
  recovery: 'Restore SSH access to the bound Runtime and reconnect.' }
const store = new AgentMuxFileAgentSessionStore(path.join(privateRoot, 'agent-sessions.json'))
process.env.AGENTMUX_AGENT_SESSION_STORE = store.path
const runtime = new RuntimeController(store, connectDesktopAgentMuxHost)
let win: BrowserWindow, snapshotCalls = 0
const spatial = new AgentMuxSpatialStateStore(path.join(privateRoot, 'spatial-state.json'))
let disposeSpatial: (() => void) | undefined
let localHealth: any
const calls: { operation: string; args: unknown[] }[] = []
const result: Record<string, any> = { passed: false, phase, pid: process.pid, controlledRemoteObservation: warning, userAppRunTouched: false }
const stage = async (step: string) => fs.writeFile(path.join(evidence, `${phase}-progress.json`), JSON.stringify({ step, pid: process.pid, snapshotCalls, at: Date.now() }))
if (recoveryInput) { delete result.controlledRemoteObservation; result.remoteTransport = recoveryInput.remoteEndpoint.transport }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function requestOwner(operation: 'stop' | 'restart' | 'terminal-noise-start' | 'terminal-noise-stop') {
  const id = `${process.pid}:${operation}:${Date.now()}`
  await fs.writeFile(path.join(privateRoot, 'owner-request.json'), JSON.stringify({ id, operation }))
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    try {
      const response = JSON.parse(await fs.readFile(path.join(privateRoot, 'owner-response.json'), 'utf8'))
      if (response.id === id) { if (response.error) throw Error(response.error); return response.result }
    } catch (error: any) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
    await delay(20)
  }
  throw Error(`The proof coordinator did not acknowledge owner ${operation}`)
}
ipcMain.handle('remote-proof:request', async (_event, operation, ...args) => {
  calls.push({ operation, args })
  switch (operation) {
    case 'setup': return { phase, config, recovery: Boolean(recoveryInput), terminalReading: recoveryInput?.terminalReading,
      splitTerminal: recoveryInput?.splitTerminal, identity: phase === 'restore' ? JSON.parse(await fs.readFile(path.join(privateRoot, 'identity.json'), 'utf8')) : recoveryInput?.identity ?? null }
    case 'spatial-read': return spatial.read()
    case 'spatial-commit': return spatial.commit(args[0])
    case 'launch': return runtime.launchAgent({ hostId: 'local', executorId: 'codex', workspacePath: config.workspaces[0].path }, localConfig as any)
    case 'snapshot': snapshotCalls++; return recoveryInput ? runtime.snapshot(runtimeConfig) : { ...await runtime.snapshot(runtimeConfig as any), runtimeEndpointWarnings: [warning] }
    case 'attach': return runtime.attachSession(win.webContents.id, args[0], args[1], runtimeConfig as any)
    case 'replay': return runtime.readSessionReplay(win.webContents.id, args[0], args[1])
    case 'detach': return runtime.detachSession(win.webContents.id, args[0])
    case 'resize': return runtime.resizeSessionAttachment(win.webContents.id, args[0], args[1], args[2])
    case 'write': return runtime.write(args[0], args[1], args[2])
    case 'paste': return runtime.paste(args[0], args[1], args[2])
    case 'resolve': return runtime.resolveSession(args[0], runtimeConfig as any)
    case 'refresh': return runtime.refresh(args[0], runtimeConfig as any)
    case 'submitPrompt': return runtime.submitPrompt(args[0], args[1], args[2], args[3], undefined, args[4], args[5], args[6])
    case 'owner-stop': return requestOwner('stop')
    case 'owner-restart': return requestOwner('restart')
    case 'terminal-noise-start': return requestOwner('terminal-noise-start')
    case 'terminal-noise-stop': return requestOwner('terminal-noise-stop')
    case 'remote-status': {
      const client = runtime.rpcClients().find(item => item.hostId === recoveryInput.identity.hostId)!.client
      return { owner: 'runtimeOwnerIdentity' in client ? client.runtimeOwnerIdentity() : null,
        status: await client.statusAgent(recoveryInput.identity.sessionId) }
    }
    case 'remote-terminal-status': {
      const client = runtime.rpcClients().find(item => item.hostId === recoveryInput.identity.hostId)!.client
      const reading = recoveryInput.terminalReading ?? recoveryInput.splitTerminal
      const run = (await client.listRuns()).find(item => item.runId === reading.runId)
      assert.ok(run, 'The original actual terminal exists')
      return run
    }
    case 'remote-terminal-arm-offline-output': {
      const session = await runtime.resolveSession(recoveryInput.terminalReading.sessionId, runtimeConfig)
      assert.ok(session?.kind === 'terminal')
      const client = runtime.rpcClients().find(item => item.hostId === recoveryInput.identity.hostId)!.client
      const before = (await client.listRuns()).find(item => item.runId === recoveryInput.terminalReading.runId)
      await runtime.write(session.control, recoveryInput.terminalReading.offlineText, 'user')
      return before
    }
    case 'save-identity': await fs.writeFile(path.join(privateRoot, 'identity.json'), JSON.stringify(args[0])); return
    case 'flush': await win.webContents.session.flushStorageData(); return
    default: throw Error(`Unowned private boundary: ${operation}`)
  }
})
app.whenReady().then(async () => {
  const until = async (expression: string, budget = 20000) => {
    const end = Date.now() + budget
    do { const value = await win.webContents.executeJavaScript(expression); if (value) return value; await delay(35) } while (Date.now() < end)
    throw Error(`Private native observation timed out: ${expression}`)
  }
  const readerAssertion = async (expression: string, message: string) => {
    const end = Date.now() + 6000
    let confirmed = false
    do { confirmed = Boolean(await win.webContents.executeJavaScript(expression)); if (confirmed) break; await delay(35) } while (Date.now() < end)
    assert.equal(confirmed, true, message)
  }
  // Capture the same JSON facts stored in receipts and the Core graph resource metadata.
  // Optional absent fields must not differ solely because structured-clone retains undefined.
  const state = async () => JSON.parse(JSON.stringify(await win.webContents.executeJavaScript('window.remoteState()')))
  const capture = async (file: string) => {
    await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await delay(350)
    await fs.writeFile(path.join(evidence, file), (await win.capturePage()).toPNG())
  }
  try {
    await stage('prepare')
    result.coreSpatialBefore = await spatial.read()
    if (phase === 'restore') {
      const saved = JSON.parse(await fs.readFile(path.join(privateRoot, 'expected-spatial.json'), 'utf8'))
      assert.ok(result.coreSpatialBefore && result.coreSpatialBefore.graph.tabs.length > 0, 'Original nonempty Core spatial state must precede Renderer recovery')
      assert.deepEqual(result.coreSpatialBefore, saved, 'The original Core document survives the ordinary process boundary')
    }
    runtime.commit(await runtime.prepare(runtimeConfig as any))
    if (recoveryInput?.localHealth) {
      const localClient = runtime.rpcClients().find(item => item.hostId === 'local')!.client
      if (phase === 'seed') {
        const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
        const session = await runtime.launchTerminal({ hostId: 'local', workspacePath: recoveryInput.localHealth.workspacePath,
          shellCommand: 'exec ' + [recoveryInput.localHealth.command, ...recoveryInput.localHealth.args].map(quote).join(' '),
          createOperationId: 'private-local-health', cols: 100, rows: 30 }, runtimeConfig)
        const run = (await localClient.listRuns()).find(item => item.runId === session.control.run.runId)!
        localHealth = { control: session.control, pid: run.pid, runId: run.runId }
        await fs.writeFile(path.join(privateRoot, 'local-health.json'), JSON.stringify(localHealth))
      } else localHealth = JSON.parse(await fs.readFile(path.join(privateRoot, 'local-health.json'), 'utf8'))
      const end = Date.now() + 20000
      for (;;) {
        const run = (await localClient.listRuns()).find(item => item.runId === localHealth.runId)
        if (run?.state === 'running' && run.latestOutputBytes > 0) {
          assert.equal(run.pid, localHealth.pid); result.localIdentity = localHealth; break
        }
        assert.ok(Date.now() < end, 'The original private local stdin process must be healthy and ready'); await delay(20)
      }
    }
    win = new BrowserWindow({ width: 1280, height: 850, show: false,
      webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, preload } })
    runtime.attach(win.webContents)
    disposeSpatial = spatial.subscribe(state => {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('remote-proof:spatial-changed', state)
    })
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) process.stderr.write(`Renderer: ${message}\n`) })
    await win.loadFile(html)
    // A hidden macOS window can report a fully laid-out DOM while capturing an
    // unpainted workbench. Exercise the native surface without stealing focus.
    win.showInactive()
    assert.equal(win.isVisible(), true, 'The private workbench must actually be painted')
    await stage('mounted-app')
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await until('window.remoteReady && !window.remoteState().loading && window.remoteLiveReady() && window.remoteState().editor')
    const localClient = runtime.rpcClients().find(item => item.hostId === 'local')!.client
    const localOwner = 'runtimeOwnerIdentity' in localClient ? localClient.runtimeOwnerIdentity() : null
    assert.ok(localOwner && Number.isSafeInteger(localOwner.processId) && localOwner.processId > 0,
      'The private local semantic Host has an actual public owner identity')
    assert.notEqual(localOwner.processId, process.pid, 'The Electron client cannot own its semantic Host')
    result.localHostOwner = localOwner
    result.initial = await state()
    assert.equal(result.initial.terminalCount, recoveryInput?.terminalReading || recoveryInput?.splitTerminal ? 2 : 1)
    assert.deepEqual(result.initial.warnings, recoveryInput ? [] : [warning])
    assert.equal(Object.keys(result.initial.tabs).length, recoveryInput ? (recoveryInput.terminalReading || recoveryInput.splitTerminal ? 2 : 1) : 2)
    if (recoveryInput?.terminalReading || recoveryInput?.splitTerminal) {
      const layout = result.initial.layouts[recoveryInput.identity.workspaceId]
      assert.equal(layout.root.type, 'split'); assert.equal(layout.groups.length, 2)
      assert.ok(layout.groups.every((group: any) => group.tabOrder.length > 0))
    }
    if (!recoveryInput) assert.equal(Object.keys(result.initial.tabs['original-remote-tab'].regions).length, 2)
    if (phase === 'restore') {
      const previous = JSON.parse(await fs.readFile(path.join(privateRoot, 'expected.json'), 'utf8'))
      for (const field of ['tabs', 'layouts', 'drafts', 'activeWorkspaceId', 'focus']) assert.deepEqual(result.initial[field], previous[field], `${field} changed across ordinary Electron restart`)
      assert.equal(calls.filter(call => call.operation === 'launch').length, 0)
    } else assert.equal(calls.filter(call => call.operation === 'launch').length, recoveryInput ? 0 : 1)
    const before = await win.webContents.executeJavaScript('window.remoteSetCaret()')
    assert.equal(before.anchor, 7); assert.equal(before.focused, true)
    const readsBefore = snapshotCalls
    await win.webContents.executeJavaScript('window.remoteResync(); true')
    await until(`window.remoteState().warnings?.length === ${recoveryInput ? 0 : 1} && window.remoteState().editor?.originalNode && window.remoteState().editor?.anchor === 7`)
    await delay(100)
    assert.equal(snapshotCalls, readsBefore + 1)
    result.afterResync = await state()
    assert.deepEqual(result.afterResync.tabs, result.initial.tabs)
    assert.deepEqual(result.afterResync.layouts, result.initial.layouts)
    assert.deepEqual(result.afterResync.drafts, result.initial.drafts)
    assert.deepEqual(result.afterResync.editor, before)
    if (recoveryInput) {
      await stage('owner-stop')
      if (recoveryInput.terminalReading?.offlineText) result.offlineTerminalBefore = await win.webContents.executeJavaScript('window.remoteProof.request("remote-terminal-arm-offline-output")')
      result.stoppedOwner = await win.webContents.executeJavaScript('window.remoteSeedUnconfirmed(); window.remoteProof.request("owner-stop")')
      await until('window.remoteState().warnings.some(warning => warning.availability !== "connected") && window.remoteState().session.status.state === "disconnected"')
      result.offline = await state()
      if (recoveryInput.splitTerminal) {
        await readerAssertion('window.remoteAttachmentNotices().some(notice => notice.unavailable && notice.recoveryAvailable)',
          'The original reader failure must have its Region service window and available observation recovery')
        result.readerRecoveryActions = []
        for (const [regionId, multiple] of [[recoveryInput.identity.regionId, true], [recoveryInput.splitTerminal.regionId, false]] as const) {
          await win.webContents.executeJavaScript(`window.remoteOpenAttachmentNotice(${JSON.stringify(regionId)}); true`)
          await readerAssertion(`window.remoteAttachmentNotices().some(notice => notice.regionId === ${JSON.stringify(regionId)} && notice.unavailable && notice.recoveryPainted && notice.recoveryAvailable)`,
            multiple ? 'The original multi-notice reader recovery action must be fully visible and reachable'
              : 'The original single-notice reader recovery action must be fully visible and reachable')
          const notice = (await win.webContents.executeJavaScript('window.remoteAttachmentNotices()')).find(item => item.regionId === regionId)
          assert.equal(multiple ? notice.noticeCount > 1 : notice.noticeCount === 1, true,
            'Both original multi-notice and single-notice recovery surfaces must be exercised')
          result.readerRecoveryActions.push(notice)
          if (!multiple) await capture(`${phase}-reader-single-notice.png`)
        }
        await win.webContents.executeJavaScript(`window.remoteOpenAttachmentNotice(${JSON.stringify(recoveryInput.identity.regionId)}); true`)
        await readerAssertion('window.remoteAttachmentNotices().some(notice => notice.unavailable && notice.recoveryPainted && notice.recoveryAvailable)',
          'The original reader recovery action must actually be painted and enabled')
        result.offlineAttachmentNotices = await win.webContents.executeJavaScript('window.remoteAttachmentNotices()')
        assert.deepEqual(result.offlineAttachmentNotices.map(item => [item.regionId, item.regionPresent]),
          [recoveryInput.identity.regionId, recoveryInput.splitTerminal.regionId].map(regionId => [regionId, true]))
      }
      assert.deepEqual(result.offline.tabs, result.initial.tabs)
      assert.deepEqual(result.offline.layouts, result.initial.layouts)
      assert.deepEqual(result.offline.drafts, result.initial.drafts)
      assert.equal(result.offline.session.processState, 'running')
      if (localHealth) {
        const client = runtime.rpcClients().find(item => item.hostId === 'local')!.client
        const before = (await client.listRuns()).find(item => item.runId === localHealth.runId)!
        await runtime.write(localHealth.control, recoveryInput.localHealth.inputText, 'user')
        const end = Date.now() + 20000
        let after
        for (;;) {
          after = (await client.listRuns()).find(item => item.runId === localHealth.runId)!
          if (after.acceptedInputBytes > before.acceptedInputBytes && after.latestOutputBytes > before.latestOutputBytes) break
          assert.ok(Date.now() < end, 'Remote unavailability must not block the original healthy local input'); await delay(20)
        }
        assert.deepEqual([after.runId, after.pid, after.state], [localHealth.runId, localHealth.pid, 'running'])
        result.localInputWhileRemoteUnavailable = { before, after }
      }
      await capture(`${phase}-owner-offline.png`)
      if (result.offlineTerminalBefore) await delay(recoveryInput.terminalReading.offlineOutputDelayMs ?? 1500)
      result.restartedOwner = await win.webContents.executeJavaScript('window.remoteProof.request("owner-restart")')
      await stage('owner-restored-await-canonical-cut')
      await until('window.remoteState().warnings.length === 0 && window.remoteState().session.status.state !== "disconnected" && window.remoteState().queue[0]?.error?.includes("unconfirmed after reconnect")')
      result.restored = await state()
      await readerAssertion('window.remoteAttachmentNotices().length > 0 && window.remoteAttachmentNotices().every(notice => notice.regionPresent && !notice.unavailable)',
        'Validated original reader restoration must settle its own Region service window')
      result.restoredAttachmentNotices = await win.webContents.executeJavaScript('window.remoteAttachmentNotices()')
      assert.equal(result.restored.error, null, 'A recovered transport workflow must not leave a generic Agent error')
      assert.equal(result.restored.lastError, null, 'Recovered endpoint diagnostics belong to their service window')
      assert.deepEqual(result.restored.tabs, result.initial.tabs)
      assert.deepEqual(result.restored.layouts, result.initial.layouts)
      assert.deepEqual(result.restored.drafts, result.initial.drafts)
      assert.equal(result.restored.queue[0].operationId, 'private-original-unconfirmed')
      assert.equal(calls.filter(call => call.operation === 'submitPrompt').length, 0, 'Unknown prepared intent never replays')
      const remote = await win.webContents.executeJavaScript('window.remoteProof.request("remote-status")')
      assert.equal(remote.owner.runtimeId, recoveryInput.identity.runtimeId)
      assert.equal(remote.status.session.agentSessionId, recoveryInput.identity.sessionId)
      assert.equal(remote.status.run.runId, recoveryInput.identity.run.runId)
      assert.equal(remote.status.run.pid, recoveryInput.identity.pid)
      assert.equal(remote.status.run.state, 'running')
      assert.deepEqual(remote.status.session.nativeHandle, recoveryInput.identity.nativeHandle)
      result.remoteIdentity = remote
      if (recoveryInput.terminalReading || recoveryInput.splitTerminal) {
        const target = recoveryInput.terminalReading ?? recoveryInput.splitTerminal
        const run = await win.webContents.executeJavaScript('window.remoteProof.request("remote-terminal-status")')
        assert.deepEqual([run.runId, run.pid, run.state], [target.runId, target.pid, 'running'])
        result.splitTerminalIdentity = run
      }
      if (result.offlineTerminalBefore) {
        await until(`window.remoteReadingState().lines.some(line => line?.includes(${JSON.stringify(recoveryInput.terminalReading.offlineMarker)}))`)
        const run = await win.webContents.executeJavaScript('window.remoteProof.request("remote-terminal-status")')
        assert.equal(run.runId, recoveryInput.terminalReading.runId); assert.equal(run.pid, recoveryInput.terminalReading.pid)
        assert.ok(run.latestOutputBytes > result.offlineTerminalBefore.latestOutputBytes)
        result.offlineTerminalAfter = { run, observed: await win.webContents.executeJavaScript('window.remoteReadingState()') }
      }
      await until('window.remoteLiveReady() && window.remoteWritersSettled()', 20000)
      result.restoredWriterObservation = await win.webContents.executeJavaScript('({ agent: window.remoteTerminalObservation(), writers: window.terminals.map(item => ({ ...item.remoteProofMetrics })) })')
      await capture(`${phase}-owner-restored.png`)
      await win.webContents.executeJavaScript('window.remoteRemoveUnconfirmed(); true')
    }
    result.workbenchPaint = await win.webContents.executeJavaScript('window.remotePaintObservation()')
    await capture(`${phase}-workbench.png`)
    assert.equal(result.workbenchPaint.hit?.belongsToEditor, true,
      'The original draft must be visible through its actual painted workbench, not clipped behind a zero-height ancestor')
    const beforeNotice = await state()
    const inputBeforeNotice = await win.webContents.executeJavaScript('window.remoteNoticeObservation()')
    const resizesBeforeNotice = calls.filter(call => call.operation === 'resize').length
    await win.webContents.executeJavaScript('document.querySelector(".global-system-notices__trigger").click(); true')
    await until('document.querySelector(".global-system-notices__details")?.matches(":popover-open")')
    await capture(`${phase}-endpoint-notice.png`)
    result.expandedNotice = await win.webContents.executeJavaScript('window.remoteNoticeObservation()')
    const afterNotice = await state()
    assert.ok(result.expandedNotice.expanded && result.expandedNotice.inputs.length > 0,
      'The actual expanded system inbox and original visible input must be observed')
    assert.deepEqual(result.expandedNotice.inputs, inputBeforeNotice.inputs, 'Reading system notices cannot resize the original input')
    assert.equal(calls.filter(call => call.operation === 'resize').length, resizesBeforeNotice,
      'Opening notice details cannot resize the original terminal grid')
    for (const field of ['tabs', 'layouts', 'drafts', 'editor']) assert.deepEqual(afterNotice[field], beforeNotice[field], `${field} changed while reading system notices`)
    if (!recoveryInput) {
      assert.equal(result.expandedNotice.notice?.kind, 'indeterminate', 'Saved references without Runtime facts remain unknown')
      assert.deepEqual({ inputClear: result.expandedNotice.inputClear, unknownQuiet: result.expandedNotice.notice?.quiet },
        { inputClear: true, unknownQuiet: true }, 'Actual notice details clear the original input and unknown facts use quiet paint')
    } else assert.equal(result.expandedNotice.inputClear, true, 'Notice details cannot cover the original Agent input')
    await win.webContents.executeJavaScript('document.querySelector(".global-system-notices__trigger").click(); true')
    // Open the actual App Settings route and existing Hosts pane, rather than drawing a mock page.
    await win.webContents.executeJavaScript('document.querySelector("button[aria-label=Settings]").click(); true')
    await until('document.querySelector("button[data-settings-target=hosts]")')
    await win.webContents.executeJavaScript('document.querySelector("button[data-settings-target=hosts]").click(); true')
    await until('document.querySelector(".settings-page")?.dataset.settingsPage === "hosts"')
    await until('document.querySelectorAll(".host-settings-card").length === 2')
    await win.webContents.executeJavaScript('document.querySelector(".host-edit-disclosure").open = true; true')
    await until(`[...document.querySelectorAll(".host-edit-grid input")].some(input => input.value === ${JSON.stringify(recoveryInput?.identity.runtimeId ?? 'fixture-bound-runtime')} && input.readOnly && input.getClientRects().length)`)
    await capture(`${phase}-hosts.png`)
    await win.webContents.executeJavaScript("document.querySelector('button[aria-label=\"Close settings\"]').click(); true")
    await until('!document.querySelector(".settings-page") && window.remoteLiveReady()')
    const inputProbe = recoveryInput?.inputProbe ?? { kind: 'fixture-marker', text: 'z', marker: 'codex-composer-rendered:' }
    assert.ok(['fixture-marker', 'accepted-input-output'].includes(inputProbe.kind))
    assert.ok(typeof inputProbe.text === 'string' && inputProbe.text.length > 0)
    const inputBefore = recoveryInput ? await win.webContents.executeJavaScript('window.remoteProof.request("remote-status")') : null
    await stage('actual-terminal-input')
    await win.webContents.executeJavaScript('window.remoteFocusAgentTerminal(); true')
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: inputProbe.text })
    if (recoveryInput) {
      const inputAfter = await until(`window.remoteProof.request("remote-status").then(fact => fact.status.run.acceptedInputBytes > ${inputBefore.status.run.acceptedInputBytes} && fact.status.run.latestOutputBytes > ${inputBefore.status.run.latestOutputBytes} ? fact : null)`)
      assert.equal(inputAfter.status.run.runId, recoveryInput.identity.run.runId)
      assert.equal(inputAfter.status.run.pid, recoveryInput.identity.pid)
      result.input = { kind: inputProbe.kind, text: inputProbe.text, before: inputBefore.status.run, after: inputAfter.status.run,
        terminalView: await win.webContents.executeJavaScript('window.remoteTerminalObservation()') }
      assert.equal(result.input.terminalView.liveReady, true)
      assert.equal(result.input.terminalView.acceptsInput, true)
    }
    if (inputProbe.kind === 'fixture-marker') {
      assert.ok(typeof inputProbe.marker === 'string' && inputProbe.marker.length > 0)
      await until(`window.terminals.some(item => Array.from({length:item.buffer.active.length},(_,index)=>item.buffer.active.getLine(index)?.translateToString()).some(line=>line?.includes(${JSON.stringify(inputProbe.marker)})))`)
    }
    if (recoveryInput?.terminalReading) {
      await stage('continuous-terminal-reading')
      result.terminalReading = await runRemoteTerminalReadingProof({
        win, reading: recoveryInput.terminalReading, identity: recoveryInput.identity, phase, capture })
    }
    result.saved = await state()
    if (phase === 'seed') await fs.writeFile(path.join(privateRoot, 'expected.json'), JSON.stringify(result.saved))
    await win.webContents.executeJavaScript('window.remoteFlush()')
    result.coreSpatialSaved = await spatial.read()
    assert.ok(result.coreSpatialSaved && result.coreSpatialSaved.graph.tabs.length > 0, 'The workbench is saved by the actual Core filesystem owner')
    const savedTabIds = result.coreSpatialSaved.graph.tabs.map((tab: any) => tab.tabId).sort()
    assert.deepEqual(savedTabIds, Object.keys(result.saved.tabs).sort(), 'Core durable identities match the original nonempty workbench')
    for (const tab of Object.values(result.saved.tabs) as any[]) for (const region of Object.values(tab.regions) as any[]) {
      const fact = result.coreSpatialSaved.graph.regions.find((item: any) => item.regionId === region.regionId)
      assert.ok(fact, 'The original Region is persisted by Core')
      if (region.kind === 'agent') assert.equal(fact.agentSessionId, region.sessionId, 'Persisting a Region cannot replace its AgentSession')
    }
    if (phase === 'seed') await fs.writeFile(path.join(privateRoot, 'expected-spatial.json'), JSON.stringify(result.coreSpatialSaved))
    result.calls = calls
    result.passed = true
  } catch (error: any) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) result.observationAtFailure = await state().catch(() => null)
  } finally {
    await stage('dispose')
    disposeSpatial?.()
    await fs.writeFile(path.join(evidence, `${phase}.json`), JSON.stringify(result, null, 2))
    await runtime.dispose().catch(error => { result.cleanupFailure = String(error); result.passed = false })
    await fs.writeFile(path.join(evidence, `${phase}.json`), JSON.stringify(result, null, 2))
    if (win && !win.isDestroyed()) win.close()
    app.quit()
  }
})
