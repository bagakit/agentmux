import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AgentMuxFileAgentSessionStore, connectAgentMuxRpc } from '@agentmux/core'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { discordConfig, discordRoomId, discordTransport } from '../../../packages/connectors/test/fixtures/discord.js'

const cleanup: Array<() => void | Promise<void>> = [], facts: unknown[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
afterAll(async () => { if (process.env.HOST_INDEX_FACTS) await writeFile(process.env.HOST_INDEX_FACTS, JSON.stringify({
  schema: 'agentmux.compiled-host-index-consumer.v1', scope: 'Actual compiled Node index and public Unix SDK/compiled CLI; synthetic namespace, Runtime I/O and official Discord SDK network I/O. No Desktop owner, live platform, migration, installed App or remote deployment qualification.', facts
}, null, 2) + '\n') })
const entry = resolve(import.meta.dirname, '../dist/index.js'), preload = resolve(import.meta.dirname, 'fixtures/host-index-native.mjs')
const nativeLine = (id: string, text: string) => JSON.stringify({ type: 'assistant', sessionId: 'original-native', uuid: id,
  message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'
async function fixture(platform = false) {
  const root = await mkdtemp(join(tmpdir(), 'amx-index-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'working-directory'); await mkdir(cwd)
  const storePath = join(root, 'sessions.json'), transcript = join(root, 'native.jsonl'), directory = join(root, 'connections')
  const store = new AgentMuxFileAgentSessionStore(storePath)
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: 'original-agent', providerId: 'claude', executorId: 'claude', hostId: 'local',
    workspacePath: root, run: { runId: 'original-run' }, retiredRuns: [], nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'original-native', transcriptPath: transcript },
    hookBindingId: 'original-hook', hookToken: 'synthetic-hook-token', createdAt: 1, updatedAt: 1 })
  await writeFile(transcript, nativeLine('before-sharing', 'Original prior private answer'))
  const wire = platform ? await discordTransport() : undefined; if (wire) cleanup.push(wire.close)
  const env = objectCliEnvironment(root, { pnpm_config_verify_deps_before_run: 'false', AGENTMUX_SPATIAL_STATE_STORE: join(root, 'spatial.json'),
    AGENTMUX_MOBILE_BUILD_DIRECTORY: join(root, 'absent-mobile'), HOST_INDEX_NATIVE_FACTS: join(root, 'native-facts.json'), HOST_INDEX_WORKSPACE: root,
    ...(wire ? { HOST_INDEX_PLATFORM_ORIGIN: wire.origin } : {}) })
  async function start(context: NodeJS.ProcessEnv = { AGENTMUX_CONNECTOR_DIRECTORY: directory }, storeArgument = storePath) {
    const child = spawn(process.execPath, ['--import', preload, entry, '--store', storeArgument], { cwd, env: { ...env, ...context }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', first: any
    let ready!: (value: unknown) => void; const opened = new Promise(done => { ready = done })
    child.stdout.on('data', chunk => { stdout += String(chunk); for (const line of stdout.split('\n')) { try { const value = JSON.parse(line); if (value.protocol === 'jsonrpc-2.0') { first = value; ready(value) } } catch { /* Startup warnings are not owner facts. */ } } })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => child.once('exit', (code, signal) => done({ code, signal })))
    const close = async () => { if (child.exitCode !== null || child.signalCode !== null) return; child.kill('SIGTERM'); await exited }
    cleanup.push(close)
    const wait = async () => { await Promise.race([opened, exited.then(value => { throw Error('Compiled index exited ' + value.code + ': ' + stderr) })]); expect(first, stderr).toBeDefined(); return first }
    const rpc = async () => { const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(root, 'control.sock') } }); cleanup.push(() => client.dispose()); return client }
    return { child, wait, close, exited, opened, rpc, logs: () => stdout + stderr }
  }
  return { root, cwd, directory, transcript, start, wire, native: async () => JSON.parse(await readFile(join(root, 'native-facts.json'), 'utf8')),
    cli: (args: string[], stdin = '') => runCompiledObjectCli(['--endpoint', 'unix:' + join(root, 'control.sock'), ...args], env, stdin) }
}

