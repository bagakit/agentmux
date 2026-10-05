import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, AgentManagedHookInstaller, AgentProviderRegistry,
  diagnoseAgentMux, type AgentMuxClientEvent } from '../dist/index.js'

afterEach(() => vi.unstubAllEnvs())

// This private Node CLI reads the actual Provider-generated JSON/YAML from disk. It is a real PTY
// process and implements a small read-only app-server fixture; it is not a vendor CLI/model or a
// claim that synthetic trust metadata confirms native activation on the user's original Run.
const cli = `#!/usr/bin/env node
import assert from 'node:assert/strict'
import { appendFileSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { parse } from ${JSON.stringify(createRequire(import.meta.url).resolve('yaml'))}
if (process.argv.includes('--version')) { console.log('private Hook reader 1.0'); process.exit(0) }
const root = process.env.AMX_PRESERVATION_ROOT
const trace = process.env.AMX_PRESERVATION_TRACE
for (const path of [trace, process.env.CODEX_HOME, process.env.HERMES_HOME, process.env.AGENTMUX_RUNTIME_DIRECTORY,
  process.env.AGENTMUX_STATE_DIRECTORY, process.env.AGENTMUX_AGENT_SESSION_STORE, process.env.AGENTMUX_MESSAGE_QUEUE_PATH]) {
  if (path) assert.equal(path.startsWith(root + '/'), true)
}
const record = value => appendFileSync(trace, JSON.stringify({ ...value, pid: process.pid }) + '\\n')
const codexPath = join(process.cwd(), '.codex/hooks.json')
if (process.argv.includes('app-server')) {
  record({ type: 'reader' })
  const input = createInterface({ input: process.stdin })
  input.on('line', line => {
    const call = JSON.parse(line)
    record({ type: 'rpc', method: call.method })
    if (call.method === 'initialize') console.log(JSON.stringify({ id: call.id, result: { userAgent: 'private-fixture' } }))
    else if (call.method === 'hooks/list') {
      const config = JSON.parse(readFileSync(codexPath, 'utf8')), hooks = []
      for (const [event, groups] of Object.entries(config.hooks)) if (Array.isArray(groups)) {
        for (const group of groups) for (const leaf of group.hooks ?? []) hooks.push({ sourcePath: codexPath, source: 'project',
          handlerType: leaf.type, eventName: event[0].toLowerCase() + event.slice(1), command: leaf.command,
          matcher: group.matcher ?? null, timeoutSec: leaf.timeout, async: leaf.async ?? false, enabled: true,
          currentHash: 'private-fixture-hash', trustStatus: 'trusted' })
      }
      console.log(JSON.stringify({ id: call.id, result: { data: [{ cwd: process.cwd(), hooks, errors: [], warnings: [] }] } }))
    } else if (call.id) throw new Error('Private fixture received an unsupported native request')
  })
} else {
  const provider = process.env.AGENTMUX_PROVIDER_ID
  assert.equal(['codex', 'hermes'].includes(provider), true)
  const config = provider === 'codex' ? JSON.parse(readFileSync(codexPath, 'utf8'))
    : parse(readFileSync(join(process.env.HERMES_HOME, 'config.yaml'), 'utf8'))
  const approvals = provider === 'hermes' ? JSON.parse(readFileSync(join(process.env.HERMES_HOME, 'shell-hooks-allowlist.json'), 'utf8')) : null
  record({ type: 'config', provider, config, approvals })
  process.stdin.setRawMode(true); process.stdin.resume()
  let pending = ''
  process.stdin.on('data', bytes => {
    pending += bytes.toString().replaceAll('\\x1b[?0u', '')
    for (let end; (end = pending.indexOf('\\r')) !== -1;) {
      const input = pending.slice(0, end); pending = pending.slice(end + 1)
      if (input === 'EXIT-PRIVATE') process.exit(0)
      record({ type: 'input', input })
    }
  })
  if (provider === 'codex') process.stdout.write('\\x1b[?u')
  record({ type: 'ready' })
}
`

type Trace = { type: string; pid: number; method?: string; input?: string; config?: any; approvals?: any }
async function waitFor<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000
  do { const value = await read(); if (accepts(value)) return value; await new Promise(resolve => setTimeout(resolve, 15)) }
  while (Date.now() < deadline)
  throw new Error('Private Hook consumer did not observe its required fact')
}

