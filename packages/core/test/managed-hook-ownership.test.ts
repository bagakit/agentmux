import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentManagedHookInstaller, type AgentManagedHookPlan } from '../src/managed-hook-installer'
import { AgentMuxClient } from '../src/client'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store'
import { AgentProviderRegistry } from '../src/agent-provider'

const fault = vi.hoisted(() => ({ registrationPath: null as string | null, beforeRename: null as null | ((from: string, to: string) => Promise<void>) }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    await fault.beforeRename?.(String(args[0]), String(args[1]))
    if (args[1] === fault.registrationPath) throw Object.assign(new Error('Interrupted ownership restoration'), { code: 'EIO' })
    return actual.rename(...args)
  } }
})

const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { fault.registrationPath = null; fault.beforeRename = null; for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const leaf = (command: string) => ({ type: 'command', command, timeout: 10 })
const declaration = (command: string) => ({ matcher: 'exact-subject', hooks: [leaf(command)] })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'managed-hook-ownership-')); closes.push(() => rm(root, { recursive: true, force: true }))
  const state = join(root, 'receipts'), target = join(root, 'hooks.json')
  const installer = () => new AgentManagedHookInstaller(state)
  const plan = (command: string, providerId = 'codex'): AgentManagedHookPlan => ({ providerId, mutations: [{ path: target,
    content: JSON.stringify({ hooks: { Stop: [declaration(command)] } }), merge: { kind: 'json-managed-events' } }] })
  const read = async () => JSON.parse(await readFile(target, 'utf8'))
  const registration = async () => {
    const name = (await readdir(join(state, 'receipts'))).find(name => name.endsWith('.ownership.json'))!
    const path = join(state, 'receipts', name)
    return { path, value: JSON.parse(await readFile(path, 'utf8')) }
  }
  return { root, state, target, installer, plan, read, registration }
}

it('a fresh installer replaces only its exact added leaf and uninstall restores both target and ownership', async () => {
  const f = await fixture(), foreign = { matcher: 'user', hooks: [leaf('foreign-collector')] }
  await writeFile(f.target, JSON.stringify({ label: 'User label', hooks: { Stop: [foreign] } }))
  const a = (await f.installer().ensure(f.plan('owned-a')))!
  const first = await f.read(), own = first.hooks.Stop.find((entry: any) => entry.matcher === 'exact-subject')
  own.hooks.push(leaf('foreign-sibling')); await writeFile(f.target, JSON.stringify(first))
  const before = await readFile(f.target, 'utf8')
  expect((await f.installer().inspect(f.plan('owned-b'))).status).toBe('not_installed')
  const b = (await f.installer().ensure(f.plan('owned-b')))!
  const next = await f.read()
  expect(next.label).toBe('User label'); expect(next.hooks.Stop[0]).toEqual(foreign)
  expect(next.hooks.Stop.flatMap((entry: any) => entry.hooks.map((hook: any) => hook.command)), 'Only the proven previous collector may be replaced').toEqual(['foreign-collector', 'foreign-sibling', 'owned-b'])
  expect(await f.installer().ensure(f.plan('owned-b'))).toBeNull()
  await f.installer().uninstall(b); expect(await readFile(f.target, 'utf8')).toBe(before)
  await f.installer().ensure(f.plan('owned-c'))
  expect((await f.read()).hooks.Stop.flatMap((entry: any) => entry.hooks.map((hook: any) => hook.command))).toEqual(['foreign-collector', 'foreign-sibling', 'owned-c'])
  expect(a.entries).toHaveLength(1)
})

