import assert from 'node:assert/strict'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxFileAgentSessionStore, defaultAgentMuxControlSocketPath, loadAgentSessions, mintAgentSessionId, startHeadlessAgentMux } from '@agentmux/core'
import { RuntimeController } from '../../../src/main/runtime-controller'
import { connectDesktopAgentMuxHost } from '../../../src/main/desktop-host'
import { ScratchTopics } from '../../../src/main/scratch-topics'
import { scratchIdentityContext } from '../../../src/main/scratch-topic-directories'
import { retainDirectoryIdentity, moteDirectoryName } from '../../../src/main/scratch-directory-identity.mjs'
import { directoryIdentity, homeZoneId } from '../../../src/shared/space-addresses'
import { SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../../../src/shared/scratch-topics'
import { migrateTopicDirectories } from '../../migrate-topic-directories.mjs'
import type { AppConfig, SessionControl } from '../../../src/shared/contracts'

const privateRoot = process.env.DIRECTORY_RUNTIME_PRIVATE_ROOT!, phase = process.env.DIRECTORY_RUNTIME_PHASE!
const helperPath = process.env.DIRECTORY_RUNTIME_HELPER!, nativeCli = process.env.DIRECTORY_RUNTIME_NATIVE_CLI!
assert.ok(privateRoot && phase && helperPath && nativeCli, 'Explicit private fixture paths are required')
const id = 'launcher:runtime-original', scratchPath = join(privateRoot, 'home/.agentmux/scratch')
const oldPath = join(scratchPath, scratchTopicDirectoryName(id)), shortPath = join(privateRoot, 'home/.agentmux/motes', moteDirectoryName(id))
const middlePath = join(privateRoot, 'home/.agentmux/motes', scratchTopicDirectoryName(id))
const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: scratchPath, name: 'Private Topics', kind: 'folder' as const }
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private Core' }],
  workspaces: [workspace], executors: { proof: { label: 'Private original native fixture', providerId: 'codex',
    command: process.execPath, args: [nativeCli], env: { AGENTMUX_FAKE_READY_MODE: 'before', DIRECTORY_RUNTIME_ORIGINAL_ALIAS: oldPath }, injectAgentMuxGuide: false } },
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true,
    viewport: true, saveBookmark: true, more: true } } }
