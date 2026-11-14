import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { AgentMuxFileAgentSessionStore } from '@agentmux/core'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { localRuntimeConnector } from '../../../test/helpers/local-runtime-connector'
import { RuntimeController } from '../../../src/main/runtime-controller'
import { ScratchTopics } from '../../../src/main/scratch-topics'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import type { AppConfig, BrowserSnapshot } from '../../../src/shared/contracts'

const [root, output, phase, nodeExecutable, html, preload] = process.argv.slice(2)
const store = new AgentMuxFileAgentSessionStore(path.join(root!, 'agent-sessions.json'))
const spatial = new AgentMuxSpatialStateStore(path.join(root!, 'runtime/state/spatial-state.json'))
const topics = new ScratchTopics(), runtime = new RuntimeController(store, localRuntimeConnector, topics)
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private navigation' }],
  executors: { fixture: { label: 'Private fixture', providerId: 'codex', command: nodeExecutable!, args: [path.join(root!, 'fake-codex-cli.mjs')],
    env: { AGENTMUX_FAKE_READY_MODE: 'before', AGENTMUX_FAKE_NATIVE_RECORD: '1' }, injectAgentMuxGuide: false } },
  workspaces: [{ id: 'other', name: 'Preserved Work', path: path.join(root!, 'other'), hostId: 'local', kind: 'folder' },
    { id: SCRATCH_WORKSPACE_ID, name: 'Private Topics', path: path.join(root!, 'topics'), hostId: 'local', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
let win: BrowserWindow
const calls: any[] = [], browsers = new Map<string, BrowserSnapshot>()
const proof: any = { phase, pid: process.pid, passed: false, calls,
  boundary: 'Actual App/BrowserPane/Survey/Store/Core Runtime/PTY and original durable Session across two Electron processes. Browser metadata/control is a fixture, no native page/OS hit-test proof.' }
async function progress(stage: string) { proof.stage = stage; await fs.writeFile(path.join(output!, phase + '-progress.json'), JSON.stringify(proof, null, 2)); console.error('private-nav:' + stage) }
const state = () => win.webContents.executeJavaScript('window.navState()')
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(expression: string) {
  const deadline = Date.now() + 20000
  do { const value = await win.webContents.executeJavaScript(expression); if (value) return value; await delay(25) } while (Date.now() < deadline)
  throw new Error('The actual private consumer did not settle: ' + expression)
}
ipcMain.handle('space-proof:request', async (event, operation, ...args) => {
  assert.equal(event.sender, win.webContents)
  calls.push({ operation, args })
  switch (operation) {
    case 'setup': return { phase, config }
    case 'spatial-read': return spatial.read()
    case 'spatial-commit': return spatial.commit(args[0])
    // This new private resource contains no Topics/Motes. Navigation uses the
    // real Core graph; unrelated knowledge initialization is not this scene.
    case 'topics': return []
    case 'providers': return runtime.providerCatalog(args[0])
    case 'discover-executors': return runtime.discoverExecutors(args[0])
    case 'snapshot': return runtime.snapshot(config)
    case 'launch': assert.equal(phase, 'seed', 'Restore cannot create a replacement Agent'); return runtime.launchAgent(args[0], config)
    case 'creation': return runtime.agentCreation(args[0], args[1])
    case 'recover': {
      const result = await runtime.recoverSession(args[0], config, args[1], args[2], args[3])
      ;(proof.recovery ??= []).push({ request: args[0], result }); return result
    }
    case 'attach': return runtime.attachSession(win.webContents.id, args[0], args[1], config)
    case 'replay': return runtime.readSessionReplay(win.webContents.id, args[0], args[1])
    case 'detach': return runtime.detachSession(win.webContents.id, args[0])
    case 'resize': return runtime.resizeSessionAttachment(win.webContents.id, args[0], args[1], args[2])
    case 'write': return runtime.write(args[0], args[1], args[2])
    case 'paste': return runtime.paste(args[0], args[1], args[2])
    case 'respond': return runtime.respondInteraction(args[0], args[1])
    case 'inspect-input': return runtime.inspectInput(args[0], args[1])
    case 'rejoin-input': return runtime.rejoinInputWaiting(args[0], args[1])
    case 'submit': return runtime.submitPrompt(args[0], args[1], args[2], args[3], undefined, args[4], args[5], args[6], args[7], args[8], args[9])
    case 'resolve': return runtime.resolveSession(args[0], config)
    case 'refresh': return runtime.refresh(args[0], config)
    case 'stop': throw new Error('No UI stop is expected in the navigation scene')
    case 'flush': win.webContents.session.flushStorageData(); return
    case 'browser-create': assert.equal(phase, 'seed'); browsers.set(args[0].id, args[0]); return args[0]
    case 'browser-read': assert.ok(browsers.has(args[0])); return browsers.get(args[0])
    case 'browser-handoff': {
      const [id, input] = args, before = browsers.get(id)!
      assert.equal(before.navigationId, input.navigationId); assert.equal(before.control!.revision, input.expectedRevision)
      const session = await runtime.refresh(input.agent, config)
      assert.equal(session.id, input.agent.agentSessionId)
      const next = { ...before, control: { ...before.control!, owner: 'agent' as const, agent: input.agent,
        revision: before.control!.revision + 1, inputIsolation: 'isolated' as const } }
      browsers.set(id, next); return next
    }
    default: throw new Error('Unexpected private navigation boundary: ' + operation)
  }
})
app.on('window-all-closed', () => {})
void app.whenReady().then(async () => {
  try {
    proof.electronPaths = Object.fromEntries(['home', 'appData', 'userData', 'sessionData'].map(key => [key, app.getPath(key as any)]))
    for (const value of Object.values(proof.electronPaths)) assert.ok(String(value).startsWith(root! + '/'))
    if (phase !== 'seed') for (const browser of JSON.parse(await fs.readFile(path.join(root!, 'browsers.json'), 'utf8'))) browsers.set(browser.id, browser)
    await progress('runtime-prepare'); runtime.commit(await runtime.prepare(config))
    win = new BrowserWindow({ title: 'AgentMux Private Survey Navigation', show: false, width: 1320, height: 900, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, preload } })
    runtime.attach(win.webContents)
    win.webContents.on('console-message', details => { if (details.level === 'error') (proof.rendererErrors ??= []).push(details.message) })
    await progress('renderer-load'); await win.loadFile(html!)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await progress('renderer-ready-wait')
    await until('window.navReady && window.spaceReady && !window.navState().loading')
    if (phase === 'seed') {
      await progress('prepare-survey')
      const prepared = await win.webContents.executeJavaScript('window.navPrepare()'); proof.prepared = prepared
      await progress('browser-button-wait')
      await until('window.navState().browserButtons > 0 && window.navState().surveyItems.length > 0')
      proof.before = await state()
      await win.webContents.executeJavaScript('document.querySelector(\'[aria-label="在右侧创建 Agent"]\').click(); true')
      await progress('original-agent-admission-wait')
      await until('Object.values(window.navState().spatialRequests).some(record => record.browserAgent?.inputStarted) && window.navState().sessions.some(session => session.kind === "agent")')
      await until('window.navState().terminalCount > 0')
      // The submitted first input reaches the real Core/PTY, not a mock queue receipt.
      await until('Object.values(window.navState().agentSteerQueues ?? {}).flat().every(entry => entry.status !== "sending")')
      const original = await state(), record = Object.values(original.spatialRequests).find((item: any) => item.purpose === 'browser-agent') as any
      const control = original.sessions.find((session: any) => session.id === record.agentSessionId).control
      const key = { kind: 'prompt' as const, agentSessionId: control.agentSessionId, expectedRun: control.run, submissionId: record.browserAgent.messageOperationId }
      const inputDeadline = Date.now() + 20000
      do {
        proof.firstInput = await runtime.inspectInput(control, key)
        if (proof.firstInput && ['admitted', 'terminal-confirmed'].includes(proof.firstInput.status)) break
        await delay(25)
      } while (Date.now() < inputDeadline)
      assert.ok(proof.firstInput && ['admitted', 'terminal-confirmed'].includes(proof.firstInput.status), 'The original typed input key is admitted by actual Core')
      assert.equal(calls.filter(call => call.operation === 'submit').length, 1)
      assert.equal(original.mainSurface, 'survey'); assert.deepEqual(original.work, prepared.heldWork)
      assert.equal(original.survey.active.regionId, record.regionId); assert.equal(original.survey.active.tabId, prepared.reference.tabId)
      assert.ok(original.surveyItems.some((item: any) => item.zoneId === prepared.zone.zoneId))
      assert.equal(calls.filter(call => call.operation === 'launch').length, 1)
      const nativeDeadline = Date.now() + 20000
      while (!(await store.load()).some(session => session.agentSessionId === record.agentSessionId && session.nativeHandle) && Date.now() < nativeDeadline) await delay(25)
      assert.ok((await store.load()).some(session => session.agentSessionId === record.agentSessionId && session.nativeHandle), 'The original provider native handle is confirmed by the durable Core owner')
      await win.webContents.executeJavaScript('window.navFlush()')
      await fs.writeFile(path.join(root!, 'expected.json'), JSON.stringify({ survey: original.survey, work: original.work, collected: original.collected,
        tabs: original.tabs, record, browser: prepared.reference, session: original.sessions.find((session: any) => session.id === record.agentSessionId) }))
      await fs.writeFile(path.join(root!, 'browsers.json'), JSON.stringify([...browsers.values()]))
    } else {
      const expected = JSON.parse(await fs.readFile(path.join(root!, 'expected.json'), 'utf8'))
      await until(`window.spaceNativeReady(${JSON.stringify(expected.record.regionId)},${JSON.stringify(expected.session.id)},${JSON.stringify(expected.session.control.run.runId)})`)
      const current = await state(), session = current.sessions.find((item: any) => item.id === expected.session.id)
      assert.equal(current.mainSurface, 'survey'); assert.deepEqual(current.survey, expected.survey); assert.deepEqual(current.work, expected.work)
      assert.deepEqual(current.collected, expected.collected); assert.deepEqual(session.control, expected.session.control)
      assert.ok(current.tabs[expected.browser.tabId].regions[expected.record.regionId].sessionId === expected.session.id)
      assert.ok(current.tabs[expected.browser.tabId].regions[expected.browser.regionId].browserId === expected.browser.regionId)
      assert.equal(calls.filter(call => ['launch', 'submit', 'browser-create', 'browser-handoff'].includes(call.operation)).length, 0)
      proof.original = expected
    }
    proof.final = await state(); proof.persisted = await store.load()
    proof.runs = await (runtime as any).hosts.get('local').client.listRuns()
    assert.ok(proof.persisted.length > 0 && proof.runs.some((run: any) => run.state === 'running'))
    await fs.writeFile(path.join(output!, phase + '.png'), (await win.webContents.capturePage()).toPNG())
    if (phase === 'restore') {
      win.showInactive()
      await progress('independent-review-window-ready')
      await delay(20000)
    }
    proof.passed = true
  } catch (error: any) {
    const causes = []; for (let cause = error.cause; cause; cause = cause.cause) causes.push({ message: cause.message, stack: cause.stack, code: cause.code, stderr: cause.stderr })
    proof.failure = { message: error.message, stack: error.stack, causes }; try { proof.final = await state() } catch {}
  }
  finally {
    try { win?.destroy(); await runtime.dispose() } catch (error) { proof.cleanupFailure = String(error); proof.passed = false }
    await fs.writeFile(path.join(output!, phase + '.json'), JSON.stringify(proof, null, 2))
    app.exit(proof.passed ? 0 : 1)
  }
})
