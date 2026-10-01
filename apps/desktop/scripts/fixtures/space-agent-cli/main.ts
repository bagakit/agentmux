import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { app, BrowserWindow, ipcMain } from 'electron'
import { AgentMuxControlServer, AgentMuxFileAgentSessionStore } from '@agentmux/core'
import { RuntimeController } from '../../../src/main/runtime-controller'
import { DesktopControlIpcBridge } from '../../../src/main/control-ipc-bridge'
import { ConfigOwner } from '../../../src/main/config-owner'
import { WorktreeService } from '../../../src/main/worktree-service'
import { registerWorkspace } from '../../../src/main/settings-workspace-add-control'
import { createSpaceZoneResource } from '../../../src/main/space-zone-resources'
import { ScratchTopics } from '../../../src/main/scratch-topics'
import { observeClientRpcSnapshot } from '../../../src/main/rpc-client-observations'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../../../src/shared/scratch-topics'
import type { AppConfig } from '../../../src/shared/contracts'

const execFile = promisify(execFileCallback)
const [html, privateRoot, phase, preload, evidence, nodeExecutable, cliPath] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
process.env.AGENTMUX_RUNTIME_DIRECTORY = path.join(privateRoot, 'runtime')
process.env.AGENTMUX_STATE_DIRECTORY = path.join(privateRoot, 'runtime', 'state')
process.env.AGENTMUX_MESSAGE_QUEUE_PATH = path.join(privateRoot, 'messages.ndjson')
const initialConfig: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private proof' }],
  executors: { fixture: { label: 'Private fixture', providerId: 'codex', command: nodeExecutable,
    args: [path.join(privateRoot, 'fake-codex-cli.mjs')], env: { AGENTMUX_FAKE_READY_MODE: 'before' }, injectAgentMuxGuide: false } },
  workspaces: [{ id: 'repo', hostId: 'local', name: 'Project', path: path.join(privateRoot, 'repo'), kind: 'folder' },
    { id: 'caller', hostId: 'local', name: 'Caller', path: path.join(privateRoot, 'caller'), kind: 'folder' },
    { id: 'other', hostId: 'local', name: 'Destination', path: path.join(privateRoot, 'other'), kind: 'folder' },
    { id: SCRATCH_WORKSPACE_ID, hostId: 'local', name: 'Topics', path: path.join(privateRoot, 'topics'), kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
let config: AppConfig = phase === 'seed' ? initialConfig : JSON.parse(await fs.readFile(path.join(privateRoot, 'config.json'), 'utf8'))
const store = new AgentMuxFileAgentSessionStore(path.join(privateRoot, 'agent-sessions.json'))
const topics = new ScratchTopics()
const runtime = new RuntimeController(store, topics)
let registrationFault = false
const owner = new ConfigOwner({ read: () => config, save: async next => {
  if (registrationFault) { registrationFault = false; throw new Error('Private registration receipt is unavailable after Git creation') }
  await fs.writeFile(path.join(privateRoot, 'config.json'), JSON.stringify(next)); return next
}, publish: next => { config = next } })
const worktrees = new WorktreeService(id => runtime.executionHost(id), { save: (next, before) => owner.edit(before, next) })
const calls: { operation: string; args: unknown[] }[] = []
const result: Record<string, any> = { schema: 'agentmux.space-agent-cli.phase.v1', passed: false, phase, pid: process.pid, cli: [] }
let win: BrowserWindow
let server: AgentMuxControlServer
let admissionArmed = false
let admissionCutting = false
let emptySnapshot = phase === 'empty-restore'
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const client = () => (runtime as any).hosts.get('local').client
const bridge = new DesktopControlIpcBridge({ isAvailable: () => Boolean(win && !win.isDestroyed()),
  sendRequest: request => win.webContents.send('agentmux:control-request', request),
  sendCancellation: cancellation => win.webContents.send('agentmux:control-cancel', cancellation) })
ipcMain.on('control:response', (_event, response) => bridge.accept(response))
ipcMain.handle('space-proof:request', async (_event, operation, ...args) => {
  calls.push({ operation, args })
  switch (operation) {
    case 'setup': return { phase, config }
    case 'topics': return topics.list(config.workspaces.find(one => one.id === SCRATCH_WORKSPACE_ID)!)
    case 'create-resource': return createSpaceZoneResource(args[0], { config: () => config, topics: () => topics.list(config.workspaces.find(one => one.id === SCRATCH_WORKSPACE_ID)!),
      host: id => runtime.executionHost(id), worktrees, register: fields => registerWorkspace(fields, owner, id => runtime.executionHost(id)) })
    case 'launch': return runtime.launchAgent(args[0], config)
    case 'creation': return runtime.agentCreation(args[0], args[1])
    case 'snapshot': if (emptySnapshot) return { sessions: [], timelines: {}, recoveryCandidates: [] }; return runtime.snapshot(config)
    case 'recover': return runtime.recoverSession(args[0], config, args[1])
    case 'attach': return runtime.attachSession(win.webContents.id, args[0], args[1], config)
    case 'replay': return runtime.readSessionReplay(win.webContents.id, args[0], args[1])
    case 'detach': return runtime.detachSession(win.webContents.id, args[0])
    case 'resize': return runtime.resizeSessionAttachment(win.webContents.id, args[0], args[1], args[2])
    case 'write': return runtime.write(args[0], args[1], args[2])
    case 'paste': return runtime.paste(args[0], args[1], args[2])
    case 'respond': return runtime.respondInteraction(args[0], args[1])
    case 'submit': return runtime.submitPrompt(args[0], args[1], args[2], args[3], undefined, args[4], args[5])
    case 'submit-message': return runtime.submitMessage(args[0], args[1])
    case 'resolve': return runtime.resolveSession(args[0], config)
    case 'refresh': return runtime.refresh(args[0], config)
    case 'stop': throw new Error('No product path in this proof is authorized to stop a healthy Agent')
    case 'flush': {
      win.webContents.session.flushStorageData()
      if (admissionArmed) {
        // The writer can request a fire-and-forget flush before the owning awaited save.
        // Block every armed flush so a second request cannot let placement pass the cut.
        if (admissionCutting) return await new Promise(() => {})
        admissionCutting = true
        const state = await win.webContents.executeJavaScript('window.spaceState()')
        const binding = state.spatialRequests['private:admission-only']
        assert.ok(binding, 'The real admission must precede the private shutdown')
        result.admission = { binding, state }
        await fs.writeFile(path.join(privateRoot, 'admission.json'), JSON.stringify(binding))
        await fs.writeFile(path.join(privateRoot, 'expected.json'), JSON.stringify(durable(state)))
        // Stop the private Electron owner after its real sync localStorage write and before placement.
        // Return a permanently pending IPC promise so the production pipeline cannot continue.
        void finish(true)
        return await new Promise(() => {})
      }
      return
    }
    default: throw new Error(`Unsupported private boundary: ${operation}`)
  }
})

const state = () => win.webContents.executeJavaScript('window.spaceState()')
const durable = (value: any) => ({ tabs: value.tabs, layouts: value.layouts, activeWorkspaceId: value.activeWorkspaceId,
  agentFocus: value.agentFocus, retainedSpatialFocus: value.retainedSpatialFocus, spaceZoneBindings: value.spaceZoneBindings, spatialRequests: value.spatialRequests })
const until = async (expression: string, budget = 15000) => {
  const deadline = Date.now() + budget
  do { const value = await win.webContents.executeJavaScript(expression); if (value) return value; await delay(30) } while (Date.now() < deadline)
  throw new Error(`Private condition did not settle: ${expression}`)
}
async function cli(args: string[], expectedExit = 0) {
  process.stderr.write(`private-cli-start ${args.slice(0, 2).join(' ')} ${args[args.indexOf('--operation-id') + 1] ?? ''}\n`)
  let stdout: string, stderr: string, exitCode = 0
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  // This process is an independent PMO/human CLI, not the parent Agent's managed identity.
  for (const name of ['AGENTMUX_ENV', 'AGENTMUX_AGENT_SESSION_ID', 'AGENTMUX_AGENT_CAPABILITY', 'AGENTMUX_RUN_ID',
    'AGENTMUX_WORKSPACE_ID', 'AGENTMUX_REGION_ID', 'AGENTMUX_TAB_ID', 'AGENTMUX_VIEW_ID']) delete env[name]
  env.AGENTMUX_AGENT_SESSION_STORE = path.join(privateRoot, 'agent-sessions.json')
  try { const value = await execFile(nodeExecutable, [cliPath, ...args], { env, timeout: 25000, maxBuffer: 1024 * 1024 }); stdout = value.stdout; stderr = value.stderr }
  catch (error: any) { stdout = error.stdout; stderr = error.stderr; exitCode = typeof error.code === 'number' ? error.code : -1 }
  assert.ok(stdout.trim(), `${args.join(' ')}: no success receipt; exit=${exitCode}\n${stderr}`)
  const lines = stdout.trim().split('\n')
  assert.equal(lines.length, 1, 'CLI returns one final JSON object')
  const receipt = JSON.parse(lines[0])
  result.cli.push({ args, exitCode, receipt, stderr })
  process.stderr.write(`private-cli-end ${args.slice(0, 2).join(' ')} exit=${exitCode}\n`)
  assert.equal(exitCode, expectedExit, `${args.join(' ')}: ${stdout}\n${stderr}`)
  assert.equal(receipt.ok, true)
  return receipt.result
}
let finishing = false
async function finish(passed: boolean) {
  if (finishing) return
  finishing = true
  result.calls = calls
  result.passed = passed
  if (win && !win.isDestroyed()) result.final = await state().catch(() => null)
  result.persisted = (await store.load()).map(one => ({ agentSessionId: one.agentSessionId, run: one.run,
    nativeHandle: one.nativeHandle, workspacePath: one.workspacePath, creation: one.creation }))
  await fs.writeFile(path.join(evidence, `${phase}.json`), JSON.stringify(result, null, 2))
  bridge.dispose()
  // Server.stop waits for this deliberately abandoned request; app exit owns its private socket.
  if (!result.admission) await server?.stop().catch(error => { result.cleanupFailure = String(error); result.passed = false })
  await runtime.dispose().catch(error => { result.cleanupFailure = String(error); result.passed = false })
  await fs.writeFile(path.join(evidence, `${phase}.json`), JSON.stringify(result, null, 2))
  if (win && !win.isDestroyed()) win.destroy()
  app.exit(result.passed ? 0 : 1)
}
app.whenReady().then(async () => {
  try {
    if (phase === 'seed') {
      await fs.writeFile(path.join(privateRoot, 'config.json'), JSON.stringify(config))
      await topics.ensure(config.workspaces.find(one => one.id === SCRATCH_WORKSPACE_ID)!, 'view:private-topic', 'Private Topic')
      await topics.ensureMote(config.workspaces.find(one => one.id === SCRATCH_WORKSPACE_ID)!, PMO_TEAMS_TOPIC_ID)
    }
    runtime.commit(await runtime.prepare(config))
    win = new BrowserWindow({ width: 1250, height: 880, show: false,
      webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, preload } })
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) process.stderr.write(`Renderer: ${message}\n`) })
    runtime.attach(win.webContents)
    await win.loadFile(html)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await until('window.spaceReady === true && !window.spaceState().loading')
    if (phase === 'seed') await win.webContents.executeJavaScript('window.spaceSelectCaller()')
    server = new AgentMuxControlServer({ execute: request => bridge.execute(request), coreClients: () => runtime.rpcClients(),
      snapshot: params => observeClientRpcSnapshot(config, topics, params) })
    await server.start()
    result.initial = await state()
    // Keep the deliberate startup outage active until its visible state is observed.
    // Runtime events can otherwise request a second canonical snapshot before this read.
    emptySnapshot = false
    const discovered = await cli(['space', 'ls'])
    const catalog = discovered.catalog
    const repo = catalog.spaces.find((one: any) => one.directoryPath === path.join(privateRoot, 'repo'))
    const caller = catalog.zones.find((one: any) => one.directoryPath === path.join(privateRoot, 'caller'))
    const other = catalog.zones.find((one: any) => one.directoryPath === path.join(privateRoot, 'other'))
    const mote = catalog.spaces.find((one: any) => one.kind === 'mote')
    assert.ok(repo && caller && other && mote)
    const moteHome = catalog.zones.filter((one: any) => one.kind === 'home' && one.directoryPath === mote.directoryPath)
    assert.equal(moteHome.length, 1, 'Choose the actual Mote Home Zone before adding other execution Zones')
    const resources = await cli(['app', 'snapshot', '--include', 'projects,workspaces,motes'])
    assert.ok(resources.workspaces.some((one: any) => one.workspaceId === 'repo'))
    const observedMote = resources.motes.find((one: any) => one.topicId === PMO_TEAMS_TOPIC_ID)
    assert.ok(observedMote?.soul?.content, 'Mote metadata comes from its actual private SOUL file')
    assert.equal(observedMote.spaceId, mote.spaceId)
    const project = resources.projects.find((one: any) => one.path === path.join(privateRoot, 'repo'))
    assert.ok(project?.projectId, 'Project resource is discovered independently of Space')
    assert.equal((await state()).activeWorkspaceId, result.initial.activeWorkspaceId, 'Metadata discovery does not navigate')
    if (phase === 'seed') {
      const opened = await cli(['agent', 'open', '--executor', 'fixture', '--space', mote.spaceId, '--project', project.projectId,
        '--new-zone', '--worktree', '--new-branch', 'private-cli', '--path', path.join(privateRoot, 'worktree'),
        '--prompt', 'First private task', '--operation-id', 'private:git-open'])
      assert.equal(opened.outcome, 'opened'); assert.equal(opened.agent.initialPrompt, 'confirmed')
      assert.equal(opened.agent.cwd, path.join(privateRoot, 'worktree'))
      assert.equal(opened.resource.projectId, project.projectId)
      assert.equal(opened.resource.sourceWorkspaceId, 'repo')
      assert.equal(opened.to.spaceId, mote.spaceId)
      assert.notEqual(project.projectId, mote.spaceId, 'Execution Project and display Space are different identities')
      assert.equal(opened.save.diskDurability, 'unconfirmed')
      assert.equal(opened.save.localStorageWritten, true)
      assert.equal(opened.to.zoneId, (await cli(['space', 'inspect', '--operation-id', 'private:git-open'])).request.report.to.zoneId)
      const count = calls.filter(one => one.operation === 'launch').length
      const repeated = await cli(['agent', 'open', '--executor', 'fixture', '--space', mote.spaceId, '--project', project.projectId,
        '--new-zone', '--worktree', '--new-branch', 'private-cli', '--path', path.join(privateRoot, 'worktree'),
        '--prompt', 'First private task', '--operation-id', 'private:git-open'])
      assert.equal(repeated.agent.agentSessionId, opened.agent.agentSessionId)
      assert.equal(calls.filter(one => one.operation === 'launch').length, count)
      assert.equal(calls.filter(one => one.operation === 'create-resource').length, 1)
      const topic = catalog.spaces.find((one: any) => one.kind === 'topic')
      const topicOpened = await cli(['agent', 'open', '--executor', 'fixture', '--space', topic.spaceId, '--prompt', 'Topic task', '--operation-id', 'private:topic-open'])
      const moteOpened = await cli(['agent', 'open', '--executor', 'fixture', '--space', mote.spaceId, '--zone', moteHome[0].zoneId, '--prompt', 'Mote task', '--focus', '--operation-id', 'private:mote-open'])
      assert.equal(topicOpened.agent.cwd, await fs.realpath(topic.directoryPath))
      assert.equal(moteOpened.agent.cwd, await fs.realpath(mote.directoryPath))
      assert.equal((await state()).activeWorkspaceId, SCRATCH_WORKSPACE_ID)
      assert.equal((await state()).agentFocus.pmo.sessionId, moteOpened.agent.agentSessionId)
      const moteDisplayGroup = (await state()).layouts[SCRATCH_WORKSPACE_ID].activeGroupId
      const directoryOpened = await cli(['agent', 'open', '--executor', 'fixture', '--space', mote.spaceId, '--project', project.projectId,
        '--display-workspace', SCRATCH_WORKSPACE_ID, '--group', moteDisplayGroup,
        '--new-zone', '--directory', path.join(privateRoot, 'directory'), '--prompt', 'Directory task', '--operation-id', 'private:directory-open'])
      assert.equal(directoryOpened.to.displayWorkspaceId, SCRATCH_WORKSPACE_ID)
      assert.equal(directoryOpened.to.groupId, moteDisplayGroup)
      assert.equal(directoryOpened.to.workspaceId, directoryOpened.resource.workspaceId)
      const callerGroup = (await state()).layouts.caller.activeGroupId
      await cli(['space', 'bind', '--tab', directoryOpened.to.tabId, '--display-workspace', 'caller', '--group', callerGroup,
        '--operation-id', 'private:directory-second-display'])
      const directoryReadback = await cli(['space', 'inspect', '--operation-id', 'private:directory-open'])
      assert.equal(directoryReadback.request.report.outcome, 'opened')
      assert.deepEqual(directoryReadback.request.report.to, directoryOpened.to)
      result.exactDisplayReadback = { initial: directoryOpened.to, secondDisplayWorkspaceId: 'caller', readback: directoryReadback.request.report.to }
      assert.equal(directoryOpened.agent.cwd, path.join(privateRoot, 'directory'))
      assert.equal(directoryOpened.resource.kind, 'directory')
      const ambiguous = await cli(['agent', 'open', '--executor', 'fixture', '--space', mote.spaceId, '--operation-id', 'private:ambiguous'], 1)
      assert.ok(ambiguous.issues[0].candidates.length > 1, 'Actual multiple Zone candidates stay explicit')
      const first = await cli(['agent', 'open', '--session', opened.agent.agentSessionId, '--zone', caller.zoneId, '--new-tab', '--focus', '--operation-id', 'private:projection'])
      await until(`window.spaceNativeReady(${JSON.stringify(first.to.regionId)}, ${JSON.stringify(opened.agent.agentSessionId)}, ${JSON.stringify(opened.agent.runId)})`)
      await until(`document.activeElement?.closest('[data-workbench-region-id]')?.dataset.workbenchRegionId === ${JSON.stringify(first.to.regionId)}`)
      result.beforeBackgroundSplit = await state()
      const second = await cli(['agent', 'open', '--session', topicOpened.agent.agentSessionId, '--region', first.to.regionId, '--split', 'right', '--operation-id', 'private:second'])
      await until(`window.spaceNativeReady(${JSON.stringify(second.to.regionId)}, ${JSON.stringify(topicOpened.agent.agentSessionId)}, ${JSON.stringify(topicOpened.agent.runId)})`)
      await until(`window.spaceNativeReady(${JSON.stringify(first.to.regionId)}, ${JSON.stringify(opened.agent.agentSessionId)}, ${JSON.stringify(opened.agent.runId)})`)
      await until(`document.activeElement?.closest('[data-workbench-region-id]')?.dataset.workbenchRegionId === ${JSON.stringify(first.to.regionId)}`)
      assert.equal(await win.webContents.executeJavaScript("document.activeElement?.closest('[data-workbench-region-id]')?.dataset.workbenchRegionId"), first.to.regionId, 'Background split does not move the caret to B')
      const third = await cli(['agent', 'open', '--session', moteOpened.agent.agentSessionId, '--region', second.to.regionId, '--split', 'below', '--operation-id', 'private:third'])
      await until(`window.spaceNativeReady(${JSON.stringify(third.to.regionId)}, ${JSON.stringify(moteOpened.agent.agentSessionId)}, ${JSON.stringify(moteOpened.agent.runId)})`)
      await until(`window.spaceNativeReady(${JSON.stringify(first.to.regionId)}, ${JSON.stringify(opened.agent.agentSessionId)}, ${JSON.stringify(opened.agent.runId)})`)
      await until(`document.activeElement?.closest('[data-workbench-region-id]')?.dataset.workbenchRegionId === ${JSON.stringify(first.to.regionId)}`)
      assert.equal(await win.webContents.executeJavaScript("document.activeElement?.closest('[data-workbench-region-id]')?.dataset.workbenchRegionId"), first.to.regionId, 'Background split does not move the caret to C')
      const beforeSplitInput = (await client().readRunReplay({ runId: opened.agent.runId })).run.latestOutputBytes
      const beforeSplitCalls = calls.length
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: 'v' })
      let splitReplay: any
      const splitDeadline = Date.now() + 15000
      do { splitReplay = await client().readRunReplay({ runId: opened.agent.runId }, beforeSplitInput)
        if (splitReplay.replay.map((chunk: any) => Buffer.from(chunk.dataBytes).toString('utf8')).join('').includes('codex-composer-rendered:1\u001b[')) break
        await delay(30)
      } while (Date.now() < splitDeadline)
      const splitOutput = splitReplay.replay.map((chunk: any) => Buffer.from(chunk.dataBytes).toString('utf8')).join('')
      assert.ok(splitOutput.includes('v') && splitOutput.includes('codex-composer-rendered:1\u001b['))
      const splitWrites = calls.slice(beforeSplitCalls).filter(one => one.operation === 'write' && one.args[1] === 'v' && one.args[2] === 'user')
      assert.equal(splitWrites.length, 1)
      assert.deepEqual(splitWrites[0]!.args[0], { kind: 'agent', hostId: 'local', agentSessionId: opened.agent.agentSessionId, run: { runId: opened.agent.runId } })
      result.backgroundSplitInput = { caretRegionId: first.to.regionId, exactWrite: splitWrites[0], rawNewOutput: splitOutput }
      result.afterBackgroundSplit = await state()
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' })
      const submittedDeadline = Date.now() + 15000
      let submittedOutput = ''
      do { submittedOutput = (await client().readRunReplay({ runId: opened.agent.runId }, beforeSplitInput)).replay.map((chunk: any) => Buffer.from(chunk.dataBytes).toString('utf8')).join('')
        if (submittedOutput.includes('codex-submit:v:accepted')) break
        await delay(30)
      } while (Date.now() < submittedDeadline)
      assert.ok(submittedOutput.includes('codex-submit:v:accepted'))
      await win.webContents.executeJavaScript(`window.spaceFocus(${JSON.stringify(first.to)}); true`)
      await until(`window.spaceState().focusedSessionId === ${JSON.stringify(opened.agent.agentSessionId)}`)
      const before = await state()
      const moved = await cli(['space', 'mv', '--from-region', first.to.regionId, '--expect-session', opened.agent.agentSessionId,
        '--zone', other.zoneId, '--new-tab', '--operation-id', 'private:move'])
      assert.equal(moved.outcome, 'moved'); assert.equal(moved.to.regionId, first.to.regionId)
      assert.equal(moved.agent.cwd, opened.agent.cwd)
      await until('window.spaceState().neutralNotice !== null')
      const held = await state()
      assert.equal(held.activeWorkspaceId, before.activeWorkspaceId)
      assert.deepEqual(held.agentFocus, before.agentFocus)
      assert.equal(held.retainedSpatialFocus.regionId, first.to.regionId)
      assert.equal(held.focusedSessionId, null)
      const commands = await win.webContents.executeJavaScript('window.spaceCommands()')
      assert.deepEqual(commands.results, [false, false]); assert.deepEqual(commands.before, commands.after)
      const regions = (await cli(['space', 'ls'])).catalog.regions.filter((one: any) => one.agentSessionId === opened.agent.agentSessionId)
      assert.equal(regions.length, 2, 'The other projection is retained exactly')
      const siblings = [second, third]
      result.survivingSourceRegions = []
      for (const sibling of siblings) {
        await until(`window.spaceNativeReady(${JSON.stringify(sibling.to.regionId)}, ${JSON.stringify(sibling.agent.agentSessionId)}, ${JSON.stringify(sibling.agent.runId)})`)
        // Topic/Mote preparation adds its authentic guide before the first task. The
        // native ready prefix is therefore not adjacent to the short requested prompt.
        // Check a readable frame against this exact original Run's real bytes instead.
        const expectedBody = 'The user request follows.'
        const nativeBody = await client().readRunReplay({ runId: sibling.agent.runId })
        assert.ok(nativeBody.replay.map((chunk: any) => Buffer.from(chunk.dataBytes).toString('utf8')).join('').includes(expectedBody))
        await until(`window.spaceRegionObservation(${JSON.stringify(sibling.to.regionId)}).viewportText.includes(${JSON.stringify(expectedBody)})`)
        const observation = await win.webContents.executeJavaScript(`window.spaceRegionObservation(${JSON.stringify(sibling.to.regionId)})`)
        assert.equal(observation.visible, true); assert.equal(observation.focused, false)
        assert.ok(!siblings.some(one => one.to.regionId === observation.caretRegionId))
        result.survivingSourceRegions.push({ ...observation, agentSessionId: sibling.agent.agentSessionId, runId: sibling.agent.runId })
      }
      const beforeBackgroundInput = calls.length
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: 'q' })
      await delay(150)
      result.backgroundNativeInput = { dispatched: 'q', observedUserWrites: calls.slice(beforeBackgroundInput).filter(one => one.operation === 'write' && one.args[1] === 'q' && one.args[2] === 'user') }
      assert.deepEqual(result.backgroundNativeInput.observedUserWrites, [], 'No replacement Region receives the next character')
      await fs.writeFile(path.join(evidence, 'background-move-source.png'), (await win.capturePage()).toPNG())
      await until(`window.spaceState().sessions.filter(one=>one.kind==='agent').length === 4`)
      const nativeDeadline = Date.now() + 15000
      while ((await store.load()).some(one => !one.nativeHandle) && Date.now() < nativeDeadline) await delay(30)
      assert.equal((await store.load()).filter(one => Boolean(one.nativeHandle)).length, 4)
      const beforeFollowup = (await client().readRunReplay({ runId: opened.agent.runId })).run
      const beforeFollowupCalls = calls.length
      const send = await cli(['agent', 'send', '--to-session', opened.agent.agentSessionId, '--text', 'Private follow-up task', '--message-id', 'private-followup'])
      assert.equal(send.agentSessionId, opened.agent.agentSessionId)
      assert.equal(send.delivery.state, 'delivered')
      const expectedPrompt = '[Message from unverified local process]\nPrivate follow-up task'
      const expectedFrame = `codex-submit:${expectedPrompt}:accepted\n`
      const followupDeadline = Date.now() + 15000
      let followup: any
      do { followup = await client().readRunReplay({ runId: opened.agent.runId }, beforeFollowup.latestOutputBytes);
        if (followup.replay.map((chunk: any) => Buffer.from(chunk.dataBytes).toString('utf8')).join('').replaceAll('\r\n', '\n').includes(expectedFrame)) break
        await delay(30)
      } while (Date.now() < followupDeadline)
      const output = followup.replay.map((chunk: any) => Buffer.from(chunk.dataBytes).toString('utf8')).join('').replaceAll('\r\n', '\n')
      assert.equal(output.split(expectedFrame).length - 1, 1, 'Exactly one fresh accepted task frame')
      assert.equal(followup.run.runId, opened.agent.runId)
      const submitted = calls.slice(beforeFollowupCalls).filter(one => one.operation === 'submit-message')
      assert.equal(submitted.length, 1)
      assert.deepEqual(submitted[0]!.args[0], { kind: 'agent', hostId: 'local', agentSessionId: opened.agent.agentSessionId, run: { runId: opened.agent.runId } })
      const submittedMessage = submitted[0]!.args[1] as any
      assert.equal(submittedMessage.envelope.messageId, 'private-followup')
      assert.equal(submittedMessage.envelope.body, 'Private follow-up task')
      assert.equal(submittedMessage.envelope.recipientSessionId, opened.agent.agentSessionId)
      assert.equal(submittedMessage.envelope.recipientRunId, opened.agent.runId)
      assert.deepEqual(submittedMessage.condition.expectedRun, { runId: opened.agent.runId })
      assert.equal(calls.slice(beforeFollowupCalls).filter(one => one.operation === 'submit').length, 0, 'Public messaging must use the authenticated Runtime entry')
      result.publicSend = { agentSessionId: opened.agent.agentSessionId, runId: opened.agent.runId, send,
        beforeOutput: beforeFollowup.latestOutputBytes, rawNewOutput: output, exactSubmit: submitted[0],
        acceptedInputBytes: followup.run.acceptedInputBytes, observedExactBodyInRawReplay: true }
      registrationFault = true
      const retained = await cli(['agent', 'open', '--executor', 'fixture', '--space', mote.spaceId, '--project', project.projectId, '--new-zone', '--worktree',
        '--new-branch', 'private-retained', '--path', path.join(privateRoot, 'retained-worktree'), '--operation-id', 'private:retained-resource'], 1)
      assert.equal(retained.outcome, 'partial'); assert.equal(retained.agent, null); assert.equal(retained.resource.workspaceId, null)
      assert.equal((await fs.stat(path.join(privateRoot, 'retained-worktree'))).isDirectory(), true)
      const resourceCalls = calls.filter(one => one.operation === 'create-resource').length
      await cli(['space', 'inspect', '--operation-id', 'private:retained-resource'], 1)
      assert.equal(calls.filter(one => one.operation === 'create-resource').length, resourceCalls)
      result.resourceRetained = retained
      // Move the first (selected by the existing navigation policy) projection into a Topic Tab
      // that already contains a healthy sibling. The other projection stays independently placed.
      const primaryMoved = await cli(['space', 'mv', '--from-region', opened.to.regionId, '--expect-session', opened.agent.agentSessionId,
        '--region', topicOpened.to.regionId, '--split', 'right', '--operation-id', 'private:primary-topic-move'])
      assert.equal(primaryMoved.outcome, 'moved')
      assert.equal(primaryMoved.to.workspaceId, SCRATCH_WORKSPACE_ID)
      assert.equal(primaryMoved.to.tabId, topicOpened.to.tabId)
      assert.equal(primaryMoved.agent.cwd, opened.agent.cwd)
      await win.webContents.executeJavaScript('window.spaceFlush()')
      await fs.writeFile(path.join(privateRoot, 'expected.json'), JSON.stringify(durable(await state())))
      await fs.writeFile(path.join(privateRoot, 'ids.json'), JSON.stringify({ opened, moved, primaryMoved, caller, other, first, second, directoryOpened }))
      result.backgroundCommands = commands
      result.created = { opened, topicOpened, moteOpened, directoryOpened, moved }
    } else {
      const expected = JSON.parse(await fs.readFile(path.join(privateRoot, 'expected.json'), 'utf8'))
      const ids = JSON.parse(await fs.readFile(path.join(privateRoot, 'ids.json'), 'utf8'))
      const restored = durable(result.initial)
      const addedLayoutIds = Object.keys(restored.layouts).filter(id => !Object.hasOwn(expected.layouts, id))
      for (const id of addedLayoutIds) {
        assert.equal(id, ids.directoryOpened.resource.workspaceId, 'Only the newly registered resource may initialize an empty layout')
        const layout = restored.layouts[id]
        assert.equal(layout.groups.length, 1)
        assert.deepEqual(layout.root, { type: 'leaf', groupId: layout.activeGroupId })
        assert.deepEqual(layout.groups[0], { id: layout.activeGroupId, tabOrder: [], activeTabId: null, recentTabIds: [] })
      }
      result.initializedEmptyResourceLayouts = Object.fromEntries(addedLayoutIds.map(id => [id, restored.layouts[id]]))
      assert.deepEqual({ ...restored, layouts: Object.fromEntries(Object.keys(expected.layouts).map(id => [id, restored.layouts[id]])) },
        expected, 'The actual private process restart retains every original durable Space/Zone/Tab/Region/focus exactly')
      assert.equal(calls.filter(one => one.operation === 'launch').length, 0, 'Restart does not create another Agent')
      assert.equal(calls.some(one => one.operation === 'stop'), false)
      if (phase === 'empty-restore') {
        assert.ok(result.initial.error?.includes('no Session facts'))
        assert.equal(Object.keys(result.initial.tabs).length, Object.keys(expected.tabs).length)
        assert.equal(result.initial.focusedSessionId, null)
        result.emptySnapshotRetained = true
      } else {
        await until('window.spaceState().neutralNotice !== null')
        const commands = await win.webContents.executeJavaScript('window.spaceCommands()')
        assert.deepEqual(commands.results, [false, false]); assert.deepEqual(commands.before, commands.after)
        result.restoredCommands = commands
      }
      const directoryRestored = await cli(['space', 'inspect', '--operation-id', 'private:directory-open'])
      assert.equal(directoryRestored.request.report.outcome, 'opened')
      assert.deepEqual(directoryRestored.request.report.to, ids.directoryOpened.to)
      result.exactDisplayRestored = directoryRestored.request.report.to
      const inspected = await cli(['space', 'inspect', '--operation-id', 'private:git-open'], 1)
      assert.equal(inspected.request.report.agent.agentSessionId, ids.opened.agent.agentSessionId)
      assert.equal(inspected.request.report.agent.cwd, ids.opened.agent.cwd)
      assert.equal(inspected.request.report.outcome, 'unknown', 'The intentionally moved original projection no longer confirms its former placement')
      const projection = await cli(['space', 'inspect', '--operation-id', 'private:projection'], 1)
      assert.equal(projection.request.report.outcome, 'unknown', 'A later intentional projection move does not pretend its old placement still exists')
      if (phase === 'restore') {
        const beforeNavigation = await state()
        const beforeNavigationCalls = calls.length
        await win.webContents.executeJavaScript(`window.spaceObserveSession(${JSON.stringify(ids.opened.agent.agentSessionId)})`)
        await until("document.querySelector('[data-space-proof-observation] button')?.textContent.includes('Open Session')")
        await win.webContents.executeJavaScript("document.querySelector('[data-space-proof-observation] button').click(); true")
        await until(`window.spaceState().activeWorkspaceId === ${JSON.stringify(ids.primaryMoved.to.workspaceId)} && window.spaceState().focusedSessionId === ${JSON.stringify(ids.opened.agent.agentSessionId)}`)
        await win.webContents.executeJavaScript('window.spaceCloseObservation(); true')
        await until(`window.spaceNativeReady(${JSON.stringify(ids.primaryMoved.to.regionId)}, ${JSON.stringify(ids.opened.agent.agentSessionId)}, ${JSON.stringify(ids.opened.agent.runId)})`)
        const afterNavigation = await state()
        const placementGraph = (value: any) => Object.entries(value.layouts).flatMap(([workspaceId, layout]: any) =>
          layout.groups.flatMap((group: any) => group.tabOrder.map((tabId: string) => ({ workspaceId, groupId: group.id, tabId }))))
        assert.deepEqual(placementGraph(afterNavigation), placementGraph(beforeNavigation))
        const placements = placementGraph(afterNavigation)
        assert.ok(placements.length > 0)
        assert.equal(new Set(placements.map((one: any) => JSON.stringify([one.workspaceId, one.groupId, one.tabId]))).size, placements.length, 'Every durable Tab occurrence has one exact display Workspace and Group address')
        assert.equal(placements.filter((one: any) => one.tabId === ids.directoryOpened.to.tabId).length, 2, 'Both references to the same Tab survive restart and navigation')
        for (const [tabId, beforeTab] of Object.entries(beforeNavigation.tabs) as any) {
          const afterTab = afterNavigation.tabs[tabId]
          assert.equal(afterTab.workspaceId, beforeTab.workspaceId)
          assert.equal(afterTab.topicId, beforeTab.topicId)
          assert.deepEqual(afterTab.space, beforeTab.space)
          assert.deepEqual(afterTab.regions, beforeTab.regions)
          assert.deepEqual(afterTab.layout.root, beforeTab.layout.root)
          if (tabId !== ids.primaryMoved.to.tabId) assert.deepEqual(afterTab, beforeTab)
        }
        assert.equal(afterNavigation.tabs[ids.primaryMoved.to.tabId].layout.activeRegionId, ids.primaryMoved.to.regionId)
        assert.equal(afterNavigation.regionCaretFocus, null, 'Low-level Open Session preserves its existing no-caret-intent contract')
        assert.equal(calls.slice(beforeNavigationCalls).some(one => one.operation === 'launch' || one.operation === 'stop'), false)
        result.restartProjectionNavigation = { before: durable(beforeNavigation), after: durable(afterNavigation),
          target: ids.primaryMoved.to, placements, observedProductionConsumer: 'SessionObservationRegions Open Session',
          agentSessionId: ids.opened.agent.agentSessionId, runId: ids.opened.agent.runId, cwd: ids.opened.agent.cwd }
        await fs.writeFile(path.join(evidence, 'restored-open-session.png'), (await win.capturePage()).toPNG())
        const focused = await cli(['space', 'mv', '--from-region', ids.moved.to.regionId, '--expect-session', ids.opened.agent.agentSessionId,
          '--region', ids.moved.to.regionId, '--focus', '--operation-id', 'private:focus-target'])
        assert.equal(focused.outcome, 'unchanged')
        assert.equal((await state()).activeWorkspaceId, ids.moved.to.workspaceId)
        await until(`window.spaceState().focusedSessionId === ${JSON.stringify(ids.opened.agent.agentSessionId)} && window.spaceState().terminalCount > 0`)
        await until(`window.spaceNativeReady(${JSON.stringify(ids.moved.to.regionId)}, ${JSON.stringify(ids.opened.agent.agentSessionId)}, ${JSON.stringify(ids.opened.agent.runId)})`)
        assert.equal((await state()).retainedSpatialFocus, null)
        const beforeRun = (await client().readRunReplay({ runId: ids.opened.agent.runId })).run
        const beforeInput = beforeRun.acceptedInputBytes
        const beforeOutput = beforeRun.latestOutputBytes
        const beforeCalls = calls.length
        await until(`document.activeElement?.closest('[data-workbench-region-id]')?.dataset.workbenchRegionId === ${JSON.stringify(ids.moved.to.regionId)}`)
        const caretRegionId = await win.webContents.executeJavaScript("document.activeElement.closest('[data-workbench-region-id]').dataset.workbenchRegionId")
        await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: 'z' })
        const inputDeadline = Date.now() + 15000
        let observedInput: any
        do { observedInput = await client().readRunReplay({ runId: ids.opened.agent.runId }, beforeOutput)
          if (observedInput.run.acceptedInputBytes > beforeInput && observedInput.replay.map((chunk: any) => Buffer.from(chunk.dataBytes).toString('utf8')).join('').includes('codex-composer-rendered:1\u001b[')) break
          await delay(30)
        } while (Date.now() < inputDeadline)
        assert.ok(observedInput.run.acceptedInputBytes > beforeInput)
        const rawNewOutput = observedInput.replay.map((chunk: any) => Buffer.from(chunk.dataBytes).toString('utf8')).join('')
        assert.ok(rawNewOutput.includes('codex-composer-rendered:1\u001b[') && rawNewOutput.includes('z'))
        const exactWrite = calls.slice(beforeCalls).find(one => one.operation === 'write' &&
          (one.args[0] as any)?.agentSessionId === ids.opened.agent.agentSessionId &&
          (one.args[0] as any)?.run.runId === ids.opened.agent.runId && one.args[1] === 'z' && one.args[2] === 'user')
        assert.ok(exactWrite)
        result.freshNativeInput = { agentSessionId: ids.opened.agent.agentSessionId, runId: ids.opened.agent.runId,
          caretRegionId, before: beforeInput, after: observedInput.run.acceptedInputBytes, beforeOutput, rawNewOutput, exactWrite, observedComposerOutput: true }
        await fs.writeFile(path.join(evidence, 'explicit-target-focus.png'), (await win.capturePage()).toPNG())
        // Return to a held logical source using another exact background move through the public CLI.
        const moved = await cli(['space', 'mv', '--from-region', ids.moved.to.regionId, '--expect-session', ids.opened.agent.agentSessionId,
          '--zone', ids.caller.zoneId, '--new-tab', '--operation-id', 'private:move-again'])
        assert.equal((await state()).retainedSpatialFocus.regionId, ids.first.to.regionId)
        ids.moved = moved
        await win.webContents.executeJavaScript('window.spaceFlush()')
        await fs.writeFile(path.join(privateRoot, 'expected.json'), JSON.stringify(durable(await state())))
        await fs.writeFile(path.join(privateRoot, 'ids.json'), JSON.stringify(ids))
      } else if (phase === 'admission') {
        admissionArmed = true
        // The private owner intentionally exits from the FIRST admission save before this CLI returns.
        void cli(['space', 'mv', '--from-region', ids.moved.to.regionId, '--expect-session', ids.opened.agent.agentSessionId,
          '--zone', ids.other.zoneId, '--new-tab', '--operation-id', 'private:admission-only']).catch(() => {})
        return
      } else if (phase === 'after-admission') {
        const interrupted = await cli(['space', 'inspect', '--operation-id', 'private:admission-only'], 1)
        assert.equal(interrupted.request.report.outcome, 'unknown')
        assert.equal(interrupted.request.report.to.tabId, ids.moved.to.tabId, 'The exact Region remains at its real source')
        assert.equal(interrupted.request.report.issues[0].code, 'SPACE_PLACEMENT_UNKNOWN')
        const before = durable(await state())
        const replay = await cli(['space', 'mv', '--from-region', ids.moved.to.regionId, '--expect-session', ids.opened.agent.agentSessionId,
          '--zone', ids.other.zoneId, '--new-tab', '--operation-id', 'private:admission-only'], 1)
        assert.equal(replay.outcome, 'unknown')
        assert.deepEqual(durable(await state()), before)
        result.admissionOnlyReconciled = interrupted
      }
      await win.webContents.executeJavaScript('window.spaceFlush()')
    }
    result.runs = (await client().listRuns()).filter((one: any) => one.state === 'running').map((one: any) => ({ runId: one.runId, pid: one.pid }))
    await finish(true)
  } catch (error: any) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) await fs.writeFile(path.join(evidence, `${phase}-failure.png`), (await win.capturePage()).toPNG())
    await finish(false)
  }
})
