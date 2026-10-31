import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { AgentMuxClient, AgentMuxFileAgentSessionStore } from '@agentmux/core'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { RuntimeController } from '../../../src/main/runtime-controller'
import { WorkbenchUserStateStore } from '../../../src/main/workbench-user-state'
import { prepareWindowWorkbenchForQuit } from '../../../src/main/window-state-persistence'

const [html, privateRoot, evidence, phase, exitMode, preload, nodeExecutable] = process.argv.slice(2)
process.env.AGENTMUX_RUNTIME_DIRECTORY = path.join(privateRoot, 'runtime')
process.env.AGENTMUX_STATE_DIRECTORY = path.join(privateRoot, 'state')
process.env.AGENTMUX_MESSAGE_QUEUE_PATH = path.join(privateRoot, 'messages.ndjson')
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
app.on('window-all-closed', () => {})
const workspace = { id: 'original-workspace', hostId: 'local', kind: 'folder' as const, name: 'Private original work', path: path.join(privateRoot, 'work') }
const config: any = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private local owner' }], executors: {},
  workspaces: [workspace], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: {
    selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
let core: AgentMuxClient, win: BrowserWindow, session: any, unsubscribe: (() => void) | undefined
const runtime = new RuntimeController(new AgentMuxFileAgentSessionStore(path.join(privateRoot, 'agent-sessions.json')), async () => {
  core = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(path.join(privateRoot, 'agent-sessions.json')) })
  await core.connect()
  return core
})
const spatial = new AgentMuxSpatialStateStore(path.join(privateRoot, 'spatial-state.json'))
const user = new WorkbenchUserStateStore(path.join(app.getPath('userData'), 'workbench-user-state.json'))
const result: any = { schema: 'agentmux.workbench-native-restart-phase.v1', passed: false, phase, exitMode, pid: process.pid,
  calls: [], console: [], boundary: 'Actual App/Store/user writer/Main file owner/Core spatial owner and private native ctxmux Terminal. Controlled unrelated service ports; no upstream Provider or user Runtime.' }
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const record = async () => fs.writeFile(path.join(evidence, phase + '.json'), JSON.stringify(result, null, 2) + '\n')