it('already-current and historical-looking declarations are never claimed merely by presence', async () => {
  const f = await fixture()
  await writeFile(f.target, JSON.stringify({ hooks: { Stop: [declaration('owned-a'), declaration('historical-looking-command')] } }))
  const before = await readFile(f.target)
  expect(await f.installer().ensure(f.plan('owned-a'))).toBeNull()
  expect(await readFile(f.target)).toEqual(before)
  await expect(stat(f.state)).rejects.toMatchObject({ code: 'ENOENT' })
  await f.installer().ensure(f.plan('owned-b'))
  expect((await f.read()).hooks.Stop.map((entry: any) => entry.hooks[0].command)).toEqual(['owned-a', 'historical-looking-command', 'owned-b'])
  await f.installer().ensure(f.plan('owned-c'))
  expect((await f.read()).hooks.Stop.map((entry: any) => entry.hooks[0].command)).toEqual(['owned-a', 'historical-looking-command', 'owned-c'])
})

it('manual changes and provider/target scopes retain their original callbacks', async () => {
  const f = await fixture(); await f.installer().ensure(f.plan('owned-a'))
  const current = await f.read(); current.hooks.Stop[0].hooks[0].timeout = 20
  await writeFile(f.target, JSON.stringify(current)); await f.installer().ensure(f.plan('owned-b'))
  expect((await f.read()).hooks.Stop[0]).toEqual(current.hooks.Stop[0])
  await f.installer().ensure(f.plan('other-provider', 'claude'))
  expect((await f.read()).hooks.Stop.map((entry: any) => entry.hooks[0].command)).toEqual(['owned-a', 'owned-b', 'other-provider'])
  const second = { ...f.plan('owned-c'), mutations: f.plan('owned-c').mutations.map(mutation => ({ ...mutation, path: join(f.root, 'other.json') })) }
  await f.installer().ensure(second)
  expect((await f.read()).hooks.Stop.map((entry: any) => entry.hooks[0].command)).toEqual(['owned-a', 'owned-b', 'other-provider'])
})

it('an existing current foreign declaration stays unowned when the previous owned declaration disappears', async () => {
  const f = await fixture(); await f.installer().ensure(f.plan('owned-a'))
  await writeFile(f.target, f.plan('foreign-b').mutations[0]!.content)
  const before = await readFile(f.target)
  await f.installer().ensure(f.plan('foreign-b'))
  expect(await readFile(f.target)).toEqual(before)
  await f.installer().ensure(f.plan('owned-c'))
  expect((await f.read()).hooks.Stop.map((entry: any) => entry.hooks[0].command)).toEqual(['foreign-b', 'owned-c'])
})

it('a new event scope retires the old owned event and preserves duplicate manually added declarations', async () => {
  const f = await fixture(); await f.installer().ensure(f.plan('owned-a'))
  const next = { providerId: 'codex', mutations: [{ path: f.target, content: JSON.stringify({ hooks: { NewEvent: [declaration('owned-b')] } }), merge: { kind: 'json-managed-events' as const } }] }
  await f.installer().ensure(next)
  expect((await f.read()).hooks.Stop).toEqual([])
  const before = await f.read(); before.hooks.NewEvent.push(declaration('owned-b')); await writeFile(f.target, JSON.stringify(before))
  await f.installer().ensure(f.plan('owned-c'))
  expect((await f.read()).hooks.NewEvent).toEqual(before.hooks.NewEvent)
  expect((await f.read()).hooks.Stop[0].hooks[0].command).toBe('owned-c')
})

