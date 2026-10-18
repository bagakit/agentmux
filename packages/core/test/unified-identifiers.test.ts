import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { Script } from 'node:vm'
import { randomClientRequestId } from '../src/client-request-id.js'
import { mintObjectId } from '../src/object-id.js'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { parseMoteAvatarOperationId } from '../src/mote-avatar-write.js'
import { capturedHistorySchema, beginCapturedStream } from '../src/captured-history.js'
import { ConversationReaderState } from '../src/conversation-reader.js'
import { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { createPiManagedHookPlan } from '../src/providers/pi.js'
import { createOpenCodeManagedHookPlan } from '../src/providers/opencode.js'
import { claudeNativeActivitySource } from '../src/providers/claude-native-activity.js'
import { READ_CORE_MAINTENANCE } from '../src/remote-core-upgrade-programs.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli, ObjectCliProbe } from './helpers/object-cli-rpc.js'
import * as processRunner from '../src/process-runner.js'
import { prepareCodexManagedLaunch } from '../src/providers/codex-native-input.js'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'

const canonical = /^[1-9A-HJ-NP-Za-km-z]{12}$/u
const legacy = 'fc69400b-bc24-4915-b35f-01a26a085af9'
const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'amux-identifiers-'))
  cleanups.push(() => rm(root, { recursive: true, force: true })); return root
}

it('uses the common portable request allocator without requiring randomUUID on local HTTP', async () => {
  const native = globalThis.crypto
  vi.stubGlobal('crypto', { getRandomValues: native.getRandomValues.bind(native) })
  try {
    const ids = Array.from({ length: 4 }, randomClientRequestId)
    expect(ids.every(id => canonical.test(id))).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  } finally { vi.stubGlobal('crypto', native) }
  const fresh = await parseAgentMuxCliInvocation(['agent', 'send', '--to-session', 'original-recipient', '--text', 'original'])
  expect(fresh.params.operationId).toMatch(canonical)
  const retained = await parseAgentMuxCliInvocation(['agent', 'send', '--to-session', 'original-recipient', '--text', 'original', '--operation-id', legacy])
  expect(retained.params.operationId).toBe(legacy)
})

it('admits new and original avatar operation identities while refusing path and unbounded inputs', () => {
  for (const id of [mintObjectId(), legacy, 'original-retained-operation']) expect(() => parseMoteAvatarOperationId(id)).not.toThrow()
  for (const id of ['', '.', '..', '../other', 'other/name', 'other\\name', 'x'.repeat(129), 'a\nb', 'a\0b', 'original\n', 'original\r', 'original\r\n']) {
    expect(() => parseMoteAvatarOperationId(id)).toThrow()
  }
})

it('keeps stored captured epochs byte-exact across database reopen and mints only a new stream', async () => {
  const path = join(await directory(), 'captured.sqlite')
  let db = new DatabaseSync(path); db.exec(capturedHistorySchema)
  const first = beginCapturedStream(db, 'new-session', null)
  expect(first.epoch).toMatch(canonical)
  db.prepare("INSERT INTO captured_streams VALUES (?,?,0,0,'preparing','beginning','[]',NULL,NULL,0)").run('original-session', legacy)
  db.close(); db = new DatabaseSync(path)
  try {
    expect(beginCapturedStream(db, 'new-session', null).epoch).toBe(first.epoch)
    expect(beginCapturedStream(db, 'original-session', null).epoch).toBe(legacy)
  } finally { db.close() }
})

it('allocates reading and lifecycle references in their original owners', async () => {
  const state = new ConversationReaderState(), ref = { hostId: 'local', agentSessionId: legacy }
  const view = state.create(ref, { ...ref, scope: { sources: [] }, cuts: [] })
  expect(view.id).toMatch(canonical)
  expect(state.get(view.id, ref, view.scope)).toBe(view)
  const registry = new AgentMuxAgentSessionRegistry(new AgentMuxMemoryAgentSessionStore())
  const reservation = await registry.reserveNew('original-session', legacy)
  expect(reservation.reservationId).toMatch(canonical)
  expect(reservation.ownerId).toMatch(canonical)
  expect(reservation.operationId).toBe(legacy)
  expect(reservation.agentSessionId).toBe('original-session')
})

