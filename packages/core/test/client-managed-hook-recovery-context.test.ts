import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveManagedHookPlan } from '../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions } from '../src/agent-session-store.js'
import { AgentMuxClient } from '../src/client.js'
import { connectLocalAgentMux } from '../src/runtime-client.js'
import type { AgentMuxAgentSession, AgentMuxClientEvent } from '../src/types.js'

const privateHome = vi.hoisted(() => ({ path: '' }))
vi.mock('node:os', async (original) => ({
  ...await original<typeof import('node:os')>(),
  homedir: () => {
    if (!privateHome.path) throw new Error('Hook fixture has not established its private home')
    return privateHome.path
  }
}))

afterEach(() => { vi.unstubAllEnvs(); privateHome.path = '' })

// This is a real PTY process, not an installed vendor CLI/model. Its small downstream API fixture
// loads the actual managed extension/plugin; real fetch enters public Core Hook admission.
const cli = `#!/usr/bin/env node
import assert from 'node:assert/strict'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
if (process.argv.includes('--version')) { console.log('private hook CLI 1.0'); process.exit(0) }
const root = process.env.AMX_HOOK_TEST_ROOT
const trace = process.env.AMX_HOOK_TEST_TRACE
const transcript = process.env.AMX_HOOK_TEST_TRANSCRIPT
const nativeId = process.env.AMX_HOOK_TEST_NATIVE_ID
const provider = process.env.AGENTMUX_PROVIDER_ID
const config = provider === 'pi' ? process.env.PI_CODING_AGENT_DIR : process.env.OPENCODE_CONFIG_DIR
for (const path of [trace, transcript, config, process.env.AGENTMUX_RUNTIME_DIRECTORY, process.env.AGENTMUX_STATE_DIRECTORY,
  process.env.AGENTMUX_AGENT_SESSION_STORE, process.env.AGENTMUX_MESSAGE_QUEUE_PATH]) {
  assert.equal(path.startsWith(root + '/'), true)
}
const allowed = ['AGENTMUX_AGENT_SESSION_ID','AGENTMUX_AGENT_SESSION_STORE','AGENTMUX_AGENT_CAPABILITY',
  'AGENTMUX_CLI','AGENTMUX_ENV','AGENTMUX_EXECUTOR_ID','AGENTMUX_HOOK_TOKEN','AGENTMUX_HOOK_URL',
  'AGENTMUX_LIFECYCLE_OPERATION_ID','AGENTMUX_MESSAGE_QUEUE_PATH','AGENTMUX_PROVIDER_ID','AGENTMUX_RUNTIME_DIRECTORY','AGENTMUX_STATE_DIRECTORY']
const agentMuxKeys = Object.keys(process.env).filter(key => key.startsWith('AGENTMUX_')).sort()
assert.deepEqual(agentMuxKeys, allowed.sort())
assert.equal(['pi', 'opencode'].includes(provider), true)
const record = value => appendFileSync(trace, JSON.stringify({ ...value, pid: process.pid }) + '\\n')
const resumeIndex = process.argv.indexOf('--session')
if (resumeIndex !== -1) assert.equal(process.argv[resumeIndex + 1], transcript)
else writeFileSync(transcript, JSON.stringify({ type:'session', id:nativeId }) + '\\n')
record({ type: resumeIndex === -1 ? 'launch' : 'resume', agentMuxKeys })
const fetchHook = globalThis.fetch
globalThis.fetch = async (...args) => {
  try {
    const response = await fetchHook(...args)
    record({ type:'hook', eventName:JSON.parse(args[1].body).eventName, status:response.status,
      ...(response.status === 204 ? {} : { error:await response.clone().text() }) })
    return response
  } catch (error) {
    record({ type:'hook-transport-error', error:String(error) })
    throw error
  }
}
const context = { sessionManager: { getSessionId: () => nativeId, getSessionFile: () => transcript } }
let emitHook, generation = 0
async function loadHook() {
  const path = join(config, provider === 'pi' ? 'extensions' : 'plugin', 'agentmux.js')
  const extension = await import(pathToFileURL(path).href + '?generation=' + generation++)
  if (provider === 'pi') {
    const handlers = new Map()
    extension.default({ on: (name, handler) => handlers.set(name, handler) })
    emitHook = () => handlers.get('agent_start')({}, context)
  } else {
    const hooks = await extension.server()
    emitHook = () => hooks.event({ event: { type:'message.part.updated', properties:{ sessionID:nativeId } } })
  }
}
await loadHook()
process.stdin.setRawMode(true)
process.stdin.resume()
let pending = ''
process.stdin.on('data', async bytes => {
  pending += bytes.toString()
  let end
  while ((end = pending.indexOf('\\r')) !== -1) {
    const input = pending.slice(0, end); pending = pending.slice(end + 1)
    if (input === 'EXIT-PRIVATE') process.exit(0)
    if (input !== 'INITIAL-HOOK') record({ type:'input', input })
    if (input === 'LOAD-CURRENT-HOOK') await loadHook()
    await emitHook()
  }
})
record({ type:'ready' })
`