it.each(['json-root-managed-events', 'yaml-managed-events', 'json-managed-approvals'] as const)('fresh ownership respects the existing %s format and foreign siblings', async kind => {
  const f = await fixture()
  const document = kind === 'json-managed-approvals' ? { approvals: [{ event: 'Stop', command: 'foreign', note: 'user note' }] }
    : kind === 'json-root-managed-events' ? { Stop: [leaf('foreign')], Future: { unknown: true } }
      : { hooks: { Stop: [leaf('foreign')], Future: { unknown: true } } }
  await writeFile(f.target, kind === 'yaml-managed-events' ? '# keep user comment\n' + stringify(document) : JSON.stringify(document))
  const plan = (command: string): AgentManagedHookPlan => ({ providerId: 'private-provider', mutations: [{ path: f.target, merge: { kind },
    content: JSON.stringify(kind === 'json-managed-approvals' ? { approvals: [{ event: 'Stop', command }] }
      : kind === 'json-root-managed-events' ? { Stop: [leaf(command)] } : { hooks: { Stop: [leaf(command)] } }) }] })
  await f.installer().ensure(plan('owned-a')); await f.installer().ensure(plan('owned-b'))
  const bytes = await readFile(f.target, 'utf8'), result = kind === 'yaml-managed-events' ? parse(bytes) : JSON.parse(bytes)
  const commands = kind === 'json-managed-approvals' ? result.approvals.map((entry: any) => entry.command)
    : (kind === 'json-root-managed-events' ? result.Stop : result.hooks.Stop).map((entry: any) => entry.command)
  expect(commands, 'Native formats must retire only the original owned collector').toEqual(['foreign', 'owned-b'])
  if (kind === 'yaml-managed-events') { expect(bytes).toContain('# keep user comment'); expect(result.hooks.Future).toEqual({ unknown: true }) }
  if (kind === 'json-managed-approvals') expect(result.approvals[0]).toEqual(document.approvals![0])
})

it.each(['before', 'after'] as const)('a fresh process resolves a pending %s target by exact bytes without accumulating collectors', async stage => {
  const f = await fixture(); await f.installer().ensure(f.plan('owned-a'))
  const before = await readFile(f.target, 'utf8')
  await f.installer().ensure(f.plan('owned-b'))
  const registered = await f.registration(); registered.value.committed = false
  await writeFile(registered.path, JSON.stringify(registered.value))
  if (stage === 'before') await writeFile(f.target, before)
  const target = await readFile(f.target), metadata = await readFile(registered.path)
  await f.installer().inspect(f.plan('owned-c'))
  expect(await readFile(f.target)).toEqual(target); expect(await readFile(registered.path)).toEqual(metadata)
  const outcome = await Promise.allSettled([f.installer().ensure(f.plan('owned-c'))])
  expect(outcome[0]!.status, 'Pending ownership must recover the exact source generation').toBe('fulfilled')
  expect((await f.read()).hooks.Stop.map((entry: any) => entry.hooks[0].command), 'Pending ownership must recover the committed source generation').toEqual(['owned-c'])
})

it('uninstall interruption restores target before ownership and keeps the original receipt recoverable', async () => {
  const f = await fixture(); await f.installer().ensure(f.plan('owned-a'))
  const before = await readFile(f.target)
  const b = (await f.installer().ensure(f.plan('owned-b')))!, original = await f.registration(), bytes = await readFile(original.path)
  fault.registrationPath = original.path
  await expect(f.installer().uninstall(b)).rejects.toThrow('Interrupted ownership restoration')
  fault.registrationPath = null
  expect(await readFile(f.target), 'Uninstall restores target before ownership').toEqual(before)
  expect(await readFile(original.path)).toEqual(bytes)
  expect((await stat(b.entries[0]!.backupPath!)).isFile()).toBe(true)
  await f.installer().ensure(f.plan('owned-c'))
  expect((await f.read()).hooks.Stop[0].hooks[0].command).toBe('owned-c')
  expect((await f.read()).hooks.Stop).toHaveLength(1)
})

it('legal large native declarations retain their separate larger receipt budget across fresh instances', async () => {
  const f = await fixture(), body = '\\'.repeat(50000)
  await f.installer().ensure(f.plan(body + 'a')); await f.installer().ensure(f.plan(body + 'b'))
  const saved = await f.registration()
  expect((await stat(f.target)).size).toBeLessThan(256 * 1024)
  expect((await stat(saved.path)).size, 'JSON encoded ownership bodies require the receipt budget, not the native budget').toBeGreaterThan(256 * 1024)
  expect((await f.installer().inspect(f.plan(body + 'b'))).status, 'Legal original native declarations must remain inspectable').toBe('installed')
  await f.installer().ensure(f.plan(body + 'c'))
  expect((await f.read()).hooks.Stop).toHaveLength(1)
  expect((await f.read()).hooks.Stop[0].hooks[0].command).toBe(body + 'c')
})

