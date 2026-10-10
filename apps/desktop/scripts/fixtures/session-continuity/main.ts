import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { AgentMuxFileAgentSessionStore, AgentMuxSpatialStateStore } from '@agentmux/core'
import { localRuntimeConnector } from '../../../test/helpers/local-runtime-connector'
import { RuntimeController } from '../../../src/main/runtime-controller'
const [html, privateRoot, phase, preload, evidence, nodeExecutable] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
process.env.AGENTMUX_RUNTIME_DIRECTORY = path.join(privateRoot, 'runtime')
process.env.AGENTMUX_STATE_DIRECTORY = path.join(privateRoot, 'runtime', 'state')
process.env.AGENTMUX_MESSAGE_QUEUE_PATH = path.join(privateRoot, 'messages.ndjson')
const executor = (mode: string) => ({ label: 'Private native continuity fixture', providerId: 'codex', command: path.join(privateRoot, 'fake-codex'),
  env: { AGENTMUX_FAKE_READY_MODE: mode, AGENTMUX_FAKE_NATIVE_RECORD: '1',
    AGENTMUX_FAKE_NATIVE_PRESERVE: '1', AGENTMUX_FAKE_NATIVE_LAUNCH_INPUT: '1', AGENTMUX_FAKE_NATIVE_CONTEXT: 'Original continuity task: retain decision sentinel continuity-body-7f41 and the independent unsent draft.',
    CODEX_HOME: path.join(privateRoot, 'codex'), AGENTMUX_FAKE_NATIVE_RECORD_DIRECTORY: path.join(privateRoot, 'codex', 'sessions') }, injectAgentMuxGuide: false })
