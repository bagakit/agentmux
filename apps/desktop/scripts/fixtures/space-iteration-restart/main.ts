import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { app, BrowserWindow, ipcMain } from 'electron'
import { ScratchTopics } from '../../../src/main/scratch-topics'

const [html, privateRoot, phase, preload, resultDirectory] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const topicStore = new ScratchTopics()
const scratch = { id: '__scratch__', hostId: 'local', name: 'Topics', path: path.join(privateRoot, 'topics'), kind: 'folder' as const }
const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private fixture' }],
  executors: { probe: { providerId: 'codex', label: 'Private boundary', command: 'unused-fixture', args: [], env: {}, injectAgentMuxGuide: false } },
  workspaces: [scratch], appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const calls: unknown[] = []
const result: Record<string, any> = { passed: false, phase, pid: process.pid,
  boundary: 'Real Electron process, Chromium persistent localStorage, production initialize/persistence/workbench/tree/overview and filesystem ScratchTopics. Session snapshot/recovery/attachment is a controlled public API boundary; no actual Core Run or user App.' }
let win: BrowserWindow
let snapshotReads = 0
let idleRecovered = phase === 'seed'
let lateTimelineItem: Record<string, any> | null = null
function session(id: string, topicId: string) {
  return { id, kind: 'agent', providerId: 'codex', executorId: 'probe',
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    hostId: 'local', workspacePath: path.join(scratch.path, topicId === 'launcher:leader' ? 'topic--launcher--leader' : 'topic--view--original'),
    label: id, createdAt: 1, updatedAt: Date.now(), processState: 'running', latestOutputBytes: 0,
    status: { state: 'running', source: 'run-process', observedAt: Date.now() },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `original-run-${id}` } } }
}
const live = session('private-live-agent', 'view:original')
const mote = session('private-mote-agent', 'launcher:leader')
const idle = session('private-idle-agent', 'view:original')
const candidate = { agentSessionId: idle.id, hostId: 'local', workspacePath: idle.workspacePath,
  providerId: 'codex', executorId: 'probe', capabilities: idle.capabilities, label: idle.label, createdAt: 1, updatedAt: Date.now(),
  semanticStatus: { state: 'done', source: 'native-hook', observedAt: Date.now(), stateEnteredAt: Date.now() - 1000 }, run: idle.control.run }
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
ipcMain.handle('space-restart:request', async (_event, operation, ...args) => {
  calls.push({ operation, args, at: Date.now() })
  switch (operation) {
    case 'setup': return { config, phase }
    case 'topics': return topicStore.list(scratch)
    case 'topic': return topicStore.read(scratch, args[1])
    case 'ensure-topic': return topicStore.ensure(scratch, args[1])
    case 'ensure-mote': return topicStore.ensureMote(scratch, args[1])
    case 'file': {
      const file = path.resolve(scratch.path, args[1])
      assert.ok(file.startsWith(`${scratch.path}${path.sep}`), 'Only private workspace files may be read')
      const content = await fs.readFile(file, 'utf8')
      return { status: 'read', document: { path: args[1], content, revision: hash(content) } }
    }
    case 'snapshot': {
      snapshotReads += 1
      if (snapshotReads === 1 && phase === 'empty-restore') return { sessions: [], timelines: {}, recoveryCandidates: [] }
      if (snapshotReads === 1 && phase === 'timeout-restore') throw new Error('Private initial snapshot timeout')
      if (snapshotReads === 2 && phase !== 'seed') await new Promise(resolve => setTimeout(resolve, 1200))
      const sessions = [live, mote, ...(idleRecovered ? [idle] : [])]
      return { sessions, timelines: Object.fromEntries(sessions.map(one => [one.id, {
        agentSessionId: one.id, revision: one.id === live.id && lateTimelineItem ? 1 : 0,
        items: one.id === live.id && lateTimelineItem ? [lateTimelineItem] : []
      }])),
        recoveryCandidates: idleRecovered ? [] : [candidate] }
    }
    case 'recover':
      assert.equal(args[0].agentSessionId, idle.id, 'Healthy Runs must never be resumed by startup')
      assert.equal(args[1], idle.workspacePath)
      if (phase === 'recovery-timeout-restore') throw new Error('Private automatic recovery timeout')
      idleRecovered = true
      if (phase === 'empty-restore' || phase === 'timeout-restore') {
        const observedAt = Date.now()
        lateTimelineItem = {
          id: 'queued-during-recovery', agentSessionId: live.id, kind: 'assistant_message', status: 'complete',
          source: 'native-hook', title: 'Fact queued during automatic recovery', createdAt: observedAt, updatedAt: observedAt
        }
        win.webContents.send('space-restart:event', { type: 'core', hostId: 'local', event: {
          type: 'agent-timeline', agentSessionId: live.id, revision: 1,
          mutation: { type: 'append', agentSessionId: live.id, item: lateTimelineItem },
          evidence: { source: 'native-hook', observedAt, run: live.control.run }
        } })
        // Hold the public recovery response until the real renderer receives this late fact.
        await new Promise(resolve => setTimeout(resolve, 75))
      }
      return { kind: 'reattachable', session: idle }
    case 'attach': {
      const control = args[0]
      const current = [live, mote, ...(idleRecovered ? [idle] : [])].find(one => one.id === control.agentSessionId)
      assert.ok(current, 'Only canonical private Sessions may attach')
      const text = `Private boundary ${current.id}\r\n`, bytes = new TextEncoder().encode(text)
      return { attachmentId: `attachment-${current.id}`, session: current, currentSize: null,
        terminal: { type: 'unknown', reason: 'origin_unknown' }, resizeRevision: 0,
        replay: [{ type: 'data', runId: current.control.run.runId, startByte: 0, endByte: bytes.length, data: text, dataBytes: bytes }], gap: null }
    }
    case 'detach': return
    case 'flush': await win.webContents.session.flushStorageData(); return
    default: throw new Error(`Unsupported private fixture operation: ${operation}`)
  }
})

