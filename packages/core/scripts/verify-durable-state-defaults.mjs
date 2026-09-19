import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { listProbeProcesses } from '../../../apps/desktop/scripts/probe-process.mjs'

// Only private processes under this invocation's two explicit roots are controlled.
// Endpoint deletion models a cold activation, not preservation of a PTY across a boot.
const base = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const exec = promisify(execFile)
const out = join(base, '.tmp/core-durable-state-defaults')
await mkdir(out, { recursive: true })
const root = await mkdtemp('/tmp/amx-durable-')
const endpoints = join(root, 'endpoints'), state = join(root, 'persistent')
await mkdir(join(root, 'home'), { mode: 0o700 })
const critical = [fileURLToPath(import.meta.url), ...['runtime-paths', 'agent-session-store', 'client', 'ctxmux-run-adapter']
  .flatMap(name => ['src/' + name + '.ts', 'dist/' + name + '.js'].map(path => join(base, 'packages/core', path))),
  join(base, 'packages/core/vendor/ctxmux/darwin-arm64/bin/ctxmuxd'),
  join(base, 'packages/core/vendor/ctxmux/darwin-arm64/manifest.json')]
const capture = async () => Object.fromEntries(await Promise.all(critical.map(async path => [path,
  createHash('sha256').update(await readFile(path)).digest('hex')])))