const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private continuity proof' }],
  executors: { healthy: executor('before'), working: executor('working-until-resume'), idle: executor('before') },
  workspaces: [{ id: 'continuity-workspace', hostId: 'local', name: 'Private continuity proof', path: path.join(privateRoot, 'workspace'), kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const store = new AgentMuxFileAgentSessionStore(path.join(privateRoot, 'agent-sessions.json'))
const spatial = new AgentMuxSpatialStateStore(path.join(privateRoot, 'spatial.json'))
const runtime = new RuntimeController(store, localRuntimeConnector)
const beganAt = Date.now()
const result: Record<string, any> = { passed: false, phase, pid: process.pid, calls: [], progress: [] }
const step = (label: string) => { const value = { label, elapsedMs: Date.now() - beganAt }; result.progress.push(value); process.stderr.write(JSON.stringify({ phase, ...value }) + '\n') }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
let win: BrowserWindow, releaseSpatial: (() => void) | undefined
let ids: Record<string, any>, sessions: any[] = []
const client = () => (runtime as any).hosts.get('local').client
const wait = async (label: string, read: () => any, budget = 20000) => {
  const end = Date.now() + budget
  do { const value = await read(); if (value) return value; await delay(40) } while (Date.now() < end)
  throw new Error('Private continuity condition did not settle: ' + label)
}
ipcMain.handle('native-proof:request', async (_event, operation, ...args) => {
  const call: any = { operation, args }; result.calls.push(call)
  try {
    switch (operation) {
      case 'setup': return { config, phase, ids, sessions }
      case 'snapshot': return runtime.snapshot(config as any)
      case 'providers': return runtime.providerCatalog(args[0])
      case 'history-sources': return runtime.sessionHistorySources(args[0])
      case 'spatial-read': return spatial.readForLayout()
      case 'spatial-commit': return spatial.commit(args[0])
      case 'spatial-retain-labels': return spatial.retainDisplayLabels(args[0])
      case 'attach': return runtime.attachSession(win.webContents.id, args[0], args[1], config as any)
      case 'replay': return runtime.readSessionReplay(win.webContents.id, args[0], args[1])
      case 'detach': return runtime.detachSession(win.webContents.id, args[0])
      case 'resize': return runtime.resizeSessionAttachment(win.webContents.id, args[0], args[1], args[2])
      case 'write': return runtime.write(args[0], args[1], args[2])
      case 'paste': return runtime.paste(args[0], args[1], args[2])
      case 'submit-prompt': return runtime.submitPrompt(args[0], args[1], args[2], args[3], undefined, args[4], args[5], args[6], args[7])
      case 'inspect-input': return runtime.inspectInput(args[0], args[1])
      case 'rejoin-input': return runtime.rejoinInputWaiting(args[0], args[1])
      case 'recover': {
        const value = await runtime.recoverSession(args[0], config as any, args[1], args[2], args[3])
        call.result = structuredClone(value); return value
      }
      case 'resolve': return runtime.resolveSession(args[0], config as any)
      case 'refresh': return runtime.refresh(args[0], config as any)
      case 'flush': await win.webContents.session.flushStorageData(); return
      default: throw new Error('Unsupported private boundary: ' + operation)
    }
  } catch (error: any) { call.error = { code: error.code, message: error.message }; throw error }
})
app.whenReady().then(async () => {
  const state = () => win.webContents.executeJavaScript('window.continuityState()')
  try {
    runtime.commit(await runtime.prepare(config as any)); step('runtime-prepared')
    if (phase === 'seed') {
      ids = {}
      for (const name of ['healthy', 'working', 'idle']) {
        const launched = await runtime.launchAgent({ hostId: 'local', executorId: name, workspacePath: config.workspaces[0].path }, config as any)
        const session = await wait(name + ' native identity', async () => {
          const value = (await store.load()).find(one => one.agentSessionId === launched.session.id)
          return value?.nativeHandle?.kind === 'provider' && value.semanticStatus?.state === (name === 'working' ? 'working' : 'done') ? value : null
        })
        step('native-ready-' + name)
        ids[name] = { sessionId: session.agentSessionId, run: session.run, nativeHandle: session.nativeHandle }
      }
      sessions = (await runtime.snapshot(config as any)).sessions
      await fs.writeFile(path.join(privateRoot, 'ids.json'), JSON.stringify(ids))
    } else ids = JSON.parse(await fs.readFile(path.join(privateRoot, 'ids.json'), 'utf8'))
    result.before = (await store.load()).map(one => ({ agentSessionId: one.agentSessionId, run: one.run, nativeHandle: one.nativeHandle, semanticStatus: one.semanticStatus }))
    result.spatialBefore = await spatial.readForLayout()
    if (phase !== 'seed') {
      const expected = JSON.parse(await fs.readFile(path.join(privateRoot, phase === 'restore' ? 'expected.json' : 'expected-restored.json'), 'utf8'))
      assert.deepEqual(result.spatialBefore, expected.spatial, 'Original spatial document must exist before Renderer hydration')
    }
    win = new BrowserWindow({ width: 1320, height: 880, show: false,
      webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, preload } })
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) process.stderr.write(`Renderer: ${message}\n`) })
    runtime.attach(win.webContents)
    releaseSpatial = spatial.subscribe(value => { if (!win.isDestroyed()) win.webContents.send('agentmux:session-event', { kind: 'native-proof-spatial-state', state: value }) })
    await win.loadFile(html); step('renderer-loaded')
    await wait('actual App and nonempty workface', async () => await win.webContents.executeJavaScript('window.continuityReady && !window.continuityState().loading && Object.keys(window.continuityState().tabs).length === 2'))
    if (phase === 'restore') await wait('working same-session native recovery', async () => {
      const value = await state(), session = value.sessions.find((one: any) => one.id === ids.working.sessionId)
      return session?.processState === 'running' && session.control.run.runId !== ids.working.run.runId &&
        value.recoveryReceipts.some((one: any) => one.args[0].agentSessionId === ids.working.sessionId && one.result.kind === 'resumed')
    }, 30000)
    step('workface-ready')
    result.initial = await state()
    result.runs = await client().listRuns()
    for (const name of ['healthy', 'working', 'idle']) {
      const current = result.initial.sessions.find((one: any) => one.id === ids[name].sessionId)
      assert.ok(current, 'Original Session remains projected: ' + name)
      assert.equal(result.initial.drafts[ids[name].sessionId], `Unsent ${name} draft remains intact`)
      if (phase === 'restore') assert.equal(current.control.run.runId === ids[name].run.runId, name !== 'working', 'Only interrupted working must replace its Run')
    }
    if (phase !== 'seed') {
      const expected = JSON.parse(await fs.readFile(path.join(privateRoot, phase === 'restore' ? 'expected.json' : 'expected-restored.json'), 'utf8'))
      for (const key of ['tabs', 'layouts', 'drafts', 'focus', 'activeWorkspaceId']) assert.deepEqual(result.initial[key], expected[key], key + ' must survive process restart')
      if (phase === 'reconnect') for (const previous of expected.sessions) {
        assert.deepEqual(result.initial.sessions.find((one: any) => one.id === previous.id)?.control.run, previous.control.run, 'Reconnecting must keep every recovered Run')
      }
      result.recoveryInput = await wait('composed recovery input has a real shared receipt', async () => {
        const working = (await store.load()).find(one => one.agentSessionId === ids.working.sessionId)
        return Object.values(working?.continuityOperations ?? {}).find((one: any) => one.recoveryDelivery?.phase === 'accepted')
      }, 30000)
      const delivery = result.recoveryInput.recoveryDelivery
      assert.equal(delivery.reminder.selected, true)
      assert.equal(delivery.continuation.selected, true)
      assert.equal(delivery.reminder.status, 'accepted')
      assert.equal(delivery.continuation.status, 'accepted')
      assert.deepEqual(delivery.reminder.receiptRef, delivery.key)
      assert.deepEqual(delivery.continuation.receiptRef, delivery.key)
      assert.deepEqual(delivery.receipt.key, delivery.key)
      assert.equal(delivery.receipt.status, 'launch-carried')
      assert.equal(result.recoveryInput.launchInput.state, 'launch-carried')
      assert.deepEqual(result.recoveryInput.launchInput.key, delivery.key)
      result.rendererRecoveryInput = await wait('actual Renderer consumes the settled original input receipt', async () => {
        const value = await state(), session = value.sessions.find((one: any) => one.id === ids.working.sessionId)
        const projected = session?.continuityOperations?.[result.recoveryInput.operationId]?.recoveryDelivery
        return projected?.phase === 'accepted' ? projected : false
      })
      assert.deepEqual(result.rendererRecoveryInput.key, delivery.key)
      if (phase === 'reconnect') assert.deepEqual(delivery, expected.recoveryInput.recoveryDelivery, 'Client restart preserves the original delivery and does not recompose or replay it')
    }
    if (phase === 'restore') {
      const auto = result.calls.filter((call: any) => call.operation === 'recover' && call.args[0].agentSessionId === ids.working.sessionId)
      assert.ok(auto.length > 0 && auto.some((call: any) => call.args[3]?.trigger === 'startup'), 'Actual initialize must submit Core startup intent')
      assert.ok(auto.some((call: any) => call.result?.kind === 'resumed'), 'Actual Renderer consumes the same-session recovery receipt')
      assert.equal(await win.webContents.executeJavaScript('window.continuitySendIdle()'), true, 'Actual Store accepts fresh explicit input for the retained idle Session')
      result.manualExecution = await wait('fresh input restores and submits', async () => {
        const value = await state(), session = value.sessions.find((one: any) => one.id === ids.idle.sessionId)
        if (session?.processState !== 'running' || session.control.run.runId === ids.idle.run.runId) return false
        const replay = await client().readRunReplay(session.control.run)
        const output = Buffer.concat(replay.replay.map((chunk: any) => Buffer.from(chunk.dataBytes))).toString('utf8')
        const witness = JSON.parse(output.match(/codex-launch-input:([^\r\n]+)/u)?.[1] ?? 'null')
        return witness?.prompt === 'Fresh explicit input resumes the retained idle conversation' ? { session, output, witness } : false
      }, 30000)
      assert.equal(result.manualExecution.output.split('codex-launch-input:').length - 1, 1, 'The native process consumes the original fresh launch prompt exactly once')
      assert.equal(result.manualExecution.output.includes('codex-submit:'), false, 'Launch-carried input must never be sent again through PTY')
      assert.equal(result.manualExecution.output.includes('codex-dropped-pre-ready-payload'), false)
      assert.equal(result.calls.filter((call: any) => call.operation === 'submit-prompt' && call.args[0].agentSessionId === ids.idle.sessionId).length, 0)
      const inputRecovery: any = Object.values((await store.load()).find(one => one.agentSessionId === ids.idle.sessionId)?.continuityOperations ?? {}).find((one: any) => one.trigger === 'input' && one.launchInput)
      result.manualInputReceipt = inputRecovery?.launchInput
      assert.equal(result.manualInputReceipt.state, 'launch-carried')
      assert.equal(result.manualInputReceipt.input.prompt, result.manualExecution.witness.prompt)
      assert.deepEqual(result.manualInputReceipt.key.expectedRun, result.manualExecution.session.control.run)
      const projected = (await state()).queues[ids.idle.sessionId]?.find((one: any) => one.operationId === result.manualInputReceipt.input.submissionId)
      assert.equal(projected?.resumeInputReceipt?.state, 'launch-carried', 'The actual queue consumes the truthful carrier receipt')
      assert.equal(projected.archived, true)
      assert.equal(projected.inputReceipt, undefined, 'No synthetic terminal input journal ACK is used')
      result.afterManualInput = await state()
      assert.equal(result.afterManualInput.drafts[ids.idle.sessionId], result.initial.drafts[ids.idle.sessionId], 'Explicit new input cannot overwrite the independently retained draft')
      const manual = result.calls.filter((call: any) => call.operation === 'recover' && call.args[0].agentSessionId === ids.idle.sessionId)
      assert.ok(manual.some((call: any) => call.args[3]?.trigger === 'input'), 'Fresh Store input must submit a typed input recovery intent')
    }
    step('before-workface-flush')
    await win.webContents.executeJavaScript('window.continuityFlush()'); step('workface-flushed')
    result.finalSpatial = await spatial.readForLayout()
    const stored = await store.load()
    result.persisted = stored.map((one: any) => ({ agentSessionId: one.agentSessionId, run: one.run, nativeHandle: one.nativeHandle,
      semanticStatus: one.semanticStatus, continuityOperations: one.continuityOperations }))
    const healthy = result.persisted.find((one: any) => one.agentSessionId === ids.healthy.sessionId)
    assert.equal(Object.values(healthy.continuityOperations ?? {}).some((one: any) => Boolean(one.recoveryDelivery)), false, 'Healthy reattachment never schedules a recovery turn')
    if (phase === 'restore') {
      const idle = result.persisted.find((one: any) => one.agentSessionId === ids.idle.sessionId)
      const inputRecovery: any = Object.values(idle.continuityOperations ?? {}).find((one: any) => one.trigger === 'input')
      assert.ok(inputRecovery)
      assert.deepEqual(inputRecovery.recoveryInputs, { reminder: '', continuation: '' }, 'Fresh explicit input does not schedule an extra recovery turn')
      assert.equal(inputRecovery.recoveryDelivery, undefined)
    }
    result.healthyTerminal = await wait('original healthy terminal is readable', async () => {
      const value = await win.webContents.executeJavaScript('window.continuityTerminalState("healthy")')
      return value?.observation?.liveReady && value.observation.visible && value.text.includes('codex-ready:') ? value : false
    })
    await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    await fs.writeFile(path.join(evidence, phase + '-workface.png'), (await win.capturePage()).toPNG())
    if (phase === 'restore') {
      const originalStore = await store.load()
      result.launchReceiptPresentation = await win.webContents.executeJavaScript('window.continuityShowLaunchReceipt()')
      await fs.writeFile(path.join(evidence, 'launch-input-receipt.png'), (await win.capturePage()).toPNG())
      await win.webContents.executeJavaScript('window.continuityHideLaunchReceipt()')
      await win.webContents.executeJavaScript('window.continuityFlush()')
      result.finalSpatial = await spatial.readForLayout()
      result.noticePresentation = await win.webContents.executeJavaScript('window.continuityShowNotice()')
      assert.equal(result.noticePresentation.draft, result.initial.drafts[ids.working.sessionId])
      await fs.writeFile(path.join(evidence, 'recovery-input-notice.png'), (await win.capturePage()).toPNG())
      await win.webContents.executeJavaScript('window.continuityHideNotice()')
      const afterPresentation = (await store.load()).find(one => one.agentSessionId === ids.working.sessionId)
      const beforePresentation = originalStore.find(one => one.agentSessionId === ids.working.sessionId)
      assert.deepEqual(afterPresentation?.continuityOperations?.[result.noticePresentation.operationId]?.recoveryDelivery,
        beforePresentation?.continuityOperations?.[result.noticePresentation.operationId]?.recoveryDelivery, 'Presentation-only notice fixture cannot alter the real Core receipt')
    }
    if (phase === 'seed') await fs.writeFile(path.join(privateRoot, 'expected.json'), JSON.stringify({ ...result.initial, spatial: result.finalSpatial }))
    if (phase === 'restore') await fs.writeFile(path.join(privateRoot, 'expected-restored.json'), JSON.stringify({ ...result.afterManualInput, spatial: result.finalSpatial, recoveryInput: result.recoveryInput }))
    result.passed = true
  } catch (error: any) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) result.observationAtFailure = await state().catch(() => null)
    result.runFailureEvidence = await Promise.all((await client().listRuns().catch(() => [])).map(async (run: any) => {
      const replay = await client().readRunReplay({ runId: run.runId }).catch(() => null)
      return { runId: run.runId, pid: run.pid, state: run.state, output: replay ? Buffer.concat(replay.replay.map((chunk: any) => Buffer.from(chunk.dataBytes))).toString('utf8').slice(-12000) : null }
    }))
  } finally {
    releaseSpatial?.()
    step('before-runtime-dispose')
    await runtime.dispose().catch(error => { result.cleanupFailure = String(error); result.passed = false })
    step('runtime-disposed')
    await fs.writeFile(path.join(evidence, phase + '.json'), JSON.stringify(result, null, 2))
    step('before-window-destroy')
    if (win && !win.isDestroyed()) win.destroy()
    step('before-app-exit')
    app.exit(result.passed ? 0 : 1)
  }
})