it('a legal YAML target can retain an owned JSON fragment larger than the native file budget', async () => {
  const f = await fixture(), content = JSON.stringify({ hooks: { Stop: [{ hooks: Array.from({ length: 6500 }, (_value, index) => ({ command: `collector-${index}` })) }] } })
  expect(Buffer.byteLength(content)).toBeLessThan(256 * 1024)
  const plan: AgentManagedHookPlan = { providerId: 'private-provider', mutations: [{ path: f.target, content, merge: { kind: 'yaml-managed-events' } }] }
  await f.installer().ensure(plan)
  expect((await stat(f.target)).size).toBeLessThan(256 * 1024)
  const saved = await f.registration()
  expect(Buffer.byteLength(saved.value.after.content)).toBeGreaterThan(256 * 1024)
  expect((await f.installer().inspect(plan)).status, 'Legal YAML source must keep its larger exact ownership fragment').toBe('installed')
  expect(await f.installer().ensure(plan)).toBeNull()
})

it('unknown pending edits preserve callbacks and report a scoped recovery failure without a rewrite', async () => {
  const f = await fixture(); await f.installer().ensure(f.plan('owned-a')); await f.installer().ensure(f.plan('owned-b'))
  const registered = await f.registration(); registered.value.committed = false
  await writeFile(registered.path, JSON.stringify(registered.value))
  const edited = await f.read(); edited.userEdit = true; await writeFile(f.target, JSON.stringify(edited))
  const target = await readFile(f.target), metadata = await readFile(registered.path)
  expect(await f.installer().inspect(f.plan('owned-c'))).toMatchObject({ status: 'error', targets: [{ code: 'HOOK_REGISTRATION_UNCONFIRMED' }] })
  await expect(f.installer().ensure(f.plan('owned-c'))).rejects.toMatchObject({ code: 'HOOK_REGISTRATION_UNCONFIRMED' })
  expect(await readFile(f.target)).toEqual(target); expect(await readFile(registered.path)).toEqual(metadata)
})

it('preview binds both target and owner generations', async () => {
  const f = await fixture(); await f.installer().ensure(f.plan('owned-a'))
  const stale = f.installer(), preview = await stale.preview(f.plan('owned-b'))
  const registered = await f.registration(); registered.value.after.receiptId = 'changed-receipt'
  await writeFile(registered.path, JSON.stringify(registered.value))
  await expect(stale.install(preview.id)).rejects.toMatchObject({ code: 'HOOK_TARGET_CHANGED' })
  expect((await f.read()).hooks.Stop[0].hooks[0].command).toBe('owned-a')
  const other = f.installer(), next = await other.preview(f.plan('owned-b'))
  await writeFile(f.target, '{"userEdit":true}\n')
  await expect(other.install(next.id)).rejects.toMatchObject({ code: 'HOOK_TARGET_CHANGED' })
  expect(await readFile(f.target, 'utf8')).toBe('{"userEdit":true}\n')
})

