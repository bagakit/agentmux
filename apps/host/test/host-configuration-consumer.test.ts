import { spawn } from 'node:child_process'
import { appendFile, chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { AgentMuxFileAgentSessionStore, DurableAgentMuxMessageQueue, connectAgentMuxRpc } from '@agentmux/core'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { discordConfig, discordRoomId, discordTransport } from '../../../packages/connectors/test/fixtures/discord.js'

const cleanups: Array<() => void | Promise<void>> = [], facts: unknown[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
afterAll(async () => { if (process.env.HOST_CONFIG_FACTS) await writeFile(process.env.HOST_CONFIG_FACTS, JSON.stringify({
  schema: 'agentmux.default-host-configuration-consumer.v1', facts,
  scope: 'Actual compiled default Node indexes, original configs, public Unix/SSH-stdio Core and SQLite journals. Controlled system SSH process, login shell environment, Native bytes and official Discord SDK HTTP/Gateway only; no real SSH/Linux/live/first enrollment/Desktop retirement qualification.'
}, null, 2) + '\n') })
const root = resolve(import.meta.dirname, '../../..'), entry = join(root, 'apps/host/dist/index.js')
const preload = join(root, 'apps/host/test/fixtures/host-configuration-native.mjs')
const line = (id: string, text: string) => JSON.stringify({ type: 'assistant', sessionId: 'original-native', uuid: id,
  message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'
const local = { id: 'local', kind: 'local', label: 'Original local Host' }

async function fixture(platform = false) {
  const directory = await mkdtemp(join(tmpdir(), 'ahc-')); cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const bin = join(directory, 'bin'); await mkdir(bin)
  await symlink(join(root, 'apps/host/test/fixtures/host-configuration-ssh.mjs'), join(bin, 'ssh'))
  const command = join(bin, 'amux'), shell = join(bin, 'login-shell')
  const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'"
  await writeFile(command, '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(join(root, 'packages/core/bin/amux')) + ' "$@"\n', { mode: 0o700 })
  // Execute the original hydration probe without sourcing the test runner user's profiles.
  await writeFile(shell, '#!/bin/sh\nfor argument do script="$argument"; done\nexec /bin/sh -c "$script"\n', { mode: 0o700 })
  await chmod(join(root, 'apps/host/test/fixtures/host-configuration-ssh.mjs'), 0o755)
  const storePath = join(directory, 'sessions.json'), transcript = join(directory, 'native.jsonl'), configPath = join(directory, 'app-config.json')
  const store = new AgentMuxFileAgentSessionStore(storePath)
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: 'original-agent', providerId: 'claude', executorId: 'claude', hostId: 'local',
    workspacePath: directory, run: { runId: 'original-run' }, retiredRuns: [], nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'original-native', transcriptPath: transcript },
    hookBindingId: 'original-hook', hookToken: 'synthetic-hook', createdAt: 1, updatedAt: 1 })
  await writeFile(transcript, line('prior-private', 'Original prior private reply'))
  const state = join(directory, 'native-state'); await writeFile(state, 'ready')
  const config = async (hosts: unknown) => { await writeFile(configPath + '.next', typeof hosts === 'string' ? hosts : JSON.stringify({ hosts })); await rename(configPath + '.next', configPath) }
  await config([local])
  const wire = platform ? await discordTransport() : undefined; if (wire) cleanups.push(wire.close)
  const sshTrace = join(directory, 'ssh.ndjson')
  const environment = objectCliEnvironment(directory, { pnpm_config_verify_deps_before_run: 'false', SHELL: shell, PATH: bin + ':' + process.env.PATH,
    AGENTMUX_CONNECTOR_DIRECTORY: join(directory, 'connections'), AGENTMUX_HOST_CONFIGURATION_PATH: configPath,
    AGENTMUX_SPATIAL_STATE_STORE: join(directory, 'spatial.json'), AGENTMUX_MOBILE_BUILD_DIRECTORY: join(directory, 'absent-mobile'),
    HOST_INDEX_NATIVE_FACTS: join(directory, 'native-facts.json'), HOST_INDEX_WORKSPACE: directory,
    AGENTMUX_FAKE_SSH_HOME: directory, HOST_CONFIG_SSH_TRACE: sshTrace, HOST_CONFIG_NATIVE_STATE: state,
    ...(wire ? { HOST_INDEX_PLATFORM_ORIGIN: wire.origin } : {}) })
  async function start(mutant = '') {
    const child = spawn(process.execPath, ['--import', preload, entry, '--store', storePath], { env: { ...environment, HOST_CONFIG_MUTANT: mutant }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', identity: any
    let opened!: () => void; const ready = new Promise<void>(done => { opened = done })
    child.stdout.on('data', chunk => { stdout += String(chunk); for (const row of stdout.split('\n')) { try { const value = JSON.parse(row); if (value.protocol === 'jsonrpc-2.0') { identity = value; opened() } } catch { /* Not an owner response. */ } } })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const exited = new Promise<number | null>(done => child.once('exit', done))
    const close = async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); expect(await exited, stderr).toBe(0) } }
    cleanups.push(close)
    await Promise.race([ready, exited.then(code => { throw Error('Default Host exited ' + code + ': ' + stderr) })])
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(directory, 'control.sock') } }); cleanups.push(() => rpc.dispose())
    return { rpc, close, owner: identity.owner, logs: () => stderr, pid: child.pid }
  }
  const native = async () => { try { return JSON.parse(await readFile(join(directory, 'native-facts.json'), 'utf8')) } catch { return { effects: [], lifecycle: [] } } }
  const ssh = async () => { try { return (await readFile(sshTrace, 'utf8')).trim().split('\n').map(row => JSON.parse(row)) } catch { return [] } }
  return { directory, transcript, store, config, start, wire, native, ssh, state,
    remote: (id: string, runtimeId: string, hostname = id) => ({ id, kind: 'ssh', label: id, hostname, remoteCommand: command, remoteSocketPath: join(directory, 'control.sock'), runtimeId }) }
}

