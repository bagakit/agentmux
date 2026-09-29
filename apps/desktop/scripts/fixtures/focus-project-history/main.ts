import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { AgentMuxFileAgentSessionStore } from '@agentmux/core'
import { RuntimeController } from '../../../src/main/runtime-controller'
import { projectAppearance } from '../../../src/main/project-appearance'
import type { AppConfig } from '../../../src/shared/contracts'

const [html, privateRoot, phase, preload, evidence, nodeExecutable] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
process.env.AGENTMUX_RUNTIME_DIRECTORY = path.join(privateRoot, 'runtime')
process.env.AGENTMUX_STATE_DIRECTORY = path.join(privateRoot, 'runtime', 'state')
process.env.AGENTMUX_MESSAGE_QUEUE_PATH = path.join(privateRoot, 'messages.ndjson')
const config: AppConfig = { version: 9, hosts: [{ id: 'local', label: 'Private Focus proof', kind: 'local' }],
  executors: { codex: { label: 'Private retained Agent fixture', providerId: 'codex', command: nodeExecutable, args: [path.join(privateRoot, 'fake-codex-cli.mjs')], env: { AGENTMUX_FAKE_READY_MODE: 'before' }, injectAgentMuxGuide: false } },
  workspaces: ['alpha', 'beta'].map(id => ({ id, hostId: 'local', name: id === 'alpha' ? 'Alpha · retained work' : 'Beta · closed work', kind: 'folder' as const, path: path.join(privateRoot, id) })),
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const runtime = new RuntimeController(new AgentMuxFileAgentSessionStore(path.join(privateRoot, 'agent-sessions.json')))
const calls: { operation: string; args: unknown[] }[] = []
const result: Record<string, any> = { passed: false, phase, pid: process.pid, boundary: 'Actual App/Store/Focus/Workbench/Terminal, a private public Core Agent keepSession and Terminal Runs. Focus timestamps are controlled fixture inputs. The Agent CLI is the repository fixture; Terminal archive facts do not qualify Agent native messages, upstream Provider writers or user installation.' }
let win: BrowserWindow
ipcMain.handle('project-history:request', async (event, operation, ...args) => {
  calls.push({ operation, args: operation === 'write' ? [args[0], '[private input bytes]'] : args })
  switch (operation) {
    case 'setup': return { config, phase, ids: phase === 'restore' ? JSON.parse(await fs.readFile(path.join(privateRoot, 'ids.json'), 'utf8')) : null }
    case 'snapshot': return runtime.snapshot(config)
    case 'launch': return runtime.launchTerminal({ ...args[0], shellCommand: `'${nodeExecutable}' '${path.join(privateRoot, 'producer.cjs')}'` }, config)
    case 'launch-agent': return runtime.launchAgent(args[0], config)
    case 'history': return runtime.sessionHistoryPage(args[0], args[1], config)
    case 'timeline': return runtime.sessionTimeline(args[0])
    case 'history-sources': return runtime.sessionHistorySources()
    case 'attach': return runtime.attachSession(event.sender.id, args[0], args[1] ?? 0, config)
    case 'detach': return runtime.detachSession(event.sender.id, args[0])
    case 'replay': return runtime.readSessionReplay(event.sender.id, args[0], args[1])
    case 'resize': return runtime.resizeSessionAttachment(event.sender.id, args[0], args[1], args[2])
    case 'write': return runtime.write(args[0], args[1], args[2])
    case 'stop': return runtime.stopSession(args[0])
    case 'resolve': return runtime.resolveSession(args[0], config)
    case 'refresh': return runtime.refresh(args[0], config)
    case 'recover': return runtime.recoverSession(args[0], config, args[1])
    case 'appearance': return projectAppearance(config.workspaces.find(workspace => workspace.id === args[0])!.path)
    case 'save-ids': await fs.writeFile(path.join(privateRoot, 'ids.json'), JSON.stringify(args[0])); return
    case 'flush': await win.webContents.session.flushStorageData(); return
    default: throw new Error(`Unsupported private Focus request: ${operation}`)
  }
})
app.whenReady().then(async () => {
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (expression: string, budget = 15000) => {
    const deadline = Date.now() + budget
    do { const observed = await win.webContents.executeJavaScript(expression); if (observed) return observed; await delay(30) } while (Date.now() < deadline)
    throw new Error(`Private Focus condition did not settle: ${expression}`)
  }
  const shot = async (name: string) => {
    // A mounted Portal can precede Chromium's painted frame. Observe two actual
    // frame boundaries rather than treating DOM presence as a visual result.
    await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await fs.writeFile(path.join(evidence, `${phase}-${name}.png`), (await win.webContents.capturePage()).toPNG())
  }
  const click = async (selector: string) => {
    const point = await win.webContents.executeJavaScript(`(() => { const node=document.querySelector(${JSON.stringify(selector)}); if(!node)throw new Error('Missing click target'); const r=node.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`)
    for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, ...point })
  }
  try {
    runtime.commit(await runtime.prepare(config))
    win = new BrowserWindow({ width: 1440, height: 940, show: false, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, preload } })
    runtime.attach(win.webContents)
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) process.stderr.write(`Renderer: ${message}\n`) })
    await win.loadFile(html)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await until('window.projectHistoryReady === true && window.projectHistoryState().tabs["original-tab"] && window.projectHistoryObservation()?.liveReady')
    const ids = JSON.parse(await fs.readFile(path.join(privateRoot, 'ids.json'), 'utf8'))
    result.ids = ids
    if (phase === 'restore') {
      const expected = JSON.parse(await fs.readFile(path.join(privateRoot, 'expected.json'), 'utf8'))
      result.restored = await win.webContents.executeJavaScript('projectHistoryState()')
      assert.deepEqual(result.restored, expected, 'Same durable groups, history, split, draft and workspace after ordinary GUI restart')
      assert.equal(calls.filter(call => ['launch', 'launch-agent'].includes(call.operation)).length, 0)
    }
    const launchesBefore = calls.filter(call => ['launch', 'launch-agent'].includes(call.operation)).length
    await win.webContents.executeJavaScript('projectHistoryPrepare()')
    await until(`projectHistoryUi().projects.length === 2 && projectHistoryUi().tracks.some(track => track.id === ${JSON.stringify(ids.archive)} && track.historical === 'true')`)
    result.state = await win.webContents.executeJavaScript('projectHistoryState()')
    assert.equal(result.state.tabs['keep-tab'], undefined)
    assert.equal(result.state.tabs['archive-tab'], undefined)
    assert.equal(result.state.tabs['original-tab'].layout.root.ratio, 0.61)
    assert.equal(result.state.drafts[ids.keep], 'A real unsent draft remains')
    assert.equal(result.state.error, null)
    assert.deepEqual(result.state.focus.execution.history.slice(0, 3).map((entry: any) => [entry.sessionId, entry.identity.project.id]), [[ids.original, 'alpha'], [ids.archive, 'beta'], [ids.keep, 'alpha']])
    assert.equal(calls.filter(call => ['launch', 'launch-agent'].includes(call.operation)).length, launchesBefore)
    assert.equal(calls.filter(call => call.operation === 'stop').length, phase === 'seed' ? 1 : 0)
    assert.equal(calls.filter(call => call.operation === 'recover').length, 0)
    result.wide = await win.webContents.executeJavaScript('projectHistoryUi()')
    assert.equal(result.wide.projects.length, 2)
    assert.equal(result.wide.originalRegion, true); assert.equal(result.wide.companionRegion, true)
    await until('document.querySelectorAll(".recent-focus__project-heading img").length === 2')
    await win.webContents.executeJavaScript('window.originalPrivateTerminal = document.querySelector("[data-workbench-region-id=original-region] .xterm"); true')
    const controlsBefore = calls.filter(call => ['launch', 'launch-agent', 'stop', 'recover'].includes(call.operation)).length
    await click(`[data-focus-timeline-id="${ids.archive}"] .recent-focus__segment`)
    await until('!!document.querySelector(".recent-focus__observation")')
    result.archive = await win.webContents.executeJavaScript('({ text:document.querySelector(".recent-focus__observation").textContent, focus:projectHistoryState().focus })')
    assert.match(result.archive.text, /Beta · closed work/)
    assert.match(result.archive.text, /Focus visits/)
    assert.deepEqual(result.archive.focus, result.state.focus)
    await until('(() => { const node=document.querySelector(".recent-focus__observation");if(!node?.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))return false;const r=node.getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()')
    result.archive.paragraphs = await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".recent-focus__observation > p"), node => ({text:node.textContent,whiteSpace:getComputedStyle(node).whiteSpace,overflow:getComputedStyle(node).overflow}))')
    assert.equal(result.archive.paragraphs.length, 2, 'Both historical reading and coverage explanations must actually be present')
    for (const paragraph of result.archive.paragraphs) {
      assert.ok(paragraph.text.trim().length > 0)
      assert.equal(paragraph.whiteSpace, 'normal', 'Historical reading and coverage explanations must wrap instead of being ellipsized')
      assert.equal(paragraph.overflow, 'visible', 'The complete explanation remains readable')
    }
    await shot('wide-archive')
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await until('!document.querySelector(".recent-focus__observation")')
    assert.equal(calls.filter(call => ['launch', 'launch-agent', 'stop', 'recover'].includes(call.operation)).length, controlsBefore)
    await click('[data-timeline-project] .recent-focus__project-heading')
    result.fold = await win.webContents.executeJavaScript('(() => { const group=document.querySelector("[data-timeline-project]");const tracks=group.querySelector(".recent-focus__project-tracks");return {expanded:group.querySelector("button").getAttribute("aria-expanded"),inert:tracks.inert,fragments:tracks.querySelectorAll(".recent-focus__segment").length};})()')
    assert.equal(result.fold.expanded, 'false'); assert.equal(result.fold.inert, true); assert.ok(result.fold.fragments > 0)
    await shot('wide-fold')
    await click('[data-timeline-project] .recent-focus__project-heading')
    await click('[aria-label="Next focus window"]')
    await until('projectHistoryUi().projects.length === 0')
    result.futureWindow = await win.webContents.executeJavaScript('projectHistoryUi()')
    assert.equal(result.futureWindow.projects.length, 0, 'Future windows cannot invent past Focus or current Run facts')
    await click('[aria-label="Return to current focus window"]')
    await until('projectHistoryUi().projects.length === 2')
    win.setContentSize(800, 720)
    await until('innerWidth === 800 && document.querySelector(".recent-focus").clientWidth <= 800')
    await shot('narrow')
    assert.equal(await win.webContents.executeJavaScript('window.originalPrivateTerminal === document.querySelector("[data-workbench-region-id=original-region] .xterm")'), true, 'Window width, archive and fold preserve the original mounted terminal')
    win.setContentSize(1440, 908)
    await until('innerWidth === 1440 && projectHistoryObservation()?.liveReady && projectHistoryObservation()?.acceptsInput')
    await click('[data-workbench-region-id="original-region"] .xterm-screen')
    const input = `focus-history-input-${phase}`
    for (const text of input) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'char', text })
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' })
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    const inputDeadline = Date.now() + 8000
    while (Date.now() < inputDeadline && !(await fs.readFile(path.join(privateRoot, 'input.log'), 'utf8').catch(() => '')).includes(input)) await delay(30)
    assert.match(await fs.readFile(path.join(privateRoot, 'input.log'), 'utf8'), new RegExp(input), 'Native producer received trusted keyboard input through unchanged production terminal')
    result.observation = await win.webContents.executeJavaScript('projectHistoryObservation()')
    result.finalState = await win.webContents.executeJavaScript('projectHistoryState()')
    await win.webContents.executeJavaScript('projectHistoryFlush()')
    if (phase === 'seed') await fs.writeFile(path.join(privateRoot, 'expected.json'), JSON.stringify(result.finalState))
    result.snapshot = await runtime.snapshot(config)
    assert.deepEqual(result.snapshot.sessions.filter(session => session.processState === 'running').map(session => session.id).sort(), [ids.keep, ids.original, ids.companion].sort())
    result.passed = true
  } catch (error: any) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) {
      result.atFailure = await win.webContents.executeJavaScript('({state:window.projectHistoryState?.(),ui:window.projectHistoryUi?.()})').catch(() => null)
      await fs.writeFile(path.join(evidence, `${phase}-failure.png`), (await win.webContents.capturePage()).toPNG()).catch(() => {})
    }
  } finally {
    result.calls = calls
    await runtime.dispose().catch(error => { result.cleanupFailure = String(error); result.passed = false })
    await fs.writeFile(path.join(evidence, `${phase}.json`), JSON.stringify(result, null, 2))
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