it.each([false, true])('same target writers use one stable OS lock across private receipt roots=%s', async separateRoot => {
  const f = await fixture(); await f.installer().ensure(f.plan('owned-a'))
  const first = f.installer(), second = separateRoot ? new AgentManagedHookInstaller(join(f.root, 'other-receipts')) : f.installer()
  const firstPreview = await first.preview(f.plan('owned-b')), secondPreview = await second.preview(f.plan('owned-c'))
  const original = await f.registration(), target = await readFile(f.target), metadata = await readFile(original.path)
  const inode = (await stat(f.target + '.agentmux.lock')).ino
  let entered!: () => void, release!: () => void
  const paused = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  fault.beforeRename = async (from, to) => {
    if (to !== original.path) return
    const value = JSON.parse(await readFile(from, 'utf8'))
    if (value.after.receiptId === firstPreview.id && !value.committed) { entered(); await gate }
  }
  const writing = first.install(firstPreview.id)
  await paused
  try {
    const result = await Promise.allSettled([second.install(secondPreview.id)])
    expect(result[0]!.status, 'Only one writer may pass the same native target write boundary').toBe('rejected')
    expect((result[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'HOOK_TARGET_BUSY' })
    expect(await readFile(f.target)).toEqual(target); expect(await readFile(original.path)).toEqual(metadata)
  } finally { fault.beforeRename = null; release(); await writing }
  await f.installer().ensure(f.plan('owned-c'))
  expect((await f.read()).hooks.Stop.map((entry: any) => entry.hooks[0].command)).toEqual(['owned-c'])
  expect((await stat(f.target + '.agentmux.lock')).ino).toBe(inode)
})

it('actual Core create and same-Run continuity consume the changed declaration once, and public inspect stays read-only', async () => {
  const f = await fixture(), runtime = join(f.root, 'runtime'), workspace = join(f.root, 'workspace'), cli = join(f.root, 'native-reader.mjs'), trace = join(f.root, 'trace.ndjson')
  await mkdir(runtime); await mkdir(workspace); await writeFile(trace, '')
  for (const key of Object.keys(process.env).filter(key => key.startsWith('AGENTMUX_'))) vi.stubEnv(key, undefined)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', runtime); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(f.root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(f.root, 'messages.ndjson'))
  await writeFile(cli, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs'
if (process.argv.includes('--version')) { console.log('private native reader'); process.exit(0) }
const read = () => appendFileSync(process.env.PRIVATE_TRACE, JSON.stringify({ pid:process.pid, hooks:JSON.parse(readFileSync(process.env.PRIVATE_TARGET,'utf8')).hooks.Stop })+'\\n')
process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', () => read()); read()
`, { mode: 0o700 })
  const daemon = spawn(fileURLToPath(new URL('../vendor/ctxmux/darwin-arm64/bin/ctxmuxd', import.meta.url)), ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(f.root, 'daemon'), '--readiness-fd', '3'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  const exited = once(daemon, 'exit'), clients: AgentMuxClient[] = []
  closes.push(async () => { await Promise.all(clients.map(client => client.dispose())); daemon.kill('SIGTERM'); const timer = setTimeout(() => daemon.kill('SIGKILL'), 2000); try { await exited } finally { clearTimeout(timer) } })
  await once(daemon.stdio[3]!, 'data')
  const provider = new AgentProviderRegistry().get('claude')
  let current = 'owned-a'
  provider.planManagedHooks = () => f.plan(current, 'claude')
  const create = async () => { const client = new AgentMuxClient({ providers: [provider], store: new AgentMuxFileAgentSessionStore(join(f.root, 'sessions.json')), hookInstaller: f.installer() }); clients.push(client); await client.connect(); return client }
  const first = await create(), session = await first.createAgent({ agentSessionId: 'private-hook-owner', createOperationId: 'create-hook-owner', providerId: 'claude', executorId: 'private-reader', workspacePath: workspace, commandOverride: cli, injectAgentMuxGuide: false, env: { PRIVATE_TRACE: trace, PRIVATE_TARGET: f.target } })
  const traces = async () => (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  await vi.waitFor(async () => expect((await traces()).length).toBeGreaterThan(0))
  const original = await first.statusAgent(session.agentSessionId), pid = (await traces())[0].pid
  current = 'owned-b'; await first.dispose()
  const fresh = await create()
  const result = await fresh.ensureAgentContinuity({ agentSessionId: session.agentSessionId, expectedRun: session.run, operationId: 'same-run-hook-owner', commandOverride: cli, env: { PRIVATE_TRACE: trace, PRIVATE_TARGET: f.target } })
  expect(result.kind).toBe('reattachable')
  const inspectedBefore = await readFile(f.target), inspected = await fresh.inspectManagedHooks('claude', { workspacePath: workspace, env: {} })
  expect(inspected.status).toBe('installed'); expect(await readFile(f.target)).toEqual(inspectedBefore)
  const ack = await fresh.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: session.run, source: 'user', data: 'read-current-hooks\r' })
  expect(ack.acceptedThroughByte).toBeGreaterThan(0)
  await vi.waitFor(async () => expect((await traces()).length).toBeGreaterThan(1))
  const consumed = (await traces()).at(-1)
  expect(consumed.hooks.flatMap((entry: any) => entry.hooks.map((hook: any) => hook.command)), 'A live native consumer must see one current owned collector after continuity').toEqual(['owned-b'])
  expect(consumed.pid).toBe(pid); expect((await fresh.statusAgent(session.agentSessionId)).run).toMatchObject({ runId: original.run.runId, pid, state: 'running' })
  const registered = await f.registration(); registered.value.committed = false
  await writeFile(registered.path, JSON.stringify(registered.value))
  const edited = await f.read(); edited.userEdit = true; await writeFile(f.target, JSON.stringify(edited))
  const beforeFailure = await readFile(f.target), events: Array<{ code: string }> = []
  fresh.onEvent(event => { if (event.type === 'agent-error') events.push(event) })
  current = 'owned-c'
  expect((await fresh.ensureAgentContinuity({ agentSessionId: session.agentSessionId, expectedRun: session.run,
    operationId: 'unknown-registration-retains-run', commandOverride: cli, env: { PRIVATE_TRACE: trace, PRIVATE_TARGET: f.target } })).kind).toBe('reattachable')
  expect(events).toEqual([expect.objectContaining({ code: 'HOOK_REGISTRATION_UNCONFIRMED' })])
  const priorInputs = (await traces()).length
  expect((await fresh.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: session.run, source: 'user', data: 'still-available\r' })).acceptedThroughByte).toBeGreaterThan(0)
  await vi.waitFor(async () => expect((await traces()).length).toBeGreaterThan(priorInputs))
  expect(await readFile(f.target)).toEqual(beforeFailure)
  expect((await fresh.statusAgent(session.agentSessionId)).run).toMatchObject({ runId: original.run.runId, pid, state: 'running' })
  registered.value.committed = true; await writeFile(registered.path, JSON.stringify(registered.value))
  const lock = await open(f.target + '.agentmux.lock', 'a+', 0o600)
  const native = createRequire(import.meta.url)('fs-native-extensions') as { tryLock(fd: number): boolean }
  expect(native.tryLock(lock.fd)).toBe(true)
  try {
    expect((await fresh.ensureAgentContinuity({ agentSessionId: session.agentSessionId, expectedRun: session.run,
      operationId: 'busy-registration-retains-run', commandOverride: cli, env: { PRIVATE_TRACE: trace, PRIVATE_TARGET: f.target } })).kind).toBe('reattachable')
    expect(events.at(-1), 'A busy Hook target must refuse only repair and expose its original service window').toMatchObject({ code: 'HOOK_TARGET_BUSY' })
    expect(await readFile(f.target)).toEqual(beforeFailure)
    expect((await fresh.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: session.run, source: 'user', data: 'available-while-repair-busy\r' })).acceptedThroughByte).toBeGreaterThan(0)
    expect((await fresh.statusAgent(session.agentSessionId)).run).toMatchObject({ runId: original.run.runId, pid, state: 'running' })
  } finally { await lock.close() }
  expect((await fresh.ensureAgentContinuity({ agentSessionId: session.agentSessionId, expectedRun: session.run,
    operationId: 'retry-original-registration', commandOverride: cli, env: { PRIVATE_TRACE: trace, PRIVATE_TARGET: f.target } })).kind).toBe('reattachable')
  expect((await f.read()).hooks.Stop.map((entry: any) => entry.hooks[0].command)).toEqual(['owned-c'])
}, 20000)