type Trace = { type: string; pid: number; input?: string; status?: number; eventName?: string }

async function waitForFact<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000
  let traces: unknown
  do {
    const value = await read()
    if (Array.isArray(value)) traces = value
    if (accepts(value)) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  } while (Date.now() < deadline)
  throw new Error(`Private Hook fixture did not observe the required public fact. ${JSON.stringify(traces)}`)
}

async function withPrivateRuntime(run: (fixture: {
  root: string; workspace: string; storePath: string; cliPath: string
  newClient: () => Promise<AgentMuxClient>
  create: (client: AgentMuxClient, id: string, providerId?: 'pi' | 'opencode') => Promise<{
    session: AgentMuxAgentSession; env: Record<string, string>; target: string; content: Buffer
    traces: () => Promise<Trace[]>
  }>
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'amx-hook-context-'))
  const runtime = join(root, 'runtime'), workspace = join(root, 'workspace')
  const storePath = join(root, 'sessions.json'), cliPath = join(root, 'fixture-cli.mjs')
  privateHome.path = join(root, 'home')
  for (const path of [privateHome.path, runtime, workspace]) await mkdir(path)
  await writeFile(cliPath, cli, { mode: 0o700 })
  for (const key of Object.keys(process.env).filter(key => key.startsWith('AGENTMUX_'))) vi.stubEnv(key, undefined)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', runtime)
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'durable'))
  vi.stubEnv('AGENTMUX_AGENT_SESSION_STORE', storePath)
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  expect(Object.keys(process.env).filter(key => key.startsWith('AGENTMUX_')).sort()).toEqual([
    'AGENTMUX_AGENT_SESSION_STORE', 'AGENTMUX_MESSAGE_QUEUE_PATH', 'AGENTMUX_RUNTIME_DIRECTORY', 'AGENTMUX_STATE_DIRECTORY'
  ])
  for (const path of [homedir(), runtime, storePath, process.env.AGENTMUX_MESSAGE_QUEUE_PATH!]) {
    expect(path.startsWith(root + '/')).toBe(true)
  }
  // Even an intentionally broken connect-time repair can write only the private default home.
  const defaultPlan = resolveManagedHookPlan('pi', workspace, {})!
  expect(defaultPlan.mutations).toHaveLength(1)
  expect(defaultPlan.mutations[0]!.path.startsWith(root + '/')).toBe(true)
  const daemon = spawn(fileURLToPath(new URL('../vendor/ctxmux/darwin-arm64/bin/ctxmuxd', import.meta.url)), [
    '--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(runtime, 'state'), '--readiness-fd', '3'
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] })
  const exited = once(daemon, 'exit')
  const clients: AgentMuxClient[] = []
  try {
    await once(daemon.stdio[3]!, 'data')
    await run({ root, workspace, storePath, cliPath,
      newClient: async () => {
        const client = await connectLocalAgentMux({ store: new AgentMuxFileAgentSessionStore(storePath) })
        clients.push(client)
        return client
      },
      create: async (client, id, providerId = 'pi') => {
        const trace = join(root, `${id}.ndjson`), transcript = join(root, `${id}.jsonl`)
        await writeFile(trace, '')
        const env = { [providerId === 'pi' ? 'PI_CODING_AGENT_DIR' : 'OPENCODE_CONFIG_DIR']: join(root, `config-${id}`), AMX_HOOK_TEST_ROOT: root,
          AMX_HOOK_TEST_TRACE: trace, AMX_HOOK_TEST_TRANSCRIPT: transcript, AMX_HOOK_TEST_NATIVE_ID: `native-${id}` }
        // A non-operative endpoint is used only to guard the resolver's target before launch. The
        // installed plugin's credentials are issued by Core and checked through actual delivery.
        const plan = resolveManagedHookPlan(providerId, workspace, env, { url: 'http://127.0.0.1/', token: 'path-guard' })!
        expect(plan.mutations).toHaveLength(1)
        const target = plan.mutations[0]!.path
        expect(target.startsWith(root + '/')).toBe(true)
        const session = await client.createAgent({ agentSessionId: id, createOperationId: `create-${id}`,
          providerId, executorId: `executor-${id}`, workspacePath: workspace,
          commandOverride: cliPath, injectAgentMuxGuide: false, env })
        const traces = async (): Promise<Trace[]> => (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean)
          .map(line => JSON.parse(line) as Trace)
        await waitForFact(traces, entries => entries.some(entry => entry.type === 'ready'))
        await client.writeAgent({ agentSessionId: id, expectedRun: session.run, source: 'user', data: 'INITIAL-HOOK\r' })
        await waitForFact(traces, entries => entries.some(entry => entry.type === 'hook' && entry.status === 204))
        expect(client.agentSession(id).nativeHandle).toEqual({
          kind: 'provider', providerId, sessionId: `native-${id}`,
          ...(providerId === 'pi' ? { transcriptPath: transcript } : {})
        })
        expect((await client.statusAgent(id)).run.pid).toBe((await traces())[0]!.pid)
        return { session, env, target, content: await readFile(target), traces }
      }
    })
  } finally {
    const disposed = await Promise.allSettled(clients.map(client => client.dispose()))
    daemon.kill('SIGTERM')
    const timer = setTimeout(() => daemon.kill('SIGKILL'), 2_000)
    try { await exited }
    finally { clearTimeout(timer); await rm(root, { recursive: true, force: true }) }
    const failures = disposed.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Private Hook clients failed cleanup')
  }
}