const before = await capture()
const environment = { ...process.env, CODEX_HOME: join(root, 'home'), AGENTMUX_RUNTIME_DIRECTORY: endpoints,
  AGENTMUX_STATE_DIRECTORY: state, AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') }
for (const name of ['AGENTMUX_AGENT_SESSION_STORE', 'AGENTMUX_AGENT_SESSION_ID', 'AGENTMUX_AGENT_CAPABILITY',
  'AGENTMUX_HOOK_URL', 'AGENTMUX_HOOK_TOKEN']) delete environment[name]
const worker = join(root, 'worker.mjs')
const records = [], cleanupErrors = []
let failure, endpointDeletion
await symlink(join(base, 'packages/core/node_modules'), join(root, 'node_modules'))
await writeFile(worker, `
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CtxmuxClient } from '@ctxmux/sdk'
import { connectLocalAgentMux, AgentMuxFileAgentSessionStore, AgentProviderRegistry, defineAgentProvider } from ${JSON.stringify(join(base, 'packages/core/dist/index.js'))}
const [mode, root] = process.argv.slice(2)
const nativeId = mode.startsWith('live-') ? 'private-live-native-id' : 'private-durable-native-id'
const template = new AgentProviderRegistry().get('codex')
const provider = defineAgentProvider({ catalog: { ...template.catalog, id: 'durable-fixture', label: 'Private durable protocol',
 executable: '/usr/bin/python3', expectedProcess: '/usr/bin/python3', hookStrategy: { kind: 'none' },
 readySignal: { kind: 'foreground-process', expectedProcess: '/usr/bin/python3' } },
 hook: { rules: [{ events: ['SessionStart'], state: 'working' }],
 eventNameSource: { kind: 'payload', payloadKey: 'hook_event_name' }, nativeHandle: { sessionIdKeys: ['session_id'] } },
 buildArgs: (_prompt, args) => [...args, nativeId],
 buildResumeArgs: (id, _path, _prompt, args) => { assert.equal(id, nativeId); return [...args, id] } })
// Both cold activations exercise the actual default FileStore consumer, without a store override.
const old = mode === 'cold-second' ? JSON.parse(await readFile(join(root, 'cold-first.json'), 'utf8')) :
 mode === 'live-second' ? JSON.parse(await readFile(join(root, 'live-first.json'), 'utf8')) : null
const store = mode === 'live-second' ? new AgentMuxFileAgentSessionStore(old.storePath) : new AgentMuxFileAgentSessionStore()
const client = await connectLocalAgentMux({ store, providers: [provider] })
const sdk = new CtxmuxClient({ socketPath: join(process.env.AGENTMUX_RUNTIME_DIRECTORY, 'ctxmux.sock') })
const wait = async (predicate, label) => { const deadline = Date.now() + 10000; do {
 const result = await predicate(); if (result) return result; await new Promise(done => setTimeout(done, 25))
 } while (Date.now() < deadline); throw new Error('Private deadline: ' + label) }
const execution = { args: ['-u', join(root, 'pty.py')], env: { CODEX_HOME: join(root, 'home') }, commandOverride: '/usr/bin/python3' }
let session, continuity, retained
try {
 const identity = await sdk.runtimeInfo()
 assert.equal(identity.daemonInstanceId, client.runtimeIdentity().instanceId)
 if (mode === 'cold-second') {
  assert.equal(identity.runtimeId, old.identity.runtimeId)
  assert.notEqual(identity.daemonInstanceId, old.identity.daemonInstanceId)
  const replay = await client.readRunReplay(old.run)
  assert.ok(replay.replay.length > 0)
  const bytes = Buffer.concat(replay.replay.map(event => Buffer.from(event.dataBytes)))
  retained = { length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  assert.deepEqual(retained, old.retained)
  continuity = await client.ensureAgentContinuity({ agentSessionId: old.id, expectedRun: old.run,
   operationId: 'cold-resume-private', ...execution })
  assert.equal(continuity.kind, 'resumed'); session = continuity.session
 } else if (mode === 'live-second') {
  assert.deepEqual(identity, old.identity)
  continuity = await client.ensureAgentContinuity({ agentSessionId: old.id, expectedRun: old.run,
   operationId: 'live-reattach-private', ...execution })
  assert.equal(continuity.kind, 'reattachable'); session = continuity.session
 } else session = await client.createAgent({ providerId: provider.id, executorId: 'private', workspacePath: root,
  injectAgentMuxGuide: false, ...execution })
 const current = await wait(async () => { const result = await client.statusAgent(session.agentSessionId)
  return result.run.state === 'running' && result.run.latestOutputBytes > 0 &&
   result.session.nativeHandle?.sessionId === nativeId ? result : null }, 'actual running Hook handle')
 await client.reattachAgent(session.agentSessionId, 0)
 await client.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: session.run, data: 'a', source: 'user' })
 const after = await wait(async () => { const result = await client.statusAgent(session.agentSessionId)
  return result.run.acceptedInputBytes > current.run.acceptedInputBytes && result.run.latestOutputBytes > current.run.latestOutputBytes ? result : null }, 'actual input and output')
 if (old) { assert.equal(session.agentSessionId, old.id); assert.deepEqual(after.session.nativeHandle, old.nativeHandle) }
 const diagnostics = await client.runtimeDiagnostics()
 assert.equal(diagnostics.ctxmux.state.configuredDirectory, join(process.env.AGENTMUX_STATE_DIRECTORY, 'ctxmux'))
 assert.equal(diagnostics.ctxmux.state.servingDirectory, mode === 'live-second' ? null : join(process.env.AGENTMUX_STATE_DIRECTORY, 'ctxmux'))
 assert.equal(client.runtimeIdentity().ownership, mode === 'live-second' ? 'unverified' : 'owned')
 if (mode !== 'live-first') {
  await client.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: session.run, data: 'q', source: 'user' })
  await wait(async () => (await client.statusAgent(session.agentSessionId)).run.state === 'exited', 'natural child exit')
  await wait(async () => { const value = await sdk.status(session.run.runId); return value.durable_output_bytes === value.latest_output_bytes && value.latest_output_bytes > 0 }, 'durable exact bytes')
 }
 if (mode === 'cold-first') {
  const replay = await client.readRunReplay(session.run)
  assert.ok(replay.replay.length > 0)
  const bytes = Buffer.concat(replay.replay.map(event => Buffer.from(event.dataBytes)))
  retained = { length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  assert.ok(retained.length > 0)
 }
 const record = { mode, clientPid: process.pid, storePath: store.path, id: session.agentSessionId,
  run: session.run, nativeHandle: after.session.nativeHandle, childPid: after.run.pid, input: after.run.acceptedInputBytes,
  output: after.run.latestOutputBytes, identity, state: diagnostics.ctxmux.state, retained, continuity: continuity?.kind }
 if (mode !== 'live-second') assert.equal(store.path, join(process.env.AGENTMUX_STATE_DIRECTORY, 'agent-sessions.json'))
 await writeFile(join(root, mode + '.json'), JSON.stringify(record))
 console.log(JSON.stringify(record))
} finally { await client.dispose() }
`)
await writeFile(join(root, 'pty.py'), `import os,sys,tty,json,uuid,urllib.request
body=json.dumps({'receiptId':uuid.uuid4().hex,'payload':{'hook_event_name':'SessionStart','session_id':sys.argv[1]}}).encode()
req=urllib.request.Request(os.environ['AGENTMUX_HOOK_URL'],data=body,headers={'Authorization':'Bearer '+os.environ['AGENTMUX_HOOK_TOKEN'],'Content-Type':'application/json'})
assert urllib.request.urlopen(req,timeout=2).status==204
tty.setraw(0)
os.write(1,b'DURABLE-READY')
while True:
 b=os.read(0,1)
 if b==b'q':break
 os.write(1,b'DURABLE-ACK:'+b)
`)
const run = async (mode, env = environment) => {
  try {
    const result = await exec(process.execPath, [worker, mode, root], { cwd: base, env, timeout: 25000, maxBuffer: 1024 * 1024 })
    await writeFile(join(out, mode + '.log'), result.stdout + result.stderr)
    const record = JSON.parse(result.stdout.trim().split('\n').at(-1)); records.push(record); return record
  } catch (error) {
    await writeFile(join(out, mode + '.log'), [error.stack, error.stdout, error.stderr].filter(Boolean).join('\n'))
    throw error
  }
}
const stopPrivateDaemon = async () => {
  const pids = await listProbeProcesses(-1, root)
  assert.equal(pids.length, 1, 'Only the private daemon may remain after natural child exit')
  const command = (await exec('/bin/ps', ['-p', String(pids[0]), '-o', 'command='])).stdout
  assert.ok(command.includes('ctxmuxd') && command.includes('--socket ' + join(endpoints, 'ctxmux.sock')) &&
    command.includes('--state-dir ' + join(state, 'ctxmux')), 'Private daemon socket and durable binding required')
  process.kill(pids[0], 'SIGTERM')
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && (await listProbeProcesses(-1, root)).length) await new Promise(done => setTimeout(done, 25))
  assert.deepEqual(await listProbeProcesses(-1, root), [])
}
try {
  const first = await run('cold-first')
  await stopPrivateDaemon()
  const durableBefore = await readFile(first.storePath)
  await rm(endpoints, { recursive: true })
  assert.deepEqual(await readFile(first.storePath), durableBefore)
  endpointDeletion = { removedDirectory: endpoints, retainedStoreSha256: createHash('sha256').update(durableBefore).digest('hex') }
  const second = await run('cold-second')
  assert.notEqual(first.run.runId, second.run.runId)
  await stopPrivateDaemon()
  const live = await run('live-first')
  const receiptPath = join(endpoints, 'owner.json'), originalReceipt = await readFile(receiptPath)
  const secondLive = await run('live-second', { ...environment, AGENTMUX_STATE_DIRECTORY: join(root, 'future-state') })
  assert.equal(secondLive.childPid, live.childPid); assert.deepEqual(secondLive.run, live.run)
  assert.ok(secondLive.input > live.input && secondLive.output > live.output)
  assert.deepEqual(await readFile(receiptPath), originalReceipt)
  assert.equal(new Set(records.map(record => record.clientPid)).size, 4)
  await stopPrivateDaemon()
} catch (error) { failure = [error.stack ?? String(error), error.stdout, error.stderr].filter(Boolean).join('\n') }
finally {
  for (const pid of await listProbeProcesses(-1, root)) {
    try {
      const command = (await exec('/bin/ps', ['-p', String(pid), '-o', 'command='])).stdout
      assert.ok(command.includes(root), 'Private process identity changed')
      process.kill(pid, 'SIGTERM')
    } catch (error) { if (error.code !== 'ESRCH' && error.code !== 1) cleanupErrors.push(String(error)) }
  }
  const deadline = Date.now() + 4000
  while (Date.now() < deadline && (await listProbeProcesses(-1, root)).length) await new Promise(done => setTimeout(done, 25))
  const remaining = await listProbeProcesses(-1, root), after = await capture()
  if (JSON.stringify(before) !== JSON.stringify(after)) failure ??= 'Selected inputs changed during proof'
  if (!remaining.length && !cleanupErrors.length) await rm(root, { recursive: true, force: true })
  const receipt = { schema: 'agentmux.core-durable-state-defaults.private.v1', passed: !failure && !remaining.length && !cleanupErrors.length,
    inputsBefore: before, inputsAfter: after, records, endpointDeletion, failure: failure ?? null,
    cleanup: { remaining, errors: cleanupErrors, rootRemoved: !remaining.length && !cleanupErrors.length },
    scope: 'Private explicit state and endpoint roots, default Core FileStore, current Native retained bytes and logical Runtime identity, same Session/nativeHandle semantic resume. Compatible live listener with different candidate default remains same Run/PID, real input and original receipt. No migration, actual computer boot, Electron, upstream Provider or user Runtime claim.' }
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, processes: records.length, failure: receipt.failure, cleanup: receipt.cleanup }))
  if (!receipt.passed) process.exitCode = 1
}