async function configuredPair() {
  const hosting = await fixture(true), execution = await fixture()
  // Original owners establish their persistent identities before configuration is authored.
  const seeds = await Promise.all([hosting.start(), execution.start()])
  const hostingRuntime = seeds[0]!.owner.runtimeId, executionRuntime = seeds[1]!.owner.runtimeId
  const hToE = execution.remote('execution', executionRuntime), eToH = hosting.remote('hosting', hostingRuntime)
  await Promise.all([hosting.config([local, { ...hToE, id: 'bad-first', hostname: 'pending.fixture' }, hToE]), execution.config([local, eToH])])
  let [h, e] = seeds
  if (!h || !e) throw Error('Expected both original owners')
  await vi.waitFor(async () => expect((await hosting.ssh()).some(row => row.destination === 'execution' && row.response?.result?.owner?.runtimeId === executionRuntime)).toBe(true))
  await vi.waitFor(async () => expect((await execution.ssh()).some(row => row.destination === 'hosting' && row.response?.result?.owner?.runtimeId === hostingRuntime)).toBe(true))
  const fence = { runtimeId: h.owner.runtimeId, ownerInstanceId: h.owner.ownerInstanceId }
  const receipt = await h.rpc.call('connection.credential.store', { operationId: 'original-credential', secret: 'synthetic-discord-token' }, { runtimeFence: fence })
  await h.rpc.call('connection.configure', { operationId: 'original-configure', expectedRevision: null, connection: { ...discordConfig, credentialRef: receipt.credentialRef } })
  const bind = () => h.rpc.call('connection.bind', { operationId: 'original-bind', bindingId: 'original-binding', connectionId: discordConfig.connectionId,
    expectedConnectionRevision: 1, executionHostId: 'execution', agentSessionId: 'original-agent', externalConversationId: discordRoomId,
    expectedSource: { providerId: 'claude', nativeSessionId: 'original-native' }, scope: { input: 'mentions-and-replies', publication: 'future-native-user-facing' } })
  let binding: any
  await vi.waitFor(async () => { binding = await bind(); expect(binding).toMatchObject({ state: 'applied', binding: { executionRuntimeId: executionRuntime } }) }, { timeout: 15_000 })
  await h.rpc.call('connection.grant', { operationId: 'original-grant', grantId: 'original-member', bindingId: binding.binding.bindingId,
    expectedBindingRevision: 1, expectedRevision: null, actor: { application: discordConfig.application, idType: 'snowflake', userId: '400' }, capabilities: ['input'], state: 'active' })
  await vi.waitFor(() => expect(hosting.wire!.sessions).toHaveLength(1))
  await Promise.all(seeds.map(seed => seed.close()))
  // Both original default indexes are cold, with the original Binding and pins;
  // neither peer endpoint already exists. Mutations cannot fail fixture enrollment.
  ;[h, e] = await Promise.all([hosting.start(process.env.HOST_CONFIG_MUTANT), execution.start()])
  expect(h.owner.runtimeId).toBe(hostingRuntime); expect(e.owner.runtimeId).toBe(executionRuntime)
  await vi.waitFor(() => expect(hosting.wire!.sessions.length).toBeGreaterThanOrEqual(2))
  const intake = async (id: string) => {
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(hosting.directory, 'control.sock') } })
    try { return (await rpc.call('connection.ingress.ls', { connectionId: discordConfig.connectionId })).ingresses.find(value => value.externalMessageId === id) }
    finally { await rpc.dispose() }
  }
  return { hosting, execution, h, e, hToE, eToH, intake, binding: binding.binding }
}