describe('managed Hook recovery uses the explicit continuity configuration', () => {
  it('connect restores live bindings without generating config; each same-Provider/Workspace env repairs only its target', async () => {
    await withPrivateRuntime(async fixture => {
      const first = await fixture.newClient()
      const a = await fixture.create(first, 'scope-a'), b = await fixture.create(first, 'scope-b')
      const pids = [(await first.statusAgent(a.session.agentSessionId)).run.pid,
        (await first.statusAgent(b.session.agentSessionId)).run.pid]
      await first.dispose()
      await writeFile(a.target, '// stale app command A\n')
      await rm(b.target)
      const fresh = await fixture.newClient()
      expect(fresh.agentSessions().map(session => session.agentSessionId).sort()).toEqual(['scope-a', 'scope-b'])
      await expect(stat(join(homedir(), '.pi', 'agent', 'extensions', 'agentmux.js'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(a.target, 'utf8')).toBe('// stale app command A\n')
      await expect(readFile(b.target)).rejects.toMatchObject({ code: 'ENOENT' })

      // The retained extension sends with its original endpoint. Only real binding restoration can
      // admit this new receipt; neither a hand-built Session nor a patched Hook server participates.
      await fresh.writeAgent({ agentSessionId: a.session.agentSessionId, expectedRun: a.session.run, source: 'user', data: 'after-connect\r' })
      const ingress = await waitForFact(a.traces, entries => entries.filter(entry => entry.type === 'hook').length === 2)
      expect(ingress.filter(entry => entry.type === 'hook').map(entry => entry.status)).toEqual([204, 204])

      const noEnv = await fresh.ensureAgentContinuity({ agentSessionId: a.session.agentSessionId,
        expectedRun: a.session.run, operationId: 'no-config-context', commandOverride: fixture.cliPath })
      expect(noEnv.kind).toBe('reattachable')
      expect(await readFile(a.target, 'utf8')).toBe('// stale app command A\n')
      const stale = await fresh.ensureAgentContinuity({ agentSessionId: a.session.agentSessionId,
        expectedRun: { runId: 'other-run' }, operationId: 'stale-run', env: a.env })
      expect(stale.kind).toBe('conflict')
      expect(await readFile(a.target, 'utf8')).toBe('// stale app command A\n')

      for (const scope of [a, b]) {
        const result = await fresh.ensureAgentContinuity({ agentSessionId: scope.session.agentSessionId,
          expectedRun: scope.session.run, operationId: `reattach-${scope.session.agentSessionId}`,
          commandOverride: fixture.cliPath, env: scope.env })
        expect(result.kind).toBe('reattachable')
        expect(await readFile(scope.target)).toEqual(scope.content)
        if (scope === a) await expect(readFile(b.target)).rejects.toMatchObject({ code: 'ENOENT' })
      }
      expect([(await fresh.statusAgent(a.session.agentSessionId)).run.pid,
        (await fresh.statusAgent(b.session.agentSessionId)).run.pid]).toEqual(pids)
      expect(fresh.agentSessions().map(session => session.run)).toEqual([a.session.run, b.session.run])

      // The existing ended-Run resume path still installs from the real explicit env and uses the
      // Hook-owned native transcript locator. The fixture independently checks --session <path>.
      await fresh.writeAgent({ agentSessionId: b.session.agentSessionId, expectedRun: b.session.run, source: 'user', data: 'EXIT-PRIVATE\r' })
      await waitForFact(() => fresh.statusAgent(b.session.agentSessionId), status => status.run.state === 'exited')
      await rm(b.target)
      const resumed = await fresh.ensureAgentContinuity({ agentSessionId: b.session.agentSessionId,
        expectedRun: b.session.run, operationId: 'native-resume-b', commandOverride: fixture.cliPath, env: b.env })
      expect(resumed.kind).toBe('resumed')
      expect(await readFile(b.target)).toEqual(b.content)
      await waitForFact(b.traces, entries => entries.filter(entry => entry.type === 'ready').length === 2)
      await fresh.writeAgent({ agentSessionId: b.session.agentSessionId,
        expectedRun: fresh.agentSession(b.session.agentSessionId).run, source: 'user', data: 'INITIAL-HOOK\r' })
      const resumedTrace = await waitForFact(b.traces, entries => entries.filter(entry => entry.type === 'hook').length === 2)
      expect(resumedTrace.filter(entry => entry.type === 'resume')).toHaveLength(1)
      expect((await fresh.statusAgent(b.session.agentSessionId)).run.pid).toBe(resumedTrace.find(entry => entry.type === 'resume')!.pid)
      expect(fresh.agentSession(b.session.agentSessionId).run.runId).not.toBe(b.session.run.runId)
      expect((await loadAgentSessions(new AgentMuxFileAgentSessionStore(fixture.storePath))).map(session => session.agentSessionId).sort())
        .toEqual(['scope-a', 'scope-b'])
      console.log(JSON.stringify({ schema: 'agentmux.hook-recovery-context.v1', kind: 'scoped-reattach-and-native-resume',
        daemon: 'actual vendored protocol18 ctxmuxd', agent: 'private Node Pi API fixture loading the generated extension',
        sessions: fresh.agentSessions().map(session => ({ id: session.agentSessionId, run: session.run })),
        originalPids: pids, resumedPid: resumedTrace.find(entry => entry.type === 'resume')!.pid,
        targetSha256: createHash('sha256').update(a.content).digest('hex'), sanitizedAgentMuxEnv: true }))
    })
  }, 30_000)

  it('repairs a plugin from its restored Binding endpoint and the regenerated plugin actually delivers', async () => {
    await withPrivateRuntime(async fixture => {
      const first = await fixture.newClient(), agent = await fixture.create(first, 'endpoint-scope', 'opencode')
      const original = await first.statusAgent(agent.session.agentSessionId)
      await first.dispose(); await rm(agent.target)
      const fresh = await fixture.newClient()
      await expect(stat(agent.target)).rejects.toMatchObject({ code: 'ENOENT' })
      const result = await fresh.ensureAgentContinuity({ agentSessionId: agent.session.agentSessionId,
        expectedRun: agent.session.run, operationId: 'reattach-restored-endpoint', commandOverride: fixture.cliPath, env: agent.env })
      expect(result.kind).toBe('reattachable')
      // OpenCode embeds endpoint credentials. Byte equality alone is backed by reloading this new
      // file in the same real process and admitting its actual authenticated HTTP request.
      expect((await readFile(agent.target)).equals(agent.content)).toBe(true)
      await fresh.writeAgent({ agentSessionId: agent.session.agentSessionId,
        expectedRun: agent.session.run, source: 'user', data: 'LOAD-CURRENT-HOOK\r' })
      const traces = await waitForFact(agent.traces, entries => entries.filter(entry => entry.type === 'hook').length === 2)
      expect(traces.filter(entry => entry.type === 'hook').map(entry => entry.status)).toEqual([204, 204])
      expect((await fresh.statusAgent(agent.session.agentSessionId)).run).toMatchObject({
        runId: original.run.runId, pid: original.run.pid, state: 'running'
      })
      console.log(JSON.stringify({ schema: 'agentmux.hook-recovery-context.v1', kind: 'restored-binding-endpoint',
        providerId: 'opencode', agentSessionId: agent.session.agentSessionId, run: agent.session.run,
        pid: original.run.pid, regeneratedPluginHookStatuses: traces.filter(entry => entry.type === 'hook').map(entry => entry.status) }))
    })
  }, 30_000)

  it('a real install failure produces an unscoped actionable notice while the same healthy Run accepts normal input, then repairs', async () => {
    await withPrivateRuntime(async fixture => {
      const first = await fixture.newClient(), agent = await fixture.create(first, 'failure-scope')
      const original = await first.statusAgent(agent.session.agentSessionId)
      await first.dispose()
      await rm(agent.target); await mkdir(agent.target)
      const fresh = await fixture.newClient(), events: AgentMuxClientEvent[] = []
      fresh.onEvent(event => events.push(event))
      const result = await fresh.ensureAgentContinuity({ agentSessionId: agent.session.agentSessionId,
        expectedRun: agent.session.run, operationId: 'reattach-install-failed', commandOverride: fixture.cliPath, env: agent.env })
      expect(result.kind).toBe('reattachable')
      const errors = events.filter(event => event.type === 'agent-error')
      expect(errors).toEqual([expect.objectContaining({ code: 'UNSAFE_HOOK_TARGET' })])
      expect(errors[0]!.agentSessionId).toBeUndefined()
      expect(errors[0]!.message).toContain('Pi')
      expect(errors[0]!.message).toContain('Hook')
      expect(errors[0]!.message).toContain('continues')
      expect(errors[0]!.message).toContain('retry')
      expect((await fresh.statusAgent(agent.session.agentSessionId)).run).toMatchObject({
        runId: original.run.runId, pid: original.run.pid, state: 'running'
      })
      const ack = await fresh.writeAgent({ agentSessionId: agent.session.agentSessionId,
        expectedRun: agent.session.run, source: 'user', data: 'input-after-install-failed\r' })
      expect(ack.acceptedThroughByte).toBeGreaterThan(0)
      const traces = await waitForFact(agent.traces, entries => entries.filter(entry => entry.type === 'hook').length === 2)
      expect(traces.filter(entry => entry.type === 'input')).toEqual([
        { type: 'input', input: 'input-after-install-failed', pid: original.run.pid }
      ])
      expect(traces.filter(entry => entry.type === 'hook').map(entry => entry.status)).toEqual([204, 204])
      expect(fresh.agentSessions().map(session => session.run)).toEqual([agent.session.run])
      expect(fresh.agentSession(agent.session.agentSessionId).semanticStatus?.state).toBe('working')
      await rm(agent.target, { recursive: true })
      const repaired = await fresh.ensureAgentContinuity({ agentSessionId: agent.session.agentSessionId,
        expectedRun: agent.session.run, operationId: 'reattach-install-retry', commandOverride: fixture.cliPath, env: agent.env })
      expect(repaired.kind).toBe('reattachable')
      expect(await readFile(agent.target)).toEqual(agent.content)
      expect(events.filter(event => event.type === 'agent-error')).toEqual(errors)
      expect((await fresh.statusAgent(agent.session.agentSessionId)).run.pid).toBe(original.run.pid)
      console.log(JSON.stringify({ schema: 'agentmux.hook-recovery-context.v1', kind: 'nonfatal-install-failure',
        agentSessionId: agent.session.agentSessionId, run: agent.session.run, pid: original.run.pid,
        code: errors[0]!.code, noticeUnscoped: errors[0]!.agentSessionId === undefined, actualInputAccepted: true }))
    })
  }, 30_000)
})