describe('compiled public Core consumes shared native Hook declarations', () => {
  it.each(['codex', 'hermes'] as const)('%s create/continuity/Doctor preserve shared config and the original healthy PTY', async providerId => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'amh-')))
    const runtime = join(root, 'runtime'), workspace = join(root, 'workspace'), cliPath = join(root, 'cli.mjs')
    const trace = join(root, 'trace.ndjson'), storePath = join(root, 'sessions.json')
    for (const path of [runtime, workspace, join(root, 'hermes')]) await mkdir(path)
    await writeFile(cliPath, cli, { mode: 0o700 }); await writeFile(trace, '')
    for (const key of Object.keys(process.env).filter(key => key.startsWith('AGENTMUX_'))) vi.stubEnv(key, undefined)
    vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', runtime); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
    vi.stubEnv('AGENTMUX_AGENT_SESSION_STORE', storePath); vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
    const env = { AMX_PRESERVATION_ROOT: root, AMX_PRESERVATION_TRACE: trace, CODEX_HOME: join(root, 'codex'), HERMES_HOME: join(root, 'hermes') }
    const provider = new AgentProviderRegistry().get(providerId)
    const plan = provider.planManagedHooks!({ workspacePath: workspace, env })!
    expect(plan.mutations.length).toBeGreaterThan(0)
    const originals = new Map<string, string>()
    for (const mutation of plan.mutations) {
      expect(mutation.path.startsWith(root + '/')).toBe(true)
      await mkdir(join(mutation.path, '..'), { recursive: true })
      const text = mutation.merge?.kind === 'yaml-managed-events'
        ? '# user comment\nsecret: private-value\nhooks:\n  pre_tool_call:\n    - command: printf agentmux-hook.js\n      timeout: 5\n  Future:\n    native: unknown\n'
        : mutation.merge?.kind === 'json-managed-approvals'
          ? JSON.stringify({ approvals: [{ event: 'pre_tool_call', command: 'printf agentmux-hook.js', approved_at: 'user-time' }] })
          : JSON.stringify({ description: 'user label', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'printf agentmux-hook.js', timeout: 5 }] }], Future: { native: 'unknown' } } })
      originals.set(mutation.path, text); await writeFile(mutation.path, text)
    }
    const daemon = spawn(fileURLToPath(new URL('../vendor/ctxmux/darwin-arm64/bin/ctxmuxd', import.meta.url)), [
      '--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(root, 'daemon-state'), '--readiness-fd', '3'
    ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
    let daemonError = ''; daemon.stderr?.on('data', data => { daemonError += data.toString() })
    const closed = once(daemon, 'close'), clients: AgentMuxClient[] = []
    const traces = async (): Promise<Trace[]> => (await readFile(trace, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
    const newClient = async () => {
      const client = new AgentMuxClient({ providers: [provider], store: new AgentMuxFileAgentSessionStore(storePath),
        hookInstaller: new AgentManagedHookInstaller(join(root, 'receipts')) })
      clients.push(client); await client.connect(); return client
    }
    try {
      await Promise.race([once(daemon.stdio[3]!, 'data'), once(daemon, 'exit').then(() => {
        throw new Error(`Private daemon exited before readiness: ${daemonError}`)
      })])
      const first = await newClient()
      const session = await first.createAgent({ agentSessionId: 'private-preserve', createOperationId: 'create-private-preserve',
        providerId, executorId: 'private-reader', workspacePath: workspace, commandOverride: cliPath,
        injectAgentMuxGuide: false, env, args: ['private-config-reader'] })
      const observed = await waitFor(traces, entries => entries.some(entry => entry.type === 'ready'))
      const pid = observed.find(entry => entry.type === 'ready')!.pid
      expect((await first.statusAgent(session.agentSessionId)).run.pid).toBe(pid)
      const consumed = observed.find(entry => entry.type === 'config')!
      expect(consumed.config.hooks.Future).toEqual({ native: 'unknown' })
      if (providerId === 'codex') {
        expect(consumed.config.description).toBe('user label')
        expect(consumed.config.hooks.Stop[0]).toEqual(JSON.parse(originals.get(plan.mutations[0]!.path)!).hooks.Stop[0])
      } else {
        expect(consumed.config.secret).toBe('private-value')
        expect(consumed.config.hooks.pre_tool_call[0]).toEqual(parse(originals.get(plan.mutations[0]!.path)!).hooks.pre_tool_call[0])
        expect(consumed.approvals.approvals[0]).toEqual(JSON.parse(originals.get(plan.mutations[1]!.path)!).approvals[0])
        expect(await readFile(plan.mutations[0]!.path, 'utf8')).toContain('# user comment')
      }
      const content = await Promise.all(plan.mutations.map(async m => ({ bytes: await readFile(m.path), mtime: (await stat(m.path)).mtimeMs })))
      await first.dispose()
      const fresh = await newClient()
      const continuity = await fresh.ensureAgentContinuity({ agentSessionId: session.agentSessionId, expectedRun: session.run,
        operationId: 'same-run-declarations', env, commandOverride: cliPath })
      expect(continuity.kind).toBe('reattachable')
      expect((await fresh.statusAgent(session.agentSessionId)).run).toMatchObject({ runId: session.run.runId, pid, state: 'running' })
      expect(await Promise.all(plan.mutations.map(async m => ({ bytes: await readFile(m.path), mtime: (await stat(m.path)).mtimeMs })))).toEqual(content)
      const doctor = await diagnoseAgentMux({ client: fresh, workspacePath: workspace, env, commandOverrides: { [providerId]: cliPath } })
      expect(doctor.host.reachable).toBe(true)
      expect(doctor.agents).toHaveLength(1)
      expect(doctor.agents[0]!.hookInstallation).toMatchObject({ status: 'installed', phase: 'pre-connect' })
      expect(doctor.agents[0]!.hookInstallation.targets.map(target => target.status)).toEqual(plan.mutations.map(() => 'current'))
      expect(JSON.stringify(doctor)).not.toContain('private-value')
      if (providerId === 'codex') expect((await traces()).filter(entry => entry.type === 'rpc').map(entry => entry.method)).toEqual(['initialize', 'initialized', 'hooks/list'])

      // A selected unsafe container rejects only repair, leaves its original bytes, and does not
      // remove the Session or the real input capability of that same Run.
      const target = plan.mutations[0]!.path, ambiguous = providerId === 'codex' ? '{"hooks":[]}' : 'hooks: [unknown]\n'
      await writeFile(target, ambiguous)
      const events: AgentMuxClientEvent[] = []; fresh.onEvent(event => events.push(event))
      expect((await fresh.ensureAgentContinuity({ agentSessionId: session.agentSessionId, expectedRun: session.run,
        operationId: 'unsafe-container-repair', env, commandOverride: cliPath })).kind).toBe('reattachable')
      expect(await readFile(target, 'utf8')).toBe(ambiguous)
      expect(events.filter(event => event.type === 'agent-error')).toEqual([expect.objectContaining({ code: 'HOOK_TARGET_UNPARSEABLE', message: expect.stringContaining('continues') })])
      const ack = await fresh.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: session.run, source: 'user', data: 'after-repair-refusal\r' })
      expect(ack.acceptedThroughByte).toBeGreaterThan(0)
      const inputs = await waitFor(traces, entries => entries.some(entry => entry.input === 'after-repair-refusal'))
      expect(inputs.filter(entry => entry.type === 'input')).toEqual([{ type: 'input', input: 'after-repair-refusal', pid }])
      expect((await fresh.statusAgent(session.agentSessionId)).run).toMatchObject({ runId: session.run.runId, pid, state: 'running' })
      expect(fresh.agentSessions().map(agent => agent.run)).toEqual([session.run])
      console.log(JSON.stringify({ schema: 'agentmux.hook-preservation-consumer.v1', providerId, run: session.run, pid,
        create: true, sameRunContinuity: true, doctor: true, unsafeRepairPreservedInput: true,
        configurationHashes: content.map(value => createHash('sha256').update(value.bytes).digest('hex')) }))
    } finally {
      const pids = [...new Set((await traces()).map(entry => entry.pid))]
      const disposed = await Promise.allSettled(clients.map(client => client.dispose()))
      daemon.kill('SIGTERM'); const timer = setTimeout(() => daemon.kill('SIGKILL'), 2_000)
      try { await closed } finally { clearTimeout(timer) }
      for (const pid of pids) await waitFor(async () => {
        try { process.kill(pid, 0); return true } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
          throw error
        }
      }, alive => !alive)
      console.log(JSON.stringify({ schema: 'agentmux.hook-preservation-cleanup.v1', daemonPid: daemon.pid, pids, exited: true }))
      await rm(root, { recursive: true, force: true })
      const failures = disposed.flatMap(value => value.status === 'rejected' ? [value.reason] : [])
      if (failures.length) throw new AggregateError(failures, 'Private Hook clients failed cleanup')
    }
  }, 25_000)
})