it('two cold default indexes use their own config and SSH authority after clients leave, while a bad first route leaves healthy local and remote work usable', async () => {
  const f = await configuredPair()
  expect(await f.h.rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'original-agent' } })).toMatchObject({ session: { run: { runId: 'original-run' } } })
  await f.h.rpc.dispose(); await f.e.rpc.dispose()
  f.hosting.wire!.message('801', 'Original default cross Host input')
  await vi.waitFor(async () => expect(await f.intake('801')).toBeDefined())
  facts.push({ case: 'cold-default-pair-durable-ingress', ingress: await f.intake('801'), initialEffects: (await f.execution.native()).effects.length })
  await vi.waitFor(async () => expect((await f.execution.native()).effects).toHaveLength(1), { timeout: 15_000 })
  expect((await f.hosting.native()).effects).toEqual([])
  const input = (await f.intake('801'))!.input!
  const journal = await new DurableAgentMuxMessageQueue(join(f.execution.directory, 'messages.ndjson')).readByOperationId(input.operationId)
  expect(journal).toMatchObject({ envelope: { sender: { authoritySource: { hostingRuntimeId: f.h.owner.runtimeId, executionRuntimeId: f.e.owner.runtimeId } } } })
  await appendFile(f.execution.transcript, line('public-final', 'Original default remote public answer'))
  await vi.waitFor(() => expect(f.hosting.wire!.calls.some(call => call.method === 'POST' && call.body.includes('Original default remote public answer'))).toBe(true), { timeout: 15_000 })
  expect((await f.hosting.ssh()).some(row => row.destination === 'pending.fixture')).toBe(true)
  expect((await f.execution.native()).lifecycle.filter((value: any) => value.name === 'stop')).toEqual([])
  facts.push({ case: 'cold-default-pair-native-and-publication', hosting: f.h.owner, execution: f.e.owner, binding: f.binding,
    native: await f.execution.native(), journal, nativeRequests: f.hosting.wire!.calls.filter(call => call.method === 'POST').length })
})

it('the default configuration preserves original clients through atomic malformed reads and isolates pending route repair from a healthy route and shutdown', async () => {
  const f = await configuredPair()
  await f.hosting.config('{')
  await vi.waitFor(() => expect(f.h.logs()).toContain('Reading the original Host configuration failed.'))
  f.hosting.wire!.message('802', 'Original route after malformed configuration')
  await vi.waitFor(async () => expect((await f.execution.native()).effects).toHaveLength(1), { timeout: 15_000 })
  await f.hosting.config([local, { ...f.hToE, id: 'bad-first', hostname: 'pending.fixture', port: 2202 }, { ...f.hToE, label: 'Original repaired label', port: 2203 }])
  await vi.waitFor(async () => expect((await f.hosting.ssh()).filter(row => row.destination === 'execution' && row.phase === 'response' && row.response.result?.owner).length).toBeGreaterThan(1))
  f.hosting.wire!.message('803', 'Original independent repaired route')
  await vi.waitFor(async () => expect((await f.execution.native()).effects).toHaveLength(2), { timeout: 15_000 })
  const input = (await f.intake('803'))!.input!
  expect('authoritySource' in input.author ? input.author.authoritySource : undefined).toEqual({ hostingRuntimeId: f.h.owner.runtimeId, executionRuntimeId: f.e.owner.runtimeId })
  await f.h.close(); await f.e.close()
  const [h, e] = await Promise.all([f.hosting.start(), f.execution.start()])
  expect(h.owner.runtimeId).toBe(f.h.owner.runtimeId); expect(e.owner.runtimeId).toBe(f.e.owner.runtimeId)
  const original = (await h.rpc.call('connection.ingress.ls', { connectionId: discordConfig.connectionId })).ingresses.find(value => value.externalMessageId === '803')!
  expect(original.input!.operationId).toBe(input.operationId)
  expect((await f.execution.native()).effects).toHaveLength(2)
  facts.push({ case: 'atomic-read-route-repair-and-reopen', originalInput: input, reopenedInput: original.input, hostingRuntimeId: h.owner.runtimeId,
    executionRuntimeId: e.owner.runtimeId, nativeEffects: 2, originalRunRetained: true })
})

