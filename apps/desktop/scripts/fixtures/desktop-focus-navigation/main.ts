import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { app, BrowserWindow, ipcMain } from 'electron'
import { AgentMuxControlServer, AgentMuxFileAgentSessionStore, parseAgentMuxControlReceipt } from '@agentmux/core'
import { openDemandStore } from '@agentmux/demand'
import { RuntimeController } from '../../../src/main/runtime-controller'
import { DesktopControlIpcBridge } from '../../../src/main/control-ipc-bridge'
import { inspectDesktopClient } from '../../../src/main/client-observation'
import { observeWorkbenchStorageAuthority } from '../../../src/main/workbench-storage-authority'
import { parseDesktopClientObservation } from '../../../src/shared/client-observation'
import { ConfigOwner } from '../../../src/main/config-owner'
import { WorktreeService } from '../../../src/main/worktree-service'
import { registerWorkspace } from '../../../src/main/settings-workspace-add-control'
import { createSpaceZoneResource } from '../../../src/main/space-zone-resources'
import { ScratchTopics } from '../../../src/main/scratch-topics'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../../../src/shared/scratch-topics'
import type { AppConfig } from '../../../src/shared/contracts'

const execFile = promisify(execFileCallback)
const [html, privateRoot, phase, preload, evidence, nodeExecutable, cliPath, sourceCommit, sourceTree, rendererId, identityJson] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
process.env.AGENTMUX_RUNTIME_DIRECTORY = path.join(privateRoot, 'runtime')
process.env.AGENTMUX_STATE_DIRECTORY = path.join(privateRoot, 'runtime', 'state')
process.env.AGENTMUX_MESSAGE_QUEUE_PATH = path.join(privateRoot, 'messages.ndjson')
const configFile = path.join(privateRoot, 'config.json')
const initialConfig: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private proof' }],
  executors: { fixture: { label: 'Private fixture', providerId: 'codex', command: nodeExecutable,
    args: [path.join(privateRoot, 'fake-codex-cli.mjs')], env: { AGENTMUX_FAKE_READY_MODE: 'before' }, injectAgentMuxGuide: false } },
  workspaces: [
    { id: 'source', hostId: 'local', name: 'Source project', path: path.join(privateRoot, 'repo'), kind: 'folder' },
    { id: 'source-side', hostId: 'local', name: 'Side Zone', path: path.join(privateRoot, 'repo-side'), kind: 'worktree', repoPath: path.join(privateRoot, 'repo'), branch: 'side' },
    { id: 'target', hostId: 'local', name: 'Target directory', path: path.join(privateRoot, 'target'), kind: 'folder' },
    { id: 'empty', hostId: 'local', name: 'Empty directory', path: path.join(privateRoot, 'empty'), kind: 'folder' },
    { id: SCRATCH_WORKSPACE_ID, hostId: 'local', name: 'Topics', path: path.join(privateRoot, 'topics'), kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
let config = phase === 'seed' ? initialConfig : JSON.parse(await fs.readFile(configFile, 'utf8')) as AppConfig
const store = new AgentMuxFileAgentSessionStore(path.join(privateRoot, 'agent-sessions.json'))
const topics = new ScratchTopics()
const demands = openDemandStore({ root: path.join(privateRoot, 'user-data', 'demands') })
const runtime = new RuntimeController(store, topics)
const configOwner = new ConfigOwner({ read: () => config,
  save: async next => { await fs.writeFile(configFile, JSON.stringify(next)); return next }, publish: next => { config = next } })
const worktrees = new WorktreeService(id => runtime.executionHost(id), { save: (next, before) => configOwner.edit(before, next) })
const calls: { operation: string; args: unknown[]; at: number }[] = []
const result: Record<string, any> = { schema: 'agentmux.desktop-focus-navigation.phase.v1', phase, pid: process.pid,
  candidate: { sourceCommit, sourceTree, rendererId }, passed: false, steps: [], cli: [], screenshots: [] }
const diagnosticOnly = process.env.AGENTMUX_FOCUS_PROOF_DIAGNOSTIC === 'delayed-input'
let coldDiagnosticActive = false
const coldMain: { kind: string; at: number; [key: string]: unknown }[] = []
const coldPoint = (kind: string, facts: Record<string, unknown> = {}) => {
  if (coldDiagnosticActive && coldMain.length < 256) coldMain.push({ kind, at: Date.now(), ...facts })
}
let win: BrowserWindow
let server: AgentMuxControlServer
let finishing = false
let emptySnapshot = phase === 'empty-restore'
let canonicalReleased = phase !== 'empty-restore'
let releaseCanonical: (() => void) | undefined
const canonicalGate = phase === 'empty-restore' ? new Promise<void>(resolve => { releaseCanonical = resolve }) : null
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const client = () => (runtime as any).hosts.get('local').client
const scratch = () => config.workspaces.find(one => one.id === SCRATCH_WORKSPACE_ID)!
const bridge = new DesktopControlIpcBridge({ isAvailable: () => Boolean(win && !win.isDestroyed()),
  sendRequest: request => {
    coldPoint('main-control-send', { requestId: request.requestId, operation: request.operation })
    win.webContents.send('agentmux:control-request', request)
  },
  sendCancellation: cancellation => {
    coldPoint('main-control-cancel', { requestId: cancellation.requestId, code: cancellation.code })
    win.webContents.send('agentmux:control-cancel', cancellation)
  } })
ipcMain.on('control:response', (_event, response) => {
  const accepted = bridge.accept(response)
  coldPoint('main-control-accept', { requestId: response.requestId, ok: response.ok, accepted })
})
ipcMain.handle('focus-proof:request', async (_event, operation, ...args) => {
  calls.push({ operation, args, at: Date.now() })
  if (operation === 'topics' || operation === 'flush') coldPoint('main-boundary-request', { operation })
  switch (operation) {
    case 'setup': return { phase, config }
    case 'topics': return topics.list(scratch())
    case 'demands': return demands.list()
    case 'ensure-topic': return args[1] === PMO_TEAMS_TOPIC_ID ? topics.ensureMote(scratch(), args[1]) : topics.ensure(scratch(), args[1])
    case 'ensure-mote': return topics.ensureMote(scratch(), args[1])
    case 'read-topic': return topics.read(scratch(), args[1])
    case 'detect': return runtime.detect(args[0], args[1], config)
    case 'create-resource': return createSpaceZoneResource(args[0], { config: () => config, topics: () => topics.list(scratch()),
      host: id => runtime.executionHost(id), worktrees, register: fields => registerWorkspace(fields, configOwner, id => runtime.executionHost(id)) })
    case 'launch-agent': return runtime.launchAgent(args[0], config)
    case 'launch-terminal': return runtime.launchTerminal(args[0], config)
    case 'creation': return runtime.agentCreation(args[0], args[1])
    case 'snapshot': {
      if (emptySnapshot) { emptySnapshot = false; result.emptySnapshotInjected = true; return { sessions: [], timelines: {}, recoveryCandidates: [] } }
      const actual = await runtime.snapshot(config)
      if (!canonicalReleased && canonicalGate) {
        result.canonicalSnapshotHeld = { agentSessionIds: actual.sessions.filter(one => one.kind === 'agent').map(one => one.id),
          runIds: actual.sessions.map(one => one.control.run.runId) }
        await canonicalGate
      }
      return actual
    }
    case 'recover': return runtime.recoverSession(args[0], config, args[1])
    case 'attach': return runtime.attachSession(win.webContents.id, args[0], args[1], config)
    case 'replay': return runtime.readSessionReplay(win.webContents.id, args[0], args[1])
    case 'detach': return runtime.detachSession(win.webContents.id, args[0])
    case 'resize': return runtime.resizeSessionAttachment(win.webContents.id, args[0], args[1], args[2])
    case 'write': return runtime.write(args[0], args[1], args[2])
    case 'paste': return runtime.paste(args[0], args[1], args[2])
    case 'respond': return runtime.respondInteraction(args[0], args[1])
    case 'submit': return runtime.submitPrompt(args[0], args[1], args[2], args[3], undefined, args[4], args[5])
    case 'resolve': return runtime.resolveSession(args[0], config)
    case 'refresh': return runtime.refresh(args[0], config)
    case 'stop': return runtime.stopSession(args[0])
    case 'flush': win.webContents.session.flushStorageData(); return
    default: throw new Error(`Unsupported private boundary: ${operation}`)
  }
})
const state = () => win.webContents.executeJavaScript('window.focusProofState()')
const evaluate = (expression: string) => win.webContents.executeJavaScript(expression)
const durable = (value: any) => ({ tabs: value.tabs, layouts: value.layouts,
  activeWorkspaceId: value.activeWorkspaceId, mainSurface: value.mainSurface, selectedDemandId: value.selectedDemandId,
  workbenchSpaceSelection: value.workbenchSpaceSelection, agentComposerDrafts: value.agentComposerDrafts,
  agentFocus: value.agentFocus, viewModes: value.viewModes, floating: value.floating })
const until = async (expression: string, budget = 15000) => {
  const deadline = Date.now() + budget
  do { const value = await evaluate(expression); if (value) return value; await delay(35) } while (Date.now() < deadline)
  throw new Error(`Private condition did not settle: ${expression}`)
}
async function recordStep(name: string, run: () => Promise<any>) {
  process.stderr.write(`focus-proof-step ${phase}:${name}\n`)
  const step: Record<string, any> = { name, startedAt: Date.now(), passed: false }
  result.steps.push(step)
  try { step.facts = await run(); step.passed = true; return step.facts }
  finally { step.finishedAt = Date.now(); await fs.writeFile(path.join(evidence, `${phase}-progress.json`), JSON.stringify(result, null, 2)) }
}
async function screenshot(name: string) {
  const filename = `${phase}-${name}.png`
  await fs.writeFile(path.join(evidence, filename), (await win.capturePage()).toPNG())
  const observed = await state()
  result.screenshots.push({ path: filename, selection: { mainSurface: observed.mainSurface, activeWorkspaceId: observed.activeWorkspaceId,
    goalId: observed.selectedDemandId, space: observed.workbenchSpaceSelection }, floating: observed.floating, caret: observed.caret })
}
async function cli(args: string[], expectedExit = 0) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  for (const name of ['AGENTMUX_ENV', 'AGENTMUX_AGENT_SESSION_ID', 'AGENTMUX_AGENT_CAPABILITY', 'AGENTMUX_RUN_ID',
    'AGENTMUX_WORKSPACE_ID', 'AGENTMUX_REGION_ID', 'AGENTMUX_TAB_ID', 'AGENTMUX_VIEW_ID']) delete env[name]
  env.AGENTMUX_AGENT_SESSION_STORE = path.join(privateRoot, 'agent-sessions.json')
  const startedAt = Date.now()
  coldPoint('main-cli-start')
  let stdout = '', stderr = '', exitCode = 0
  try { const output = await execFile(nodeExecutable, [cliPath, ...args], { env, timeout: 25000, maxBuffer: 1024 * 1024 }); stdout = output.stdout; stderr = output.stderr }
  catch (error: any) { stdout = error.stdout ?? ''; stderr = error.stderr ?? ''; exitCode = typeof error.code === 'number' ? error.code : -1 }
  const lines = stdout.trim().split('\n')
  const entry: Record<string, any> = { args, stdout, stderr, exitCode, startedAt, finishedAt: Date.now() }
  coldPoint('main-cli-end', { exitCode })
  result.cli.push(entry)
  assert.equal(lines.length, 1, 'The public CLI returns one JSON receipt')
  assert.equal(exitCode, expectedExit, `${args.join(' ')}: ${stdout}\n${stderr}`)
  const receipt = parseAgentMuxControlReceipt(JSON.parse(lines[0]))
  entry.receipt = receipt
  assert.equal(receipt.ok, true, stdout)
  return receipt.result as any
}
const lifecycle = (entries: typeof calls) => entries.filter(one => ['launch-agent', 'launch-terminal', 'stop', 'submit', 'write', 'paste', 'create-resource', 'recover', 'refresh', 'ensure-topic', 'ensure-mote', 'read-topic', 'detect'].includes(one.operation))
async function preservation(name: string, args: string[], presentation = 'main-visible') {
  return recordStep(name, async () => {
    const beforeCalls = calls.length, before = durable(await state())
    const receipt = await cli(['focus', ...args])
    const input = await evaluate('window.focusProofPreservedInput()')
    assert.ok(input.sameElement && input.sameView && input.sameAnchor && input.sameFocus && input.sameOffsets && input.sameValue,
      `Original Mote caret/View changed: ${JSON.stringify(input)}`)
    assert.deepEqual(input.events.filter((one: any) => ['focusin', 'focusout', 'compositionend'].includes(one.type)), [])
    assert.equal(receipt.input.outcome, 'preserved')
    assert.equal(receipt.input.after.scope, 'floating')
    assert.equal(receipt.presentation.state, presentation)
    assert.equal(receipt.partial, presentation !== 'main-visible')
    assert.deepEqual(lifecycle(calls.slice(beforeCalls)), [], 'Navigation never authorizes lifecycle, preparation or input')
    const after = durable(await state())
    assert.deepEqual(after.agentComposerDrafts, before.agentComposerDrafts)
    assert.deepEqual(after.floating, before.floating)
    return { receipt, actualInput: input, beforeCalls, afterCalls: calls.length }
  })
}
async function observeBorrowedHomeNotice(tabId: string, regionId: string) {
  await until(`document.querySelector('.workbench-tab-slot[data-workbench-tab-id=' + CSS.escape(${JSON.stringify(tabId)}) + '] [data-workbench-borrowed-view-notice]')`)
  const notice = await evaluate(`(() => {
    const markers = [...document.querySelectorAll('[data-workbench-borrowed-view-notice]')]
    const visible = element => { if (!element?.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' &&
        rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight }
    const unobscured = element => { if (!visible(element)) return false; const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2); return Boolean(hit && element.contains(hit)) }
    const actual = markers.filter(visible)
    if (actual.length !== 1) throw new Error('Expected one actually visible Main borrowed View notice, got ' + actual.length)
    const marker = actual[0], serviceWindow = marker.querySelector('.service-window'), slot = marker.closest('.workbench-tab-slot')
    const lines = ['step', 'mode', 'restore'].map(name => { const element = serviceWindow?.querySelector('.service-window__' + name);
      return { name, present: Boolean(element), visible: visible(element), unobscured: unobscured(element), text: element?.textContent ?? null } })
    const rect = serviceWindow?.getBoundingClientRect(), hit = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null
    const panel = document.querySelector('[data-pmo-teams-topic-floating]')
    const region = panel?.querySelector('[data-workbench-region-id=' + CSS.escape(${JSON.stringify(regionId)}) + ']')
    return { markerCount: markers.length, visibleMarkerCount: actual.length, tabId: slot?.dataset.workbenchTabId ?? null,
      main: !marker.closest('[data-pmo-teams-topic-floating]'), outsideInbox: !marker.closest('.global-system-notices'),
      serviceVisible: visible(serviceWindow), role: serviceWindow?.getAttribute('role'), ariaLive: serviceWindow?.getAttribute('aria-live'),
      unobscured: Boolean(hit && serviceWindow?.contains(hit)), lines,
      originalViewFloating: Boolean(region?.isConnected && region.closest('.retained-workbench-view') && region.closest('[data-pmo-teams-topic-floating]')) }
  })()`)
  assert.ok(notice.markerCount > 0 && notice.visibleMarkerCount === 1)
  assert.equal(notice.tabId, tabId)
  assert.ok(notice.main && notice.outsideInbox && notice.serviceVisible && notice.unobscured && notice.originalViewFloating)
  assert.equal(notice.role, 'status'); assert.equal(notice.ariaLive, 'polite')
  assert.deepEqual(notice.lines, [
    { name: 'step', present: true, visible: true, unobscured: true, text: 'Selected View is in Mote' },
    { name: 'mode', present: true, visible: true, unobscured: true, text: 'This Tab is selected here. Its original View remains in the floating window.' },
    { name: 'restore', present: true, visible: true, unobscured: true, text: 'Close Mote to return this View to Space.' }
  ])
  return notice
}
async function freshTerminalInput(name: string, address: any, character: string, precedingReceipt?: any) {
  return recordStep(name, async () => {
    const beforeDom = await evaluate(`({ liveReady: window.focusProofReadyTerminal(${JSON.stringify(address.to.regionId)}, ${JSON.stringify(address.agent.agentSessionId)}, ${JSON.stringify(address.agent.runId)}),
      regionPresent: Boolean(document.querySelector('[data-workbench-region-id=' + CSS.escape(${JSON.stringify(address.to.regionId)}) + ']')) })`)
    const receipt = precedingReceipt ?? await cli(['focus', '--region', address.to.regionId, '--input', 'target'])
    assert.equal(receipt.input.outcome, 'transferred')
    assert.equal(receipt.input.after.regionId, address.to.regionId)
    assert.equal(receipt.input.after.sessionId, address.agent.agentSessionId)
    await until(`window.focusProofReadyTerminal(${JSON.stringify(address.to.regionId)}, ${JSON.stringify(address.agent.agentSessionId)}, ${JSON.stringify(address.agent.runId)})`)
    const before = (await client().readRunReplay({ runId: address.agent.runId })).run
    const cursor = calls.length
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: character })
    let replay: any, rawNewOutput = ''
    const deadline = Date.now() + 15000
    do { replay = await client().readRunReplay({ runId: address.agent.runId }, before.latestOutputBytes)
      rawNewOutput = replay.replay.map((chunk: any) => Buffer.from(chunk.dataBytes).toString('utf8')).join('')
      if (replay.run.acceptedInputBytes > before.acceptedInputBytes && rawNewOutput.includes(character) && rawNewOutput.includes('codex-composer-rendered:')) break
      await delay(35)
    } while (Date.now() < deadline)
    assert.ok(replay.run.acceptedInputBytes > before.acceptedInputBytes && replay.run.latestOutputBytes > before.latestOutputBytes)
    assert.ok(rawNewOutput.includes(character) && rawNewOutput.includes('codex-composer-rendered:'))
    assert.ok(rawNewOutput.includes(`\u001b[32m${character}\u001b[0m`) || rawNewOutput.includes(`\u001b[36m${character}\u001b[0m`), 'The exact new character is present in a fresh Provider composer frame')
    assert.ok(rawNewOutput.includes('\u001b[?2026h\u001b[22;3H') && rawNewOutput.includes('\u001b[?2026l'), 'The post-cursor bytes contain the actual complete composer frame')
    const writes = calls.slice(cursor).filter(one => one.operation === 'write' && one.args[1] === character && one.args[2] === 'user')
    assert.equal(writes.length, 1)
    assert.deepEqual(writes[0].args[0], { kind: 'agent', hostId: 'local', agentSessionId: address.agent.agentSessionId, run: { runId: address.agent.runId } })
    await screenshot(name)
    return { receipt, beforeDom, precedingPublicCaretReceipt: Boolean(precedingReceipt), agentSessionId: address.agent.agentSessionId, runId: address.agent.runId,
      before: { acceptedInputBytes: before.acceptedInputBytes, latestOutputBytes: before.latestOutputBytes },
      after: { acceptedInputBytes: replay.run.acceptedInputBytes, latestOutputBytes: replay.run.latestOutputBytes },
      rawNewOutput, writes }
  })
}
async function finish(passed: boolean) {
  if (finishing) return
  finishing = true
  result.passed = passed
  result.calls = calls
  if (win && !win.isDestroyed()) result.final = await state().catch(() => null)
  result.persisted = (await store.load()).map(one => ({ agentSessionId: one.agentSessionId, run: one.run,
    nativeHandle: one.nativeHandle, workspacePath: one.workspacePath, creation: one.creation }))
  try { result.runs = (await client().listRuns()).filter((one: any) => one.state === 'running').map((one: any) => ({ runId: one.runId, pid: one.pid })) }
  catch (error) { result.runObservationFailure = String(error) }
  bridge.dispose()
  try { await server?.stop(); await runtime.dispose() }
  catch (error) { result.cleanupFailure = String(error); result.passed = false }
  await fs.writeFile(path.join(evidence, `${phase}.json`), JSON.stringify(result, null, 2))
  if (win && !win.isDestroyed()) win.destroy()
  app.exit(result.passed ? 0 : 1)
}
app.whenReady().then(async () => {
  try {
    if (phase === 'seed') {
      await fs.writeFile(configFile, JSON.stringify(config))
      await topics.ensure(scratch(), 'view:focus-proof-topic', 'Private Topic')
      await topics.ensure(scratch(), 'view:focus-proof-empty', 'Private empty Topic')
      await topics.ensureMote(scratch(), PMO_TEAMS_TOPIC_ID)
      await demands.create({ id: 'private-goal-linked', title: 'First linked Goal', status: 'in_progress' })
      await demands.create({ id: 'private-goal-exact', title: 'Exact requested Goal', status: 'in_progress', description: 'This exact Goal must stay selected.' })
    }
    runtime.commit(await runtime.prepare(config))
    win = new BrowserWindow({ width: 1250, height: 880, show: false,
      webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, preload } })
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) process.stderr.write(`Renderer: ${message}\n`) })
    runtime.attach(win.webContents)
    await win.loadFile(html)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await until('window.focusProofReady === true && !window.focusProofState().loading')
    const loadedRenderer = { kind: 'bundled' as const, id: rendererId, identity: JSON.parse(identityJson) }
    server = new AgentMuxControlServer({ execute: request => request.operation === 'inspect.client'
      ? inspectDesktopClient(request, { pid: process.pid,
        package: { schema: 'agentmux.package-identity.v1', sourceCommit, sourceTree, appVersion: 'private-proof', platform: process.platform, arch: process.arch },
        renderer: () => loadedRenderer, generation: () => runtime.rendererGeneration(win.webContents),
        storage: () => observeWorkbenchStorageAuthority(win.webContents.session, { userData: app.getPath('userData'), sessionData: app.getPath('sessionData') }),
        runtimes: () => runtime.connectedRuntimeIdentities(), execute: input => bridge.execute(input) })
      : bridge.execute(request) })
    await server.start()
    result.initial = await state()
    let ids: any
    if (phase === 'seed') {
      ids = await recordStep('authorized-initial-setup', async () => {
        const catalog = (await cli(['space', 'ls'])).catalog
        const zone = (id: string) => catalog.zones.find((one: any) => one.workspaceId === id)
        const moteSpace = catalog.spaces.find((one: any) => one.kind === 'mote')
        const topicSpace = catalog.spaces.find((one: any) => one.kind === 'topic' && one.topicId === 'view:focus-proof-topic')
        const emptyTopicSpace = catalog.spaces.find((one: any) => one.kind === 'topic' && one.topicId === 'view:focus-proof-empty')
        assert.ok(zone('source') && zone('target') && zone('empty') && moteSpace && topicSpace && emptyTopicSpace)
        const open = async (key: string, flags: string[]) => {
          const opened = await cli(['agent', 'open', '--executor', 'fixture', ...flags, '--prompt', `Private ${key} setup`, '--request-id', `private:focus:${key}`])
          assert.equal(opened.outcome, 'opened'); assert.equal(opened.agent.initialPrompt, 'confirmed')
          return opened
        }
        const source = await open('source', ['--zone', zone('source').zoneId, '--focus'])
        const target = await open('target', ['--zone', zone('target').zoneId])
        const mote = await open('mote', ['--space', moteSpace.spaceId])
        const moteSecond = await cli(['agent', 'open', '--session', mote.agent.agentSessionId,
          '--region', mote.to.regionId, '--split', 'right', '--request-id', 'private:focus:mote-second-projection'])
        assert.equal(moteSecond.outcome, 'opened')
        assert.equal(moteSecond.agent.agentSessionId, mote.agent.agentSessionId)
        assert.equal(moteSecond.agent.runId, mote.agent.runId)
        assert.equal(moteSecond.to.tabId, mote.to.tabId)
        assert.notEqual(moteSecond.to.regionId, mote.to.regionId)
        await cli(['focus', '--region', mote.to.regionId])
        await cli(['focus', '--region', source.to.regionId])
        const topic = await open('topic', ['--space', topicSpace.spaceId])
        await demands.linkSession('private-goal-linked', source.agent.agentSessionId)
        await evaluate('window.focusProofRefreshDemands()')
        await recordStep('actual-hover-preview-readonly', async () => {
          const before = await state(), cursor = calls.length
          const box = await evaluate(`(() => { const button = document.querySelector('[data-pmo-teams-topic-launcher] button');
            if (!button) throw new Error('Actual Mote launcher absent'); const rect = button.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height } })()`)
          assert.ok(box.width > 0 && box.height > 0)
          await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
          await until('window.focusProofState().floating?.preview === true')
          await delay(250)
          const current = await state()
          assert.equal(current.floating.open, false)
          assert.deepEqual(current.tabs, before.tabs)
          assert.equal(current.caret.regionId, before.caret.regionId)
          assert.deepEqual(lifecycle(calls.slice(cursor)), [], 'Hover preview grants no lifecycle/input/preparation authority')
          const observed = parseDesktopClientObservation((await cli(['inspect', '--client'])).observation)
          assert.equal(observed.workbench.desktop.floating.state, 'preview')
          assert.equal(observed.workbench.desktop.floating.tabId, mote.to.tabId)
          assert.equal(observed.workbench.desktop.floating.presentation, 'visible')
          await screenshot('actual-hover-preview')
          await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 10 })
          await until('window.focusProofState().floating?.preview === false && window.focusProofState().floating?.open === false')
          const closed = parseDesktopClientObservation((await cli(['inspect', '--client'])).observation)
          assert.equal(closed.workbench.desktop.floating.state, 'closed')
          assert.deepEqual(lifecycle(calls.slice(cursor)), [])
          return { before: { caret: before.caret, floating: before.floating }, box, current: { caret: current.caret, floating: current.floating }, observed, closed }
        })
        await evaluate(`window.focusProofInitializeMote(${JSON.stringify(mote.to.tabId)}, ${JSON.stringify(mote.agent.agentSessionId)}); true`)
        await until('window.focusProofMoteInput() && window.focusProofMoteInput().getBoundingClientRect().height > 0')
        await delay(400)
        await evaluate('window.focusProofFocusMoteInput(); true')
        await win.webContents.debugger.sendCommand('Input.insertText', { text: 'Private unsent Mote draft' })
        await until(`window.focusProofState().agentComposerDrafts[${JSON.stringify(mote.agent.agentSessionId)}]?.includes('Private unsent Mote draft')`)
        const setupIds = { source, target, mote, moteSecond, topic, empty: zone('empty'), sourceSpace: zone('source').spaceId, moteSpace, topicSpace, emptyTopicSpace }
        await fs.writeFile(path.join(privateRoot, 'ids.json'), JSON.stringify(setupIds))
        return setupIds
      })
      result.baselineCalls = calls.length
      result.baselineRuns = (await client().listRuns()).filter((one: any) => one.state === 'running').map((one: any) => ({ runId: one.runId, pid: one.pid }))
      await recordStep('native-ime-start', async () => {
        await win.webContents.debugger.sendCommand('Input.imeSetComposition', { text: '草', selectionStart: 1, selectionEnd: 1 })
        await until("window.focusProofEvents.some(one => one.type === 'compositionstart')")
        return evaluate('window.focusProofCaptureInput()')
      })
      await preservation('space-zone-preserve', ['--zone', ids.source.to.zoneId])
      await screenshot('source-space-with-mote')
      await preservation('exact-tab-preserve', ['--tab', ids.target.to.tabId])
      await preservation('exact-region-preserve', ['--region', ids.source.to.regionId])
      const goal = await preservation('exact-goal-preserve', ['--goal', 'private-goal-exact'])
      assert.equal(goal.receipt.navigation.selection.goalId, 'private-goal-exact')
      await screenshot('exact-goal-with-mote')
      for (const surface of ['search', 'focus', 'goals', 'space']) await preservation(`surface-${surface}-preserve`, ['--surface', surface])
      assert.equal((await state()).selectedDemandId, 'private-goal-exact')
      const borrowed = await preservation('borrowed-view-partial', ['--region', ids.mote.to.regionId], 'floating')
      await recordStep('borrowed-home-service-window-visible', async () => {
        const before = durable(await state()), cursor = calls.length
        const notice = await observeBorrowedHomeNotice(ids.mote.to.tabId, ids.mote.to.regionId)
        const input = await evaluate('window.focusProofPreservedInput()')
        assert.ok(input.sameElement && input.sameView && input.sameAnchor && input.sameFocus && input.sameOffsets && input.sameValue)
        assert.deepEqual(input.events.filter((one: any) => ['focusin', 'focusout', 'compositionend'].includes(one.type)), [])
        assert.deepEqual(durable(await state()), before)
        assert.deepEqual(lifecycle(calls.slice(cursor)), [])
        await screenshot('borrowed-view-partial-inline-service-window')
        return { receipt: borrowed.receipt, notice, input, calls: calls.slice(cursor) }
      })
      await recordStep('zero-tab-no-lifecycle', async () => {
        const cursor = calls.length, before = await state(), runs = await client().listRuns()
        const receipt = await cli(['focus', '--zone', ids.empty.zoneId])
        assert.equal(receipt.navigation.selection.space.tabId, null)
        assert.equal(receipt.navigation.selection.space.zoneId, ids.empty.zoneId)
        assert.equal(receipt.presentation.state, 'main-visible')
        await delay(300)
        assert.deepEqual(lifecycle(calls.slice(cursor)), [])
        const after = await state()
        assert.deepEqual(after.tabs, before.tabs)
        assert.deepEqual((await client().listRuns()).map((one: any) => one.runId), runs.map((one: any) => one.runId))
        return { receipt, calls: calls.slice(cursor), tabs: Object.keys(after.tabs), runs: runs.map((one: any) => one.runId) }
      })
      await recordStep('strict-native-targets', async () => {
        const before = durable(await state()), cursor = calls.length
        const ambiguous = await cli(['focus', '--space', ids.sourceSpace])
        assert.equal(ambiguous.navigation.state, 'rejected')
        assert.ok(ambiguous.issues[0].candidates.length >= 2)
        const mismatch = await cli(['focus', '--space', ids.sourceSpace, '--region', ids.target.to.regionId])
        assert.equal(mismatch.navigation.state, 'rejected')
        const unknown = await cli(['focus', '--zone', 'private:unknown-zone'])
        assert.equal(unknown.navigation.state, 'rejected')
        assert.deepEqual(durable(await state()), before)
        assert.deepEqual(lifecycle(calls.slice(cursor)), [])
        return { ambiguous, mismatch, unknown }
      })
      await recordStep('native-ime-complete', async () => {
        const still = await evaluate('window.focusProofPreservedInput()')
        assert.ok(still.sameElement && still.sameView && still.sameOffsets)
        await win.webContents.debugger.sendCommand('Input.insertText', { text: '草稿' })
        await until("window.focusProofEvents.some(one => one.type === 'compositionend')")
        await win.webContents.debugger.sendCommand('Input.insertText', { text: ' continues' })
        await delay(80)
        const actual = await state()
        assert.ok(actual.agentComposerDrafts[ids.mote.agent.agentSessionId].includes('草稿 continues'))
        assert.equal(actual.caret.regionId, ids.mote.to.regionId)
        return { events: actual.events.filter((one: any) => one.type.startsWith('composition')), draft: actual.agentComposerDrafts[ids.mote.agent.agentSessionId], caret: actual.caret }
      })
      await freshTerminalInput('mounted-target-native-input', ids.source, 'q')
      await freshTerminalInput('target-native-input', ids.target, 'x')
      await evaluate(`window.focusProofHumanViewMode(${JSON.stringify(ids.mote.agent.agentSessionId)}, 'terminal'); true`)
      await freshTerminalInput('mote-native-input', ids.mote, 'm')
      await evaluate(`window.focusProofHumanViewMode(${JSON.stringify(ids.mote.agent.agentSessionId)}, 'activity'); true`)
      await until('window.focusProofMoteInput()')
      await evaluate('window.focusProofFocusMoteInput(); window.focusProofCaptureInput()')
      const delayedTarget = await recordStep('delayed-exact-input-owner', async () => {
        const cursor = calls.length
        coldDiagnosticActive = true
        coldPoint('main-diagnostic-begin')
        await evaluate(`window.focusProofBeginColdDiagnostics(${JSON.stringify(ids.target.to.regionId)}); true`)
        try {
          await evaluate(`window.focusProofHoldTargetInput(${JSON.stringify(ids.target.to.regionId)}); true`)
          const pending = cli(['focus', '--region', ids.target.to.regionId, '--input', 'target'])
          await until(`window.focusProofState().regionCaretFocus?.regionId === ${JSON.stringify(ids.target.to.regionId)}`)
          coldPoint('main-nonce-observed')
          await evaluate("window.focusProofColdPoint('fixture-nonce-observed'); true")
          const held = await state()
          assert.equal(held.caret.regionId, ids.mote.to.regionId)
          coldPoint('main-70ms-delay-begin')
          await delay(70)
          coldPoint('main-70ms-delay-end')
          await evaluate('window.focusProofReleaseTargetInput(); true')
          const receipt = await pending
          assert.equal(receipt.input.outcome, 'transferred')
          assert.equal(receipt.input.after.regionId, ids.target.to.regionId)
          assert.equal(receipt.input.after.sessionId, ids.target.agent.agentSessionId)
          assert.equal((await state()).regionCaretFocus, null)
          assert.deepEqual(lifecycle(calls.slice(cursor)), [])
          await screenshot('delayed-target-input')
          return { boundaryFault: 'One exact existing Region host is temporarily inert; its original input owner waits.', held, receipt }
        } finally {
          const renderer = await evaluate('window.focusProofEndColdDiagnostics()').catch(error => ({ failure: String(error) }))
          coldPoint('main-diagnostic-end')
          result.coldDiagnostics = { scope: 'One cold delayed-input step only; metadata, no draft/output content.', main: coldMain, renderer }
          coldDiagnosticActive = false
        }
      })
      if (diagnosticOnly) {
        result.diagnosticOnly = 'delayed-input'
        await finish(true)
        return
      }
      await freshTerminalInput('delayed-target-native-input', ids.target, 'd', delayedTarget.receipt)
      await evaluate('window.focusProofFocusMoteInput(); window.focusProofCaptureInput()')
      await recordStep('later-human-navigation-cancels-input', async () => {
        const cursor = calls.length, before = await state()
        const moteDom = await evaluate(`window.focusProofCaptureMoteRegions(${JSON.stringify(ids.mote.to.regionId)}, ${JSON.stringify(ids.moteSecond.to.regionId)})`)
        await evaluate(`window.focusProofHoldTargetInput(${JSON.stringify(ids.target.to.regionId)}); true`)
        const pending = cli(['focus', '--region', ids.target.to.regionId, '--input', 'target'])
        await until(`window.focusProofState().regionCaretFocus?.regionId === ${JSON.stringify(ids.target.to.regionId)}`)
        const held = await state()
        const humanNavigationRequestedAt = Date.now()
        await evaluate("window.focusProofHumanNavigate('search'); true")
        const humanNavigationReturnedAt = Date.now()
        const receipt = await pending
        assert.equal(receipt.navigation.state, 'unconfirmed')
        assert.equal(receipt.navigation.selection.surface, 'search')
        assert.notEqual(receipt.input.outcome, 'transferred')
        assert.equal((await state()).regionCaretFocus, null)
        assert.equal(await evaluate('document.activeElement === document.querySelector(".global-search-input input")'), true, 'The later human Search action owns its actual input')
        const humanInput = await evaluate('window.focusProofCaptureInput()')
        assert.equal(humanInput.caret.tag, 'INPUT')
        assert.ok(humanInput.caret.connected && humanInput.caret.visible && !humanInput.caret.inert)
        assert.equal(typeof humanInput.value, 'string')
        assert.ok(Number.isSafeInteger(humanInput.caret.selectionStart) && Number.isSafeInteger(humanInput.caret.selectionEnd))
        await evaluate('window.focusProofReleaseTargetInput(); true')
        await delay(100)
        const preserved = await evaluate('window.focusProofPreservedInput()')
        assert.ok(preserved.sameElement && preserved.sameValue)
        assert.equal(preserved.caret.selectionStart, humanInput.caret.selectionStart)
        assert.equal(preserved.caret.selectionEnd, humanInput.caret.selectionEnd)
        assert.deepEqual(preserved.events.filter((one: any) => ['focusin', 'focusout'].includes(one.type)), [])
        const afterHuman = await state(), moteNodes = await evaluate('window.focusProofCheckMoteRegions()')
        assert.ok(moteNodes.leftSame && moteNodes.rightSame && moteNodes.leftValueSame && moteNodes.rightValueSame, 'The original Mote DOM and values survive independently of the human input move')
        assert.deepEqual(afterHuman.agentComposerDrafts, before.agentComposerDrafts)
        assert.equal(afterHuman.regionCaretFocus, null)
        await screenshot('later-navigation-keeps-human-search-input')
        const returned = await cli(['focus', '--region', ids.target.to.regionId])
        // Main Search is now hidden/inert. Its input cannot be claimed as visible/preserved;
        // default display navigation still never authorizes the cancelled target caret.
        assert.equal(returned.input.outcome, 'unavailable')
        const hiddenSearch = await evaluate('window.focusProofCapturedInputState()')
        assert.ok(hiddenSearch.capturedExists && hiddenSearch.capturedIsSearch && hiddenSearch.capturedConnected &&
          hiddenSearch.capturedHidden && hiddenSearch.capturedInert, 'The same original Search input is now actually hidden and inert')
        // The receipt captures its own instant. Chromium may leave the hidden Search active
        // then move to body before this live read; both observations must tell their real facts.
        if (returned.input.after.scope === 'main') {
          assert.deepEqual(returned.input.after, { provenance: 'observed', scope: 'main', ownerKind: 'other',
            tabId: null, regionId: null, sessionId: null, connected: true, visible: false, inert: true })
        } else {
          assert.deepEqual(returned.input.after, { provenance: 'observed', scope: 'none', ownerKind: null,
            tabId: null, regionId: null, sessionId: null, connected: null, visible: null, inert: null })
        }
        const afterReturn = await state()
        assert.equal(hiddenSearch.activeConnected, true)
        assert.ok(hiddenSearch.activeSameCaptured || hiddenSearch.activeBody || !hiddenSearch.activeEditable,
          'The live owner is the original hidden Search or a real non-input control, never a different editable owner')
        assert.equal(afterReturn.regionCaretFocus, null)
        assert.ok(humanInput.eventCursor > 0, 'The actual focus event stream was populated before cancellation')
        assert.deepEqual(afterReturn.events.slice(humanInput.eventCursor).filter((one: any) => one.type === 'focusin' && one.editableTarget), [])
        assert.deepEqual(afterReturn.agentComposerDrafts, before.agentComposerDrafts)
        assert.deepEqual(lifecycle(calls.slice(cursor)), [])
        await screenshot('default-target-does-not-replay-cancelled-input')
        return { boundaryFault: 'Exact target temporarily inert while a later human navigation wins.', held, receipt,
          humanNavigationRequestedAt, humanNavigationReturnedAt, humanInput, preserved, moteDom, moteNodes, before, afterHuman, returned, hiddenSearch, afterReturn }
      })
      await recordStep('readonly-inspect-client', async () => {
        await delay(160)
        const beforeState = await state(), before = durable(beforeState), cursor = calls.length
        const inputBefore = await evaluate('window.focusProofCaptureInput()')
        const inputPresence = await evaluate('({ connected: Boolean(document.activeElement?.isConnected), body: document.activeElement === document.body, editable: Boolean(document.activeElement?.isContentEditable || ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) })')
        assert.equal(inputPresence.connected, true, 'The current active DOM element actually exists')
        await evaluate('window.focusProofBeginInspect(); true')
        // Observe the same cold request through the original shared Main schema.
        const observed = parseDesktopClientObservation((await cli(['inspect', '--client'])).observation)
        assert.equal(observed.main.pid, process.pid)
        assert.equal(observed.workbench.desktop.floating.tabId, ids.mote.to.tabId)
        if (!inputPresence.editable) {
          if (inputPresence.body) assert.equal(inputBefore.caret.tag, 'BODY')
          else assert.ok(inputBefore.caret.tag, 'A real non-input control is the current active element')
          assert.deepEqual(observed.workbench.desktop.input, { provenance: 'observed', scope: 'none', ownerKind: null,
            tabId: null, regionId: null, sessionId: null, connected: null, visible: null, inert: null })
        } else {
          assert.ok(inputBefore.caret.tag, 'A nonempty actual editable owner is required')
          const input = observed.workbench.desktop.input
          assert.equal(input.provenance, 'observed')
          assert.equal(input.scope, inputBefore.caret.floating ? 'floating' : 'main')
          assert.equal(input.regionId, inputBefore.caret.regionId)
          assert.equal(input.connected, inputBefore.caret.connected)
          assert.equal(input.visible, inputBefore.caret.visible)
          assert.equal(input.inert, inputBefore.caret.inert)
          if (inputBefore.caret.regionId) {
            const tabs = Object.values(beforeState.tabs).filter((tab: any) => Boolean(tab.regions[inputBefore.caret.regionId])) as any[]
            assert.equal(tabs.length, 1, 'The actual input Region resolves to one nonempty original Tab')
            assert.equal(input.tabId, tabs[0].id)
            assert.equal(input.sessionId, tabs[0].regions[inputBefore.caret.regionId].sessionId ?? null)
          } else {
            assert.equal(input.tabId, null)
            assert.equal(input.sessionId, null)
          }
        }
        assert.ok(!JSON.stringify(observed).includes('Private unsent Mote draft'))
        assert.deepEqual(durable(await state()), before)
        assert.deepEqual(calls.slice(cursor).filter(one => one.operation !== 'topics'), [])
        const inputAfter = await evaluate('window.focusProofPreservedInput()')
        assert.ok(inputAfter.sameElement && inputAfter.sameValue)
        assert.equal(inputAfter.caret.selectionStart, inputBefore.caret.selectionStart)
        assert.equal(inputAfter.caret.selectionEnd, inputBefore.caret.selectionEnd)
        const stable = await evaluate('window.focusProofInspectEnd()')
        assert.deepEqual(stable, { stateSame: true, writes: 0, caretSame: true })
        return { observed, inputBefore, inputPresence, inputAfter, calls: calls.slice(cursor), stable }
      })
      await recordStep('empty-topic-original-mote-pointer', async () => {
        const cursor = calls.length
        const receipt = await cli(['focus', '--space', ids.emptyTopicSpace.spaceId])
        assert.equal(receipt.navigation.selection.space.tabId, null)
        assert.equal(receipt.navigation.selection.space.topicId, 'view:focus-proof-empty')
        const before = durable(await state())
        const dom = await evaluate(`window.focusProofCaptureMoteRegions(${JSON.stringify(ids.mote.to.regionId)}, ${JSON.stringify(ids.moteSecond.to.regionId)})`)
        const box = await evaluate(`(() => { const input = window.focusProofMoteInput(); if (!input) throw new Error('Original Mote input absent');
          const rect = input.getBoundingClientRect(); return { x: rect.left + Math.min(12, rect.width / 2), y: rect.top + Math.min(9, rect.height / 2), width: rect.width, height: rect.height } })()`)
        assert.ok(box.width > 0 && box.height > 0)
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
        await delay(160)
        const after = durable(await state()), actual = await state()
        const input = await evaluate('window.focusProofCheckMoteRegions()')
        assert.ok(input.leftSame && input.rightSame && input.leftValueSame && input.rightValueSame, 'Physical Mote click keeps both original input and View DOM objects')
        assert.equal(await evaluate('document.activeElement === window.focusProofMoteRegionRefs.left.input'), true, 'The physical pointer now authorizes the original left Mote input')
        assert.equal(await evaluate('window.focusProofMoteInput().contains(document.getSelection()?.anchorNode) && window.focusProofMoteInput().contains(document.getSelection()?.focusNode)'), true)
        assert.deepEqual(after.workbenchSpaceSelection, before.workbenchSpaceSelection)
        assert.equal(after.workbenchSpaceSelection.topicId, 'view:focus-proof-empty')
        assert.equal(after.activeWorkspaceId, SCRATCH_WORKSPACE_ID)
        assert.deepEqual(after.tabs, before.tabs)
        assert.deepEqual(after.agentComposerDrafts, before.agentComposerDrafts)
        assert.deepEqual(after.floating, before.floating)
        assert.equal(actual.caret.regionId, ids.mote.to.regionId)
        assert.equal(actual.caret.floating, true)
        assert.ok(actual.caret.connected && actual.caret.visible && !actual.caret.inert)
        assert.deepEqual(lifecycle(calls.slice(cursor)), [])
        await screenshot('empty-topic-mote-pointer-keeps-main')
        return { receipt, box, dom, before, after, input, actualCaret: actual.caret, calls: calls.slice(cursor) }
      })
      await recordStep('floating-pointer-selects-only-local-mote-region', async () => {
        const beforeState = await state(), before = durable(beforeState), cursor = calls.length
        assert.equal(before.workbenchSpaceSelection.topicId, 'view:focus-proof-empty')
        assert.equal(before.workbenchSpaceSelection.tabId, null)
        assert.equal(before.tabs[ids.mote.to.tabId].layout.activeRegionId, ids.mote.to.regionId)
        const dom = await evaluate(`window.focusProofCaptureMoteRegions(${JSON.stringify(ids.mote.to.regionId)}, ${JSON.stringify(ids.moteSecond.to.regionId)})`)
        assert.ok(dom.box.width > 0 && dom.box.height > 0)
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: dom.box.x, y: dom.box.y, button: 'left', clickCount: 1 })
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dom.box.x, y: dom.box.y, button: 'left', clickCount: 1 })
        await delay(160)
        const actual = await state(), after = durable(actual), nodes = await evaluate('window.focusProofCheckMoteRegions()')
        assert.deepEqual(nodes, { leftSame: true, rightSame: true, leftActive: false, rightActive: true,
          rightCaret: true, rightSelection: true, rightValueSame: true, leftValueSame: true })
        assert.equal(after.tabs[ids.mote.to.tabId].layout.activeRegionId, ids.moteSecond.to.regionId)
        assert.deepEqual(after.tabs[ids.mote.to.tabId].layout.root, before.tabs[ids.mote.to.tabId].layout.root)
        assert.deepEqual(after.tabs[ids.mote.to.tabId].regions, before.tabs[ids.mote.to.tabId].regions)
        const otherTabs = (tabs: Record<string, any>) => Object.fromEntries(Object.entries(tabs).filter(([tabId]) => tabId !== ids.mote.to.tabId))
        assert.deepEqual(otherTabs(after.tabs), otherTabs(before.tabs))
        assert.deepEqual(after.workbenchSpaceSelection, before.workbenchSpaceSelection)
        assert.deepEqual(after.layouts, before.layouts)
        assert.equal(after.activeWorkspaceId, before.activeWorkspaceId)
        assert.equal(after.mainSurface, before.mainSurface)
        assert.deepEqual(after.agentComposerDrafts, before.agentComposerDrafts)
        assert.deepEqual(after.viewModes, before.viewModes)
        assert.deepEqual(after.floating, before.floating)
        assert.equal(after.selectedDemandId, before.selectedDemandId)
        assert.deepEqual(actual.navigationInputPolicy, beforeState.navigationInputPolicy)
        assert.deepEqual(actual.retainedSpatialFocus, beforeState.retainedSpatialFocus)
        assert.equal(actual.caret.regionId, ids.moteSecond.to.regionId)
        assert.equal(actual.caret.floating, true)
        assert.ok(actual.caret.connected && actual.caret.visible && !actual.caret.inert)
        const observed = parseDesktopClientObservation((await cli(['inspect', '--client'])).observation)
        assert.deepEqual(observed.workbench.desktop.selection.space, before.workbenchSpaceSelection)
        assert.equal(observed.workbench.desktop.floating.regionId, ids.moteSecond.to.regionId)
        assert.equal(observed.workbench.desktop.input.regionId, ids.moteSecond.to.regionId)
        assert.equal(observed.workbench.desktop.input.sessionId, ids.mote.agent.agentSessionId)
        assert.equal(observed.workbench.desktop.input.scope, 'floating')
        assert.equal(observed.workbench.desktop.focus.pmoSessionId, ids.mote.agent.agentSessionId)
        assert.deepEqual(lifecycle(calls.slice(cursor)), [])
        await screenshot('floating-right-region-ring-keeps-empty-topic')
        return { sameSessionId: ids.mote.agent.agentSessionId, distinctRegionIds: [ids.mote.to.regionId, ids.moteSecond.to.regionId], dom, nodes,
          before, after, actualCaret: actual.caret, observed, calls: calls.slice(cursor) }
      })
      await recordStep('settings-covered-preserve', async () => {
        await evaluate("document.querySelector('[aria-label=Settings]').click(); true")
        await until("document.querySelector('[aria-label=\"Search settings\"]')")
        await evaluate("document.querySelector('[aria-label=\"Search settings\"]').focus(); true")
        await win.webContents.debugger.sendCommand('Input.insertText', { text: 'Private settings query' })
        const before = await evaluate('window.focusProofCaptureInput()'), cursor = calls.length
        const receipt = await cli(['focus', '--goal', 'private-goal-exact'])
        assert.equal(receipt.presentation.state, 'covered'); assert.equal(receipt.partial, true)
        assert.deepEqual(receipt.presentation.blockers, ['settings'])
        const input = await evaluate('window.focusProofPreservedInput()')
        assert.ok(input.sameElement && input.sameValue)
        const observed = parseDesktopClientObservation((await cli(['inspect', '--client'])).observation)
        assert.equal(observed.workbench.desktop.overlays.settings, true)
        assert.equal(observed.workbench.desktop.input.scope, 'overlay')
        assert.deepEqual(lifecycle(calls.slice(cursor)), [])
        await screenshot('settings-covered')
        await evaluate("document.querySelector('[aria-label=\"Close settings\"]').click(); true")
        await until("!document.querySelector('[aria-label=\"Search settings\"]')")
        return { before, receipt, input, observed }
      })
      await recordStep('quick-switch-covered-preserve', async () => {
        await evaluate('window.focusProofOpenQuickSwitcher(); true')
        await until("document.querySelector('[aria-label=\"Search sessions and tabs\"]')")
        await win.webContents.debugger.sendCommand('Input.insertText', { text: 'Private quick query' })
        const before = await evaluate('window.focusProofCaptureInput()'), cursor = calls.length
        const receipt = await cli(['focus', '--zone', ids.empty.zoneId])
        assert.equal(receipt.presentation.state, 'covered'); assert.deepEqual(receipt.presentation.blockers, ['quick-switcher'])
        const input = await evaluate('window.focusProofPreservedInput()')
        assert.ok(input.sameElement && input.sameValue)
        assert.deepEqual(lifecycle(calls.slice(cursor)), [])
        await screenshot('quick-switch-covered')
        await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
        await until("!document.querySelector('[aria-label=\"Search sessions and tabs\"]')")
        return { before, receipt, input }
      })
      await recordStep('shortcuts-covered-preserve', async () => {
        await evaluate('window.focusProofOpenShortcuts(); true')
        await until("document.querySelector('[data-settings-page=\"keyboard-shortcuts\"]')")
        const cursor = calls.length
        const receipt = await cli(['focus', '--goal', 'private-goal-exact'])
        assert.equal(receipt.presentation.state, 'covered'); assert.deepEqual(receipt.presentation.blockers, ['settings'])
        assert.deepEqual(lifecycle(calls.slice(cursor)), [])
        await screenshot('shortcuts-covered')
        await evaluate("document.querySelector('[aria-label=\"Close settings\"]').click(); true")
        return { receipt }
      })
      await recordStep('original-ui-tab-close-keeps-session-and-parent', async () => {
        const cursor = calls.length
        const beforeRuns = (await client().listRuns()).filter((one: any) => one.state === 'running').map((one: any) => ({ runId: one.runId, pid: one.pid }))
        const opened = await cli(['agent', 'open', '--session', ids.target.agent.agentSessionId,
          '--zone', ids.target.to.zoneId, '--new-tab', '--request-id', 'private:focus:extra-presentation'])
        assert.equal(opened.outcome, 'opened')
        assert.equal(opened.agent.agentSessionId, ids.target.agent.agentSessionId)
        assert.equal(opened.agent.runId, ids.target.agent.runId)
        assert.notEqual(opened.to.tabId, ids.target.to.tabId)
        const selected = await cli(['focus', '--tab', opened.to.tabId])
        assert.equal(selected.navigation.selection.space.tabId, opened.to.tabId)
        await until(`document.querySelector('[data-workbench-tab-id=' + CSS.escape(${JSON.stringify(opened.to.tabId)}) + '] .workbench-tab__close')`)
        // Activate the actual observed Tab button and its original close/confirmation owner.
        // A second original projection keeps this Session out of the last-View stop flow.
        const close = await evaluate(`(() => { const button = document.querySelector('[data-workbench-tab-id=' + CSS.escape(${JSON.stringify(opened.to.tabId)}) + '] .workbench-tab__close');
          if (!button) throw new Error('Exact original Tab close affordance absent');
          const observed = { tag: button.tagName, label: button.getAttribute('aria-label'), tabId: button.closest('[data-workbench-tab-id]').dataset.workbenchTabId };
          button.click(); return observed })()`)
        await until(`!window.focusProofState().tabs[${JSON.stringify(opened.to.tabId)}]`)
        const after = await state()
        const observed = parseDesktopClientObservation((await cli(['inspect', '--client'])).observation)
        assert.ok(after.tabs[ids.target.to.tabId]?.regions[ids.target.to.regionId], 'Original projection remains')
        assert.equal(after.workbenchSpaceSelection.spaceId, opened.to.spaceId)
        assert.equal(after.workbenchSpaceSelection.zoneId, opened.to.zoneId)
        assert.equal(after.workbenchSpaceSelection.tabId, ids.target.to.tabId)
        assert.equal(after.workbenchSpaceSelection.regionId, ids.target.to.regionId)
        assert.deepEqual(observed.workbench.desktop.selection.space, after.workbenchSpaceSelection)
        assert.ok(!observed.workbench.tabs.some(tab => tab.id === opened.to.tabId))
        assert.deepEqual((await client().listRuns()).filter((one: any) => one.state === 'running').map((one: any) => ({ runId: one.runId, pid: one.pid })), beforeRuns)
        assert.deepEqual(lifecycle(calls.slice(cursor)), [], 'Additional presentation and original UI close keep all existing Runs')
        ids.closedProjection = opened.to
        await fs.writeFile(path.join(privateRoot, 'ids.json'), JSON.stringify(ids))
        await screenshot('original-ui-closed-tab-keeps-parent')
        return { opened, selected, close, actualSelection: after.workbenchSpaceSelection, observed, runs: beforeRuns, calls: calls.slice(cursor) }
      })
      await recordStep('durable-before-exit', async () => {
        await until('window.focusProofMoteInput()')
        await evaluate('window.focusProofFocusMoteInput(); window.focusProofCaptureInput()')
        const receipt = await cli(['focus', '--zone', ids.empty.zoneId])
        assert.equal(receipt.navigation.selection.space.tabId, null)
        assert.equal(receipt.save.diskDurability, 'unconfirmed')
        await evaluate('window.focusProofFlush()')
        const beforeNarrow = durable(await state())
        await screenshot('before-ordinary-exit')
        win.setSize(920, 750); await delay(120)
        await screenshot('narrow-mote')
        const narrowCursor = calls.length, narrowInputBefore = await evaluate('window.focusProofCaptureInput()')
        assert.equal(beforeNarrow.tabs[ids.mote.to.tabId]?.regions[narrowInputBefore.caret.regionId]?.sessionId, ids.mote.agent.agentSessionId)
        assert.ok(narrowInputBefore.caret.floating && narrowInputBefore.caret.connected && narrowInputBefore.caret.visible && !narrowInputBefore.caret.inert)
        const narrowBorrowed = await cli(['focus', '--tab', ids.mote.to.tabId])
        assert.equal(narrowBorrowed.navigation.selection.space.tabId, ids.mote.to.tabId)
        assert.equal(narrowBorrowed.presentation.state, 'floating'); assert.equal(narrowBorrowed.partial, true)
        const narrowNotice = await observeBorrowedHomeNotice(ids.mote.to.tabId, narrowInputBefore.caret.regionId)
        const narrowInput = await evaluate('window.focusProofPreservedInput()')
        assert.ok(narrowInput.sameElement && narrowInput.sameView && narrowInput.sameAnchor && narrowInput.sameFocus && narrowInput.sameOffsets && narrowInput.sameValue)
        assert.deepEqual(narrowInput.events.filter((one: any) => ['focusin', 'focusout', 'compositionend'].includes(one.type)), [])
        await screenshot('narrow-borrowed-inline-service-window')
        const narrowReturned = await cli(['focus', '--zone', ids.empty.zoneId])
        assert.equal(narrowReturned.navigation.selection.space.tabId, null)
        assert.equal(narrowReturned.navigation.selection.space.zoneId, ids.empty.zoneId)
        assert.deepEqual(lifecycle(calls.slice(narrowCursor)), [])
        await evaluate('window.focusProofFlush()')
        const expected = durable(await state())
        assert.deepEqual(expected.tabs, beforeNarrow.tabs)
        assert.deepEqual(expected.agentFocus, beforeNarrow.agentFocus)
        assert.deepEqual(expected.floating, beforeNarrow.floating)
        assert.deepEqual(expected.agentComposerDrafts, beforeNarrow.agentComposerDrafts)
        assert.deepEqual(expected.viewModes, beforeNarrow.viewModes)
        const modes = await evaluate('window.focusProofPersistedModes()')
        assert.equal(modes.present, true, 'Final production writer must include durable viewModes')
        assert.deepEqual(modes.modes, expected.viewModes, 'Compare the whole mode map consumed by the actual writer')
        assert.equal(expected.viewModes[ids.mote.agent.agentSessionId], 'activity')
        await fs.writeFile(path.join(privateRoot, 'expected.json'), JSON.stringify(expected))
        return { expected, receipt, actualWriterModes: modes, narrowInputBefore, narrowBorrowed, narrowNotice, narrowInput, narrowReturned }
      })
    } else {
      ids = JSON.parse(await fs.readFile(path.join(privateRoot, 'ids.json'), 'utf8'))
      await recordStep('ordinary-process-durable-restore', async () => {
        const expected = JSON.parse(await fs.readFile(path.join(privateRoot, 'expected.json'), 'utf8'))
        const actual = durable(await state())
        assert.ok(Object.keys(actual.tabs).length >= 4, 'Durable workface is nonempty')
        assert.deepEqual(actual, expected, 'Independent ordinary Electron reads exact original durable workface')
        const modes = await evaluate('window.focusProofPersistedModes()')
        assert.equal(modes.present, true)
        assert.deepEqual(modes.modes, expected.viewModes)
        assert.ok(ids.closedProjection, 'The original UI close case ran before restart')
        assert.equal(actual.tabs[ids.closedProjection.tabId], undefined, 'A confirmed closed Tab cannot return after restart')
        assert.ok(actual.tabs[ids.target.to.tabId]?.regions[ids.target.to.regionId], 'The other original projection survives')
        assert.ok(!Object.values(actual.tabs).some((tab: any) => Boolean(tab.regions[ids.closedProjection.regionId])))
        if (phase === 'empty-restore') assert.equal(result.emptySnapshotInjected, true)
        await screenshot('durable-restored')
        return { expected, actual, actualWriterModes: modes }
      })
      if (phase === 'empty-restore') {
        const firstMount = await recordStep('canonical-first-mount-exact-input', async () => {
          const deadline = Date.now() + 10000
          while (!result.canonicalSnapshotHeld && Date.now() < deadline) await delay(35)
          assert.ok(result.canonicalSnapshotHeld?.agentSessionIds.includes(ids.target.agent.agentSessionId), 'The held response contains actual healthy Core facts')
          assert.ok(result.canonicalSnapshotHeld.runIds.includes(ids.target.agent.runId), 'The held response references the same original healthy Run')
          await delay(160)
          assert.equal(await evaluate('document.activeElement === document.body'), true)
          await evaluate('window.focusProofCaptureInput()')
          const before = await state(), cursor = calls.length
          const absent = await evaluate(`!document.querySelector('[data-workbench-region-id=' + CSS.escape(${JSON.stringify(ids.target.to.regionId)}) + '] .xterm-helper-textarea')`)
          assert.equal(absent, true, 'The saved target View precedes its actual Terminal first mount')
          const savedRegion = before.tabs[ids.target.to.tabId]?.regions[ids.target.to.regionId]
          assert.equal(savedRegion?.kind, 'agent')
          assert.equal(savedRegion.sessionId, ids.target.agent.agentSessionId)
          assert.ok(!before.sessions.some((one: any) => one.id === ids.target.agent.agentSessionId))
          const preservedReceipt = await cli(['focus', '--region', ids.target.to.regionId])
          assert.equal(preservedReceipt.navigation.state, 'applied')
          assert.equal(preservedReceipt.input.policy, 'preserve')
          assert.notEqual(preservedReceipt.input.outcome, 'transferred')
          assert.equal(preservedReceipt.input.before.scope, 'none')
          assert.equal((await state()).regionCaretFocus, null)
          const preserved = await evaluate('window.focusProofPreservedInput()')
          assert.equal(preserved.sameElement, true, 'Default navigation before first mount keeps the original body')
          assert.deepEqual(preserved.events.filter((one: any) => ['focusin', 'focusout'].includes(one.type)), [])
          assert.equal(await evaluate('document.activeElement === document.body'), true)
          coldDiagnosticActive = true
          coldPoint('main-first-mount-input-begin')
          await evaluate(`window.focusProofBeginColdDiagnostics(${JSON.stringify(ids.target.to.regionId)}); true`)
          try {
            const pending = cli(['focus', '--region', ids.target.to.regionId, '--input', 'target'])
            void pending.catch(() => {}) // Still awaited below; preserve the phase receipt if a pre-release assertion fails.
            await until(`window.focusProofState().regionCaretFocus?.regionId === ${JSON.stringify(ids.target.to.regionId)}`)
            coldPoint('main-first-mount-nonce-observed')
            const held = await state(), beforeNode = await evaluate('window.focusProofColdTarget()')
            assert.ok(beforeNode.regionPresent && beforeNode.regionConnected && beforeNode.sameRegion)
            assert.equal(beforeNode.inputPresent, false, 'The explicit public target intent predates the actual first input node')
            assert.deepEqual(held.tabs[ids.target.to.tabId].regions[ids.target.to.regionId], savedRegion)
            assert.equal(held.regionCaretFocus.regionId, ids.target.to.regionId)
            assert.ok(Number.isSafeInteger(held.regionCaretFocus.nonce))
            assert.ok(!held.sessions.some((one: any) => one.id === ids.target.agent.agentSessionId))
            assert.equal(await evaluate('document.activeElement === document.body'), true)
            const heldInput = await evaluate('window.focusProofPreservedInput()')
            assert.equal(heldInput.sameElement, true)
            assert.deepEqual(heldInput.events.filter((one: any) => ['focusin', 'focusout'].includes(one.type)), [])
            coldPoint('main-canonical-response-release')
            canonicalReleased = true
            releaseCanonical!(); releaseCanonical = undefined
            const receipt = await pending
            assert.equal(receipt.input.outcome, 'transferred')
            assert.equal(receipt.input.after.regionId, ids.target.to.regionId)
            assert.equal(receipt.input.after.sessionId, ids.target.agent.agentSessionId)
            await until(`window.focusProofReadyTerminal(${JSON.stringify(ids.target.to.regionId)}, ${JSON.stringify(ids.target.agent.agentSessionId)}, ${JSON.stringify(ids.target.agent.runId)})`)
            const after = await state(), mountedNode = await evaluate('window.focusProofColdTarget()')
            assert.ok(mountedNode.sameRegion && mountedNode.inputPresent && mountedNode.inputConnected && mountedNode.inputActive)
            assert.equal(mountedNode.actualInputRegion, ids.target.to.regionId)
            assert.deepEqual(after.tabs[ids.target.to.tabId].regions[ids.target.to.regionId], savedRegion)
            assert.deepEqual(after.agentComposerDrafts, before.agentComposerDrafts)
            assert.equal(after.workbenchSpaceSelection.regionId, ids.target.to.regionId)
            assert.equal(after.regionCaretFocus, null)
            assert.deepEqual(lifecycle(calls.slice(cursor)), [], 'Canonical first mount consumes only the explicit caret intent, with no lifecycle, preparation or payload')
            await screenshot('canonical-first-mount-exact-target-input')
            return { boundaryFault: 'One initial empty snapshot, then a finitely held unchanged real Core snapshot response.',
              actualHeldFacts: result.canonicalSnapshotHeld, before, preservedReceipt, preserved, held, beforeNode,
              receipt, after, mountedNode, calls: calls.slice(cursor) }
          } finally {
            const renderer = await evaluate('window.focusProofEndColdDiagnostics()').catch(error => ({ failure: String(error) }))
            coldPoint('main-first-mount-input-end')
            result.coldDiagnostics = { scope: 'One cold canonical first-mount input target step only; metadata, no draft/output content.', main: coldMain, renderer }
            coldDiagnosticActive = false
          }
        })
        await freshTerminalInput('newly-mounted-target-native-input', ids.target, 't', firstMount.receipt)
      }
      await until('window.focusProofMoteInput()')
      await recordStep('restored-original-mote-input-setup', async () => {
        const cursor = calls.length, before = await state()
        const box = await evaluate(`(() => { const input = window.focusProofMoteInput(); if (!input) throw new Error('Original restored Mote input absent');
          const rect = input.getBoundingClientRect(); return { x: rect.left + Math.min(12, rect.width / 2), y: rect.top + Math.min(9, rect.height / 2), width: rect.width, height: rect.height } })()`)
        assert.ok(box.width > 0 && box.height > 0)
        await evaluate('window.focusProofBeginMoteInputDiagnostics(); true')
        try {
          // Real pointer and keyboard input let the maintained editor own selection.
          // Do not inject a container Range before its focus handler normalizes the DOM.
          await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
          await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
          await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 })
          await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35 })
          const afterKeys = await evaluate('({ owner: window.focusProofMoteSelectionOwner(), input: window.focusProofCaptureInput() })')
          result.restoredInputSetup = { box, afterKeys, keysReturnedAt: Date.now() }
          assert.ok(afterKeys.owner.inputPresent && afterKeys.owner.inputActive && afterKeys.owner.editorAttached &&
            afterKeys.owner.anchorInside && afterKeys.owner.focusInside, 'The real post-key Range exists within the original maintained input')
          await evaluate("window.focusProofMoteInputDiagnosticPoint('native-keys-returned'); true")
          // Observe the original input owner's completion at this exact Range. A
          // normalization to another Node/offset cannot satisfy the pinned condition.
          await until('window.focusProofMoteInputReady()')
          const beforePublic = await evaluate('window.focusProofPreservedInput()')
          assert.ok(beforePublic.sameElement && beforePublic.sameView && beforePublic.sameAnchor &&
            beforePublic.sameFocus && beforePublic.sameOffsets && beforePublic.sameValue)
          await evaluate("window.focusProofMoteInputDiagnosticPoint('original-owner-complete'); true")
          const captured = await evaluate('({ owner: window.focusProofMoteSelectionOwner(), input: window.focusProofCaptureInput() })')
          result.restoredInputSetup = { ...result.restoredInputSetup, beforePublic, captured, ownerCompleteAt: Date.now() }
          assert.ok(captured.owner.inputPresent && captured.owner.inputActive && captured.owner.editorAttached &&
            captured.owner.anchorInside && captured.owner.focusInside, 'The actual original maintained Mote input owns both Range endpoints')
          assert.equal(captured.owner.domModelAnchor, captured.owner.modelAnchor)
          assert.equal(captured.owner.domModelFocus, captured.owner.modelHead)
          assert.ok(Number.isSafeInteger(captured.owner.modelAnchor) && Number.isSafeInteger(captured.owner.modelHead))
          assert.ok(captured.input.selection.rangeCount > 0)
          assert.ok(captured.input.selection.anchor.withinInput && captured.input.selection.focus.withinInput)
          assert.ok(Number.isSafeInteger(captured.input.selection.anchor.textOffset) && Number.isSafeInteger(captured.input.selection.focus.textOffset))
          assert.ok(typeof captured.input.value === 'string' && captured.input.value.length > 0)
          assert.ok(captured.input.selection.anchor.textOffset > 0 && captured.input.selection.anchor.textOffset < captured.input.value.length &&
            captured.input.selection.focus.textOffset > 0 && captured.input.selection.focus.textOffset < captured.input.value.length,
            'The real original editor owns a nonterminal caret, not a synthetic container end')
          assert.equal(captured.input.value, before.agentComposerDrafts[ids.mote.agent.agentSessionId])
          assert.equal(captured.input.caret.floating, true)
          assert.ok(captured.input.caret.connected && captured.input.caret.visible && !captured.input.caret.inert)
          assert.deepEqual((await state()).agentComposerDrafts, before.agentComposerDrafts)
          assert.deepEqual(lifecycle(calls.slice(cursor)), [])
          return { ...result.restoredInputSetup, calls: calls.slice(cursor) }
        } finally {
          result.restoredInputDiagnostics = await evaluate('window.focusProofEndMoteInputDiagnostics()')
        }
      })
      const cursor = calls.length
      await preservation('restored-goal-preserve', ['--goal', 'private-goal-exact'])
      await screenshot('restored-goal-with-mote')
      await freshTerminalInput('restored-target-native-input', ids.target, phase === 'restore' ? 'r' : 's')
      assert.deepEqual(lifecycle(calls.slice(cursor)).filter(one => one.operation !== 'write'), [], 'Restored navigation keeps exact healthy Runs')
      await evaluate(`window.focusProofHumanViewMode(${JSON.stringify(ids.mote.agent.agentSessionId)}, 'activity'); true`)
      await until('window.focusProofMoteInput()')
      await evaluate('window.focusProofFocusMoteInput(); window.focusProofCaptureInput()')
      await cli(['focus', '--zone', ids.empty.zoneId])
      await evaluate('window.focusProofFlush()')
    }
    await finish(true)
  } catch (error: any) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) await screenshot('failure').catch(() => {})
    process.stderr.write(`focus-proof-failed ${phase}: ${error.message}\n`)
    await finish(false)
  }
})