it('compiled Node index owns protected credentials, official native ingress and public replies after every client exits, then reopens the same namespace', async () => {
  const f = await fixture(true), first = await f.start(), ready = await first.wait(), client = await first.rpc()
  expect(ready.pid).not.toBe(process.pid)
  const fence = { runtimeId: ready.owner.runtimeId, ownerInstanceId: ready.owner.ownerInstanceId }
  const stored = await f.cli(['connection', 'credential', 'store', '--operation-id', 'original-credential', '--secret-stdin'], 'synthetic-discord-token')
  expect(stored.code, stored.stdout + stored.stderr).toBe(0)
  const receipt = JSON.parse(stored.stdout).result; expect(Object.keys(receipt)).toEqual(['credentialRef'])
  expect(await client.call('connection.credential.inspect', { operationId: 'original-credential' }, { runtimeFence: fence })).toEqual({ receipt })
  await expect(client.call('connection.credential.store', { operationId: 'foreign-runtime', secret: 'synthetic-token' }, { runtimeFence: { ...fence, runtimeId: 'foreign-runtime' } })).rejects.toHaveProperty('code')
  const config = { ...discordConfig, credentialRef: receipt.credentialRef }
  await client.call('connection.configure', { operationId: 'original-configure', expectedRevision: null, connection: config })
  expect(await client.call('connection.test', { connectionId: config.connectionId })).toMatchObject({ observation: { authentication: { state: 'ready' } } })
  const metadataInput = { connectionId: config.connectionId, expectedConnectionRevision: 1, subject: { kind: 'conversation' as const, externalConversationId: discordRoomId } }
  expect(await client.call('connection.metadata.refresh', metadataInput)).toMatchObject({ entry: { observation: { profile: { name: 'Original channel' } } } })
  const result = await client.call('connection.bind', { operationId: 'original-bind', bindingId: 'original-binding', connectionId: config.connectionId,
    expectedConnectionRevision: 1, executionHostId: 'local', agentSessionId: 'original-agent', externalConversationId: discordRoomId,
    expectedSource: { providerId: 'claude', nativeSessionId: 'original-native' }, scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } })
  expect(result.state).toBe('applied'); if (result.state !== 'applied') throw Error('Original audience binding not applied')
  await client.call('connection.grant', { operationId: 'original-grant', grantId: 'original-member', bindingId: result.binding.bindingId,
    expectedBindingRevision: 1, expectedRevision: null, actor: { application: config.application, idType: 'snowflake', userId: '400' }, capabilities: ['input'], state: 'active' })
  await client.dispose()
  await vi.waitFor(() => expect(f.wire!.sessions).toHaveLength(1))
  f.wire!.message('701', 'Actual compiled index native input')
  await vi.waitFor(async () => expect((await f.native()).effects).toHaveLength(1), { timeout: 15_000 })
  await appendFile(f.transcript, nativeLine('first-answer', 'Original Node index public reply'))
  const copies = (text: string) => f.wire!.calls.filter(call => call.method === 'POST' && call.path === '/channels/300/messages' && call.body.includes(text)).length
  await vi.waitFor(() => expect(copies('Original Node index public reply')).toBe(1), { timeout: 15_000 })
  const before = await first.rpc(), page = await before.call('connection.ingress.ls', { connectionId: config.connectionId }), record = page.ingresses[0]!
  expect(await before.call('connection.ingress.inspect', { ingressId: record.ingressId })).toMatchObject({ inputReceipt: { status: 'terminal-confirmed', originalControlOperationId: record.input!.operationId } })
  expect((await before.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'original-agent' } })).session.run).toEqual({ runId: 'original-run' })
  await before.dispose(); await first.close()
  const second = await f.start(), reopened = await second.wait(), next = await second.rpc()
  expect(reopened.owner.runtimeId).toBe(ready.owner.runtimeId); expect(reopened.owner.ownerInstanceId).not.toBe(ready.owner.ownerInstanceId)
  await expect(next.call('connection.credential.inspect', { operationId: 'original-credential' }, { runtimeFence: fence })).rejects.toHaveProperty('code')
  const repeated = await f.cli(['connection', 'credential', 'store', '--operation-id', 'original-credential', '--secret-stdin'], 'synthetic-discord-token')
  expect(repeated.code, repeated.stdout + repeated.stderr).toBe(0); expect(JSON.parse(repeated.stdout).result).toEqual(receipt)
  expect(await next.call('connection.metadata.get', { connectionId: config.connectionId, subject: metadataInput.subject })).toMatchObject({ entry: { observation: { profile: { name: 'Original channel' } } } })
  expect((await next.call('connection.ingress.ls', { connectionId: config.connectionId })).ingresses.map(value => [value.ingressId, value.input])).toEqual(page.ingresses.map(value => [value.ingressId, value.input]))
  await next.dispose(); await vi.waitFor(() => expect(f.wire!.sessions).toHaveLength(2))
  f.wire!.message('701', 'Actual compiled index native input')
  f.wire!.message('702', 'A new original input after restart')
  await vi.waitFor(async () => expect((await f.native()).effects).toHaveLength(2), { timeout: 15_000 })
  await appendFile(f.transcript, nativeLine('second-answer', 'Reply after original index restart'))
  await vi.waitFor(() => expect(copies('Reply after original index restart')).toBe(1), { timeout: 15_000 })
  expect(copies('Original Node index public reply')).toBe(1); expect(copies('Original prior private answer')).toBe(0)
  expect((await f.native()).lifecycle.filter((value: any) => value.name === 'stop')).toEqual([])
  expect((await stat(f.directory)).mode & 0o777).toBe(0o700); expect((await stat(join(f.directory, 'connections.sqlite'))).mode & 0o777).toBe(0o600)
  expect(first.logs() + second.logs() + stored.stdout + stored.stderr).not.toContain('synthetic-discord-token')
  facts.push({ case: 'compiled-index-client-exit-reopen', owner: ready.owner, reopenedOwner: reopened.owner, originalIngressId: record.ingressId,
    sameOperationAndRef: true, desktopAbsent: true, nativeEffects: 2, publicReplyCopies: [copies('Original Node index public reply'), copies('Reply after original index restart')], healthyRun: 'original-run' })
})

