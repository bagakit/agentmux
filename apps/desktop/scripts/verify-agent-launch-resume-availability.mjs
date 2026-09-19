import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { listProbeProcesses } from './probe-process.mjs'

// Existing proof owns actual Controller/Store ordinary-process workbench restoration. This proof
// consumes it, then adds public Core semantic resume against the exact current private Native.
const base = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const exec = promisify(execFile)
const out = join(base, '.tmp/p00-launch-resume-availability')
await mkdir(out, { recursive: true })
const root = await mkdtemp('/tmp/amx-p00-resume-')
await mkdir(join(root, 'home'), { mode: 0o700 })
const critical = [fileURLToPath(import.meta.url),
  join(base, 'apps/desktop/scripts/verify-agent-launch-projection-restart.mjs'),
  ...['client.js', 'agent-session-store.js', 'ctxmux-run-adapter.js', 'runtime-paths.js'].map(name => join(base, 'packages/core/dist', name)),
  join(base, 'packages/core/vendor/ctxmux/darwin-arm64/bin/ctxmuxd'),
  join(base, 'packages/core/vendor/ctxmux/darwin-arm64/manifest.json')]
const capture = async () => Object.fromEntries(await Promise.all(critical.map(async path => [path,
  createHash('sha256').update(await readFile(path)).digest('hex')])))
