import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentProviderRegistry, defineAgentProvider, type AgentManagedHookPlanContext, type AgentProvider } from '../src/agent-provider.js'
import { createPiProvider } from '../src/providers/pi.js'
import { AgentMuxPluginRegistry } from '../src/agent-plugin.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentManagedHookInstaller, type AgentManagedHookPlan } from '../src/managed-hook-installer.js'
import { AgentMuxClient } from '../src/client.js'
import type { AgentMuxClientEvent } from '../src/types.js'

const execFileAsync = promisify(execFile)
afterEach(() => vi.unstubAllEnvs())
const providerId = 'private-contribution'
const baseProvider = createPiProvider(defineAgentProvider)
const hook = baseProvider.hook
function provider(planManagedHooks: NonNullable<AgentProvider['planManagedHooks']>): AgentProvider {
  const base = baseProvider.catalog
  return defineAgentProvider({
    catalog: { ...base, id: providerId, label: 'Private contribution', executable: 'node', expectedProcess: 'node',
      readySignal: { kind: 'foreground-process', expectedProcess: 'node' }, promptDelivery: 'positional-argv' },
    hook,
    planManagedHooks,
    buildArgs: (_prompt, args) => [...args],
    buildResumeArgs: (_id, transcript, _prompt, args) => ['--resume-fixture', transcript!, ...args]
  })
}
function plan(context: AgentManagedHookPlanContext, version = 'a'): AgentManagedHookPlan {
  return { providerId, mutations: [{ path: context.env!.AMX_CONTRIBUTION_TARGET!, mode: 0o600,
    content: JSON.stringify({ version, workspacePath: context.workspacePath, scope: context.env!.AMX_CONTRIBUTION_SCOPE,
      endpoint: context.endpoint ?? null }) }] }
}