it('keeps an actual Provider reading window addressable through its original public continuation', async () => {
  const f = await nativeHistoryFixture('claude', jsonl([{ type: 'user', uuid: legacy, sessionId: 'native-main',
    message: { role: 'user', content: 'Original native record' } }]))
  cleanups.push(f.close)
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const first = await f.client.readAgentConversation(ref)
  expect(first.window.id).toMatch(canonical)
  expect(first.window.view).toBeTypeOf('string')
  const continued = await f.client.readAgentConversation({ ...ref, view: first.window.view! })
  expect(continued.window.id).toBe(first.window.id)
  expect(continued.window.itemCount).toBe(first.window.itemCount)
  expect((await f.bytes()).native).toEqual(f.before.native)
  expect(f.controls.every(control => control.mock.calls.length === 0)).toBe(true)
})

it('executes generated Pi and OpenCode senders with per-event common IDs and one original retry identity', async () => {
  for (const provider of ['pi', 'opencode'] as const) {
    const root = await directory()
    const source = provider === 'pi' ? createPiManagedHookPlan({ PI_CODING_AGENT_DIR: root }).mutations[0]!.content
      : createOpenCodeManagedHookPlan('http://127.0.0.1/private', 'original-private-token', { OPENCODE_CONFIG_DIR: root }).mutations[0]!.content
    const file = join(root, 'hook.mjs'); await writeFile(file, source)
    const module = await import(/* @vite-ignore */ pathToFileURL(file).href)
    const attempts: Array<{ receiptId: string }> = []
    const original = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      attempts.push(JSON.parse(String(init.body)))
      return new Response(attempts.length === 1 ? JSON.stringify({ accepted: false, stage: 'admission' }) : null,
        { status: attempts.length === 1 ? 429 : 204, headers: { 'retry-after': '0' } })
    }) as typeof fetch
    vi.stubEnv('AGENTMUX_HOOK_URL', 'http://127.0.0.1/private'); vi.stubEnv('AGENTMUX_HOOK_TOKEN', 'original-private-token')
    try {
      let event: () => unknown
      if (provider === 'pi') {
        const handlers = new Map<string, (...args: unknown[]) => unknown>()
        module.default({ on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler) })
        event = () => handlers.get('agent_start')!({}, {})
      } else {
        const plugin = await module.server()
        event = () => plugin.event({ event: { type: 'session.status', properties: { status: { type: 'busy' } } } })
      }
      await event(); await vi.waitFor(() => expect(attempts).toHaveLength(2))
      await event(); await vi.waitFor(() => expect(attempts).toHaveLength(3))
      expect(attempts.map(a => a.receiptId).every(id => canonical.test(id))).toBe(true)
      expect(attempts[0]!.receiptId).toBe(attempts[1]!.receiptId)
      expect(attempts[2]!.receiptId).not.toBe(attempts[0]!.receiptId)
    } finally { globalThis.fetch = original }
  }
})

it('executes a separate Claude observer generation for each runtime while preserving native identities', async () => {
  const source = claudeNativeActivitySource(), sources: string[] = []
  for (const _ of [0, 1]) {
    const file = join(await directory(), 'observer.mjs'); await writeFile(file, source)
    const module = await import(/* @vite-ignore */ pathToFileURL(file).href)
    const handlers = new Map<string, (...args: unknown[]) => unknown>(), payloads: Array<Record<string, unknown>> = []
    module.register((name: string, handler: (...args: unknown[]) => unknown) => { handlers.set(name, handler); return { catch() {} } })
    const api = { env: { get: async () => '1' }, session: { id: async () => legacy },
      process: { run: async (_args: unknown, input: { stdin: string }) => { payloads.push(JSON.parse(input.stdin)); return { exitCode: 0, stderr: '' } } }, ui: { log() {} } }
    await handlers.get('session.start')!(api, {}, (event: unknown) => event)
    await handlers.get('turn.start')!(api, { turnId: 'original-native-turn' }, (event: unknown) => event)
    await vi.waitFor(() => expect(payloads).toHaveLength(1))
    expect(payloads[0]).toMatchObject({ session_id: legacy, turnId: 'original-native-turn' })
    expect(payloads[0]!.sourceId).toMatch(canonical)
    sources.push(payloads[0]!.sourceId as string)
  }
  expect(sources[0]).not.toBe(sources[1])
  // The remote program is CJS without a workspace resolver. Its embedded allocator
  // must execute before any original owner/path inspection, not be a quoted label.
  const prefix = READ_CORE_MAINTENANCE.slice(0, READ_CORE_MAINTENANCE.indexOf("const fs=require"))
  const id = new Script(prefix + '\nmintObjectId()').runInNewContext({ crypto: globalThis.crypto })
  expect(id).toMatch(canonical)
  expect(READ_CORE_MAINTENANCE).toContain("consumerId:'core-upgrade-inspect-'+mintObjectId()")
})