app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1500, height: 920, show: false, webPreferences: { contextIsolation: true, sandbox: true, preload } })
    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 2) process.stderr.write(`Renderer: ${message}\n`)
    })
    await win.loadFile(html)
    const until = async (expression: string, budget = 8000) => {
      const deadline = Date.now() + budget
      do {
        if (await win.webContents.executeJavaScript(expression)) return
        await new Promise(resolve => setTimeout(resolve, 25))
      } while (Date.now() < deadline)
      throw new Error(`Space restart condition did not settle: ${expression}`)
    }
    await until('window.spaceRestartReady === true && document.querySelectorAll(".space-topic-row").length === 2')
    result.shell = await win.webContents.executeJavaScript('({ state: window.spaceRestartState(), ui: window.spaceRestartUi() })')
    assert.equal(result.shell.state.loading, false)
    assert.deepEqual(Object.keys(result.shell.state.tabs).sort(), ['original-agent-tab', 'original-background-tab', 'original-idle-tab', 'original-mote-tab'])
    assert.deepEqual(result.shell.ui.topicTree, ['Original Topic', 'Other Topic'])
    assert.deepEqual(result.shell.ui.overview, result.shell.ui.topicTree)
    assert.deepEqual(result.shell.ui.motes, ['Mote'])
    assert.deepEqual(result.shell.ui.regions, ['original-agent-region', 'original-background-region', 'original-file-region', 'original-idle-region', 'original-mote-region'],
      'Each original Region must have exactly one production Workbench consumer')
    assert.equal(result.shell.ui.overviewSelected, 'view:original')
    assert.equal(result.shell.ui.topicSelected, 'Open Original Topic')
    if (phase === 'empty-restore' || phase === 'timeout-restore') {
      assert.ok(result.shell.ui.regions.includes('original-agent-region'), 'Saved Agent Region must render before late canonical facts')
      assert.ok(result.shell.state.error, 'Unavailable snapshot must produce a service-window notice')
      assert.ok(result.shell.state.sessions.length === 0, 'Late canonical snapshot has not been returned yet')
    }
    if (phase === 'recovery-timeout-restore') {
      assert.ok(result.shell.state.error.includes('Private automatic recovery timeout'))
      assert.ok(result.shell.ui.regions.includes('original-idle-region'))
    } else {
      await until('window.spaceRestartState().sessions.some(one => one.id === "private-live-agent") && window.spaceRestartState().sessions.some(one => one.id === "private-idle-agent")')
      await until('document.querySelector("[data-workbench-region-id=original-agent-region] .xterm") !== null')
      assert.ok(calls.some((call: any) => call.operation === 'attach' && call.args[0].agentSessionId === live.id), 'Healthy Session automatically reattaches through the production TerminalView')
      if (phase !== 'seed') assert.equal(calls.filter((call: any) => call.operation === 'recover').length, 1, 'Saved recent-idle Agent automatically receives one recovery attempt')
      if (phase === 'empty-restore' || phase === 'timeout-restore') {
        await until('window.spaceRestartState().timelines["private-live-agent"]?.items.some(one => one.id === "queued-during-recovery")')
        assert.ok(snapshotReads >= 3, 'The existing resync owner must drain facts received during recovery')
      }
    }
    await until('document.querySelector("[data-workbench-region-id=original-file-region] .editor-pane") !== null')
    await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    result.final = await win.webContents.executeJavaScript('({ state: window.spaceRestartState(), ui: window.spaceRestartUi(), durable: JSON.parse(localStorage.getItem("agentmux-workbench-v1")) })')
    assert.equal(result.final.state.drafts['private-live-agent'], 'Original unsent draft survives restart')
    assert.equal(result.final.state.documents['__scratch__\u0000topic--view--original/topic.md'].content,
      '# Original Topic\n\nOriginal shared goal\n\nOriginal unsaved file note\n')
    assert.equal(result.final.state.dirtyDocuments['__scratch__\u0000topic--view--original/topic.md'], true)
    assert.equal(result.final.state.layouts.__scratch__.root.ratio, 0.57)
    assert.equal(result.final.state.tabs['original-agent-tab'].layout.root.ratio, 0.63)
    assert.equal(result.final.state.tabs['original-agent-tab'].layout.activeRegionId, 'original-file-region')
    assert.equal(result.final.state.agentFocus.execution.sessionId, 'private-live-agent')
    if (phase === 'seed') await fs.writeFile(path.join(privateRoot, 'expected.json'), JSON.stringify(result.final.state))
    else {
      const expected = JSON.parse(await fs.readFile(path.join(privateRoot, 'expected.json'), 'utf8'))
      for (const key of ['tabs', 'layouts', 'activeWorkspaceId', 'agentFocus', 'drafts', 'documents', 'dirtyDocuments', 'order', 'pins']) assert.deepEqual(result.final.state[key], expected[key], `${key} changed across a real Electron restart`)
    }
    await fs.writeFile(path.join(resultDirectory, `${phase}.png`), (await win.webContents.capturePage()).toPNG())
    result.calls = calls
    result.passed = true
  } catch (error: any) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }; result.calls = calls
    if (win && !win.isDestroyed()) result.observationAtFailure = await win.webContents.executeJavaScript(
      '({ state: window.spaceRestartState?.(), facts: window.spaceRestartFacts, ui: window.spaceRestartUi?.() })'
    ).catch(() => null)
  }
  finally {
    await fs.writeFile(path.join(resultDirectory, `${phase}.json`), JSON.stringify(result, null, 2))
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