const before = await capture()
const environment = { ...process.env, CODEX_HOME: join(root, 'home'),
  AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(root, 'state'), AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') }
for (const name of ['AGENTMUX_AGENT_SESSION_STORE', 'AGENTMUX_AGENT_SESSION_ID', 'AGENTMUX_AGENT_CAPABILITY',
  'AGENTMUX_HOOK_URL', 'AGENTMUX_HOOK_TOKEN']) delete environment[name]
const worker = join(root, 'worker.mjs')
const records = [], cleanupErrors = []
let failure, workbench
await writeFile(worker, `
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { connectLocalAgentMux, AgentMuxFileAgentSessionStore, AgentProviderRegistry, defineAgentProvider } from '@agentmux/core'
const [mode, root] = process.argv.slice(2)
const template = new AgentProviderRegistry().get('codex')
const provider = defineAgentProvider({ catalog: { ...template.catalog, id: 'p00-fixture', label: 'Private native resume protocol',
 executable: '/usr/bin/python3', expectedProcess: '/usr/bin/python3', hookStrategy: { kind: 'none' },
 readySignal: { kind: 'foreground-process', expectedProcess: '/usr/bin/python3' } },
 hook: { rules: [{ events: ['SessionStart'], state: 'working' }],
 eventNameSource: { kind: 'payload', payloadKey: 'hook_event_name' }, nativeHandle: { sessionIdKeys: ['session_id'] } },
 buildArgs: (_prompt, args) => [...args, 'private-native-id'],
 buildResumeArgs: (id, _path, _prompt, args) => { assert.equal(id, 'private-native-id'); return [...args, id] } })
const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
const client = await connectLocalAgentMux({ store, providers: [provider] })
const wait = async (predicate, label) => { const deadline = Date.now() + 10000; do {
 const result = await predicate(); if (result) return result; await new Promise(done => setTimeout(done, 25))
 } while (Date.now() < deadline); throw new Error('Private deadline: ' + label) }
let session, previous, continuity
const execution = { args: ['-u', join(root, 'pty.py')], env: { CODEX_HOME: join(root, 'home') }, commandOverride: '/usr/bin/python3' }
try {
 if (mode === 'create') {
  session = await client.createAgent({ providerId: provider.id, executorId: 'private', workspacePath: root,
   injectAgentMuxGuide: false, ...execution })
 } else {
  previous = JSON.parse(await readFile(join(root, mode === 'resume' ? 'create.json' : 'resume.json'), 'utf8'))
  continuity = await client.ensureAgentContinuity({ agentSessionId: previous.id, expectedRun: previous.run,
   operationId: mode + '-private', ...execution })
  assert.equal(continuity.kind, mode === 'resume' ? 'resumed' : 'reattachable')
  session = continuity.session
 }
 const current = await wait(async () => { const result = await client.statusAgent(session.agentSessionId)
  return result.run.state === 'running' && result.run.latestOutputBytes > 0 &&
   result.session.nativeHandle?.sessionId === 'private-native-id' ? result : null }, 'running Agent with actual Hook handle')
 const attached = await client.reattachAgent(session.agentSessionId, 0)
 assert.equal(attached.attachment.run.runId, session.run.runId)
 await client.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: session.run, data: mode === 'create' ? 'a' : 'b', source: 'user' })
 const after = await wait(async () => { const result = await client.statusAgent(session.agentSessionId)
  return result.run.acceptedInputBytes > current.run.acceptedInputBytes && result.run.latestOutputBytes > current.run.latestOutputBytes ? result : null }, 'actual input and output')
 const record = { mode, clientPid: process.pid, id: session.agentSessionId, run: session.run, childPid: after.run.pid,
  previousRun: previous?.run, nativeHandle: after.session.nativeHandle, input: after.run.acceptedInputBytes,
  output: after.run.latestOutputBytes, daemon: client.runtimeIdentity(), continuity: continuity?.kind }
 if (mode === 'create') {
  await client.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: session.run, data: 'q', source: 'user' })
  await wait(async () => (await client.statusAgent(session.agentSessionId)).run.state === 'exited', 'natural original child exit')
 } else if (mode === 'reattach') await client.stopAgent(session.agentSessionId, session.run)
 await writeFile(join(root, mode + '.json'), JSON.stringify(record))
 process.stdout.write(JSON.stringify(record) + '\\n')
} finally { await client.dispose() }
`)
await writeFile(join(root, 'pty.py'), `import os,sys,tty,json,uuid,urllib.request
body=json.dumps({'receiptId':uuid.uuid4().hex,'payload':{'hook_event_name':'SessionStart','session_id':sys.argv[1]}}).encode()
req=urllib.request.Request(os.environ['AGENTMUX_HOOK_URL'],data=body,headers={'Authorization':'Bearer '+os.environ['AGENTMUX_HOOK_TOKEN'],'Content-Type':'application/json'})
assert urllib.request.urlopen(req,timeout=2).status==204
tty.setraw(0)
os.write(1,b'PRIVATE-READY')
while True:
 b=os.read(0,1)
 if b==b'q':break
 os.write(1,b'PRIVATE-ACK:'+b)
`)
await symlink(join(base, 'apps/desktop/node_modules'), join(root, 'node_modules'))
try {
  const proof = await exec(process.execPath, [join(base, 'apps/desktop/scripts/verify-agent-launch-projection-restart.mjs')],
    { cwd: base, env: environment, timeout: 90000, maxBuffer: 1024 * 1024 })
  await writeFile(join(out, 'workbench.log'), proof.stdout + proof.stderr)
  workbench = JSON.parse(await readFile(join(base, '.tmp/agent-launch-projection-proof/restart-last.json'), 'utf8'))
  assert.equal(workbench.passed, true)
  assert.equal(workbench.records.length, 2)
  for (const mode of ['create', 'resume', 'reattach']) {
    const result = await exec(process.execPath, [worker, mode, root], { cwd: base, env: environment,
      timeout: 25000, maxBuffer: 1024 * 1024 })
    await writeFile(join(out, mode + '.log'), result.stdout + result.stderr)
    records.push(JSON.parse(result.stdout.trim().split('\n').at(-1)))
  }
  const [created, resumed, attached] = records
  for (const record of records) {
    assert.ok(Number.isInteger(record.childPid) && record.childPid > 0, 'Actual live child PID is required')
    assert.ok(record.run.runId && record.daemon.instanceId, 'Actual Run and Native identity are required')
  }
  assert.equal(created.id, resumed.id); assert.equal(resumed.id, attached.id)
  assert.notEqual(created.run.runId, resumed.run.runId)
  assert.deepEqual(resumed.previousRun, created.run); assert.deepEqual(attached.run, resumed.run)
  assert.deepEqual(created.nativeHandle, resumed.nativeHandle); assert.deepEqual(resumed.nativeHandle, attached.nativeHandle)
  assert.equal(attached.childPid, resumed.childPid)
  assert.ok(attached.input > resumed.input); assert.ok(attached.output > resumed.output)
  assert.equal(new Set(records.map(record => record.clientPid)).size, 3)
  assert.equal(new Set(records.map(record => record.daemon.instanceId)).size, 1)
} catch (error) {
  failure = [error.stack ?? String(error), error.stdout, error.stderr].filter(Boolean).join('\n')
}
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
  const remaining = await listProbeProcesses(-1, root)
  const after = await capture()
  if (JSON.stringify(before) !== JSON.stringify(after)) failure ??= 'Selected inputs changed during proof'
  if (!remaining.length && !cleanupErrors.length) await rm(root, { recursive: true, force: true })
  const receipt = { schema: 'agentmux.p00-launch-resume-private.v1', passed: !failure && !remaining.length && !cleanupErrors.length,
    inputsBefore: before, inputsAfter: after, records, workbench, failure: failure ?? null,
    cleanup: { remaining, errors: cleanupErrors, rootRemoved: !remaining.length && !cleanupErrors.length },
    scope: 'Public Core/FileStore/current Native, synthetic Provider verified HTTP Hook handle and native resume, actual input; existing Controller/Store two ordinary Node workbench proof. No upstream model, Electron/OS input or user Runtime claim.' }
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, processes: records.length, failure: receipt.failure, cleanup: receipt.cleanup }))
  if (!receipt.passed) process.exitCode = 1
}