it('carries new operation IDs through the compiled CLI and real Core journal, then reads the same original operation', async () => {
  const h = await rpcOwnerFixture(['identifier-author', 'identifier-recipient']); cleanups.push(h.close)
  const server = new AgentMuxControlServer({ socketPath: join(h.root, 'control.sock'), coreClients: h.coreClients })
  await server.start(); cleanups.push(() => server.stop())
  const env = objectCliEnvironment(h.root, { AGENTMUX_AGENT_SESSION_ID: h.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: h.credentials.capability })
  const sent = await runCompiledObjectCli(['--endpoint', `unix:${server.path}`, 'agent', 'send', '--to-session', 'identifier-recipient', '--text', 'original-body'], env)
  expect(sent.code, sent.stderr).toBe(0)
  const saved = JSON.parse(sent.stdout).result
  expect(saved.envelope.operationId).toMatch(canonical)
  const read = await runCompiledObjectCli(['--endpoint', `unix:${server.path}`, 'message', 'read', '--operation-id', saved.envelope.operationId], env)
  expect(read.code, read.stderr).toBe(0)
  expect(JSON.parse(read.stdout).result.message.envelope).toEqual(saved.envelope)
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: h.credentials }); cleanups.push(() => rpc.dispose())
  const sub = await rpc.subscribe('agent.output', { agentSessionId: 'identifier-recipient', follow: true }, { onEvent() {} })
  expect(sub.subscriptionId).toMatch(canonical); await sub.dispose()
})

it('uses the common allocator for actual CLI and public client wire requests independent of business operations', async () => {
  const probe = new ObjectCliProbe(); await probe.start(); cleanups.push(() => probe.stop())
  const result = await probe.run(['--endpoint', `unix:${probe.socketPath}`, 'agent', 'send', '--to-session', 'original-recipient', '--text', 'original'])
  expect(result.code).toBe(1)
  expect(probe.requests).toHaveLength(1)
  expect(probe.requests[0]!.id).toMatch(canonical)
  expect(probe.requests[0]!.params.operationId).toMatch(canonical)
  expect(probe.requests[0]!.id).not.toBe(probe.requests[0]!.params.operationId)
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: probe.socketPath } }); cleanups.push(() => rpc.dispose())
  await expect(rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: legacy } })).rejects.toMatchObject({ code: 'CLI_ROUTE_PROBE' })
  expect(probe.requests).toHaveLength(2)
  expect(probe.requests[1]!.id).toMatch(canonical)
})

it.runIf(process.platform === 'darwin')('uses ordinary IDs for the original qualified native actor while retaining its separate authentication secret', async () => {
  const version = vi.spyOn(processRunner, 'runProcess').mockResolvedValue({ exitCode: 0, stdout: 'codex-cli 0.163.0\n', stderr: '' })
  const plan = { command: process.execPath, args: ['--no-alt-screen'], env: {} }
  const first = await prepareCodexManagedLaunch(plan, legacy, { kind: 'create' })
  const second = await prepareCodexManagedLaunch(plan, 'second-original-operation', { kind: 'create' })
  expect(version).toHaveBeenCalledWith(plan.command, ['--version'], expect.any(Object))
  expect(first.nativeActor?.actorId).toMatch(canonical)
  expect(second.nativeActor?.actorId).toMatch(canonical)
  expect(first.nativeActor?.actorId).not.toBe(second.nativeActor?.actorId)
  expect(first.nativeActor?.lifecycleOperationId).toBe(legacy)
  expect(first.nativeActor?.token).toMatch(/^[a-f0-9]{64}$/u)
  expect(first.nativeActor?.launch).toEqual({ command: plan.command, args: plan.args })
})

it('builds an executable public CLI bundle without eagerly evaluating the managed native worker', async () => {
  const root = resolve(import.meta.dirname, '../../..'), target = join(await directory(), 'cli.mjs')
  const require = createRequire(join(root, 'packages/core/package.json'))
  const { build } = require('esbuild') as typeof import('esbuild')
  await symlink(join(root, 'packages/core/node_modules'), join(resolve(target, '..'), 'node_modules'), 'dir')
  await build({ entryPoints: [fileURLToPath(new URL('../src/agentmux.ts', import.meta.url))], outfile: target,
    platform: 'node', format: 'esm', packages: 'external', bundle: true, logLevel: 'silent' })
  const execute = promisify(execFile)
  await expect(execute(process.execPath, ['--check', target])).resolves.toMatchObject({ stderr: '' })
  const help = await execute(process.execPath, [target, '--help'])
  expect(help.stderr).toBe('')
  expect(help.stdout).toContain('amux')
})
