import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { AgentMuxError, AgentMuxFileAgentSessionStore } from '@agentmux/core'
import { RuntimeController } from '../../../src/main/runtime-controller'
const [html, privateRoot, phase, preload, evidence, nodeExecutable] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
process.env.AGENTMUX_RUNTIME_DIRECTORY = path.join(privateRoot, 'runtime')
process.env.AGENTMUX_MESSAGE_QUEUE_PATH = path.join(privateRoot, 'messages.ndjson')
const config = { version: 9, hosts: [{ id: 'local', kind: 'local' as const, label: 'Private proof' }],
  executors: { codex: { label: 'Private CLI fixture', providerId: 'codex', command: nodeExecutable,
    args: [path.join(privateRoot, 'fake-codex-cli.mjs')], env: { AGENTMUX_FAKE_PERMISSION_REQUEST: '1', AGENTMUX_FAKE_READY_MODE: 'before' }, injectAgentMuxGuide: false } },
  workspaces: [{ id: 'native-workspace', hostId: 'local', name: 'Private proof', path: path.join(privateRoot, 'workspace'), kind: 'folder' as const }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const store = new AgentMuxFileAgentSessionStore(path.join(privateRoot, 'agent-sessions.json'))
const runtime = new RuntimeController(store)
const calls: { operation: string; args: any[] }[] = []
const result: Record<string, any> = { passed: false, phase, pid: process.pid }
let win: BrowserWindow
let armed = false
const client = () => (runtime as any).hosts.get('local').client
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
ipcMain.handle('native-proof:request', async (_event, operation, ...args) => {
  calls.push({ operation, args })
  switch (operation) {
    case 'setup': return { phase, config, ids: phase === 'restore' ? JSON.parse(await fs.readFile(path.join(privateRoot, 'ids.json'), 'utf8')) : null }
    case 'launch': return runtime.launchAgent({ hostId: 'local', executorId: 'codex', workspacePath: config.workspaces[0].path }, config as any)
    case 'snapshot': return runtime.snapshot(config as any)
    case 'attach': return runtime.attachSession(win.webContents.id, args[0], args[1], config as any)
    case 'replay': return runtime.readSessionReplay(win.webContents.id, args[0], args[1])
    case 'detach': return runtime.detachSession(win.webContents.id, args[0])
    case 'resize': return runtime.resizeSessionAttachment(win.webContents.id, args[0], args[1], args[2])
    case 'write': return runtime.write(args[0], args[1], args[2])
    case 'paste': return runtime.paste(args[0], args[1], args[2])
    case 'respond': return runtime.respondInteraction(args[0], args[1])
    case 'resolve': return runtime.resolveSession(args[0], config as any)
    case 'refresh': return runtime.refresh(args[0], config as any)
    case 'save-ids': await fs.writeFile(path.join(privateRoot, 'ids.json'), JSON.stringify(args[0])); return
    case 'flush': await win.webContents.session.flushStorageData(); return
    default: throw new Error(`Unsupported private boundary: ${operation}`)
  }
})
app.whenReady().then(async () => {
  const until = async (expression: string, budget = 15000) => {
    const deadline = Date.now() + budget
    do { const value = await win.webContents.executeJavaScript(expression); if (value) return value; await delay(30) } while (Date.now() < deadline)
    throw new Error(`Private native condition did not settle: ${expression}`)
  }
  const state = () => win.webContents.executeJavaScript('window.nativeState()')
  try {
    runtime.commit(await runtime.prepare(config as any))
    // Inject one lost receipt after REAL ctxmux accepts the exact public user operation.
    // No synthetic Run/Input ACK: the saved real ACK is retained in the proof.
    const originalWrite = client().writeAgent.bind(client())
    client().writeAgent = async (input: any) => {
      if (!armed || input.source !== 'user') return originalWrite(input)
      armed = false
      const kernel = client().kernel
      const originalInput = kernel.input.bind(kernel)
      kernel.input = async (runId: string, operation: any) => {
        const ack = await originalInput(runId, operation)
        if (runId === input.expectedRun.runId && operation.data === input.data) {
          result.lostReceipt = { agentSessionId: input.agentSessionId, run: input.expectedRun, operation, ack }
          throw new AgentMuxError('Private proof lost one already accepted input receipt.', 'PRIVATE_ACK_LOST', 'unknown')
        }
        return ack
      }
      try { return await originalWrite(input) } finally { kernel.input = originalInput }
    }
    win = new BrowserWindow({ width: 1220, height: 850, show: false,
      webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, preload } })
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) process.stderr.write(`Renderer: ${message}\n`) })
    runtime.attach(win.webContents)
    await win.loadFile(html)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await until('window.nativeReady === true && window.nativeState().terminalCount === 1 && window.nativeState().session?.pendingInteraction && window.nativeLiveReady()')
    const ids = JSON.parse(await fs.readFile(path.join(privateRoot, 'ids.json'), 'utf8'))
    result.initial = await state()
    result.originalRun = (await client().listRuns()).find((run: any) => run.runId === ids.run.runId)
    assert.ok(result.originalRun?.pid)
    if (phase === 'seed') {
      assert.equal(calls.filter(call => call.operation === 'launch').length, 1)
      assert.equal(result.initial.session.interactionResponseUnavailableReason, undefined, 'Protocol replies cannot mark a request unconfirmed')
      // A second private Agent proves the non-defining Core caller and both live projections.
      // Its observed Provider Stop clears attention; a resolved input ACK alone is not enough.
      const extra = await runtime.launchAgent({ hostId: 'local', executorId: 'codex', workspacePath: config.workspaces[0].path }, config as any)
      let extraSession: any
      const deadline = Date.now() + 15000
      do {
        extraSession = (await runtime.snapshot(config as any)).sessions.find((one: any) => one.id === extra.session.id)
        if (extraSession?.pendingInteraction) break
        await delay(30)
      } while (Date.now() < deadline)
      assert.ok(extraSession?.pendingInteraction)
      await win.webContents.executeJavaScript(`window.nativeObserveExtra(${JSON.stringify(extraSession)}); true`)
      const extraState = () => win.webContents.executeJavaScript(`window.nativeExtraState(${JSON.stringify(extraSession.id)})`)
      await until(`window.nativeExtraState(${JSON.stringify(extraSession.id)}).cards.length === 2`)
      const before = await extraState()
      await runtime.respondInteraction(extraSession.control, { kind: 'permission', requestId: extraSession.pendingInteraction.id,
        decision: { outcome: 'selected', optionId: 'allow-once' } })
      await until(`window.nativeExtraState(${JSON.stringify(extraSession.id)}).cards.length === 0 && window.nativeExtraState(${JSON.stringify(extraSession.id)}).session.status.state === "done"`)
      const after = await extraState()
      assert.equal(after.needsYou, before.needsYou - 1)
      assert.equal(after.session.pendingInteraction, undefined)
      assert.equal(after.session.processState, 'running')
      result.otherViewAnswer = { before, after }
      await win.webContents.executeJavaScript('window.nativeCloseExtra(); true')
      await client().stopAgent(extraSession.id, extraSession.control.run)
      armed = true
      await win.webContents.executeJavaScript('window.terminals.find(one=>one.element?.isConnected).focus(); true')
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await until('window.nativeState().session?.interactionResponseUnavailableReason?.includes("delivery is unknown")')
      assert.ok(result.lostReceipt)
      await until('window.terminals.some(t=>Array.from({length:t.buffer.active.length},(_,n)=>t.buffer.active.getLine(n)?.translateToString()).some(line=>line?.includes("codex-permission-cancelled")))')
    } else {
      assert.equal(calls.filter(call => call.operation === 'launch').length, 0, 'Restart must reattach the original Agent')
      const expected = JSON.parse(await fs.readFile(path.join(privateRoot, 'expected.json'), 'utf8'))
      for (const field of ['tabs', 'layouts', 'drafts', 'focus', 'activeWorkspaceId']) assert.deepEqual(result.initial[field], expected[field], `${field} changed across restart`)
      assert.equal(result.originalRun.runId, expected.session.control.run.runId)
      assert.equal(result.initial.session.pendingInteraction.id, expected.session.pendingInteraction.id)
      assert.equal(result.initial.session.interactionResponseUnavailableReason, expected.session.interactionResponseUnavailableReason)
    }
    result.beforeTyped = (await client().listRuns()).find((run: any) => run.runId === ids.run.runId).acceptedInputBytes
    result.typedAttempt = await win.webContents.executeJavaScript('window.nativeRespond().then(()=>"accepted",error=>String(error))')
    assert.notEqual(result.typedAttempt, 'accepted', 'Unknown native handling cannot approve an old request')
    result.afterTyped = (await client().listRuns()).find((run: any) => run.runId === ids.run.runId).acceptedInputBytes
    assert.equal(result.afterTyped, result.beforeTyped, 'The rejected typed grant must write zero bytes')
    await win.webContents.executeJavaScript('window.nativeReviewHere(); true')
    await until('document.querySelector(".focus-toolbar__review")')
    await win.webContents.executeJavaScript('document.querySelector(".focus-toolbar__review").click(); true')
    await until(`document.querySelector(".attention-request-panel [aria-label='Agent interaction needs native confirmation']")`)
    result.attentionView = await win.webContents.executeJavaScript('({text:document.querySelector(".attention-request-panel").textContent, requestId:document.querySelector(".attention-request-panel .agent-interaction").dataset.requestId})')
    assert.equal(result.attentionView.requestId, result.initial.session.pendingInteraction.id)
    assert.ok(result.attentionView.text.includes(result.initial.session.interactionResponseUnavailableReason ?? 'delivery is unknown'))
    await fs.writeFile(path.join(evidence, `${phase}-attention.png`), (await win.capturePage()).toPNG())
    await win.webContents.executeJavaScript('[...document.querySelectorAll(".attention-request-panel button")].find(one=>one.textContent==="Open terminal").click(); true')
    await until('document.querySelector("[data-agent-surface-mode=terminal]") && window.nativeLiveReady()')
    result.afterAttentionNavigation = await state()
    assert.equal(result.afterAttentionNavigation.session.id, ids.sessionId)
    assert.equal(result.afterAttentionNavigation.session.control.run.runId, ids.run.runId)
    await win.webContents.executeJavaScript('window.nativeActivity(); true')
    await until('document.querySelector("[data-agent-surface-mode=activity]") && [...document.querySelectorAll(".agent-interaction button")].some(one=>one.textContent==="Open terminal")')
    await win.webContents.executeJavaScript('[...document.querySelectorAll(".agent-interaction button")].find(one=>one.textContent==="Open terminal").click(); true')
    await until('document.querySelector("[data-agent-surface-mode=terminal]") && window.nativeState().terminalCount === 1 && window.nativeLiveReady()')
    await win.webContents.executeJavaScript('window.terminals.find(one=>one.element?.isConnected).focus(); true')
    const beforeNative = (await client().listRuns()).find((run: any) => run.runId === ids.run.runId).acceptedInputBytes
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: 'z' })
    await until(`window.terminals.filter(t=>t.element?.isConnected).some(t=>Array.from({length:t.buffer.active.length},(_,n)=>t.buffer.active.getLine(n)?.translateToString()).some(line=>line?.includes("codex-composer-rendered:${phase === 'seed' ? 1 : 2}")))`)
    const afterNative = (await client().listRuns()).find((run: any) => run.runId === ids.run.runId).acceptedInputBytes
    assert.ok(afterNative > beforeNative, 'The restored terminal must send fresh bytes')
    result.freshNativeInput = { beforeNative, afterNative }
    result.saved = await state()
    result.persisted = (await store.load()).find((session: any) => session.agentSessionId === ids.sessionId)
    assert.equal(result.persisted.pendingInteraction.nativeInput.delivery, 'unknown')
    assert.equal(result.persisted.pendingInteraction.request.id, result.initial.session.pendingInteraction.id)
    assert.equal(result.saved.drafts[ids.sessionId], 'Keep this unsent draft')
    assert.ok(calls.some(call => call.operation === 'write' && call.args[2] === 'user'))
    assert.equal(result.saved.session.processState, 'running')
    if (phase === 'seed') await fs.writeFile(path.join(privateRoot, 'expected.json'), JSON.stringify(result.saved))
    result.persisted = { agentSessionId: result.persisted.agentSessionId, run: result.persisted.run, pendingInteraction: result.persisted.pendingInteraction }
    await win.webContents.executeJavaScript('window.nativeFlush()')
    result.calls = calls
    result.passed = true
  } catch (error: any) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    result.calls = calls
    if (win && !win.isDestroyed()) result.observationAtFailure = await state().catch(() => null)
    result.storeAtFailure = (await store.load().catch(() => [])).map((one: any) => ({ agentSessionId: one.agentSessionId, run: one.run, pendingInteraction: one.pendingInteraction }))
  } finally {
    await runtime.dispose().catch(error => { result.cleanupFailure = String(error); result.passed = false })
    await fs.writeFile(path.join(evidence, `${phase}.json`), JSON.stringify(result, null, 2))
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