app.whenReady().then(async () => {
  try {
    result.stage = 'connect-private-runtime'; await record()
    await fs.mkdir(workspace.path, { recursive: true })
    runtime.commit(await runtime.prepare(config))
    result.stage = 'resolve-original-terminal'; await record()
    if (phase === 'seed') {
      session = await runtime.launchTerminal({ hostId: 'local', workspacePath: workspace.path,
        shellCommand: `'${nodeExecutable}' '${path.join(privateRoot, 'producer.cjs')}'`, cols: 90, rows: 30 }, config)
      await fs.writeFile(path.join(privateRoot, 'original-run.json'), JSON.stringify({ id: session.id, control: session.control }) + '\n')
    } else {
      const original = JSON.parse(await fs.readFile(path.join(privateRoot, 'original-run.json'), 'utf8'))
      session = await runtime.resolveSession(original.id, config)
      assert.ok(session)
      assert.equal(session.control.run.runId, original.control.run.runId)
    }
    ipcMain.handle('durable-restart:request', async (event, operation: string, ...args: any[]) => {
      assert.equal(event.sender, win.webContents, 'Only the original private root document owns fixture ports')
      result.calls.push({ operation })
      switch (operation) {
        case 'setup': return { config, session, phase }
        case 'spatial-read': return spatial.readForLayout()
        case 'spatial-commit': return spatial.commit(args[0])
        case 'spatial-labels': return spatial.retainDisplayLabels(args[0])
        case 'user-read': return user.read()
        case 'user-write': return user.write(args[0])
        case 'user-import': return user.importIfAbsent(args[0])
        case 'flush': await user.read(); return
        case 'snapshot': return runtime.snapshot(config)
        case 'attach': return runtime.attachSession(event.sender.id, args[0], args[1] ?? 0, config)
        case 'detach': return runtime.detachSession(event.sender.id, args[0])
        case 'replay': return runtime.readSessionReplay(event.sender.id, args[0], args[1])
        case 'resize': return runtime.resizeSessionAttachment(event.sender.id, args[0], args[1], args[2])
        case 'write': return runtime.write(args[0], args[1], args[2])
        case 'refresh': return runtime.refresh(args[0], config)
        default: throw Error('Unsupported original fixture port: ' + operation)
      }
    })
    win = new BrowserWindow({ width: 1400, height: 860, useContentSize: true, show: false,
      webPreferences: { preload, contextIsolation: true, sandbox: true, backgroundThrottling: false } })
    runtime.attach(win.webContents)
    unsubscribe = spatial.subscribe(value => { if (!win.isDestroyed()) win.webContents.send('durable-restart:spatial', value) })
    win.webContents.on('console-message', details => { if (details.level === 'error') result.console.push(details.message.slice(0, 1200)) })
    const read = (code: string) => win.webContents.executeJavaScript(code)
    const until = async (name: string, probe: () => Promise<unknown>) => {
      const deadline = Date.now() + 20000
      do { if (await probe()) return; await pause(30) } while (Date.now() < deadline)
      throw Error('Actual private App did not settle: ' + name)
    }
    await win.loadFile(html)
    result.stage = 'wait-original-workface'; await record()
    await until('original visible Regions and native output', () => read(`window.durableRestartReady && (()=>{
      const f=durableRestartFacts();return !f.loading&&f.regions.includes('original-terminal')&&f.regions.includes('original-file')&&f.terminal.some(t=>t.connected&&t.lines.includes('ORIGINAL-LIVE'));
    })()`))
    await until('automatic host save with latest draft and unsaved edit', async () => {
      const raw = await user.read()
      if (!raw) return false
      const state = JSON.parse(raw).state
      return state.agentComposerDrafts?.['original-terminal'] === 'Latest native-host draft survives both exit modes' &&
        state.documents?.['original-workspace\0notes.md']?.content?.includes('Latest unsaved annotation.')
    })
    // This is a read of the actual periodic writer's result. No helper flush or
    // test write is used to make abrupt exit or the restoring process succeed.
    result.state = await read('durableRestartFacts()')
    result.user = user.observe()
    result.savedUser = JSON.parse((await user.read())!)
    result.spatial = await spatial.readForLayout()
    result.run = (await core!.listRuns()).find(run => run.runId === session.control.run.runId)
    result.observationBoundary = { callCount: result.calls.length,
      userWritesBeforeAssertions: result.calls.filter((call: any) => call.operation === 'user-write').length,
      checkpointRequested: false, diagnosticCompletionAwaited: false }
    assert.equal(result.state.error, null)
    assert.equal(result.state.saveWarning, null)
    assert.equal(result.state.originalLegacyPresent, false, 'Native import removes only confirmed original browser bytes')
    assert.equal(result.state.auxiliaryLegacyPresent, false, 'Original auxiliary bytes are handed off only after the same native writer ACK')
    assert.equal(result.state.auxiliary.globalGoalPatrolOperation, 'original-patrol-operation')
    assert.equal(Object.values(result.state.auxiliary.moteAvatarSaveDrafts).length, 1)
    assert.equal(result.run?.state, 'running')
    assert.ok(result.run.pid)
    assert.equal(result.state.queues['original-retained-agent'][0].operationId, 'original-queued-input')
    assert.equal(result.calls.filter((call: any) => call.operation === 'user-import').length, phase === 'seed' ? 1 : 0,
      'Only the first process imports original user bytes')
    const keys = ['tabs', 'layouts', 'selection', 'focus', 'drafts', 'queues', 'documents', 'dirtyDocuments',
      'activeWorkspaceId', 'mainSurface', 'regions', 'auxiliary']
    if (phase === 'seed') await fs.writeFile(path.join(privateRoot, 'expected.json'), JSON.stringify({ state: result.state, run: result.run }) + '\n')
    else {
      const original = JSON.parse(await fs.readFile(path.join(privateRoot, 'expected.json'), 'utf8'))
      assert.equal(result.state.seeded, false, 'Restoring process cannot seed or reconstruct original work')
      for (const key of keys) assert.deepEqual(result.state[key], original.state[key], 'Original ' + key + ' survives actual process restart')
      assert.equal(result.run.runId, original.run.runId)
      assert.equal(result.run.pid, original.run.pid, 'The same healthy native process survives both App lifetimes')
    }
    // Real native input remains available after restore; no queued Agent input
    // is dispatched. The private Terminal echoes a receipt for this explicit input.
    if (phase === 'restore') {
      await read(`(()=>{const t=window.terminals.find(t=>t.element?.closest('[data-workbench-region-id]')?.dataset.workbenchRegionId==='original-terminal');t.focus();return true})()`)
      for (const keyCode of 'recovered-input') win.webContents.sendInputEvent({ type: 'char', keyCode })
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
      await until('original healthy Terminal acknowledges restored native input', () => read(`durableRestartFacts().terminal.some(t=>t.lines.includes('ACK:recovered-input'))`))
      result.nativeInputConfirmed = true
    }
    result.passed = true
    if (phase === 'seed' && exitMode === 'abrupt') {
      result.exitBoundary = 'SIGKILL after automatic user/space saves were read; no quit checkpoint or extra test flush'
      await record()
      process.kill(process.pid, 'SIGKILL')
      return
    }
    await prepareWindowWorkbenchForQuit(win)
    result.exitBoundary = 'Actual prepareWindowWorkbenchForQuit and Renderer prepareRendererUpdate before normal exit'
  } catch (error: any) {
    result.passed = false
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) result.observed = await win.webContents.executeJavaScript('({state:window.durableRestartFacts?.(),errors:window.durableRestartErrors})').catch(() => null)
  } finally {
    unsubscribe?.()
    await runtime.dispose().catch(error => { result.passed = false; result.cleanupFailure = String(error) })
    await record()
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