it.each([
  ['bare-core', {}],
  ['relative-namespace', { AGENTMUX_CONNECTOR_DIRECTORY: 'relative-connections' }],
  ['missing-namespace-with-Mote', { AGENTMUX_MOTE_CONFIGURATION_PATH: (new URL('file:///').pathname + "synthetic/original-config.json") }]
] as const)('compiled index keeps the original Core usable with %s and never writes connector files under cwd', async (kind, context) => {
  const f = await fixture(), host = await f.start(context), ready = await host.wait(), rpc = await host.rpc()
  expect((await rpc.call('runtime.owner.identity', {})).owner).toEqual(ready.owner)
  expect((await rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'original-agent' } })).session.run).toEqual({ runId: 'original-run' })
  await expect(rpc.call('connection.ls', {})).rejects.toMatchObject({ code: kind === 'bare-core' ? 'CONTROL_UNAVAILABLE' : 'CONNECTION_STORAGE_UNAVAILABLE' })
  expect(await readdir(f.cwd)).toEqual([])
  facts.push({ case: kind, originalCoreAvailable: true, connectorUnavailable: true, cwdUnchanged: true })
})

it('compiled index isolates an invalid Mote configuration from healthy group services and refuses only the original Mote operation', async () => {
  for (const path of ['', 'relative-original-config.json']) {
    const f = await fixture(), host = await f.start({ AGENTMUX_CONNECTOR_DIRECTORY: f.directory, AGENTMUX_MOTE_CONFIGURATION_PATH: path })
    await host.wait(); const rpc = await host.rpc()
    expect((await rpc.call('connection.ls', {})).connections).toEqual([])
    await expect(rpc.call('space.mote.chat.configure', { operationId: 'invalid-Mote-source', expectedRevision: null, expectedConnectionRevision: null,
      target: { spaceId: 'original-space', zoneId: 'original-zone', expectedResource: { hostId: 'local', workspaceId: 'original-workspace', workspacePath: f.root } },
      values: { enabled: false, connection: null, conversationIdleMs: 60_000, strangerMessageLimit: 0 }
    })).rejects.toMatchObject({ code: 'MOTE_CHAT_TARGET_UNCONFIRMED' })
    expect((await rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'original-agent' } })).session.run).toEqual({ runId: 'original-run' })
    expect(await readdir(f.cwd)).toEqual([])
    facts.push({ case: path ? 'relative-Mote-only-failure' : 'empty-Mote-only-failure', groupServiceAvailable: true, originalCoreAvailable: true, exactMoteRefused: true, cwdUnchanged: true })
    await rpc.dispose(); await host.close()
  }
})

it('compiled index refuses a different original Store argument without adopting another namespace', async () => {
  const f = await fixture(), host = await f.start(undefined, join(f.root, 'foreign-sessions.json'))
  const outcome = await Promise.race([host.exited.then(exit => ({ kind: 'exited', ...exit })), host.opened.then(() => ({ kind: 'opened', code: 0 }))])
  expect(outcome.kind, host.logs()).toBe('exited'); expect(outcome.code, host.logs()).not.toBe(0); expect(host.logs()).toContain('The Host Store argument and original namespace do not agree.')
  await expect(stat(join(f.root, 'control.sock'))).rejects.toMatchObject({ code: 'ENOENT' })
  facts.push({ case: 'mismatched-original-namespace', startupRefused: true, noForeignOwner: true })
})