// Real downstream PTY fixture. No vendor CLI, model, patched Hook server or fabricated Run.
const cli = `#!/usr/bin/env node
import assert from 'node:assert/strict'
import { appendFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
if (process.argv.includes('--version')) { console.log('private contribution 1.0'); process.exit(0) }
const root = process.env.AMX_CONTRIBUTION_ROOT
const trace = process.env.AMX_CONTRIBUTION_TRACE
const transcript = process.env.AMX_CONTRIBUTION_TRANSCRIPT
for (const p of [trace, transcript, process.env.AMX_CONTRIBUTION_TARGET, process.env.AGENTMUX_RUNTIME_DIRECTORY,
  process.env.AGENTMUX_STATE_DIRECTORY, process.env.AGENTMUX_AGENT_SESSION_STORE, process.env.AGENTMUX_MESSAGE_QUEUE_PATH]) {
  assert.equal(p.startsWith(root + '/'), true)
}
const resume = process.argv.indexOf('--resume-fixture')
if (resume !== -1) assert.equal(process.argv[resume + 1], transcript)
else writeFileSync(transcript, '{}\\n')
const record = value => appendFileSync(trace, JSON.stringify({ ...value, pid: process.pid }) + '\\n')
process.stdin.setRawMode(true)
process.stdin.resume()
let pending = ''
process.stdin.on('data', async bytes => {
  pending += bytes.toString()
  let end
  while ((end = pending.indexOf('\\r')) !== -1) {
    const input = pending.slice(0, end); pending = pending.slice(end + 1)
    if (input === 'EXIT-PRIVATE') process.exit(0)
    record({ type: 'input', input })
    if (input === 'HOOK') {
      const response = await fetch(process.env.AGENTMUX_HOOK_URL, {
        method: 'POST', headers: { authorization: 'Bearer ' + process.env.AGENTMUX_HOOK_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ receiptId: randomUUID(), eventName: 'agent_start',
          payload: { hook_event_name: 'agent_start', session_id: 'native-private', session_file: transcript } })
      })
      record({ type: 'hook', status: response.status })
    }
  }
})
record({ type: 'ready', resumed: resume !== -1 })
`
type Trace = { type: string; pid: number; input?: string; status?: number; resumed?: boolean }
async function waitFor<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000
  do {
    const value = await read()
    if (accepts(value)) return value
    await new Promise(resolve => setTimeout(resolve, 15))
  } while (Date.now() < deadline)
  throw new Error('Private contribution fixture did not observe its required fact')
}
type Fixture = {
  root: string; workspace: string; cliPath: string; env: Record<string, string>
  installer: AgentManagedHookInstaller
  client: (registered: AgentProvider) => Promise<AgentMuxClient>
  traces: () => Promise<Trace[]>
}
async function withPrivateRuntime(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'amx-provider-contribution-'))
  const runtime = join(root, 'runtime'), workspace = join(root, 'workspace'), cliPath = join(root, 'cli.mjs')
  const storePath = join(root, 'sessions.json'), tracePath = join(root, 'trace.ndjson')
  for (const path of [runtime, workspace]) await mkdir(path)
  await writeFile(cliPath, cli, { mode: 0o700 }); await writeFile(tracePath, '')
  for (const key of Object.keys(process.env).filter(key => key.startsWith('AGENTMUX_'))) vi.stubEnv(key, undefined)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', runtime)
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_AGENT_SESSION_STORE', storePath)
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const env = { AMX_CONTRIBUTION_ROOT: root, AMX_CONTRIBUTION_TRACE: tracePath,
    AMX_CONTRIBUTION_TRANSCRIPT: join(root, 'transcript.jsonl'), AMX_CONTRIBUTION_TARGET: join(root, 'hook.json'),
    AMX_CONTRIBUTION_SCOPE: 'owned-executor-scope' }
  expect(Object.keys(process.env).filter(key => key.startsWith('AGENTMUX_')).sort()).toEqual([
    'AGENTMUX_AGENT_SESSION_STORE', 'AGENTMUX_MESSAGE_QUEUE_PATH', 'AGENTMUX_RUNTIME_DIRECTORY', 'AGENTMUX_STATE_DIRECTORY'
  ])
  const daemon = spawn(fileURLToPath(new URL('../vendor/ctxmux/darwin-arm64/bin/ctxmuxd', import.meta.url)), [
    '--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(runtime, 'daemon-state'), '--readiness-fd', '3'
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] })
  const closed = once(daemon, 'close')
  const clients: AgentMuxClient[] = []
  const traces = async (): Promise<Trace[]> => (await readFile(tracePath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as Trace)
  try {
    await once(daemon.stdio[3]!, 'data')
    await run({ root, workspace, cliPath, env, installer: new AgentManagedHookInstaller(join(root, 'receipts')),
      traces,
      client: async registered => {
        const client = new AgentMuxClient({ providers: [registered], store: new AgentMuxFileAgentSessionStore(storePath),
          hookInstaller: new AgentManagedHookInstaller(join(root, 'receipts')) })
        clients.push(client); await client.connect(); return client
      } })
  } finally {
    const pids = [...new Set((await traces()).map(entry => entry.pid))]
    const cleanup = await Promise.allSettled(clients.map(client => client.dispose()))
    daemon.kill('SIGTERM')
    const timer = setTimeout(() => daemon.kill('SIGKILL'), 2_000)
    try { await closed } finally { clearTimeout(timer) }
    for (const pid of pids) {
      await waitFor(async () => {
        try { process.kill(pid, 0); return true } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
          throw error
        }
      }, alive => !alive)
    }
    const command = await execFileAsync('ps', ['-p', String(daemon.pid), '-o', 'command=']).catch(error => {
      if (error.code === 1) return { stdout: '' }
      throw error
    })
    expect(command.stdout.trim()).toBe('')
    console.log(JSON.stringify({ schema: 'agentmux.provider-contribution-cleanup.v1', daemonPid: daemon.pid, ptyPids: pids, exited: true }))
    await rm(root, { recursive: true, force: true })
    const failures = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Private contribution cleanup failed')
  }
}

async function create(f: Fixture, client: AgentMuxClient) {
  const session = await client.createAgent({ agentSessionId: 'contribution-agent', createOperationId: 'create-contribution-agent',
    providerId, executorId: 'private-executor', workspacePath: f.workspace, commandOverride: f.cliPath,
    injectAgentMuxGuide: false, env: f.env })
  const ready = await waitFor(f.traces, entries => entries.some(entry => entry.type === 'ready'))
  expect((await client.statusAgent(session.agentSessionId)).run.pid).toBe(ready[0]!.pid)
  return session
}