const topics = new ScratchTopics(), store = new AgentMuxFileAgentSessionStore(join(privateRoot, 'state/sessions.json'))
const targetFile = join(privateRoot, 'target.json'), expectedNote = '# Original private Note\n'
let host: Awaited<ReturnType<typeof startHeadlessAgentMux>> | undefined, runtime: RuntimeController | undefined
let output: Awaited<ReturnType<NonNullable<typeof host>['client']['observeAgentOutput']>> | undefined
let target: { agentSessionId: string; runId?: string; workspacePath: string; object?: { dev: string; ino: string }; spaceId: string; zoneId: string }
let rawOutput = '', serial = Promise.resolve()
const inputs: unknown[] = []
async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 15000
  let last: T | undefined
  do { const value = last = await read(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)) } while (Date.now() < deadline)
  throw Object.assign(new Error('Private original Runtime did not confirm ' + label), { observation: last })
}
async function facts() {
  const status = await host!.client.statusAgent(target.agentSessionId), projected = await runtime!.snapshot(config)
  const session = projected.sessions.find(one => one.kind === 'agent' && one.id === target.agentSessionId)
  const topic = await topics.read(workspace, id), saved = (await loadAgentSessions(store)).find(one => one.agentSessionId === target.agentSessionId)
  assert.ok(topic && saved && session, 'Original Session and Mote must remain discoverable')
  return { pid: process.pid, phase, owner: host!.ownerIdentity(),
    target: { ...target, runId: status.run.runId }, run: { runId: status.run.runId, pid: status.run.pid, state: status.run.state,
      workspacePath: status.run.workspacePath, acceptedInputBytes: status.run.acceptedInputBytes, latestOutputBytes: status.run.latestOutputBytes },
    session: { id: session.id, workspacePath: session.workspacePath, processState: session.processState, control: session.control },
    saved: { id: saved.agentSessionId, run: saved.run, workspacePath: saved.workspacePath },
    orderedOutput: rawOutput,
    mote: { id: topic.id, identityDirectoryPath: topic.identityDirectoryPath, physicalDirectoryPath: topic.physicalDirectoryPath,
      confirmedDirectoryPaths: topic.confirmedDirectoryPaths, readError: topic.readError ?? null,
      spaceId: directoryIdentity('local', topic.identityDirectoryPath!), zoneId: homeZoneId(directoryIdentity('local', topic.identityDirectoryPath!)) } }
}
async function nativeInput(label: string) {
  const before = await host!.client.statusAgent(target.agentSessionId), from = rawOutput.length
  assert.equal(before.run.state, 'running', 'Only the original healthy private Run is written')
  const control: SessionControl = { kind: 'agent', hostId: 'local', agentSessionId: target.agentSessionId, run: { runId: before.run.runId } }
  await runtime!.write(control, label, 'user')
  const marker = await until(() => [...rawOutput.slice(from).matchAll(/DIRECTORY_RUNTIME_CWD:(\{[^\r\n]*\})/g)].map(row => JSON.parse(row[1]!)),
    rows => rows.some(row => row.input.includes(label)), 'actual Native cwd and old-address file read for ' + label)
  const observed = marker.find(row => row.input.includes(label))!
  const after = await host!.client.statusAgent(target.agentSessionId)
  assert.equal(after.run.runId, before.run.runId); assert.equal(after.run.pid, before.run.pid)
  assert.equal(observed.pid, before.run.pid); assert.deepEqual(observed.object, target.object)
  assert.equal(observed.note, expectedNote); assert.equal(observed.oldAddressNote, expectedNote)
  assert.ok(after.run.acceptedInputBytes! > before.run.acceptedInputBytes!, 'Original real ctxmux input watermark advances')
  const row = { label, observed, before: { runId: before.run.runId, pid: before.run.pid, input: before.run.acceptedInputBytes },
    after: { runId: after.run.runId, pid: after.run.pid, input: after.run.acceptedInputBytes } }
  inputs.push(row); return row
}
async function shutdown(stopRuns = false) {
  await output?.close(); output = undefined
  if (stopRuns && host) {
    const saved = (await loadAgentSessions(store)).find(one => one.agentSessionId === target.agentSessionId)
    if (saved) {
      assert.equal(saved.workspacePath, oldPath, 'Cleanup is fenced to the explicitly created fixture Session/cwd')
      const status = await host.client.statusAgent(saved.agentSessionId)
      if (status.run.state === 'running') await host.client.stopAgent(saved.agentSessionId, saved.run)
    }
  }
  await runtime?.dispose(); runtime = undefined
  await host?.stop(); host = undefined
}
try {
  await mkdir(scratchPath, { recursive: true })
  if (phase === 'seed') {
    const seed = await topics.ensure(workspace, id, 'Original private Mote', false)
    await rename(seed.physicalDirectoryPath!, oldPath)
    await writeFile(join(oldPath, 'SOUL.md'), '# Original private Mote\n\nKeep the original resource.\n')
    await writeFile(join(oldPath, 'note.md'), expectedNote)
    await retainDirectoryIdentity(oldPath, { ...await scratchIdentityContext(scratchPath, id), original: oldPath }, { helperPath })
    const object = await stat(oldPath, { bigint: true }), spaceId = directoryIdentity('local', oldPath)
    target = { agentSessionId: mintAgentSessionId(), workspacePath: oldPath, object: { dev: String(object.dev), ino: String(object.ino) },
      spaceId, zoneId: homeZoneId(spaceId) }
    // Record exact intent before Core dispatch so cleanup can inspect only this private Session.
    await writeFile(targetFile, JSON.stringify(target))
  } else target = JSON.parse(await readFile(targetFile, 'utf8'))
  host = await startHeadlessAgentMux({ store, stateDirectory: join(privateRoot, 'state'), socketPath: defaultAgentMuxControlSocketPath() })
  runtime = new RuntimeController(store, connectDesktopAgentMuxHost, topics)
  runtime.commit(await runtime.prepare(config))
  if (phase === 'cleanup') { await shutdown(true); process.stdout.write(JSON.stringify({ passed: true, phase, pid: process.pid }) + '\n'); process.exit(0) }
  if (phase === 'seed') {
    const launched = await runtime.launchAgent({ hostId: 'local', executorId: 'proof', workspacePath: scratchPath,
      scratchTopicId: id, agentSessionId: target.agentSessionId, createOperationId: 'directory-runtime-original-create' }, config)
    assert.equal(launched.created.agentSessionId, target.agentSessionId)
    target.runId = launched.created.run.runId; await writeFile(targetFile, JSON.stringify(target))
  }
  output = await host.client.observeAgentOutput(target.agentSessionId, 0, event => {
    if (event.type === 'terminal-output' && event.run.runId === target.runId) rawOutput += event.data
  })
  await until(() => host!.client.statusAgent(target.agentSessionId), value => value.run.state === 'running' &&
    Boolean(value.session.nativeHandle) && value.session.semanticStatus?.state === 'done', 'original Native readiness facts')
  if (phase === 'restore') {
    const recovery = await runtime.recoverSession({ kind: 'agent', hostId: 'local', agentSessionId: target.agentSessionId,
      run: { runId: target.runId! } }, config, undefined, 'directory-runtime-cold-continuity')
    assert.equal(recovery.kind, 'reattachable', 'Cold observation reconnects the same healthy Run without Provider restart')
  }
  const ready = await facts(); process.stdout.write(JSON.stringify({ ready: true, ...ready }) + '\n')
  process.on('message', (message: { request: number; action: string }) => {
    serial = serial.then(async () => {
      let result: unknown
      if (message.action === 'facts') result = await facts()
      else if (message.action === 'input') result = await nativeInput('input-' + phase + '-' + message.request)
      else if (message.action === 'migrate') {
        const before = await facts(), preview = await migrateTopicDirectories({ scratchRoot: scratchPath, execute: false, motesOnly: true, helperPath })
        const report = await migrateTopicDirectories({ scratchRoot: scratchPath, execute: true, motesOnly: true, helperPath,
          nativeOptions: { beforeSwap: async () => { await nativeInput('before-swap-' + inputs.length) }, afterSwap: async () => { await nativeInput('after-swap-' + inputs.length) } } })
        assert.equal(report.success, true, JSON.stringify(report))
        const after = await facts(), object = await stat(shortPath, { bigint: true })
        assert.deepEqual({ dev: String(object.dev), ino: String(object.ino) }, target.object)
        assert.equal(after.mote.physicalDirectoryPath, shortPath)
        assert.equal(after.mote.identityDirectoryPath, oldPath); assert.equal(after.mote.spaceId, target.spaceId); assert.equal(after.mote.zoneId, target.zoneId)
        assert.ok(after.mote.confirmedDirectoryPaths?.includes(middlePath)); assert.ok(after.mote.confirmedDirectoryPaths?.includes(oldPath))
        assert.equal(after.run.runId, before.run.runId); assert.equal(after.run.pid, before.run.pid); assert.equal(after.run.workspacePath, oldPath)
        result = { before, preview, report, after, inputs }
      } else if (message.action === 'stop') { result = await facts(); await shutdown(true) }
      else if (message.action === 'detach') { result = await facts(); await shutdown() }
      else throw new Error('Unsupported private command ' + message.action)
      process.send?.({ request: message.request, result })
      if (message.action === 'stop' || message.action === 'detach') process.exit(0)
    }).catch(error => { process.send?.({ request: message.request, error: { message: error.message, stack: error.stack } }) })
  })
  process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)) })
} catch (error) {
  process.stderr.write(JSON.stringify({ phase, message: (error as Error).message, stack: (error as Error).stack,
    observation: (error as Error & { observation?: unknown }).observation, orderedOutput: rawOutput }) + '\n')
  await shutdown().catch(failure => process.stderr.write(String(failure) + '\n')); process.exit(1)
}
