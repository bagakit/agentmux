import assert from 'node:assert/strict'
import { execFile as callbackExecFile } from 'node:child_process'
import { mkdir, readFile, readdir, rename, realpath, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { app, BrowserWindow, ipcMain } from 'electron'
import { AgentMuxControlServer, AgentMuxFileAgentSessionStore, connectAgentMuxRpc,
  defaultAgentMuxControlSocketPath, loadAgentSessions, startHeadlessAgentMux } from '@agentmux/core'
import { AgentMuxSpatialStateStore, spatialCatalog } from '@agentmux/core/spatial-state'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { RuntimeController } from '../../../src/main/runtime-controller'
import { connectDesktopAgentMuxHost } from '../../../src/main/desktop-host'
import { DesktopControlIpcBridge } from '../../../src/main/control-ipc-bridge'
import { refreshSettingsExecutor } from '../../../src/main/settings-executor-refresh-control'
import { ConfigOwner } from '../../../src/main/config-owner'
import { ScratchTopics } from '../../../src/main/scratch-topics'
import { WorkspaceFiles } from '../../../src/main/workspace-files'
import { FileReadOwner } from '../../../src/main/file-read-owner'
import { observeClientRpcSnapshot } from '../../../src/main/rpc-client-observations'
import { scratchIdentityContext } from '../../../src/main/scratch-topic-directories'
import { retainDirectoryIdentity, moteDirectoryName, SCRATCH_DIRECTORY_IDENTITY_PATH } from '../../../src/main/scratch-directory-identity.mjs'
import { migrateTopicDirectories } from '../../migrate-topic-directories.mjs'
import { assertManualPromptSenderTrusted, senderTrust, assertSenderTrusted } from '../../../src/main/ipc-sender-trust'
import { configWithRuntimeBindings } from '../../../src/main/runtime-config-transaction'
import { sessionSnapshotPayload } from '../../../src/main/session-snapshot-payload'
import { sessionInputWriteResult } from '../../../src/shared/session-input-result'
import { observeWorkbenchStorageAuthority, requireWorkbenchStorageAuthority } from '../../../src/main/workbench-storage-authority'
import { directoryIdentity, homeZoneId } from '../../../src/shared/space-addresses'
import { SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../../../src/shared/scratch-topics'
import type { AppConfig } from '../../../src/shared/contracts'

const execFile = promisify(callbackExecFile), pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const require = createRequire(import.meta.url)
export async function runPublicOwner(input: { html: string; privateRoot: string; phase: string; evidence: string;
  preload: string; node: string; cli: string; handlers: string }): Promise<boolean> {
  const { privateRoot, phase, evidence } = input
  const helperPath = process.env.DIRECTORY_PUBLIC_HELPER; assert.ok(helperPath)
  const id = 'launcher:public-original', scratchPath = join(privateRoot, 'home/.agentmux/scratch')
  const oldPath = join(scratchPath, scratchTopicDirectoryName(id)), shortPath = join(privateRoot, 'home/.agentmux/motes', moteDirectoryName(id))
  const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: scratchPath, name: 'Private Topics', kind: 'folder' as const }
  const expectedNote = '# Original public Note\n', notePath = join(oldPath, 'note.md')
  const configFile = join(privateRoot, 'config.json'), targetFile = join(privateRoot, 'public-target.json')
  let config: AppConfig = phase === 'seed' ? { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private Core' }],
    workspaces: [workspace], executors: { proof: { label: 'Private original native fixture', providerId: 'codex', command: input.node,
      args: [join(privateRoot, 'native-observer.mjs')], env: { AGENTMUX_FAKE_READY_MODE: 'before', DIRECTORY_PUBLIC_ORIGINAL_ALIAS: oldPath }, injectAgentMuxGuide: false } },
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true,
      viewport: true, saveBookmark: true, more: true } } } : JSON.parse(await readFile(configFile, 'utf8'))
  const topics = new ScratchTopics(), store = new AgentMuxFileAgentSessionStore(join(privateRoot, 'state/sessions.json'))
  const spatialState = new AgentMuxSpatialStateStore(join(privateRoot, 'state/spatial.json'))
  const files = new WorkspaceFiles(id => { assert.ok(runtime); return runtime.executionHost(id) })
  const result: any = { schema: 'agentmux.directory.published-public-phase.v1', passed: false, phase, pid: process.pid,
    typedRPC: [], sourceCLI: [], bridgeRequests: [], acceptedResponses: [], calls: [], userRunTouched: false }
  let win: BrowserWindow | undefined, server: AgentMuxControlServer | undefined
  let host: Awaited<ReturnType<typeof startHeadlessAgentMux>> | undefined, runtime: RuntimeController | undefined
  let disposeSpatial: (() => void) | undefined, detachRuntime: (() => void) | undefined
  let observation: Awaited<ReturnType<NonNullable<typeof host>['client']['observeAgentOutput']>> | undefined, output = ''
  let target: any, closed = false
  const attachments = new Set<string>(), pendingIpc = new Set<Promise<any>>()
  const configOwner = new ConfigOwner({ read: () => config, save: async next => { await writeFile(configFile, JSON.stringify(next)); return next }, publish: next => { config = next } })
  const read = async (code: string): Promise<any> => win!.webContents.executeJavaScript(code)
  async function until(readValue: () => Promise<any>, accepted: (value: any) => boolean, label: string): Promise<any> {
    const deadline = Date.now() + 20000; let last: any
    do { last = await readValue(); if (accepted(last)) return last; await pause(30) } while (Date.now() < deadline)
    throw Object.assign(new Error('Original public proof did not confirm ' + label), { observation: last })
  }
  async function runFacts() {
    const status = await host!.client.statusAgent(target.agentSessionId), saved = (await loadAgentSessions(store)).find(one => one.agentSessionId === target.agentSessionId)
    assert.ok(saved); const topic = await topics.read(workspace, id); assert.ok(topic)
    return { hostPid: process.pid, owner: host!.ownerIdentity(), target,
      run: { runId: status.run.runId, pid: status.run.pid, state: status.run.state, workspacePath: status.run.workspacePath,
        acceptedInputBytes: status.run.acceptedInputBytes, latestOutputBytes: status.run.latestOutputBytes },
      saved: { agentSessionId: saved.agentSessionId, workspacePath: saved.workspacePath, run: saved.run },
      mote: { id: topic.id, physicalDirectoryPath: topic.physicalDirectoryPath, identityDirectoryPath: topic.identityDirectoryPath,
        spaceId: directoryIdentity('local', topic.identityDirectoryPath!), zoneId: homeZoneId(directoryIdentity('local', topic.identityDirectoryPath!)) },
      orderedOutput: output }
  }
  async function nativeInput(text: string) {
    const before = await runFacts(), from = output.length
    assert.equal(before.run.state, 'running')
    await read(`window.publicProof.input(${JSON.stringify(target.agentSessionId)},${JSON.stringify(text)})`)
    const values = await until(async () => [...output.slice(from).matchAll(/DIRECTORY_PUBLIC_CWD:(\{[^\r\n]*\})/g)].map(row => JSON.parse(row[1]!)),
      rows => rows.some((row: any) => row.input.includes(text)), 'actual Native input/cwd/old alias')
    const native = values.find((row: any) => row.input.includes(text)), after = await runFacts()
    assert.equal(native.pid, before.run.pid); assert.equal(native.note, expectedNote); assert.equal(native.oldAliasNote, expectedNote)
    assert.deepEqual(native.object, target.object); assert.equal(after.run.runId, before.run.runId); assert.equal(after.run.pid, before.run.pid)
    assert.equal(after.run.workspacePath, oldPath); assert.ok(after.run.acceptedInputBytes !== null && before.run.acceptedInputBytes !== null); assert.ok(after.run.acceptedInputBytes > before.run.acceptedInputBytes)
    return { text, before, native, after }
  }
  async function cli(args: string[]) {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    for (const name of ['AGENTMUX_ENV', 'AGENTMUX_AGENT_SESSION_ID', 'AGENTMUX_AGENT_CAPABILITY', 'AGENTMUX_RUN_ID', 'AGENTMUX_WORKSPACE_ID', 'AGENTMUX_REGION_ID', 'AGENTMUX_TAB_ID', 'AGENTMUX_VIEW_ID']) delete env[name]
    env.AGENTMUX_RPC_ENDPOINT = 'unix:' + server!.path
    const raw = await execFile(input.node, [input.cli, ...args], { env, timeout: 25000, maxBuffer: 1024 * 1024 })
    const value = JSON.parse(raw.stdout); assert.equal(value.ok, true, raw.stdout + raw.stderr)
    result.sourceCLI.push({ args, stdout: raw.stdout, stderr: raw.stderr, value }); return value.result
  }
  async function publicReads() {
    const before = await readFile(notePath), topic = await topics.read(workspace, id); assert.ok(topic)
    const metadataPath = join(topic.physicalDirectoryPath!, SCRATCH_DIRECTORY_IDENTITY_PATH), metadataBefore = await readFile(metadataPath)
    const badPath = join(privateRoot, 'home/.agentmux/motes/0123456789abcdef'), badBefore = await readdir(badPath)
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server!.path } })
    try {
      const snapshot = await rpc.call('app.snapshot', { include: ['motes'] })
      const mote = snapshot.motes?.find(one => one.id === id); assert.ok(mote); assert.ok(snapshot.unavailable.length)
      assert.equal(mote.spaceId, directoryIdentity('local', topic.identityDirectoryPath!)); assert.ok(mote.spaceId)
      const params = { spaceId: mote.spaceId, zoneId: homeZoneId(mote.spaceId), path: 'note.md',
        expectedResource: { hostId: 'local', workspaceId: workspace.id, workspacePath: scratchPath } }
      const file = await rpc.call('file.read', params)
      result.typedRPC.push({ method: 'app.snapshot', params: { include: ['motes'] }, result: snapshot }, { method: 'file.read', params, result: file })
      assert.equal(file.result.status, 'read', JSON.stringify(file))
      if (file.result.status !== 'read') throw Error('Original File read is not confirmed')
      assert.equal(file.result.document.content, expectedNote); assert.match(file.result.document.revision, /^sha256:[a-f0-9]{64}$/)
      assert.equal(file.resource?.zonePath, topic.identityDirectoryPath)
      assert.equal(await realpath(file.resource!.zonePath), topic.physicalDirectoryPath)
      const snapshotCli = await cli(['app', 'snapshot', '--include', 'motes'])
      assert.deepEqual(snapshotCli.motes, snapshot.motes); assert.deepEqual(snapshotCli.unavailable, snapshot.unavailable)
      const fileCli = await cli(['file', 'read', '--space', mote.spaceId, '--zone', params.zoneId, '--path', 'note.md', '--host', 'local', '--workspace', workspace.id, '--workspace-path', scratchPath])
      assert.deepEqual(fileCli, file)
      assert.deepEqual(await readFile(notePath), before)
      assert.deepEqual(await readFile(metadataPath), metadataBefore); assert.deepEqual(await readdir(badPath), badBefore)
      result.readOnlyChecks ??= []; result.readOnlyChecks.push({ metadataPath, metadataBytesPreserved: true, noteBytesPreserved: true, badDirectoryEntries: badBefore })
      return { mote, params, file }
    } finally { await rpc.dispose() }
  }
  try {
    await mkdir(scratchPath, { recursive: true })
    if (phase === 'seed') {
      const seed = await topics.ensure(workspace, id, 'Original private Mote', false)
      await rename(seed.physicalDirectoryPath!, oldPath); await writeFile(join(oldPath, 'SOUL.md'), '# Original private Mote\n')
      await writeFile(notePath, expectedNote)
      await retainDirectoryIdentity(oldPath, { ...await scratchIdentityContext(scratchPath, id), original: oldPath }, { helperPath })
      await mkdir(join(privateRoot, 'home/.agentmux/motes/0123456789abcdef'), { recursive: true })
      await writeFile(configFile, JSON.stringify(config))
    }
    host = await startHeadlessAgentMux({ store, stateDirectory: join(privateRoot, 'state'), socketPath: defaultAgentMuxControlSocketPath() })
    runtime = new RuntimeController(store, connectDesktopAgentMuxHost, topics); runtime.commit(await runtime.prepare(config))
    win = new BrowserWindow({ width: 1040, height: 780, show: false, webPreferences: { preload: input.preload, contextIsolation: true, sandbox: false, backgroundThrottling: false } })
    win.webContents.on('console-message', (_event, _level, message) => process.stdout.write('Renderer ' + message + '\n'))
    win.webContents.on('preload-error', (_event, _file, error) => { result.preloadError = error.message })
    const bridge = new DesktopControlIpcBridge({ isAvailable: () => !closed && !win!.isDestroyed(),
      sendRequest: request => { result.bridgeRequests.push(request); win!.webContents.send('agentmux:control-request', request) },
      sendCancellation: cancellation => win!.webContents.send('agentmux:control-cancel', cancellation) })
    ipcMain.on('control:response', (event, response) => {
      if (!senderTrust('control:response', event.sender, win!.webContents).trusted || !response || typeof response.requestId !== 'string') return
      result.acceptedResponses.push(response); bridge.accept(response)
    })
    const handlers = require(input.handlers)
    const invoke = (channel: string, fn: (...values: any[]) => any, values: any[], event?: any) => {
      result.calls.push({ channel, values })
      const operation = Promise.resolve().then(() => event ? fn(event, ...values) : fn(...values)).then(value => {
        if (channel === 'sessions:attach') attachments.add(value.attachmentId)
        if (channel === 'sessions:detach') attachments.delete(values[0])
        return value
      })
      pendingIpc.add(operation); operation.then(() => pendingIpc.delete(operation), () => pendingIpc.delete(operation)); return operation
    }
    const ports = { handle: (channel: string, fn: (...values: any[]) => any) => ipcMain.handle(channel, (_event, ...values) => invoke(channel, fn, values)),
      handleWithEvent: (channel: string, fn: (...values: any[]) => any) => ipcMain.handle(channel, (event, ...values) => invoke(channel, fn, values, event)),
      args: { runtime, scratchTopics: topics, window: win }, config, configOwner, workspace: (current: AppConfig, wid: string) => { const value = current.workspaces.find(one => one.id === wid); assert.ok(value); return value },
      spatialState, files, FileReadOwner, spatialCatalog, notebookStore: new AgentMuxNotebookStore(), app, sessionSnapshotPayload, configWithRuntimeBindings, refreshSettingsExecutor,
      sessionInputWriteResult, assertManualPromptSenderTrusted, observeWorkbenchStorageAuthority, requireWorkbenchStorageAuthority,
      requireTrustedSender: (channel: any, event: any) => assertSenderTrusted(senderTrust(channel, event.sender, win!.webContents)),
      pauseUserProgress: () => { /* No progress loop is configured in this private proof. */ } }
    const publicFiles = handlers(ports).publicFiles
    ipcMain.handle('config:get', () => config)
    detachRuntime = runtime.attach(win.webContents)
    disposeSpatial = spatialState.subscribe(state => { if (!closed && !win!.isDestroyed()) win!.webContents.send('spatial:changed', state) })
    server = new AgentMuxControlServer({ execute: request => bridge.execute(request), spatialState, files: publicFiles,
      coreClients: () => runtime!.rpcClients(), snapshot: params => observeClientRpcSnapshot(config, topics, params) }, join(privateRoot, 'runtime/control.sock.desktop'))
    await server.start(); await win.loadFile(input.html, { query: { phase } }); win.showInactive()
    await until(() => read('window.publicProof?.facts().ready'), Boolean, 'original App/Store initialize')
    await read(`window.publicProof.openOriginal(${JSON.stringify(id)})`)
    result.preRead = { workbench: await read('window.publicProof.durable()'), core: await spatialState.read() }; const reads = await publicReads(); result.initialPublicReads = reads
    if (phase === 'seed') {
      result.newCreation = await read('window.publicProof.createNew()'); assert.match(result.newCreation.physicalDirectoryPath.split('/').at(-1), /^[a-f0-9]{16}$/)
      await read(`window.publicProof.draft('Original unsent request')`); await read('window.publicProof.save()')
      result.originalDraft = await read('window.publicProof.durable()')
      const metadata = await stat(oldPath, { bigint: true })
      const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
      try {
        assert.ok(reads.mote.spaceId)
        const params = { content: { kind: 'new-agent' as const, executorId: 'proof' }, destination: { spaceId: reads.mote.spaceId, zoneId: reads.params.zoneId, newTab: true }, operationId: 'private:public-open', focus: true }
        const opened = await rpc.call('agent.open', params); result.typedRPC.push({ method: 'agent.open', params, result: opened })
        assert.equal(opened.outcome, 'opened', JSON.stringify(opened)); assert.ok(opened.agent && opened.to)
        target = { agentSessionId: opened.agent.agentSessionId, runId: opened.agent.runId, cwd: oldPath,
          object: { dev: String(metadata.dev), ino: String(metadata.ino) }, to: opened.to }
        await writeFile(targetFile, JSON.stringify(target)); result.opened = opened
        const inspected = await cli(['space', 'inspect', '--operation-id', 'private:public-open']); assert.equal(inspected.request.report.outcome, 'opened')
        assert.equal(inspected.request.report.agent.agentSessionId, target.agentSessionId)
      } finally { await rpc.dispose() }
    } else target = JSON.parse(await readFile(targetFile, 'utf8'))
    observation = await host.client.observeAgentOutput(target.agentSessionId, 0, event => { if (event.type === 'terminal-output' && event.run.runId === target.runId) output += event.data })
    await until(() => host!.client.statusAgent(target.agentSessionId), value => value.run.state === 'running' && Boolean(value.session.nativeHandle) && value.session.semanticStatus?.state === 'done', 'real Native readiness')
    result.inputBefore = await nativeInput('private-input-' + phase)
    if (phase === 'seed') {
      result.maintenance = await migrateTopicDirectories({ scratchRoot: scratchPath, execute: true, motesOnly: true, helperPath,
        nativeOptions: { beforeSwap: async () => { await nativeInput('before-public-swap') }, afterSwap: async () => { await nativeInput('after-public-swap') } } })
      assert.equal(result.maintenance.success, false, 'The intentionally unknown sibling stays unavailable')
      assert.ok(result.maintenance.issues.some((issue: any) => issue.code === 'DIRECTORY_IDENTITY_INVALID' && issue.directoryName === '0123456789abcdef'))
      assert.equal(result.maintenance.objects.find((one: any) => one.id === id)?.state, 'migrated', JSON.stringify(result.maintenance))
      await read('window.publicProof.refresh()'); result.finalPublicReads = await publicReads()
      assert.equal(await realpath(result.finalPublicReads.file.resource.zonePath), shortPath)
      result.inputAfter = await nativeInput('private-input-after-maintenance')
      await read('window.publicProof.save()'); result.beforeRestart = { native: await runFacts(), workbench: await read('window.publicProof.durable()') }
      await writeFile(join(privateRoot, 'public-expected.json'), JSON.stringify(result.beforeRestart))
    } else {
      const expected = JSON.parse(await readFile(join(privateRoot, 'public-expected.json'), 'utf8'))
      const after = { native: await runFacts(), workbench: await read('window.publicProof.durable()') }
      for (const key of ['runId', 'pid', 'workspacePath', 'state'] as const) assert.equal(after.native.run[key], expected.native.run[key])
      assert.deepEqual(after.native.saved, expected.native.saved)
      assert.deepEqual(after.workbench, expected.workbench, 'Original Core topology and serialized Tab/Region/layout/selection/drafts survive another actual Electron PID')
      assert.deepEqual(after.native.mote, expected.native.mote); assert.notEqual(after.native.hostPid, expected.native.hostPid)
      assert.equal(after.native.owner.runtimeId, expected.native.owner.runtimeId); assert.notEqual(after.native.owner.ownerInstanceId, expected.native.owner.ownerInstanceId)
      result.restored = { expected, after }; result.inputAfter = await nativeInput('private-input-after-cold-restore')
      result.finalPublicReads = await publicReads(); await read('window.publicProof.save()')
    }
    result.final = { native: await runFacts(), workbench: await read('window.publicProof.durable()') }
    await writeFile(join(evidence, phase + '.png'), (await win.webContents.capturePage()).toPNG())
    if (phase === 'restore') { await observation.close(); observation = undefined; await host.client.stopAgent(target.agentSessionId, { runId: target.runId }); result.exactPrivateRunStopped = true }
    bridge.dispose(); result.passed = true
  } catch (error) {
    result.error = { message: (error as Error).message, stack: (error as Error).stack, observation: (error as any).observation }
    if (win && !win.isDestroyed()) {
      result.renderer = await read('({body:document.body.innerText,setup:window.publicSetup,facts:window.publicProof?.facts()})').catch(error => ({ error: error.message }))
      await writeFile(join(evidence, phase + '-failure.png'), (await win.webContents.capturePage()).toPNG())
    }
  } finally {
    const errors: string[] = []; closed = true
    if (win && !win.isDestroyed()) {
      await read('window.publicProof?.dispose()').catch(error => errors.push('Private App unmount: ' + error.message))
      await Promise.allSettled([...pendingIpc])
      for (const attachmentId of attachments) try { await runtime!.detachSession(win.webContents.id, attachmentId) }
        catch (error) { errors.push('Original private attachment detach: ' + (error as Error).message) }
      result.privateAttachmentsReleased = attachments.size; attachments.clear()
    }
    for (const action of [() => observation?.close(), () => server?.stop(), () => disposeSpatial?.(), () => detachRuntime?.(), () => runtime?.dispose(), () => host?.stop()]) {
      try { await action() } catch (error) { errors.push((error as Error).message) }
    }
    if (win && !win.isDestroyed()) win.destroy()
    result.cleanupErrors = errors; if (errors.length) result.passed = false
    await writeFile(join(evidence, phase + '.json'), JSON.stringify(result, null, 2)); process.stdout.write(JSON.stringify({ phase, passed: result.passed, error: result.error }) + '\n')
  }
  return result.passed
}
