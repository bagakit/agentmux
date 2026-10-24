import assert from 'node:assert/strict'
import { localRuntimeConnector } from '../../../test/helpers/local-runtime-connector'
import fs from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { AgentMuxFileAgentSessionStore } from '@agentmux/core'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { RuntimeController } from '../../../src/main/runtime-controller'
import { ScratchTopics } from '../../../src/main/scratch-topics'
import { SpaceObjectImages } from '../../../src/main/space-object-images'
import { WorkspaceFiles } from '../../../src/main/workspace-files'
import { TopicKnowledgeOwner } from '@agentmux/host/topic-knowledge'
import { TopicSpatialOwner } from '@agentmux/host/topic-spatial-owner'
const [html, privateRoot, phase, preload, resultDirectory, nodeExecutable] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
process.env.AGENTMUX_RUNTIME_DIRECTORY = path.join(privateRoot, 'runtime')
process.env.AGENTMUX_STATE_DIRECTORY = path.join(privateRoot, 'runtime', 'state')
process.env.AGENTMUX_MESSAGE_QUEUE_PATH = path.join(privateRoot, 'messages.ndjson')
const scratch = { id: '__scratch__', hostId: 'local', name: 'Topics', path: path.join(privateRoot, 'scratch'), kind: 'folder' as const }
const config = { version: 9, hosts: [{ id: 'local', kind: 'local' as const, label: 'Private fixture' }], executors: {},
  workspaces: [scratch], appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const topics = new ScratchTopics()
const images = new SpaceObjectImages(async target => {
  assert.equal(target.kind, 'topic', 'Only private Topic images belong to this fixture')
  if (target.kind !== 'topic') throw new Error('Private Topic image required')
  assert.equal(target.workspaceId, scratch.id)
  const identity = await topics.topicAppearanceIdentity(scratch, target.topicId, target.objectKey)
  return { hostId: scratch.hostId, directoryPath: identity.physicalDirectoryPath }
})
const runtime = new RuntimeController(new AgentMuxFileAgentSessionStore(path.join(privateRoot, 'agent-sessions.json')), localRuntimeConnector, topics)
const spatial = new AgentMuxSpatialStateStore(path.join(privateRoot, 'spatial-state.json'))
const knowledge = new TopicKnowledgeOwner(topics, new WorkspaceFiles(() => config.hosts[0]!), () => scratch)
knowledge.setSpatialPort(new TopicSpatialOwner({ state: spatial, workspace: () => scratch,
  topics: () => knowledge.listTopicSnapshots(), categories: () => knowledge.listCategories(),
  ensureDefaultCategory: () => knowledge.ensureDefaultCategoryContent() }))
const calls: { operation: string; args: any[]; at: number }[] = []
let win: BrowserWindow
let disposeSpatial: (() => void) | undefined
const result: Record<string, any> = { passed: false, phase, pid: process.pid,
  boundary: 'Actual App/Store/SessionPane/TerminalView/xterm, Electron restart, filesystem Topic and public RuntimeController/Core/ctxmux private Terminal Runs. Private topology seed only; no user App/Run.' }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
ipcMain.handle('topic-terminal:request', async (event, operation, ...args) => {
  calls.push({ operation, args, at: Date.now() })
  switch (operation) {
    case 'setup': return { config, phase }
    case 'spatial-read': return spatial.readForLayout()
    case 'spatial-commit': return spatial.commit(args[0])
    case 'spatial-labels': return spatial.retainDisplayLabels(args[0])
    case 'snapshot': return runtime.snapshot(config)
    case 'launch': return runtime.launchTerminal({ ...args[0], shellCommand: `'${nodeExecutable}' '${path.join(privateRoot, 'producer.cjs')}'` }, config)
    case 'attach': return runtime.attachSession(event.sender.id, args[0], args[1] ?? 0, config)
    case 'detach': return runtime.detachSession(event.sender.id, args[0])
    case 'replay': return runtime.readSessionReplay(event.sender.id, args[0], args[1])
    case 'resize': return runtime.resizeSessionAttachment(event.sender.id, args[0], args[1], args[2])
    case 'write': return runtime.write(args[0], args[1], args[2])
    case 'stop': return runtime.stopSession(args[0])
    case 'refresh': return runtime.refresh(args[0], config)
    case 'resolve': return runtime.resolveSession(args[0], config)
    case 'topics': return topics.list(scratch)
    case 'topic': return topics.read(scratch, args[1])
    case 'ensure-topic': return topics.ensure(scratch, args[1])
    case 'ensure-mote': return topics.ensureMote(scratch, args[1])
    case 'topic-call': return knowledge.call(args[0], args[1])
    case 'object-appearance': return images.appearance(args[0])
    case 'save-ids': await fs.writeFile(path.join(privateRoot, 'ids.json'), JSON.stringify(args[0])); return
    case 'flush': await win.webContents.session.flushStorageData(); return
    default: throw new Error(`Unsupported private fixture request: ${operation}`)
  }
})
app.whenReady().then(async () => {
  const until = async (expression: string, budget = 12000) => {
    const deadline = Date.now() + budget
    do { const value = await win.webContents.executeJavaScript(expression); if (value) return value; await delay(30) } while (Date.now() < deadline)
    throw new Error(`Private terminal condition did not settle: ${expression}`)
  }
  try {
    runtime.commit(await runtime.prepare(config))
    win = new BrowserWindow({ width: 1460, height: 940, show: false,
      webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, preload } })
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) process.stderr.write(`Renderer: ${message}\n`) })
    runtime.attach(win.webContents)
    disposeSpatial = spatial.subscribe(state => {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('topic-terminal:spatial-change', state)
    })
    await win.loadFile(html)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await until('window.topicTerminalReady === true && window.topicTerminalUi().terminals.length === 4')
    const ids = JSON.parse(await fs.readFile(path.join(privateRoot, 'ids.json'), 'utf8'))
    const originalTopic = (await knowledge.call('topic.inspect', { topicId: ids.topicId })).topic!
    assert.equal(originalTopic.topicId, ids.topicId)
    assert.equal(originalTopic.zoneId, ids.zoneId)
    assert.equal(originalTopic.directoryPath, ids.directoryPath)
    assert.equal(path.dirname(originalTopic.directoryPath), path.join(privateRoot, 'topics'), 'Canonical content is outside the logical Scratch root')
    assert.equal(calls.filter(call => call.operation === 'topic-call' && call.args[0] === 'topic.create').length,
      phase === 'seed' ? 1 : 0, 'Restart reads the same saved Topic without creating another')
    result.originalTopic = originalTopic
    const snapshotForIdentity = await runtime.snapshot(config)
    assert.ok(snapshotForIdentity.sessions.length >= 4)
    const state = () => win.webContents.executeJavaScript('topicTerminalState()')
    const ui = () => win.webContents.executeJavaScript('topicTerminalUi()')
    await until('window.topicTerminalUi().floating.activeTabIds.length === 1 && window.topicTerminalUi().floating.activeTabIds[0] === "mote-tab"')
    // Current startup publishes the durable workface before its independent
    // Runtime membership read settles. Observe the original owner's recovery;
    // seeing Terminal DOM alone cannot certify that the read has completed.
    await until('window.topicTerminalState().error === null')
    result.initial = { state: await state(), ui: await ui(), savedFloatingAtStartup: await win.webContents.executeJavaScript('window.topicTerminalFloatingAtStartup') }
    assert.equal(result.initial.state.tabs[ids.tabId].topicId, ids.topicId)
    assert.equal(result.initial.state.tabs[ids.tabId].space.zoneId, ids.zoneId)
    assert.equal(result.initial.savedFloatingAtStartup.open, true, 'Both App generations start from the saved open floating state')
    assert.equal(result.initial.savedFloatingAtStartup.targetTabId, 'mote-tab', 'Both App generations read the original saved explicit target')
    assert.deepEqual(result.initial.ui.floating.activeTabIds, ['mote-tab'])
    assert.equal(result.initial.ui.floating.open, true)
    assert.equal(result.initial.state.error, null, 'A valid durable saved target restores without a preparation error')
    assert.equal(result.initial.state.tabs['mote-launcher-tab'].regions['mote-launcher-region'].kind, 'launcher', 'The earlier same-Mote Tab remains a genuine non-running workface')
    assert.equal(result.initial.state.layouts.__scratch__.groups[0].activeTabId, ids.tabId, 'Saved-open floating target cannot change main Topic selection')
    assert.equal(result.initial.ui.sessionPanes, 4, 'Each original Region must own exactly one SessionPane')
    assert.deepEqual(result.initial.ui.regions, [ids.regionId, 'secondary-region', 'mote-launcher-region', 'mote-region', 'close-region'].sort())
    assert.equal(new Set(result.initial.ui.terminals.map((terminal: any) => terminal.regionId)).size, 4)
    if (phase === 'seed') assert.equal(calls.filter(call => call.operation === 'launch').length, 4, 'Rapid opening plus three explicit extra Terminals')
    else {
      assert.equal(calls.filter(call => call.operation === 'launch').length, 0, 'Restart must never repeat default Terminal creation')
      const expected = JSON.parse(await fs.readFile(path.join(privateRoot, 'expected.json'), 'utf8'))
      for (const key of ['tabs', 'layouts', 'focus', 'drafts', 'activeWorkspaceId']) assert.deepEqual(result.initial.state[key], expected[key], `${key} changed across a real Electron restart`)
      assert.deepEqual(result.initial.state.sessions.filter((session: any) => session.state === 'running').map((session: any) => session.run.runId).sort(), expected.sessions.map((session: any) => session.run.runId).sort(), 'The same private Runs survive')
    }
    await until(`window.topicTerminalUi().terminals.find(one => one.regionId === ${JSON.stringify(ids.regionId)})?.baseY > 800`)
    await win.webContents.executeJavaScript(`window.originalTopicTerminal = window.terminals.find(one => one.element?.closest('[data-workbench-region-id]')?.dataset.workbenchRegionId === ${JSON.stringify(ids.regionId)}); window.originalMoteTerminal = window.terminals.find(one => one.element?.closest('[data-workbench-region-id]')?.dataset.workbenchRegionId === 'mote-region'); true`)
    await until('document.getElementById(topicTerminalMoteSlotId("mote-floating-tab-slot"))?.contains(window.originalMoteTerminal.element)')
    assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll("[data-workbench-region-id=mote-launcher-region]").length'), 1, 'Earlier launcher is retained once; no healthy workface is removed')
    await win.webContents.executeJavaScript('topicTerminalCloseFloat()')
    await until('document.getElementById(topicTerminalMoteSlotId("workbench-tab-slot"))?.contains(window.originalMoteTerminal.element)')
    assert.deepEqual((await state()).focus.execution, result.initial.state.focus.execution, 'Closing saved-open floating target keeps original execution focus')
    await delay(300)
    await win.webContents.executeJavaScript('window.topicEventCounts.tracking = true; true')
    result.reading = []
    for (let index = 0; index < 5; index++) {
      const before = (await ui()).terminals.find((one: any) => one.regionId === ids.regionId)
      const beforeCalls = calls.filter(call => ['attach', 'replay', 'resize', 'write'].includes(call.operation)).length
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.floor(before.point.x), y: Math.floor(before.point.y), deltaX: 0, deltaY: -240 })
      await until(`window.originalTopicTerminal.buffer.active.viewportY < ${before.viewportY}`)
      const after = (await ui()).terminals.find((one: any) => one.regionId === ids.regionId)
      result.reading.push({ before: before.viewportY, after: after.viewportY, inputBefore: calls.filter(call => call.operation === 'write').length,
        protocolOperations: calls.filter(call => ['attach', 'replay', 'resize', 'write'].includes(call.operation)).length - beforeCalls })
      assert.equal(result.reading[index].protocolOperations, 0, 'Reading local history cannot amplify unrelated Run work')
    }
    await delay(600)
    result.eventConsumers = await win.webContents.executeJavaScript('({ raw: window.topicEventCounts.raw, delivered: window.topicEventCounts.delivered })')
    assert.equal(Object.keys(result.eventConsumers.raw).length, 4, 'All four private active Runs must publish observed bytes')
    assert.deepEqual(result.eventConsumers.delivered, result.eventConsumers.raw, 'Each fact reaches exactly its related terminal consumer, regardless of unrelated Runs')
    await win.webContents.executeJavaScript('topicTerminalBoard(); topicTerminalOpenFloat()')
    await until('document.getElementById(topicTerminalMoteSlotId("mote-floating-tab-slot"))?.contains(window.originalMoteTerminal.element) && window.topicTerminalUi().terminals.find(one => one.regionId === "mote-region")?.visible')
    assert.equal((await ui()).sessionPanes, 4)
    assert.deepEqual((await ui()).floating.activeTabIds, ['mote-tab'], 'Chrome and original View share the explicit target')
    assert.equal(await win.webContents.executeJavaScript('window.terminals.filter(one => one.element?.isConnected).length === 4 && document.getElementById(topicTerminalMoteSlotId("mote-floating-tab-slot")).contains(window.originalMoteTerminal.element)'), true)
    assert.deepEqual((await state()).focus.execution, result.initial.state.focus.execution, 'Shortcut opening preserves the original execution focus and history')
    result.floating = await ui()
    await win.webContents.executeJavaScript('topicTerminalNoWorkspace()')
    await until('document.getElementById(topicTerminalMoteSlotId("mote-floating-tab-slot"))?.contains(window.originalMoteTerminal.element)')
    assert.equal((await ui()).sessionPanes, 4, 'Board with no active Project must retain the original floating owner')
    // Keep the floating terminal genuinely usable after a full cold-parking deadline.
    if (phase === 'seed') await delay(31000)
    assert.equal(await win.webContents.executeJavaScript('window.originalMoteTerminal.element?.isConnected && document.getElementById(topicTerminalMoteSlotId("mote-floating-tab-slot")).contains(window.originalMoteTerminal.element)'), true)
    const moteInput = (await ui()).terminals.find((terminal: any) => terminal.regionId === 'mote-region')
    assert.equal(moteInput?.visible, true, 'The original Mote Terminal must be a visible native input target')
    result.nativeInputTarget = await win.webContents.executeJavaScript(`(() => {
      window.topicTerminalPointerEvents = [];
      document.addEventListener('pointerdown', event => window.topicTerminalPointerEvents.push({ trusted: event.isTrusted,
        originalMote: window.originalMoteTerminal.element.contains(event.target) }), { capture: true });
      return { point: ${JSON.stringify(moteInput.point)},
        originalMote: window.originalMoteTerminal.element.contains(document.elementFromPoint(${moteInput.point.x}, ${moteInput.point.y})) };
    })()`)
    assert.equal(result.nativeInputTarget.originalMote, true, 'The measured native pointer point hits the exact original Mote Terminal')
    for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',
      { type, x: moteInput.point.x, y: moteInput.point.y, button: 'left', clickCount: 1 })
    await until('window.originalMoteTerminal.element.contains(document.activeElement)')
    result.nativeInputTarget.pointerEvents = await win.webContents.executeJavaScript('window.topicTerminalPointerEvents')
    assert.ok(result.nativeInputTarget.pointerEvents.some((event: any) => event.trusted && event.originalMote),
      'A trusted native pointer reaches the original Mote Terminal before typing')
    result.nativeInputTarget.caretWithinOriginalMote = true
    for (const text of 'private-input-still-works') await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'char', text })
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' })
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await until('Array.from({length:window.originalMoteTerminal.buffer.active.length},(_,n)=>window.originalMoteTerminal.buffer.active.getLine(n)?.translateToString()).some(line=>line?.includes("ACK:private-input-still-works"))')
    const inputControls = calls.filter(call => call.operation === 'write').map(call => call.args[0])
    assert.ok(inputControls.length > 0)
    assert.ok(inputControls.every(control => control.kind === 'terminal' && control.hostId === 'local' && control.runId === ids.moteId && control.run.runId === ids.moteId),
      'Every actual input write targets only the original Mote Run')
    result.inputWrites = calls.filter(call => call.operation === 'write').length
    assert.ok(result.inputWrites > 0)
    result.inputFocus = (await state()).focus.execution
    result.inputPmoFocus = (await state()).focus.pmo
    result.inputReference = (await ui()).floating.saved.reference
    assert.equal(result.inputPmoFocus.sessionId, ids.moteId, 'Original Mote input retains its coordination focus lane')
    assert.deepEqual(result.inputFocus, result.initial.state.focus.execution, 'Mote input preserves the complete original execution focus and MRU')
    assert.deepEqual(result.inputReference, { displayWorkspaceId: '__scratch__', groupId: 'original-group', tabId: 'mote-tab', regionId: 'mote-region' }, 'Native input retains the exact original Mote occurrence')
    await win.webContents.executeJavaScript('topicTerminalCloseFloat()')
    assert.deepEqual((await state()).focus.execution, result.inputFocus, 'Shortcut closing preserves the original execution focus and history')
    await win.webContents.executeJavaScript('window.topicTerminalWorkbench()')
    await win.webContents.executeJavaScript('window.topicTerminalRestoreWorkspace()')
    await until('document.getElementById(topicTerminalMoteSlotId("workbench-tab-slot"))?.contains(window.originalMoteTerminal.element)')
    assert.equal((await ui()).sessionPanes, 4)
    assert.equal(await win.webContents.executeJavaScript('window.originalTopicTerminal.element?.isConnected'), true)
    result.originalViewportAfterFloat = await win.webContents.executeJavaScript('window.originalTopicTerminal.buffer.active.viewportY')
    assert.equal(result.originalViewportAfterFloat, result.reading.at(-1).after, 'Floating navigation preserves the original ongoing history reading position')
    assert.equal((await state()).layouts.__scratch__.groups[0].activeTabId, ids.tabId, 'Floating open/close must keep the original main Topic selected')
    assert.deepEqual((await state()).focus.execution, result.inputFocus, 'Returning to Workbench keeps the original execution Session and history')
    result.closeEntries = (await ui()).close
    assert.ok(result.closeEntries.length > 0)
    assert.ok(result.closeEntries.every((entry: any) => Number(entry.opacity) > 0), 'All actual close entries must be visible without hovering')
    result.afterMovement = await state()
    assert.equal(result.afterMovement.drafts['untouched-draft'], 'An unsent draft remains')
    assert.equal(result.afterMovement.tabs[ids.tabId].layout.root.ratio, 0.61)
    if (phase === 'restore') {
      // Exercise the actual close affordance after verifying the original persisted workface.
      await win.webContents.executeJavaScript('document.querySelector("[data-workbench-tab-id=close-tab] .workbench-tab__close").click()')
      await until('window.topicTerminalState().tabs["close-tab"] === undefined')
      assert.equal(calls.filter(call => call.operation === 'stop').length, 1)
      assert.equal(calls.find(call => call.operation === 'stop')!.args[0].runId, ids.closeId)
      assert.equal((await state()).drafts['untouched-draft'], 'An unsent draft remains')
      result.afterClose = await state()
      assert.equal(result.afterClose.tabs[ids.tabId].regions[ids.regionId].sessionId, ids.sessionId)
    }
    await win.webContents.executeJavaScript('topicTerminalOpenFloat()')
    await until('document.getElementById(topicTerminalMoteSlotId("mote-floating-tab-slot"))?.contains(window.originalMoteTerminal.element) && window.topicTerminalUi().floating.activeTabIds[0] === "mote-tab"')
    result.savedOpenForRestart = { state: await state(), ui: await ui() }
    assert.equal(result.savedOpenForRestart.ui.floating.saved.open, true)
    assert.equal(result.savedOpenForRestart.ui.floating.saved.targetTabId, 'mote-tab')
    assert.equal(result.savedOpenForRestart.state.layouts.__scratch__.groups[0].activeTabId, ids.tabId)
    assert.deepEqual(result.savedOpenForRestart.state.focus.execution, result.afterMovement.focus.execution)
    if (phase === 'seed') await fs.writeFile(path.join(privateRoot, 'expected.json'), JSON.stringify(result.savedOpenForRestart.state))
    await delay(350)
    await win.webContents.session.flushStorageData()
    result.owners = runtime.resourceOwnerCounts()
    assert.equal(result.owners.sessionAttachmentOwners, phase === 'seed' ? 4 : 3)
    assert.equal(result.owners.sessionAttachmentLeases, phase === 'seed' ? 4 : 3)
    await fs.writeFile(path.join(resultDirectory, `${phase}.png`), (await win.webContents.capturePage()).toPNG())
    result.calls = calls.map(({ operation, args, at }) => ({ operation, at, args: operation === 'write' ? [args[0], '[private input bytes]'] : args }))
    result.passed = true
  } catch (error: any) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    result.calls = calls
    if (win && !win.isDestroyed()) result.observationAtFailure = await win.webContents.executeJavaScript('({ state: window.topicTerminalState?.(), ui: window.topicTerminalUi?.() })').catch(() => null)
  } finally {
    disposeSpatial?.()
    await runtime.dispose().catch(error => { result.cleanupFailure = String(error); result.passed = false })
    await fs.writeFile(path.join(resultDirectory, `${phase}.json`), JSON.stringify(result, null, 2))
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