describe('registered Provider managed Hook contribution', () => {
  it('definition/register/replace enforce the same capability contract before mutating the registry', () => {
    const contribution = (context: AgentManagedHookPlanContext) => plan(context)
    const original = provider(contribution)
    expect(original.planManagedHooks).toBe(contribution)
    const registry = new AgentProviderRegistry([original])
    const invalid = { ...original, planManagedHooks: undefined } as unknown as AgentProvider
    expect(() => registry.replace(invalid)).toThrowError(/explicit-managed/)
    expect(registry.get(providerId)).toBe(original)
    const empty = new AgentProviderRegistry([])
    expect(() => empty.register(invalid)).toThrowError(/explicit-managed/)
    expect(empty.list()).toEqual([])
    const unmanaged = { ...original, catalog: { ...original.catalog, hookStrategy: { kind: 'none' as const } } }
    expect(() => empty.register(unmanaged)).toThrowError(/explicit-managed/)
    expect(empty.list()).toEqual([])
    expect(() => defineAgentProvider({ catalog: original.catalog, hook, buildArgs: (_prompt, args) => [...args] }))
      .toThrowError(/explicit-managed/)
  })

  it('public inspection uses registered/replaced plans and selected activation, then unregister has no residual contribution', async () => {
    await withPrivateRuntime(async f => {
      const a = provider(context => plan(context, 'a')), b = provider(context => plan(context, 'b'))
      const client = await f.client(a)
      const ctx = { workspacePath: f.workspace, env: f.env, endpoint: { url: 'http://127.0.0.1:1/', token: 'private-inspection' } }
      await f.installer.ensure(a.planManagedHooks!(ctx)!)
      expect(await client.inspectManagedHooks(providerId, ctx)).toMatchObject({ status: 'installed', targets: [{ path: f.env.AMX_CONTRIBUTION_TARGET, status: 'current' }] })
      client.providers.replace(b)
      expect(await client.inspectManagedHooks(providerId, ctx)).toMatchObject({ status: 'partial', targets: [{ path: f.env.AMX_CONTRIBUTION_TARGET, status: 'partial' }] })
      await f.installer.ensure(b.planManagedHooks!(ctx)!)
      const activation: string[] = []
      const selected = { ...a, planManagedHooks: (context: AgentManagedHookPlanContext) => {
        client.providers.replace({ ...b, inspectHookActivation: async () => { activation.push('b'); return { active: true, code: 'B', action: null } } })
        return plan(context, 'b')
      }, inspectHookActivation: async () => { activation.push('a'); return { active: true, code: 'A', action: null } } }
      client.providers.replace(selected)
      expect(await client.inspectManagedHooks(providerId, ctx)).toMatchObject({ status: 'installed', code: 'A' })
      expect(activation).toEqual(['a'])
      const before = await readFile(f.env.AMX_CONTRIBUTION_TARGET!)
      client.providers.unregister(providerId)
      expect(client.providers.list()).toEqual([])
      expect(await client.inspectManagedHooks(providerId, ctx)).toMatchObject({ status: 'error', targets: [] })
      expect(await readFile(f.env.AMX_CONTRIBUTION_TARGET!)).toEqual(before)
      const plugins = new AgentMuxPluginRegistry([{ id: 'private-plugin', version: '1', providers: [a] }])
      expect(plugins.providers.get(providerId).planManagedHooks).toBe(a.planManagedHooks)
      plugins.unregister('private-plugin')
      expect(plugins.providers.list()).toEqual([])
      expect(plugins.list()).toEqual([])
    })
  }, 20_000)

  it('create, fresh Client restart and native resume actually install from the selected object and exact context', async () => {
    await withPrivateRuntime(async f => {
      const contexts: AgentManagedHookPlanContext[] = []
      const registered = provider(context => { contexts.push(context); return plan(context) })
      const first = await f.client(registered), original = await create(f, first)
      await expect(readFile(f.env.AMX_CONTRIBUTION_TARGET!, 'utf8')).resolves.toContain('"version":"a"')
      const initial = JSON.parse(await readFile(f.env.AMX_CONTRIBUTION_TARGET!, 'utf8'))
      expect(initial).toMatchObject({ version: 'a', workspacePath: f.workspace, scope: f.env.AMX_CONTRIBUTION_SCOPE,
        endpoint: { url: expect.stringContaining('http://127.0.0.1:'), token: expect.any(String) } })
      await first.writeAgent({ agentSessionId: original.agentSessionId, expectedRun: original.run, source: 'user', data: 'HOOK\r' })
      await waitFor(f.traces, entries => entries.some(entry => entry.type === 'hook' && entry.status === 204))
      expect(first.agentSession(original.agentSessionId).nativeHandle).toEqual({ kind: 'provider', providerId,
        sessionId: 'native-private', transcriptPath: f.env.AMX_CONTRIBUTION_TRANSCRIPT })
      const pid = (await first.statusAgent(original.agentSessionId)).run.pid
      await first.dispose(); await rm(f.env.AMX_CONTRIBUTION_TARGET!)
      const fresh = await f.client(registered)
      expect(contexts).toHaveLength(1)
      const restored = await fresh.ensureAgentContinuity({ agentSessionId: original.agentSessionId, expectedRun: original.run,
        operationId: 'restart-contribution', commandOverride: f.cliPath, env: f.env })
      expect(restored.kind).toBe('reattachable')
      expect(JSON.parse(await readFile(f.env.AMX_CONTRIBUTION_TARGET!, 'utf8'))).toEqual(initial)
      expect((await fresh.statusAgent(original.agentSessionId)).run).toMatchObject({ runId: original.run.runId, pid })
      await fresh.writeAgent({ agentSessionId: original.agentSessionId, expectedRun: original.run, source: 'user', data: 'EXIT-PRIVATE\r' })
      await waitFor(() => fresh.statusAgent(original.agentSessionId), status => status.run.state === 'exited')
      await rm(f.env.AMX_CONTRIBUTION_TARGET!)
      const resumed = await fresh.ensureAgentContinuity({ agentSessionId: original.agentSessionId, expectedRun: original.run,
        operationId: 'resume-contribution', commandOverride: f.cliPath, env: f.env })
      expect(resumed.kind).toBe('resumed')
      const after = JSON.parse(await readFile(f.env.AMX_CONTRIBUTION_TARGET!, 'utf8'))
      expect(after).toMatchObject({ version: 'a', workspacePath: f.workspace, scope: f.env.AMX_CONTRIBUTION_SCOPE })
      expect(after.endpoint.token).not.toBe(initial.endpoint.token)
      expect(contexts).toHaveLength(3)
      for (const context of contexts) { expect(context.workspacePath).toBe(f.workspace); expect(context.env).toEqual(f.env); expect(context.endpoint?.token).toBeTruthy() }
      await waitFor(f.traces, entries => entries.filter(entry => entry.type === 'ready').length === 2)
      const session = fresh.agentSession(original.agentSessionId)
      expect(session.agentSessionId).toBe(original.agentSessionId)
      expect(session.run.runId).not.toBe(original.run.runId)
      const ack = await fresh.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: session.run, source: 'user', data: 'after-native-resume\r' })
      expect(ack.acceptedThroughByte).toBeGreaterThan(0)
      const traces = await waitFor(f.traces, entries => entries.some(entry => entry.input === 'after-native-resume'))
      const resumedPid = (await fresh.statusAgent(session.agentSessionId)).run.pid
      expect(traces.filter(entry => entry.type === 'ready').map(entry => entry.resumed)).toEqual([false, true])
      expect(traces.find(entry => entry.input === 'after-native-resume')?.pid).toBe(resumedPid)
      console.log(JSON.stringify({ schema: 'agentmux.provider-contribution-proof.v1', kind: 'create-restart-resume',
        agentSessionId: session.agentSessionId, originalRun: original.run, resumedRun: session.run, originalPid: pid, resumedPid,
        planCalls: contexts.length, initialPlanSha256: createHash('sha256').update(JSON.stringify(initial)).digest('hex') }))
    })
  }, 25_000)

  it.each([
    ['null', 'HOOK_PLAN_CONTEXT_UNAVAILABLE'], ['throw', 'HOOK_PLAN_FAILED'], ['mismatched-id', 'HOOK_PLAN_PROVIDER_MISMATCH']
  ] as const)('%s planning has explicit typed feedback and the actual same Run remains input-capable', async (mode, code) => {
    await withPrivateRuntime(async f => {
      const broken = provider(context => {
        if (mode === 'null') return null
        if (mode === 'throw') throw new Error('private planning cause')
        return { ...plan(context), providerId: 'unrelated-provider' }
      })
      const client = await f.client(broken), events: AgentMuxClientEvent[] = []
      client.onEvent(event => events.push(event))
      const original = await create(f, client), before = await client.statusAgent(original.agentSessionId)
      const errors = events.filter(event => event.type === 'agent-error')
      expect(errors).toEqual([expect.objectContaining({ code, message: expect.stringContaining('continues') })])
      expect(errors[0]!.message).toContain('unconfirmed')
      expect(errors[0]!.message).toContain('retry')
      if (mode === 'throw') expect(errors[0]!.message).toContain('private planning cause')
      const inspected = await client.inspectManagedHooks(providerId, { workspacePath: f.workspace, env: f.env })
      expect(inspected).toMatchObject({ status: mode === 'null' ? 'skipped' : 'error', code, targets: [] })
      if (mode === 'throw') expect(inspected.action).toContain('private planning cause')
      await expect(readFile(f.env.AMX_CONTRIBUTION_TARGET!)).rejects.toMatchObject({ code: 'ENOENT' })
      const ack = await client.writeAgent({ agentSessionId: original.agentSessionId, expectedRun: original.run, source: 'user', data: `input-after-${mode}\r` })
      expect(ack.acceptedThroughByte).toBeGreaterThan(0)
      const traces = await waitFor(f.traces, entries => entries.some(entry => entry.input === `input-after-${mode}`))
      expect(traces.filter(entry => entry.type === 'input')).toEqual([{ type: 'input', input: `input-after-${mode}`, pid: before.run.pid }])
      expect((await client.statusAgent(original.agentSessionId)).run).toMatchObject({ runId: original.run.runId, pid: before.run.pid, state: 'running' })
      expect(client.agentSessions().map(session => session.run)).toEqual([original.run])
      console.log(JSON.stringify({ schema: 'agentmux.provider-contribution-proof.v1', kind: 'nonfatal-planning', mode, code,
        run: original.run, pid: before.run.pid, acceptedThroughByte: ack.acceptedThroughByte, observedInputs: traces.filter(entry => entry.type === 'input') }))
    })
  }, 20_000)
})