it('an incorrect configured Runtime pin refuses the original remote Binding and never adopts that route as a new identity', async () => {
  const hosting = await fixture(true), execution = await fixture()
  const [h, e] = await Promise.all([hosting.start(), execution.start()])
  await h.close()
  await hosting.config([local, execution.remote('execution', h.owner.runtimeId)])
  const current = await hosting.start(process.env.HOST_CONFIG_MUTANT)
  await vi.waitFor(async () => expect((await hosting.ssh()).some(row => row.destination === 'execution' && row.phase === 'response')).toBe(true))
  const receipt = await current.rpc.call('connection.credential.store', { operationId: 'pin-credential', secret: 'synthetic-discord-token' },
    { runtimeFence: { runtimeId: current.owner.runtimeId, ownerInstanceId: current.owner.ownerInstanceId } })
  await current.rpc.call('connection.configure', { operationId: 'pin-connection', expectedRevision: null, connection: { ...discordConfig, credentialRef: receipt.credentialRef } })
  const result = await current.rpc.call('connection.bind', { operationId: 'pin-bind', bindingId: 'incorrect-runtime-binding', connectionId: discordConfig.connectionId,
    expectedConnectionRevision: 1, executionHostId: 'execution', agentSessionId: 'original-agent', externalConversationId: discordRoomId,
    expectedSource: { providerId: 'claude', nativeSessionId: 'original-native' }, scope: { input: 'mentions-and-replies', publication: 'future-native-user-facing' } })
    .then(value => ({ value }), error => ({ error: error.code }))
  facts.push({ case: 'wrong-configured-runtime-pin', configuredRuntimeId: h.owner.runtimeId, actualRuntimeId: e.owner.runtimeId, result,
    hosting: current.owner, execution: e.owner, native: await execution.native() })
  expect(result).toMatchObject({ error: 'ROOM_BINDING_OPERATION_UNCONFIRMED' })
  expect((await current.rpc.call('connection.binding.inspect', { bindingId: 'incorrect-runtime-binding' })).current).toBeNull()
  expect((await execution.native()).effects).toEqual([])
  expect((await current.rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'original-agent' } })).session.run).toEqual({ runId: 'original-run' })
})

it('a valid reverse-route removal refuses only rejoin, while restoring the original config rejoins the saved waiting input and original ID', async () => {
  const f = await configuredPair()
  await writeFile(f.execution.state, 'unavailable')
  f.hosting.wire!.message('804', 'Original waiting default input')
  let before: any
  await vi.waitFor(async () => {
    const ingress = await f.intake('804'); expect(ingress?.input).toBeDefined()
    const receipt = await f.e.rpc.call('agent.input.inspect', { kind: 'message-control', originalControlOperationId: ingress!.input!.operationId })
    before = receipt.input; expect(before).toMatchObject({ status: 'waiting' })
  }, { timeout: 15_000 })
  const closes = (await f.execution.ssh()).filter(row => row.destination === 'hosting' && row.phase === 'closed').length
  await f.execution.config([local])
  await vi.waitFor(async () => expect((await f.execution.ssh()).filter(row => row.destination === 'hosting' && row.phase === 'closed').length).toBeGreaterThan(closes))
  await expect(f.e.rpc.call('agent.input.rejoin', { ref: before.ref })).rejects.toMatchObject({ code: 'EXTERNAL_INPUT_AUTHORITY_UNCONFIRMED' })
  expect((await f.execution.native()).effects).toEqual([])
  expect((await f.e.rpc.call('agent.input.inspect', { key: before.key })).input?.ref).toEqual(before.ref)
  await f.execution.config([local, f.eToH]); await writeFile(f.execution.state, 'ready')
  await vi.waitFor(async () => {
    const rejoined = await f.e.rpc.call('agent.input.rejoin', { ref: before.ref })
    expect(rejoined.ref).toEqual(before.ref)
  }, { timeout: 15_000 })
  await vi.waitFor(async () => expect((await f.execution.native()).effects).toHaveLength(1), { timeout: 15_000 })
  const original = await f.intake('804')
  expect(original!.input!.operationId).toBe(before.originalControlOperationId)
  facts.push({ case: 'default-reverse-removal-and-wait-rejoin', source: 'authoritySource' in original!.input!.author ? original!.input!.author.authoritySource : null, ref: before.ref,
    originalControlOperationId: before.originalControlOperationId, after: (await f.e.rpc.call('agent.input.inspect', { key: before.key })).input })
})
