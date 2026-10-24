import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'

const artifact = resolve(process.argv[2]), report = resolve(process.argv[3])
const hostPackage = join(artifact, 'node_modules/@agentmux/host'), corePackage = join(hostPackage, 'node_modules/@agentmux/core')
const root = await realpath(await mkdtemp('/tmp/amx-ph-'))
await chmod(root, 0o700)
const runtime = join(root, 'runtime'), state = join(root, 'state'), workspacePath = join(root, 'scratch'), directory = join(root, 'connections')
await mkdir(runtime); await mkdir(workspacePath); await mkdir(join(state, 'ctxmux'), { recursive: true, mode: 0o700 })
const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
const env = { ...clean, pnpm_config_verify_deps_before_run: 'false', AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: state,
  AGENTMUX_AGENT_SESSION_STORE: join(root, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson'),
  AGENTMUX_CONNECTOR_DIRECTORY: directory, AGENTMUX_MOTE_CONFIGURATION_PATH: join(root, 'config.json'),
  AGENTMUX_SPATIAL_STATE_STORE: join(root, 'spatial.json'), AGENTMUX_MOBILE_BUILD_DIRECTORY: join(root, 'absent-mobile') }
for (const key of Object.keys(process.env)) if (key.startsWith('AGENTMUX_') || key.startsWith('CTXMUX_')) delete process.env[key]
Object.assign(process.env, env)
const core = await import(pathToFileURL(join(corePackage, 'dist/index.js')).href)
const { ScratchTopics } = await import(pathToFileURL(join(hostPackage, 'dist/mote-resources.js')).href)
const { directoryIdentity, homeZoneId, SCRATCH_WORKSPACE_ID } = await import(pathToFileURL(join(hostPackage, 'dist/mote-model.js')).href)
const { moteConnectionBaseline } = await import(pathToFileURL(join(corePackage, 'dist/mote-preferences.js')).href)
const fixture = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', name: 'Portable fixture', path: workspacePath, kind: 'folder' }
const facts = { passed: false, platform: process.platform, arch: process.arch, node: process.versions.node,
  boundary: 'Actual portable default Host, original packaged Core/CLI/SQLite/native file helper. Fresh private namespace; no Desktop, SSH, live platform or Agent turn is qualified.', steps: [] }
let native, currentHost
const closed = child => new Promise((done, fail) => { child.once('error', fail); child.once('exit', (code, signal) => done({ code, signal })) })
async function stopHost() { if (!currentHost) return; const value = currentHost; currentHost = undefined; value.child.kill('SIGTERM'); assert.deepEqual(await value.exit, { code: 0, signal: null }) }
async function startHost() {
  const child = spawn(join(artifact, 'bin/agentmux-host'), ['--store', env.AGENTMUX_AGENT_SESSION_STORE], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const exit = closed(child); let stdout = '', stderr = '', resolveReady
  const ready = new Promise(done => { resolveReady = done })
  child.stdout.on('data', bytes => { stdout += bytes; for (const line of stdout.split('\n')) { try { const value = JSON.parse(line); if (value.protocol === 'jsonrpc-2.0') resolveReady(value) } catch {} } })
  child.stderr.on('data', bytes => { stderr += bytes })
  currentHost = { child, exit }
  const value = await Promise.race([ready, exit.then(result => { throw Error('Portable Host exited before its owner receipt: ' + JSON.stringify(result) + ': ' + stderr) })])
  assert.equal(value.pid, child.pid)
  return value.owner
}
async function cli(args, stdin = '') {
  const child = spawn(join(artifact, 'bin/amux'), ['--endpoint', 'unix:' + join(runtime, 'control.sock'), ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const exit = closed(child); let stdout = '', stderr = ''
  child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes }); child.stdin.end(stdin)
  assert.deepEqual(await exit, { code: 0, signal: null }, stdout + stderr)
  return JSON.parse(stdout).result
}
const rpc = () => core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(runtime, 'control.sock') } })
try {
  const topic = await new ScratchTopics().ensureMote(fixture, 'view:portable-original-mote')
  assert.ok(topic.identityDirectoryPath && topic.physicalDirectoryPath && !topic.readError, 'Fresh Mote must be confirmed by the original packaged native identity owner')
  const spaceId = directoryIdentity('local', topic.identityDirectoryPath), zoneId = homeZoneId(spaceId)
  const target = { spaceId, zoneId, expectedResource: { hostId: 'local', workspaceId: fixture.id, workspacePath } }
  const spatial = new core.AgentMuxSpatialStateStore(env.AGENTMUX_SPATIAL_STATE_STORE)
  await spatial.commit({ expectedRevision: 0, graph: { spaces: [{ spaceId, kind: 'mote', name: 'Portable Mote', hostId: 'local', directoryPath: topic.physicalDirectoryPath, projectId: null, topicId: topic.id }],
    zones: [{ zoneId, workspaceId: fixture.id, kind: 'home', hostId: 'local', directoryPath: topic.physicalDirectoryPath, branch: null }], bindings: [{ spaceId, zoneId }],
    tabs: [], regions: [], layouts: {}, tabLayouts: {}, resources: {} } })
  await writeFile(env.AGENTMUX_MOTE_CONFIGURATION_PATH, JSON.stringify({ hosts: [{ id: 'local', kind: 'local', label: 'Private fixture' }], workspaces: [fixture] }))
  facts.steps.push({ step: 'fresh-original-mote', topicId: topic.id, identityConfirmed: true })
  native = spawn(join(corePackage, 'bin/ctxmuxd'), ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'], { env, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let nativeError = ''
  native.stderr.on('data', bytes => { nativeError += bytes })
  const nativeExit = closed(native); native.exitReceipt = nativeExit
  await Promise.race([once(native.stdio[3], 'data'), nativeExit.then(value => { throw Error('Private Native exited before readiness: ' + JSON.stringify(value) + ': ' + nativeError) })])
  native.stdio[3].destroy()
  const original = await startHost(), client = await rpc()
  const receipt = await cli(['connection', 'credential', 'store', '--operation-id', 'portable-original-credential', '--secret-stdin'], 'synthetic-portable-secret')
  const connection = { connectionId: 'portable-original-bot', adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: 'cli_portable_synthetic' }, label: 'Portable synthetic bot', enabled: false, credentialRef: receipt.credentialRef }
  const configured = await client.call('connection.configure', { operationId: 'portable-original-configure', expectedRevision: null, connection })
  assert.equal(configured.status, 'configured'); assert.equal(configured.connection.config.connectionId, connection.connectionId); assert.equal(configured.connection.revision, 1)
  const first = await client.call('space.mote.preferences.read', { kind: 'connection', target })
  assert.equal(first.status, 'ready')
  const saved = await client.call('space.mote.preferences.save', { kind: 'connection', target, operationId: 'portable-original-save', baseline: moteConnectionBaseline(first), values: { connection: { connectionId: connection.connectionId, application: connection.application } } })
  assert.equal(saved.status, 'saved', 'The default packaged Host must create MOTE.md through its original native File owner')
  const moteFile = join(topic.physicalDirectoryPath, 'MOTE.md'), originalBytes = await readFile(moteFile)
  facts.steps.push({ step: 'default-host-sdk-cli', runtimeId: original.runtimeId, originalCredentialRef: receipt.credentialRef, moteWritten: true, desktopAbsent: true })
  await client.dispose()
  assert.equal((await cli(['connection', 'inspect', '--connection', connection.connectionId])).connection.config.connectionId, connection.connectionId)
  await stopHost()
  const db = new DatabaseSync(join(directory, 'connections.sqlite'))
  const opaque = Uint8Array.from([0x76, 0x31, 0x30, 0, 0xff])
  db.prepare('INSERT INTO connection_credential(credential_ref,operation_id,ciphertext) VALUES(?,?,?)').run('portable-original-opaque', 'portable-opaque-operation', opaque)
  const sentinel = JSON.stringify({ operationId: 'portable-original-unknown', payload: { kind: 'speech', text: 'Original frozen synthetic request' } })
  db.prepare('INSERT INTO connector_publication_operation(operation_id,projection_id,source_revision,fragment_ordinal,binding_id,binding_revision,operation_json,state) VALUES(?,?,?,?,?,?,?,?)')
    .run('portable-original-unknown', 'portable-projection', 'original-source-revision', 0, 'portable-original-absent-binding', 1, sentinel, 'unknown')
  db.close()
  const reopened = await startHost(), next = await rpc()
  assert.equal(reopened.runtimeId, original.runtimeId); assert.notEqual(reopened.ownerInstanceId, original.ownerInstanceId)
  assert.deepEqual(await cli(['connection', 'credential', 'store', '--operation-id', 'portable-original-credential', '--secret-stdin'], 'synthetic-portable-secret'), receipt)
  const current = await next.call('space.mote.preferences.read', { kind: 'connection', target })
  assert.equal(current.status, 'ready'); assert.equal(current.values.connection.connectionId, connection.connectionId)
  assert.deepEqual(await readFile(moteFile), originalBytes)
  const observation = new DatabaseSync(join(directory, 'connections.sqlite'), { readOnly: true })
  assert.deepEqual(new Uint8Array(observation.prepare('SELECT ciphertext FROM connection_credential WHERE credential_ref=?').get('portable-original-opaque').ciphertext), opaque)
  assert.deepEqual({ ...observation.prepare('SELECT operation_json,state FROM connector_publication_operation WHERE operation_id=?').get('portable-original-unknown') }, { operation_json: sentinel, state: 'unknown' })
  observation.close(); await next.dispose(); await stopHost()
  facts.steps.push({ step: 'same-db-reopen', sameRuntimeId: true, differentOwnerInstance: true, sameCredentialRef: true, opaqueBytesUntouched: true,
    syntheticUnknownUntouched: true, unknownIsStorageFixtureNotPlatformReplayProof: true, sameMoteIdentityAndBytes: true })
  facts.passed = true
} catch (error) { facts.failure = { name: error.name, code: error.code, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally {
  await stopHost().catch(error => { facts.cleanupError = error.message; facts.passed = false; process.exitCode = 1 })
  if (native) { native.kill('SIGINT'); facts.nativeExit = await native.exitReceipt }
  facts.finalNamespaceWasPrivate = root.startsWith(await realpath('/tmp') + '/amx-ph-')
  await rm(root, { recursive: true, force: true })
  await writeFile(report, JSON.stringify(facts, null, 2) + '\n')
}
